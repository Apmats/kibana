/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { errors } from '@elastic/elasticsearch';
import type { IScopedClusterClient } from '@kbn/core-elasticsearch-server';
import type { Logger } from '@kbn/logging';
import type { KibanaRequest } from '@kbn/core-http-server';
import type { AuthorizationServiceSetup } from '@kbn/security-plugin-types-server';
import type {
  SmlService,
  SmlSearchResult,
  SmlAutocompleteResult,
  SmlDocument,
  SmlTypeDefinition,
  SmlSearchFilters,
  SmlSearchScoping,
  MatchedDiscoveryLabel,
} from './types';
import { createSmlTypeRegistry, type SmlTypeRegistry } from './sml_type_registry';
import { createSmlIndexer, type SmlIndexer } from './sml_indexer';
import { SmlCrawlerImpl } from './sml_crawler';
import type { SmlCrawler } from './types';
import { smlIndexName } from './sml_storage';

export interface SmlServiceSetup {
  /**
   * Register an SML type definition.
   * Should be called during plugin setup.
   */
  registerType: (definition: SmlTypeDefinition) => void;
}

export interface SmlServiceStartDeps {
  logger: Logger;
  securityAuthz?: AuthorizationServiceSetup;
}

export interface SmlServiceInstance {
  setup: (deps: { logger: Logger }) => SmlServiceSetup;
  start: (deps: SmlServiceStartDeps) => SmlService;
}

export const createSmlService = (): SmlServiceInstance => {
  return new SmlServiceImpl();
};

class SmlServiceImpl implements SmlServiceInstance {
  private registry: SmlTypeRegistry;
  private indexer?: SmlIndexer;
  private crawler?: SmlCrawler;
  private securityAuthz?: AuthorizationServiceSetup;

  constructor() {
    this.registry = createSmlTypeRegistry();
  }

  setup({ logger }: { logger: Logger }): SmlServiceSetup {
    return {
      registerType: (definition: SmlTypeDefinition) => {
        this.registry.register(definition);
        logger.info(`Registered SML type: ${definition.id}`);
      },
    };
  }

  start({ logger, securityAuthz }: SmlServiceStartDeps): SmlService {
    this.securityAuthz = securityAuthz;
    if (!securityAuthz) {
      logger.warn(
        'SML service started without security authorization — permission checks are disabled (open access)'
      );
    }
    this.indexer = createSmlIndexer({ registry: this.registry, logger: logger.get('indexer') });
    this.crawler = new SmlCrawlerImpl({
      indexer: this.indexer,
      logger: logger.get('crawler'),
    });

    const crawler = this.crawler;

    return {
      getCrawler: () => crawler,
      search: async ({
        query,
        size = 10,
        skipContent,
        spaceId,
        esClient,
        request,
        scoping,
        filters,
      }) => {
        return searchSml({
          query,
          size,
          skipContent,
          spaceId,
          esClient,
          request,
          securityAuthz: this.securityAuthz,
          logger,
          scoping,
          filters,
        });
      },
      autocomplete: async ({ query, size = 10, spaceId, esClient, request, scoping, filters }) => {
        const rawResults = await autocompleteSml({
          query,
          size,
          spaceId,
          esClient,
          logger,
          scoping,
          filters,
        });
        return filterResultsByPermissions({
          searchResult: rawResults,
          request,
          securityAuthz: this.securityAuthz,
          logger,
        });
      },
      checkItemsAccess: async ({ ids, spaceId, esClient, request }) => {
        return checkItemsAccess({
          ids,
          spaceId,
          esClient,
          request,
          securityAuthz: this.securityAuthz,
          logger,
        });
      },
      indexAttachment: async (params) => {
        return this.getIndexer().indexAttachment(params);
      },
      getDocuments: async ({ ids, spaceId, esClient }) => {
        return getDocumentsByIds({ ids, spaceId, esClient, logger });
      },
      getTypeDefinition: (typeId: string) => {
        return this.registry.get(typeId);
      },
      listTypeDefinitions: () => {
        return this.registry.list();
      },
    };
  }

