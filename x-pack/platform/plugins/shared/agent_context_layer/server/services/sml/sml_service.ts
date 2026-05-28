/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { errors } from '@elastic/elasticsearch';
import type { FieldValue } from '@elastic/elasticsearch/lib/api/types';
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

/**
 * Maximum docs scanned per search request — a cap on the total overfetch used
 * to absorb permission filtering. If size × MAX_SCAN_MULTIPLIER docs are
 * scanned without filling the page the caller's permissions are too restrictive
 * to reliably fill it — return what we have.
 */
const MAX_SCAN_MULTIPLIER = 10;

/**
 * All fields used in FORK MATCH branches: BM25 text fields first, then their
 * corresponding semantic_text multi-fields. Each field gets its own FORK branch
 * so FUSE can apply RRF across all six sub-retrievers independently.
 */
const SML_MATCH_FIELDS = [
  'title',
  'description',
  'content',
  'title.semantic',
  'description.semantic',
  'content.semantic',
] as const;

/**
 * Build an ES|QL query string + positional params array for the SML search path.
 *
 * Non-empty queries: six FORK branches (one MATCH per field, BM25 + semantic)
 * merged by FUSE with RRF. Filters are applied as WHERE clauses before FORK so
 * every branch operates on the same filtered set.
 *
 * Empty string or `*`: plain sorted scan — no FORK/FUSE, no relevance signal.
 *
 * Spaces filter uses MV_CONTAINS rather than `==` because `==` returns null
 * (not false) when the field has multiple values — a known ES|QL multi-value
 * semantic that would silently drop multi-space documents.
 *
 * Tag filter similarly uses MV_CONTAINS for the same reason.
 *
 * The LIMIT is size × MAX_SCAN_MULTIPLIER to leave room for permission
 * post-filtering; the caller slices the authorized results to `size`.
 *
 * `references.uri` is extracted via EVAL before KEEP so the result column is
 * a flat keyword array that can be reconstructed into Array<{uri}> client-side.
 */