  private getIndexer(): SmlIndexer {
    if (!this.indexer) {
      throw new Error('SML indexer not initialized — call start() first');
    }
    return this.indexer;
  }
}

export const isNotFoundError = (error: unknown): boolean => {
  return error instanceof errors.ResponseError && error.statusCode === 404;
};

/**
 * Batch-check which of the given Kibana privilege strings the current user holds.
 * Returns the set of authorized privilege strings.
 */
const getAuthorizedPermissions = async ({
  permissions,
  request,
  securityAuthz,
  logger,
}: {
  permissions: string[];
  request: KibanaRequest;
  securityAuthz: AuthorizationServiceSetup;
  logger: Logger;
}): Promise<Set<string>> => {
  if (permissions.length === 0) {
    return new Set();
  }

  try {
    const checkPrivileges = securityAuthz.checkPrivilegesDynamicallyWithRequest(request);
    const response = await checkPrivileges({ kibana: permissions });

    return new Set(response.privileges.kibana.filter((p) => p.authorized).map((p) => p.privilege));
  } catch (error) {
    logger.warn(`SML permission check failed: ${(error as Error).message}`);
    return new Set();
  }
};

/**
 * Filter a single page of results by the current user's Kibana RBAC permissions.
 * Used by the search loop (per page) and directly by autocomplete (single pass).
 */
const filterPageByPermissions = async <T extends { permissions: string[] }>(
  items: T[],
  {
    request,
    securityAuthz,
    logger,
  }: {
    request: KibanaRequest;
    securityAuthz?: AuthorizationServiceSetup;
    logger: Logger;
  }
): Promise<T[]> => {
  if (!securityAuthz || items.length === 0) return items;

  const allPermissions = [...new Set(items.flatMap((hit) => hit.permissions))];
  if (allPermissions.length === 0) return items;

  const authorizedPerms = await getAuthorizedPermissions({
    permissions: allPermissions,
    request,
    securityAuthz,
    logger,
  });

  return items.filter(
    (hit) => hit.permissions.length === 0 || hit.permissions.every((p) => authorizedPerms.has(p))
  );
};

/**
 * Wrap filterPageByPermissions for callers that hold a `{ results }` object.
 * Used by the autocomplete path.
 */
const filterResultsByPermissions = async <T extends { permissions: string[] }>({
  searchResult,
  request,
  securityAuthz,
  logger,
}: {
  searchResult: { results: T[] };
  request: KibanaRequest;
  securityAuthz?: AuthorizationServiceSetup;
  logger: Logger;
}): Promise<{ results: T[] }> => {
  const filtered = await filterPageByPermissions(searchResult.results, {
    request,
    securityAuthz,
    logger,
  });
  return { results: filtered };
};

/**
 * Check whether the current user has access to specific SML items.
 * Looks up each item's permissions from the index and batch-checks them.
 */
const checkItemsAccess = async ({
  ids,
  spaceId,
  esClient,
  request,
  securityAuthz,
  logger,
}: {
  ids: string[];
  spaceId: string;
  esClient: IScopedClusterClient;
  request: KibanaRequest;
  securityAuthz?: AuthorizationServiceSetup;
  logger: Logger;
}): Promise<Map<string, boolean>> => {
  const accessMap = new Map<string, boolean>();

  // When the security plugin is absent, grant access to all items.
  if (!securityAuthz) {
    for (const id of ids) {
      accessMap.set(id, true);
    }
    return accessMap;
  }

  let docPermissions: Map<string, string[]>;
  try {
    const response = await esClient.asInternalUser.search<Pick<SmlDocument, 'id' | 'permissions'>>({
      index: smlIndexName,
      size: ids.length,
      allow_no_indices: true,
      ignore_unavailable: true,
      query: {
        bool: {
          filter: [
            { terms: { id: ids } },
            {
              bool: {
                should: [{ term: { spaces: spaceId } }, { term: { spaces: '*' } }],
                minimum_should_match: 1,
              },
            },
          ],
        },
      },
      _source: ['id', 'permissions'],
    });

    docPermissions = new Map(
      response.hits.hits
        .filter((hit) => hit._source != null)
        .map((hit) => {
          const source = hit._source!;
          return [source.id ?? '', source.permissions ?? []] as [string, string[]];
        })
    );
  } catch (error) {
    if (isNotFoundError(error)) {
      for (const id of ids) {
        accessMap.set(id, false);
      }
      return accessMap;
    }
    logger.warn(`SML items access check failed: ${(error as Error).message}`);
    for (const id of ids) {
      accessMap.set(id, false);
    }
    return accessMap;
  }

  const allPermissions = [...new Set([...docPermissions.values()].flat())];

  const authorizedPerms = await getAuthorizedPermissions({
    permissions: allPermissions,
    request,
    securityAuthz,
    logger,
  });

  for (const id of ids) {
    const perms = docPermissions.get(id);
    if (!perms) {
      accessMap.set(id, false);
      continue;
    }
    if (perms.length === 0) {
      accessMap.set(id, true);
      continue;
    }
    accessMap.set(
      id,
      perms.every((p) => authorizedPerms.has(p))
    );
  }

  return accessMap;
};

const BM25_TITLE_BOOST = 2;

/**
 * PIT-backed pagination constants for the search loop.
 *
 * OVERFETCH_MULTIPLIER: how many docs to fetch per loop iteration relative to
 * the remaining gap. 2× means we expect ~50% of docs to pass the permission
 * filter; increase if real-world permission drop rates are higher.
 *
 * MAX_SCAN_MULTIPLIER: hard cap on total docs scanned per request. If we scan
 * size × 10 docs without filling the page the user's permissions are too
 * restrictive to reliably serve a full page — return what we have.
 *
 * PIT_KEEP_ALIVE: how long ES keeps the point-in-time snapshot alive between
 * loop iterations. 1 minute is sufficient since all iterations happen within a
 * single request handler; the PIT is always closed before the handler returns.
 */
const OVERFETCH_MULTIPLIER = 2;
const MAX_SCAN_MULTIPLIER = 10;
const PIT_KEEP_ALIVE = '1m';

/**
 * Stable sort for PIT + search_after pagination.
 * _score desc as primary, _shard_doc asc as unique tiebreaker within the PIT.
 */
const SEARCH_SORT: Array<Record<string, { order: 'asc' | 'desc' }>> = [
  { _score: { order: 'desc' } },
  { _shard_doc: { order: 'asc' } },
];

/**
 * Build the search retriever body for the natural-language path. Hybrid:
 *   - BM25 over `title^2`, `description`, `content` (best_fields multi_match)
 *   - Semantic over `unified_semantic` (semantic_text aggregator over
 *     title + description + content via copy_to)
 * combined with RRF.
 *
 * Filters (space + scoping + agent-supplied) are applied per child retriever
 * via the standard retriever's `filter` field — every child retriever sees
 * the same scope, so RRF can't pull unauthorized documents into the top-k.
 *
 * After trim: empty string or `*` → falls back to a `match_all` query body
 * (no retrieval signal to combine).
 */
const buildSmlSearchBody = ({
  query,
  filterClauses,
}: {
  query: string;
  filterClauses: Array<Record<string, unknown>>;
}): Record<string, unknown> => {
  const trimmed = query.trim();
  if (trimmed === '' || trimmed === '*') {
    return {
      query: {
        bool: {
          must: [{ match_all: {} }],
          filter: filterClauses,
        },
      },
    };
  }

  return {
    retriever: {
      rrf: {
        retrievers: [
          {
            standard: {
              query: {
                multi_match: {
                  query: trimmed,
                  type: 'best_fields',
                  fields: [`title^${BM25_TITLE_BOOST}`, 'description', 'content'],
                },
              },
              filter: filterClauses,
            },
          },
          {
            standard: {
              query: {
                semantic: {
                  field: 'unified_semantic',
                  query: trimmed,
                },
              },
              filter: filterClauses,
            },
          },
        ],
        // rank_constant and rank_window_size are omitted — ES defaults (60 and
        // 100 respectively) apply. Introduce named constants here once retrieval
        // eval baselines exist and we have signal to tune against.
      },
    },
  };
};