const buildSmlEsqlQuery = ({
  query,
  size,
  skipContent,
  spaceId,
  scoping,
  filters,
}: {
  query: string;
  size: number;
  skipContent?: boolean;
  spaceId: string;
  scoping?: SmlSearchScoping;
  filters?: SmlSearchFilters;
}): { esql: string; params: unknown[] } => {
  const params: unknown[] = [];
  const lines: string[] = [`FROM ${smlIndexName}`];

  // spaces filter — MV_CONTAINS handles multi-value docs (== returns null for them)
  params.push(spaceId);
  lines.push('| WHERE MV_CONTAINS(spaces, ?)');

  // runtime-imposed per-type id-allowlist scoping
  if (scoping) {
    for (const [typeId, criteria] of Object.entries(scoping)) {
      if (!criteria?.ids) continue;
      if (criteria.ids.length === 0) {
        // Explicitly empty → exclude all documents of this type
        params.push(typeId);
        lines.push('| WHERE type != ?');
      } else {
        // Non-empty → allow matching docs of this type, pass through other types
        const idPlaceholders = criteria.ids.map(() => '?').join(', ');
        params.push(typeId, ...criteria.ids);
        lines.push(`| WHERE type != ? OR origin_id IN (${idPlaceholders})`);
      }
    }
  }

  // agent-discoverable type filter
  if (filters?.types && filters.types.length > 0) {
    const placeholders = filters.types.map(() => '?').join(', ');
    params.push(...filters.types);
    lines.push(`| WHERE type IN (${placeholders})`);
  }

  // agent-discoverable tag filter — MV_CONTAINS for multi-value safety
  if (filters?.tags && filters.tags.length > 0) {
    const tagConditions = filters.tags.map((tag) => {
      params.push(tag);
      return 'MV_CONTAINS(tags, ?)';
    });
    lines.push(`| WHERE ${tagConditions.join(' OR ')}`);
  }

  const trimmed = query.trim();
  if (trimmed === '' || trimmed === '*') {
    lines.push('| SORT id ASC');
  } else {
    lines.push('| FORK');
    for (const field of SML_MATCH_FIELDS) {
      params.push(trimmed);
      lines.push(`  (MATCH(${field}, ?))`);
    }
    lines.push('| FUSE');
    lines.push('| SORT _score DESC, id ASC');
  }

  lines.push(`| LIMIT ${size * MAX_SCAN_MULTIPLIER}`);

  // Materialize the object sub-field into a flat keyword column before KEEP.
  lines.push('| EVAL ref_uris = references.uri');

  const keepCols = [
    'id',
    'type',
    'title',
    'origin_id',
    'description',
    'tags',
    'ref_uris',
    'spaces',
    'permissions',
    ...(skipContent ? [] : ['content']),
  ];
  lines.push(`| KEEP ${keepCols.join(', ')}`);

  return { esql: lines.join('\n'), params };
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
 * Empty arrays are ignored (treated as "no constraint") — the agent has no
 * way to express "exclude everything" and passing `[]` accidentally should
 * be a no-op.
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
 * Returns true for ES|QL errors that indicate the SML index does not exist yet.
 * ES|QL does not support `ignore_unavailable`; a missing index surfaces as a
 * `verification_exception` (400) or `index_not_found_exception` (400/404).
 */
const isEsqlIndexMissingError = (error: unknown): boolean => {
  if (!(error instanceof errors.ResponseError)) return false;
  const body = error.body as { error?: { type?: string } } | undefined;
  return (
    body?.error?.type === 'index_not_found_exception' ||
    body?.error?.type === 'verification_exception'
  );
};

/**
 * Search the SML index using ES|QL FORK + FUSE hybrid retrieval.
 *
 * A single ES|QL query fetches size × MAX_SCAN_MULTIPLIER docs (to absorb
 * permission post-filtering). Docs are filtered by Kibana RBAC and the first
 * `size` authorized results are returned.
 *
 * Non-empty queries: six FORK branches (BM25 × 3 + semantic × 3), merged by
 * FUSE with RRF. Empty string or `*`: plain sorted scan, no relevance signal.
 *
 * Filter composition: spaces (MV_CONTAINS) + scoping (runtime-imposed per-type
 * id-allowlist) + agent filters — all ANDed as WHERE clauses before FORK.
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
  logger.debug(`SML search: query=${JSON.stringify(query)}, size=${size}, spaceId='${spaceId}'`);

  const { esql, params } = buildSmlEsqlQuery({
    query,
    size,
    skipContent,
    spaceId,
    scoping,
    filters,
  });

  let response: { columns: Array<{ name: string; type: string }>; values: unknown[][] };
  try {
    response = await esClient.asInternalUser.esql.query({
      query: esql,
      ...(params.length > 0 ? { params: params as unknown as FieldValue[] } : {}),
    });
  } catch (error) {
    if (isNotFoundError(error) || isEsqlIndexMissingError(error)) {
      logger.debug('SML index does not exist yet — returning empty results');
      return { results: [] };
    }
    logger.warn(`SML search failed: ${(error as Error).message}`);
    throw error;
  }

  const colIndex = new Map<string, number>(response.columns.map((col, i) => [col.name, i]));

  const toStringArray = (v: unknown): string[] => {
    if (v == null) return [];
    return Array.isArray(v) ? (v as unknown[]).filter((s) => s != null).map(String) : [String(v)];
  };

  const allResults: SmlSearchResult[] = response.values.map((row) => {
    const result: SmlSearchResult = {
      id: String(row[colIndex.get('id')!] ?? ''),
      type: String(row[colIndex.get('type')!] ?? ''),
      title: String(row[colIndex.get('title')!] ?? ''),
      origin_id: String(row[colIndex.get('origin_id')!] ?? ''),
      spaces: toStringArray(row[colIndex.get('spaces')!]),
      permissions: toStringArray(row[colIndex.get('permissions')!]),
    };

    const contentIdx = colIndex.get('content');
    if (!skipContent && contentIdx !== undefined) {
      const content = row[contentIdx];
      if (content != null) result.content = String(content);
    }

    const desc = row[colIndex.get('description')!];
    if (desc != null) result.description = String(desc);

    const rawTags = row[colIndex.get('tags')!];
    if (rawTags != null) result.tags = toStringArray(rawTags);

    const refUrisIdx = colIndex.get('ref_uris');
    if (refUrisIdx !== undefined) {
      const refUris = toStringArray(row[refUrisIdx]);
      if (refUris.length > 0) result.references = refUris.map((uri) => ({ uri }));
    }

    return result;
  });

  const authorized = await filterPageByPermissions(allResults, { request, securityAuthz, logger });
  logger.debug(
    `SML search: scanned=${response.values.length}, authorized=${authorized.length}, size=${size}`
  );
  return { results: authorized.slice(0, size) };
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
 * and the UI renders plain `value`.
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