/**
 * Build an ES filter clause from runtime-imposed per-type scoping.
 *
 * For each type with an `ids` constraint, the filter returns documents that
 * either (a) match the type AND have an origin_id in the list, or (b) are
 * NOT of the constrained type. Types without scoping are unaffected.
 *
 * Renamed from `buildTypeFilters` to reflect the trust-boundary split
 * between runtime-imposed scope and agent-discoverable filters.
 */
export const buildScopingFilter = (
  scoping: SmlSearchScoping | undefined
): Record<string, unknown> | undefined => {
  if (!scoping) {
    return undefined;
  }

  const clauses: Array<Record<string, unknown>> = [];

  for (const [typeId, criteria] of Object.entries(scoping)) {
    if (!criteria?.ids) {
      continue;
    }

    if (criteria.ids.length === 0) {
      // Explicitly empty → exclude all documents of this type
      clauses.push({ bool: { must_not: [{ term: { type: typeId } }] } });
    } else {
      // Non-empty → allow matching documents of this type, pass through other types
      clauses.push({
        bool: {
          should: [
            {
              bool: {
                must: [{ term: { type: typeId } }, { terms: { origin_id: criteria.ids } }],
              },
            },
            {
              bool: {
                must_not: [{ term: { type: typeId } }],
              },
            },
          ],
          minimum_should_match: 1,
        },
      });
    }
  }

  if (clauses.length === 0) {
    return undefined;
  }

  if (clauses.length === 1) {
    return clauses[0];
  }

  return { bool: { must: clauses } };
};

/**
 * Build ES filter clauses from agent-discoverable filters (`types[]`,
 * `tags[]`). Each dimension lowers into a single `terms` clause; multiple
 * dimensions AND together via inclusion in the outer `filter` list.
 *
 * Empty arrays are ignored (treated as "no constraint" rather than "exclude
 * everything") — the agent has no way to express the latter and the former
 * is the more useful default if the LLM passes `[]` accidentally.
 */
export const buildAgentFilters = (
  filters: SmlSearchFilters | undefined
): Array<Record<string, unknown>> => {
  if (!filters) {
    return [];
  }

  const clauses: Array<Record<string, unknown>> = [];

  if (filters.types && filters.types.length > 0) {
    clauses.push({ terms: { type: filters.types } });
  }

  if (filters.tags && filters.tags.length > 0) {
    clauses.push({ terms: { tags: filters.tags } });
  }

  return clauses;
};

/**
 * Search the SML index with the hybrid RRF retriever, guaranteeing up to
 * `size` permission-authorized results via an internal PIT + search_after loop.
 *
 * Each iteration fetches `remaining × OVERFETCH_MULTIPLIER` docs, filters them
 * by Kibana RBAC, and accumulates until the page is full or the index is
 * exhausted. The loop stops early if `MAX_SCAN_MULTIPLIER × size` total docs
 * have been scanned without filling the page — a sign that the caller's
 * permissions are too restrictive to reliably serve a full page.
 *
 * The PIT is always closed before the function returns.
 *
 * Filter composition: spaces (always) + scoping (runtime-imposed) + agent
 * filters (caller refinement) — all ANDed. The agent's `filters` can only
 * narrow the runtime-imposed `scoping`; it can't widen it.
 *
 * `content` is included in results unless `skipContent` is true.
 */
const searchSml = async ({
  query,
  size,
  skipContent,
  spaceId,
  esClient,
  request,
  securityAuthz,
  logger,
  scoping,
  filters,
}: {
  query: string;
  size: number;
  skipContent?: boolean;
  spaceId: string;
  esClient: IScopedClusterClient;
  request: KibanaRequest;
  securityAuthz?: AuthorizationServiceSetup;
  logger: Logger;
  scoping?: SmlSearchScoping;
  filters?: SmlSearchFilters;
}): Promise<{ results: SmlSearchResult[] }> => {
  logger.debug(
    `SML search: query=${JSON.stringify(query)}, size=${size}, spaceId='${spaceId}'`
  );

  const filterClauses: Array<Record<string, unknown>> = [
    {
      bool: {
        should: [{ term: { spaces: spaceId } }, { term: { spaces: '*' } }],
        minimum_should_match: 1,
      },
    },
  ];
  const scopingFilter = buildScopingFilter(scoping);
  if (scopingFilter) filterClauses.push(scopingFilter);
  for (const agentClause of buildAgentFilters(filters)) filterClauses.push(agentClause);

  const body = buildSmlSearchBody({ query, filterClauses });

  let pitId: string;
  try {
    const pit = await esClient.asInternalUser.openPointInTime({
      index: smlIndexName,
      keep_alive: PIT_KEEP_ALIVE,
      ignore_unavailable: true,
    });
    pitId = pit.id;
  } catch (error) {
    if (isNotFoundError(error)) {
      logger.debug('SML index does not exist yet — returning empty results');
      return { results: [] };
    }
    throw error;
  }

  const accumulated: SmlSearchResult[] = [];
  const maxScan = size * MAX_SCAN_MULTIPLIER;
  let scanned = 0;
  let currentSearchAfter: Array<string | number | null> | undefined;

  try {
    while (accumulated.length < size && scanned < maxScan) {
      const remaining = size - accumulated.length;
      const fetchSize = Math.min(remaining * OVERFETCH_MULTIPLIER, maxScan - scanned);

      const response = await esClient.asInternalUser.search<SmlDocument>({
        pit: { id: pitId, keep_alive: PIT_KEEP_ALIVE },
        size: fetchSize,
        sort: SEARCH_SORT,
        ...(currentSearchAfter ? { search_after: currentSearchAfter } : {}),
        ...body,
        _source: {
          includes: [
            'id',
            'type',
            'title',
            'origin_id',
            'description',
            'tags',
            'references',
            'spaces',
            'permissions',
            ...(skipContent ? [] : ['content']),
          ],
        },
      });

      // ES may rotate the PIT ID on each response — always use the latest.
      if (response.pit_id) pitId = response.pit_id;

      const hits = response.hits.hits;
      if (hits.length === 0) break;

      scanned += hits.length;
      const lastSort = hits[hits.length - 1].sort;
      if (lastSort) currentSearchAfter = lastSort as Array<string | number | null>;

      const pageResults: SmlSearchResult[] = hits
        .filter((hit) => hit._source != null)
        .map((hit) => {
          const source = hit._source!;
          const result: SmlSearchResult = {
            id: source.id ?? '',
            type: source.type ?? '',
            title: source.title ?? '',
            origin_id: source.origin_id ?? '',
            spaces: source.spaces ?? [],
            permissions: source.permissions ?? [],
            score: hit._score ?? 0,
          };
          if (!skipContent && source.content !== undefined) result.content = source.content;
          if (source.description !== undefined) result.description = source.description;
          if (source.tags !== undefined) result.tags = source.tags;
          if (source.references !== undefined) result.references = source.references;
          return result;
        });

      const authorizedPage = await filterPageByPermissions(pageResults, {
        request,
        securityAuthz,
        logger,
      });
      accumulated.push(...authorizedPage);

      if (hits.length < fetchSize) break; // partial page → index exhausted
    }

    logger.debug(
      `SML search: scanned=${scanned}, accumulated=${accumulated.length}, size=${size}`
    );
    return { results: accumulated.slice(0, size) };
  } catch (error) {
    logger.warn(`SML search failed: ${(error as Error).message}`);
    throw error;
  } finally {
    await esClient.asInternalUser.closePointInTime({ id: pitId }).catch((err: Error) => {
      logger.warn(`Failed to close SML search PIT: ${err.message}`);
    });
  }
};

/**
 * Pick a highlight snippet from ES's per-subfield highlight object.
 * Returns the first non-empty snippet; absent if none.
 */
const pickHighlightSnippet = (
  highlight: Record<string, string[]> | undefined
): string | undefined => {
  if (!highlight) return undefined;
  for (const snippets of Object.values(highlight)) {
    if (snippets && snippets.length > 0) {
      return snippets[0];
    }
  }
  return undefined;
};

/**
 * Build the autocomplete query: a single nested `multi_match bool_prefix` against
 * `discovery_labels.value` (SAYT) and its auto-generated `_2gram` / `_3gram`
 * subfields, with `inner_hits` to surface which entries matched (with their
 * `kind`). Title and type are reachable through this surface because the
 * indexer auto-prepends them to `discovery_labels`.
 *
 * `bool_prefix` is SAYT's native query type: all-but-last analyzed tokens are
 * required to match as exact indexed terms (against the bigram/trigram shingle
 * subfields), and the last token is required to match as a prefix (against
 * `_index_prefix`). With `operator: and` every typed token must contribute —
 * including the trailing partial. This yields tight per-token semantics:
 * `"github c"` matches `"GitHub Connector"` but not `"Githubster Cup"`
 * (because `"github"` is not an indexed token of `"Githubster"`).
 *
 * Known limitation: ES does not produce useful highlight snippets for
 * SAYT + `bool_prefix` + nested + inner_hits (bug
 * elastic/elasticsearch#53744, open since 2020). The highlight config below
 * is retained so the route is forward-compatible once the bug is fixed; until
 * then, `matched_discovery_labels` entries are returned without `highlighted`
 * and the UI renders plain `value`. See PR description for the trade-off vs
 * the earlier custom edge_ngram approach (working highlights but looser
 * matching) and the hybrid AND alternative.
 *
 * After trim: empty string or `*` → `match_all`.
 */
const buildSmlAutocompleteQuery = (query: string): Record<string, unknown> => {
  const trimmed = query.trim();
  if (trimmed === '' || trimmed === '*') {
    return { match_all: {} };
  }
  return {
    nested: {
      path: 'discovery_labels',
      query: {
        multi_match: {
          query: trimmed,
          type: 'bool_prefix',
          operator: 'and',
          fields: [
            'discovery_labels.value',
            'discovery_labels.value._2gram',
            'discovery_labels.value._3gram',
          ],
        },
      },
      inner_hits: {
        _source: ['discovery_labels.value', 'discovery_labels.kind'],
        size: 10,
        highlight: {
          type: 'unified',
          number_of_fragments: 0,
          pre_tags: ['<em>'],
          post_tags: ['</em>'],
          // HTML-encode the source text so literal `<`/`>`/`&` in user content
          // don't collide with the `<em>` wrappers when rendered. No-op while
          // #53744 keeps SAYT+nested highlight broken; correct once it lands.
          encoder: 'html',
          fields: {
            'discovery_labels.value': {},
          },
        },
      },
    },
  };
};

/**
 * Autocomplete the SML index. Prefix-only, with per-row provenance for the @ menu.
 */
const autocompleteSml = async ({
  query,
  size,
  spaceId,
  esClient,
  logger,
  scoping,
  filters,
}: {
  query: string;
  size: number;
  spaceId: string;
  esClient: IScopedClusterClient;
  logger: Logger;
  scoping?: SmlSearchScoping;
  filters?: SmlSearchFilters;
}): Promise<{ results: SmlAutocompleteResult[] }> => {
  logger.debug(
    `SML autocomplete: query=${JSON.stringify(
      query
    )}, size=${size}, spaceId='${spaceId}', index='${smlIndexName}'`
  );

  try {
    const smlQuery = buildSmlAutocompleteQuery(query);

    const filterClauses: Array<Record<string, unknown>> = [
      {
        bool: {
          should: [{ term: { spaces: spaceId } }, { term: { spaces: '*' } }],
          minimum_should_match: 1,
        },
      },
    ];
    const scopingFilter = buildScopingFilter(scoping);
    if (scopingFilter) {
      filterClauses.push(scopingFilter);
    }
    for (const agentClause of buildAgentFilters(filters)) {
      filterClauses.push(agentClause);
    }

    const response = await esClient.asInternalUser.search<SmlDocument>({
      index: smlIndexName,
      size,
      allow_no_indices: true,
      ignore_unavailable: true,
      query: {
        bool: {
          must: [smlQuery],
          filter: filterClauses,
        },
      },
      _source: ['id', 'type', 'title', 'origin_id', 'spaces', 'permissions'],
    });

    const results: SmlAutocompleteResult[] = response.hits.hits
      .filter((hit) => hit._source != null)
      .map((hit) => {
        const source = hit._source!;
        const result: SmlAutocompleteResult = {
          id: source.id ?? '',
          type: source.type ?? '',
          title: source.title ?? '',
          origin_id: source.origin_id ?? '',
          spaces: source.spaces ?? [],
          permissions: source.permissions ?? [],
        };
        // Inner hits from the nested discovery_labels query: the specific entries
        // that matched, with their ES-generated highlight snippet wrapping the
        // matched span(s) in <em>...</em>.
        const innerHits = (
          hit as {
            inner_hits?: Record<
              string,
              {
                hits: {
                  hits: Array<{
                    _source: { value?: string; kind?: string };
                    highlight?: Record<string, string[]>;
                  }>;
                };
              }
            >;
          }
        ).inner_hits;
        const labelHits = innerHits?.discovery_labels?.hits?.hits;
        if (labelHits && labelHits.length > 0) {
          const matched: MatchedDiscoveryLabel[] = labelHits
            .filter((h) => h._source?.value != null && h._source?.kind != null)
            .map((h) => {
              const entry: MatchedDiscoveryLabel = {
                value: h._source.value!,
                kind: h._source.kind!,
              };
              const snippet = pickHighlightSnippet(h.highlight);
              if (snippet) {
                entry.highlighted = snippet;
              }
              return entry;
            });
          if (matched.length > 0) {
            result.matched_discovery_labels = matched;
          }
        }
        return result;
      });

    logger.debug(`SML autocomplete: returned ${results.length} result(s)`);

    return { results };
  } catch (error) {
    if (isNotFoundError(error)) {
      logger.debug('SML index does not exist yet — returning empty autocomplete results');
      return { results: [] };
    }
    logger.warn(`SML autocomplete failed: ${(error as Error).message}`);
    throw error;
  }
};

/**
 * Fetch SML documents by their chunk IDs, scoped to a space.
 */
const getDocumentsByIds = async ({
  ids,
  spaceId,
  esClient,
  logger,
}: {
  ids: string[];
  spaceId: string;
  esClient: IScopedClusterClient;
  logger: Logger;
}): Promise<Map<string, SmlDocument>> => {
  const docMap = new Map<string, SmlDocument>();
  if (ids.length === 0) return docMap;

  try {
    const response = await esClient.asInternalUser.search<SmlDocument>({
      index: smlIndexName,
      size: ids.length,
      allow_no_indices: true,
      ignore_unavailable: true,
      query: {
        bool: {
          filter: [
            { terms: { id: ids } },
            {
              bool: {
                should: [{ term: { spaces: spaceId } }, { term: { spaces: '*' } }],
                minimum_should_match: 1,
              },
            },
          ],
        },
      },
    });

    for (const hit of response.hits.hits) {
      if (!hit._source) continue;
      const source = hit._source;
      const doc: SmlDocument = {
        id: source.id ?? '',
        type: source.type ?? '',
        title: source.title ?? '',
        origin_id: source.origin_id ?? '',
        content: source.content ?? '',
        created_at: source.created_at ?? '',
        updated_at: source.updated_at ?? '',
        spaces: source.spaces ?? [],
        permissions: source.permissions ?? [],
      };
      if (source.description !== undefined) {
        doc.description = source.description;
      }
      if (source.tags !== undefined) {
        doc.tags = source.tags;
      }
      if (source.discovery_labels !== undefined) {
        doc.discovery_labels = source.discovery_labels;
      }
      if (source.payload !== undefined) {
        doc.payload = source.payload;
      }
      if (source.user_id !== undefined) {
        doc.user_id = source.user_id;
      }
      if (source.references !== undefined) {
        doc.references = source.references;
      }
      docMap.set(doc.id, doc);
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      logger.warn(`SML getDocuments failed: ${(error as Error).message}`);
    }
  }

  return docMap;
};
