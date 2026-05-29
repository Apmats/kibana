/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { errors } from '@elastic/elasticsearch';
import { loggerMock } from '@kbn/logging-mocks';
import type { ElasticsearchClient, IScopedClusterClient } from '@kbn/core-elasticsearch-server';
import type { KibanaRequest } from '@kbn/core-http-server';
import type { AuthorizationServiceSetup } from '@kbn/security-plugin-types-server';
import { SmlSearchFilterType } from '../../../common/http_api/sml';
import { createSmlService, isNotFoundError } from './sml_service';
import { smlIndexName } from './sml_storage';
import type { SmlTypeDefinition } from './types';

const createMockEsClient = (): jest.Mocked<ElasticsearchClient> =>
  ({
    search: jest.fn(),
    count: jest.fn(),
    esql: {
      query: jest.fn(),
    },
  } as unknown as jest.Mocked<ElasticsearchClient>);

// Column order produced by buildSmlEsqlQuery. permissions is always present;
// spaces and other optional fields appear only when explicitly requested.
const makeEsqlColumns = (includeContent = true, includeSpaces = false) => [
  { name: 'id', type: 'keyword' },
  { name: 'type', type: 'keyword' },
  { name: 'title', type: 'text' },
  { name: 'origin_uri', type: 'keyword' },
  { name: 'description', type: 'text' },
  { name: 'tags', type: 'keyword' },
  { name: 'ref_uris', type: 'keyword' },
  ...(includeSpaces ? [{ name: 'spaces', type: 'keyword' }] : []),
  { name: 'permissions', type: 'keyword' },
  ...(includeContent ? [{ name: 'content', type: 'text' }] : []),
];

// Build a single ES|QL row value array matching makeEsqlColumns order.
const makeEsqlRow = (
  id: string,
  type: string,
  title: string,
  originId: string,
  permissions: string | string[],
  {
    spaces,
    description,
    tags,
    refUris,
    content,
    includeContent = true,
    includeSpaces = false,
  }: {
    spaces?: string | string[];
    description?: string;
    tags?: string[] | null;
    refUris?: string[] | null;
    content?: string;
    includeContent?: boolean;
    includeSpaces?: boolean;
  } = {}
): unknown[] => [
  id,
  type,
  title,
  originId,
  description ?? null,
  tags ?? null,
  refUris ?? null,
  ...(includeSpaces ? [spaces ?? null] : []),
  permissions,
  ...(includeContent ? [content ?? null] : []),
];

const createMockScopedClient = (
  internalUser: jest.Mocked<ElasticsearchClient>
): IScopedClusterClient =>
  ({
    asInternalUser: internalUser,
    asCurrentUser: createMockEsClient(),
  } as unknown as IScopedClusterClient);

const createMockLogger = () => {
  const log = loggerMock.create();
  log.get = jest.fn().mockReturnValue(log);
  return log;
};

const createMockSecurityAuthz = (authorizedPrivileges: string[]): AuthorizationServiceSetup => {
  const checkPrivileges = jest.fn().mockImplementation(async (req: { kibana: string[] }) => ({
    privileges: {
      kibana: req.kibana.map((privilege) => ({
        privilege,
        authorized: authorizedPrivileges.includes(privilege),
      })),
    },
  }));
  return {
    checkPrivilegesDynamicallyWithRequest: jest.fn().mockReturnValue(checkPrivileges),
  } as unknown as AuthorizationServiceSetup;
};

const createMockSecurityAuthzPartial = (
  authorized: string[],
  unauthorized: string[]
): AuthorizationServiceSetup => {
  const authorizedSet = new Set(authorized);
  const checkPrivileges = jest.fn().mockImplementation(async (req: { kibana: string[] }) => ({
    privileges: {
      kibana: req.kibana.map((privilege) => ({
        privilege,
        authorized: authorizedSet.has(privilege),
      })),
    },
  }));
  return {
    checkPrivilegesDynamicallyWithRequest: jest.fn().mockReturnValue(checkPrivileges),
  } as unknown as AuthorizationServiceSetup;
};

const createMockSmlTypeDefinition = (
  overrides: Partial<SmlTypeDefinition> = {}
): SmlTypeDefinition => ({
  id: 'test-type',
  list: jest.fn(),
  getSmlData: jest.fn(),
  toAttachment: jest.fn(),
  ...overrides,
});

const createNotFoundError = () =>
  new errors.ResponseError({
    statusCode: 404,
    body: { error: { type: 'index_not_found_exception' } },
    warnings: [],
    headers: {},
    meta: {} as any,
  });

describe('createSmlService', () => {
  describe('lifecycle', () => {
    it('setup() returns registerType', () => {
      const service = createSmlService();
      const logger = createMockLogger();
      const setup = service.setup({ logger });

      expect(setup.registerType).toBeDefined();
      expect(typeof setup.registerType).toBe('function');

      const def = createMockSmlTypeDefinition({ id: 'dashboard' });
      setup.registerType(def);
      expect(logger.info).toHaveBeenCalledWith('Registered SML type: dashboard');
    });

    it('start() returns the SmlService with registered types accessible', () => {
      const service = createSmlService();
      const logger = createMockLogger();
      const setup = service.setup({ logger });

      const def = createMockSmlTypeDefinition({ id: 'dashboard' });
      setup.registerType(def);

      const smlService = service.start({ logger });

      expect(smlService.search).toBeDefined();
      expect(smlService.autocomplete).toBeDefined();
      expect(smlService.checkItemsAccess).toBeDefined();
      expect(smlService.getDocuments).toBeDefined();
      expect(smlService.indexAttachment).toBeDefined();
      expect(smlService.getTypeDefinition).toBeDefined();
      expect(smlService.listTypeDefinitions).toBeDefined();
      expect(smlService.getCrawler).toBeDefined();
      expect(smlService.getCrawler()).toBeDefined();
      expect(smlService.getTypeDefinition('dashboard')).toBe(def);
      expect(smlService.listTypeDefinitions()).toContain(def);
    });
  });
});

describe('isNotFoundError', () => {
  it('returns true for ES ResponseError with statusCode 404', () => {
    const notFoundError = createNotFoundError();
    expect(isNotFoundError(notFoundError)).toBe(true);
  });

  it('returns false for ES ResponseError with other status code', () => {
    const serverError = new errors.ResponseError({
      statusCode: 500,
      body: { error: { type: 'internal_server_error' } },
      warnings: [],
      headers: {},
      meta: {} as any,
    });
    expect(isNotFoundError(serverError)).toBe(false);
  });

  it('returns false for generic Error', () => {
    expect(isNotFoundError(new Error('generic'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
    expect(isNotFoundError('string')).toBe(false);
  });
});

describe('SmlService', () => {
  let esClient: jest.Mocked<ElasticsearchClient>;
  let esqlQueryMock: jest.Mock;
  let scopedClient: IScopedClusterClient;
  let logger: ReturnType<typeof createMockLogger>;
  let request: KibanaRequest;

  beforeEach(() => {
    esClient = createMockEsClient();
    // `jest.Mocked` does not unwrap overloaded functions, so extract as jest.Mock directly.
    esqlQueryMock = (esClient as unknown as { esql: { query: jest.Mock } }).esql.query;
    scopedClient = createMockScopedClient(esClient);
    logger = createMockLogger();
    request = {} as unknown as KibanaRequest;
  });

  describe('search', () => {
    it('issues an ES|QL FORK+FUSE hybrid query with MV_CONTAINS space filter', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esqlQueryMock.mockResolvedValue({
        columns: makeEsqlColumns(),
        values: [],
      } as any);

      await smlService.search({
        query: 'foo bar',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(esqlQueryMock).toHaveBeenCalledTimes(1);
      expect(esClient.search).not.toHaveBeenCalled();
      expect(
        (scopedClient.asCurrentUser as jest.Mocked<ElasticsearchClient>).search
      ).not.toHaveBeenCalled();

      const { query: esql, params } = esqlQueryMock.mock.calls[0]![0]! as {
        query: string;
        params?: unknown[];
      };
      // Hybrid search path: FORK + FUSE present
      expect(esql).toContain('| FORK');
      expect(esql).toContain('| FUSE');
      // METADATA required for FUSE (_id, _index, _score columns)
      expect(esql).toContain('METADATA _id, _index, _score');
      // Space filter uses MV_CONTAINS (not `==`) for multi-value safety
      expect(esql).toContain('| WHERE MV_CONTAINS(spaces, ?)');
      // Two FORK branches: BM25 (OR across text fields) + semantic (OR across semantic multi-fields)
      expect(esql).toContain(
        '(WHERE MATCH(title, ?) OR MATCH(description, ?) OR MATCH(content, ?) | LIMIT 100)'
      );
      expect(esql).toContain(
        '(WHERE MATCH(title.semantic, ?) OR MATCH(description.semantic, ?) OR MATCH(content.semantic, ?) | LIMIT 100)'
      );
      // Outer overfetch limit after FUSE: size(10) × MAX_SCAN_MULTIPLIER(10)
      expect(esql).toContain('| LIMIT 100');
      // Sorted by relevance score after FUSE
      expect(esql).toContain('| SORT _score DESC');
      // spaceId is first positional param
      expect(params![0]).toBe('default');
    });

    it('uses plain sorted scan for query "*" (no FORK/FUSE)', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esqlQueryMock.mockResolvedValue({
        columns: makeEsqlColumns(),
        values: [],
      } as any);

      await smlService.search({
        query: '*',
        size: 5,
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      const { query: esql } = esqlQueryMock.mock.calls[0]![0]! as { query: string };
      expect(esql).not.toContain('FORK');
      expect(esql).not.toContain('FUSE');
      expect(esql).toContain('| SORT id ASC');
    });

    it('uses plain sorted scan for empty query after trim (no FORK/FUSE)', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esqlQueryMock.mockResolvedValue({
        columns: makeEsqlColumns(),
        values: [],
      } as any);

      await smlService.search({
        query: '',
        size: 5,
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      const { query: esql } = esqlQueryMock.mock.calls[0]![0]! as { query: string };
      expect(esql).not.toContain('FORK');
      expect(esql).toContain('| SORT id ASC');
    });

    it('threads constraints and agent filters as WHERE clauses with positional params', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esqlQueryMock.mockResolvedValue({
        columns: makeEsqlColumns(),
        values: [],
      } as any);

      await smlService.search({
        query: 'github',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
        constraints: { [SmlSearchFilterType.connector]: { ids: ['gh-1'] } },
        filters: { types: ['connector', 'dashboard'], tags: ['production'] },
      });

      const { query: esql, params } = esqlQueryMock.mock.calls[0]![0]! as {
        query: string;
        params?: unknown[];
      };

      // Constraints WHERE clause: exclude type OR allow specific origin_ids
      expect(esql).toContain('| WHERE type != ? OR origin_id IN (?)');
      // Agent type filter
      expect(esql).toContain('| WHERE type IN (?, ?)');
      // Agent tag filter with MV_CONTAINS
      expect(esql).toContain('| WHERE MV_CONTAINS(tags, ?)');

      // Positional params: [spaceId, scopeTypeId, scopeId, filterType1, filterType2, filterTag, ...queryX6]
      expect(params![0]).toBe('default'); // spaceId
      expect(params![1]).toBe('connector'); // constraints typeId
      expect(params![2]).toBe('gh-1'); // constraints id
      expect(params![3]).toBe('connector'); // filter type 1
      expect(params![4]).toBe('dashboard'); // filter type 2
      expect(params![5]).toBe('production'); // filter tag
      // query string repeated for each of the 6 MATCH branches
      expect(params!.slice(6)).toEqual(Array(6).fill('github'));
    });

    it('passes query to MATCH branches for all BM25 and semantic fields', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esqlQueryMock.mockResolvedValue({
        columns: makeEsqlColumns(),
        values: [],
      } as any);

      await smlService.search({
        query: 'how is the fleet performing this quarter',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      const { query: esql, params } = esqlQueryMock.mock.calls[0]![0]! as {
        query: string;
        params?: unknown[];
      };
      // Both FORK branches present with all six fields
      expect(esql).toContain('MATCH(title, ?)');
      expect(esql).toContain('MATCH(description, ?)');
      expect(esql).toContain('MATCH(content, ?)');
      expect(esql).toContain('MATCH(title.semantic, ?)');
      expect(esql).toContain('MATCH(description.semantic, ?)');
      expect(esql).toContain('MATCH(content.semantic, ?)');
      // Query repeated six times (once per MATCH branch), after the spaceId param
      const queryString = 'how is the fleet performing this quarter';
      expect(params!.slice(1)).toEqual(Array(6).fill(queryString));
    });

    it('returns baseline fields only when no fields param is provided', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esqlQueryMock.mockResolvedValue({
        columns: makeEsqlColumns(false),
        values: [
          makeEsqlRow('chunk-1', 'lens', 'My Viz', 'ref-1', ['saved_object:lens/get'], {
            description: 'A lens viz',
            includeContent: false,
          }),
        ],
      } as any);

      const result = await smlService.search({
        query: 'viz',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({
        id: 'chunk-1',
        type: 'lens',
        title: 'My Viz',
        origin: { uri: 'ref-1' },
        description: 'A lens viz',
      });
      expect(result.results[0]).not.toHaveProperty('content');
      expect(result.results[0]).not.toHaveProperty('tags');
      expect(result.results[0]).not.toHaveProperty('spaces');
      expect(result.results[0]).not.toHaveProperty('permissions');

      // content not in KEEP when fields is omitted
      const { query: esql } = esqlQueryMock.mock.calls[0]![0]! as { query: string };
      expect(esql).not.toMatch(/\bKEEP\b.*\bcontent\b/);
    });

    it('returns requested optional fields when fields param is provided', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esqlQueryMock.mockResolvedValue({
        columns: makeEsqlColumns(true),
        values: [
          makeEsqlRow(
            'chunk-1',
            'lens',
            'My Viz',
            'ref-1',
            ['saved_object:lens/get'],
            { description: 'A lens viz', refUris: ['lens:other:uuid'], content: 'content text' }
          ),
        ],
      } as any);

      const result = await smlService.search({
        query: 'viz',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
        fields: ['content', 'description', 'references'],
      });

      expect(result.results[0]).toEqual({
        id: 'chunk-1',
        type: 'lens',
        title: 'My Viz',
        origin: { uri: 'ref-1' },
        content: 'content text',
        description: 'A lens viz',
        references: [{ uri: 'lens:other:uuid' }],
      });
      expect(result.results[0]).not.toHaveProperty('spaces');
      expect(result.results[0]).not.toHaveProperty('permissions');
    });

    it('returns only the requested fields when fields param is provided', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esqlQueryMock.mockResolvedValue({
        columns: makeEsqlColumns(false),
        values: [
          makeEsqlRow('chunk-bare', 'connector', 'Bare', 'b1', [], {
            includeContent: false,
          }),
        ],
      } as any);

      const result = await smlService.search({
        query: '*',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
        fields: ['description'],
      });
      expect(result.results[0]).not.toHaveProperty('content');

      // Only requested optional fields appear in KEEP; content is absent
      const { query: esql } = esqlQueryMock.mock.calls[0]![0]! as { query: string };
      expect(esql).not.toMatch(/\bKEEP\b.*\bcontent\b/);
      expect(esql).toContain('description');
    });

    it('surfaces description, tags, and references on hits (compact LLM shape)', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esqlQueryMock.mockResolvedValue({
        columns: makeEsqlColumns(true),
        values: [
          makeEsqlRow(
            'chunk-2',
            'dashboard',
            'Sales Q3',
            'dash-100',
            ['saved_object:dashboard/get'],
            {
              description: 'sales summary',
              tags: ['sales', 'executive'],
              refUris: ['category://sales'],
              content: 'sales content',
            }
          ),
        ],
      } as any);

      const result = await smlService.search({
        query: 'sales',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
        fields: ['content', 'tags', 'references'],
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({
        id: 'chunk-2',
        type: 'dashboard',
        title: 'Sales Q3',
        origin: { uri: 'dash-100' },
        content: 'sales content',
        description: 'sales summary',
        tags: ['sales', 'executive'],
        references: [{ uri: 'category://sales' }],
      });
      expect(result.results[0]).not.toHaveProperty('spaces');
      expect(result.results[0]).not.toHaveProperty('permissions');
    });

    it('returns multiple results from ES|QL tabular response', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esqlQueryMock.mockResolvedValue({
        columns: makeEsqlColumns(true),
        values: [
          makeEsqlRow('chunk-1', 'lens', 'A', 'r1', [], { content: '' }),
          makeEsqlRow('chunk-2', 'lens', 'B', 'r2', [], { content: '' }),
        ],
      } as any);

      const result = await smlService.search({
        query: '*',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(result.results).toHaveLength(2);
    });

    it('returns empty results when index does not exist (404)', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esqlQueryMock.mockRejectedValue(createNotFoundError());

      const result = await smlService.search({
        query: 'foo',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(result.results).toEqual([]);
      expect(logger.debug).toHaveBeenCalledWith(
        'SML index does not exist yet — returning empty results'
      );
    });

    it('throws on non-404 errors', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esqlQueryMock.mockRejectedValue(new Error('Connection refused'));

      await expect(
        smlService.search({
          query: 'foo',
          size: 10,
          spaceId: 'default',
          esClient: scopedClient,
          request,
        })
      ).rejects.toThrow('Connection refused');

      expect(logger.warn).toHaveBeenCalledWith('SML search failed: Connection refused');
    });

    it('filters results by permissions when securityAuthz is present', async () => {
      const securityAuthz = createMockSecurityAuthzPartial(
        ['saved_object:lens/get'],
        ['saved_object:dashboard/get']
      );
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger, securityAuthz });

      esqlQueryMock.mockResolvedValue({
        columns: makeEsqlColumns(true),
        values: [
          makeEsqlRow('chunk-1', 'lens', 'Lens', 'r1', ['saved_object:lens/get'], { content: '' }),
          makeEsqlRow('chunk-2', 'dashboard', 'Dashboard', 'r2', ['saved_object:dashboard/get'], {
            content: '',
          }),
        ],
      } as any);

      const result = await smlService.search({
        query: '*',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe('chunk-1');
      expect(result.results[0].type).toBe('lens');
    });

    it('returns all results when securityAuthz is absent', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esqlQueryMock.mockResolvedValue({
        columns: makeEsqlColumns(true),
        values: [
          makeEsqlRow('chunk-1', 'lens', 'Lens', 'r1', ['saved_object:lens/get'], { content: '' }),
          makeEsqlRow('chunk-2', 'dashboard', 'Dashboard', 'r2', ['saved_object:dashboard/get'], {
            content: '',
          }),
        ],
      } as any);

      const result = await smlService.search({
        query: '*',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(result.results).toHaveLength(2);
    });

    it('uses default size of 10 when not specified (LIMIT = size × 10)', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esqlQueryMock.mockResolvedValue({
        columns: makeEsqlColumns(),
        values: [],
      } as any);

      await smlService.search({
        query: '*',
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      const { query: esql } = esqlQueryMock.mock.calls[0]![0]! as { query: string };
      // Default size 10, MAX_SCAN_MULTIPLIER 10 → LIMIT 100
      expect(esql).toContain('| LIMIT 100');
    });
  });

  describe('autocomplete', () => {
    it('builds a single nested discovery_labels query (with inner_hits) and a space filter', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esClient.search.mockResolvedValue({
        hits: { total: 0, hits: [] },
      } as any);

      await smlService.autocomplete({
        query: 'git',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(esClient.search).toHaveBeenCalledTimes(1);
      const call = esClient.search.mock.calls[0]![0]!;
      expect(call.query).toEqual({
        bool: {
          must: [
            {
              nested: {
                path: 'discovery_labels',
                query: {
                  multi_match: {
                    query: 'git',
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
                    encoder: 'html',
                    fields: {
                      'discovery_labels.value': {},
                    },
                  },
                },
              },
            },
          ],
          filter: [
            {
              bool: {
                should: [{ term: { spaces: 'default' } }, { term: { spaces: '*' } }],
                minimum_should_match: 1,
              },
            },
          ],
        },
      });
      expect(call._source).toEqual(['id', 'type', 'title', 'origin', 'spaces', 'permissions']);
    });

    it('uses match_all for query "*"', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esClient.search.mockResolvedValue({ hits: { total: 0, hits: [] } } as any);

      await smlService.autocomplete({
        query: '*',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      const call = esClient.search.mock.calls[0]![0]!;
      expect(call.query!.bool!.must).toEqual([{ match_all: {} }]);
    });

    it('threads per-type constraints through buildConstraintsFilter into the ES filter clauses', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esClient.search.mockResolvedValue({ hits: { total: 0, hits: [] } } as any);

      await smlService.autocomplete({
        query: 'git',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
        constraints: { [SmlSearchFilterType.connector]: { ids: ['gh-1', 'jira-1'] } },
      });

      const call = esClient.search.mock.calls[0]![0]!;
      const filterClauses = call.query!.bool!.filter as Array<Record<string, unknown>>;
      // First clause is the space filter; second is the constraints filter.
      expect(filterClauses).toHaveLength(2);
      expect(filterClauses[1]).toEqual({
        bool: {
          should: [
            {
              bool: {
                must: [
                  { term: { type: 'connector' } },
                  { terms: { origin_id: ['gh-1', 'jira-1'] } },
                ],
              },
            },
            { bool: { must_not: [{ term: { type: 'connector' } }] } },
          ],
          minimum_should_match: 1,
        },
      });
    });

    it('maps inner_hits onto matched_discovery_labels', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esClient.search.mockResolvedValue({
        hits: {
          total: 1,
          hits: [
            {
              _source: {
                id: 'chunk-1',
                type: 'connector',
                title: 'GitHub Connector',
                origin: { uri: 'gh-1' },
                spaces: ['default'],
                permissions: [],
              },
              _score: 5.4,
              inner_hits: {
                discovery_labels: {
                  hits: {
                    total: { value: 2, relation: 'eq' },
                    hits: [
                      {
                        _nested: { field: 'discovery_labels', offset: 0 },
                        _score: 5.4,
                        _source: { value: 'GitHub Connector', kind: 'title' },
                        highlight: {
                          'discovery_labels.value': ['<em>GitHub</em> Connector'],
                        },
                      },
                      {
                        _nested: { field: 'discovery_labels', offset: 2 },
                        _score: 4.1,
                        _source: { value: 'github', kind: 'tagline' },
                        highlight: {
                          'discovery_labels.value': ['<em>github</em>'],
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      } as any);

      const result = await smlService.autocomplete({
        query: 'git',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({
        id: 'chunk-1',
        type: 'connector',
        title: 'GitHub Connector',
        origin: { uri: 'gh-1' },
        spaces: ['default'],
        permissions: [],
        matched_discovery_labels: [
          {
            value: 'GitHub Connector',
            kind: 'title',
            highlighted: '<em>GitHub</em> Connector',
          },
          { value: 'github', kind: 'tagline', highlighted: '<em>github</em>' },
        ],
      });
    });

    it('omits matched_discovery_labels when absent', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esClient.search.mockResolvedValue({
        hits: {
          total: 1,
          hits: [
            {
              _source: {
                id: 'chunk-2',
                type: 'dashboard',
                title: 'Sales Q3',
                origin: { uri: 'dash-1' },
                spaces: ['default'],
                permissions: [],
              },
              _score: 2.0,
            },
          ],
        },
      } as any);

      const result = await smlService.autocomplete({
        query: 'sal',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(result.results[0]).toEqual({
        id: 'chunk-2',
        type: 'dashboard',
        title: 'Sales Q3',
        origin: { uri: 'dash-1' },
        spaces: ['default'],
        permissions: [],
      });
    });

    it('returns empty results when the index does not exist (404)', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esClient.search.mockRejectedValue(createNotFoundError());

      const result = await smlService.autocomplete({
        query: 'git',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(result).toEqual({ results: [] });
    });

    it('applies permission filtering when securityAuthz is present', async () => {
      const securityAuthz = createMockSecurityAuthzPartial(
        ['saved_object:dashboard/get'],
        ['saved_object:connector/get']
      );
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger, securityAuthz });

      esClient.search.mockResolvedValue({
        hits: {
          total: 2,
          hits: [
            {
              _source: {
                id: 'chunk-allowed',
                type: 'dashboard',
                title: 'Allowed',
                origin: { uri: 'd1' },
                spaces: ['default'],
                permissions: ['saved_object:dashboard/get'],
              },
              _score: 3,
            },
            {
              _source: {
                id: 'chunk-denied',
                type: 'connector',
                title: 'Denied',
                origin: { uri: 'c1' },
                spaces: ['default'],
                permissions: ['saved_object:connector/get'],
              },
              _score: 2,
            },
          ],
        },
      } as any);

      const result = await smlService.autocomplete({
        query: 'a',
        size: 10,
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe('chunk-allowed');
    });
  });

  describe('checkItemsAccess', () => {
    it('grants all access when securityAuthz is absent', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      const result = await smlService.checkItemsAccess({
        ids: ['item-1', 'item-2'],
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(result.get('item-1')).toBe(true);
      expect(result.get('item-2')).toBe(true);
      expect(esClient.search).not.toHaveBeenCalled();
    });

    it('denies access when items not found in index', async () => {
      const securityAuthz = createMockSecurityAuthz(['saved_object:lens/get']);
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger, securityAuthz });

      esClient.search.mockResolvedValue({
        hits: {
          total: 0,
          hits: [],
        },
      } as any);

      const result = await smlService.checkItemsAccess({
        ids: ['missing-item'],
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(result.get('missing-item')).toBe(false);
    });

    it('checks permissions correctly for authorized items', async () => {
      const securityAuthz = createMockSecurityAuthz(['saved_object:lens/get']);
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger, securityAuthz });

      esClient.search.mockResolvedValue({
        hits: {
          total: 1,
          hits: [
            {
              _source: {
                id: 'item-1',
                permissions: ['saved_object:lens/get'],
              },
            },
          ],
        },
      } as any);

      const result = await smlService.checkItemsAccess({
        ids: ['item-1'],
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(result.get('item-1')).toBe(true);
    });

    it('checks permissions correctly for unauthorized items', async () => {
      const securityAuthz = createMockSecurityAuthzPartial([], ['saved_object:dashboard/get']);
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger, securityAuthz });

      esClient.search.mockResolvedValue({
        hits: {
          total: 1,
          hits: [
            {
              _source: {
                id: 'item-1',
                permissions: ['saved_object:dashboard/get'],
              },
            },
          ],
        },
      } as any);

      const result = await smlService.checkItemsAccess({
        ids: ['item-1'],
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(result.get('item-1')).toBe(false);
    });

    it('grants access for items with empty permissions', async () => {
      const securityAuthz = createMockSecurityAuthz([]);
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger, securityAuthz });

      esClient.search.mockResolvedValue({
        hits: {
          total: 1,
          hits: [
            {
              _source: {
                id: 'item-1',
                permissions: [],
              },
            },
          ],
        },
      } as any);

      const result = await smlService.checkItemsAccess({
        ids: ['item-1'],
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(result.get('item-1')).toBe(true);
    });

    it('handles 404 error by returning false for all items', async () => {
      const securityAuthz = createMockSecurityAuthz(['saved_object:lens/get']);
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger, securityAuthz });

      esClient.search.mockRejectedValue(createNotFoundError());

      const result = await smlService.checkItemsAccess({
        ids: ['item-1', 'item-2'],
        spaceId: 'default',
        esClient: scopedClient,
        request,
      });

      expect(result.get('item-1')).toBe(false);
      expect(result.get('item-2')).toBe(false);
    });

    it('calls ES search with correct query for checkItemsAccess', async () => {
      const securityAuthz = createMockSecurityAuthz([]);
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger, securityAuthz });

      esClient.search.mockResolvedValue({
        hits: { total: 0, hits: [] },
      } as any);

      await smlService.checkItemsAccess({
        ids: ['id-1'],
        spaceId: 'my-space',
        esClient: scopedClient,
        request,
      });

      expect(esClient.search).toHaveBeenCalledWith(
        expect.objectContaining({
          index: smlIndexName,
          size: 1,
          allow_no_indices: true,
          ignore_unavailable: true,
          query: {
            bool: {
              filter: [
                { terms: { id: ['id-1'] } },
                {
                  bool: {
                    should: [{ term: { spaces: 'my-space' } }, { term: { spaces: '*' } }],
                    minimum_should_match: 1,
                  },
                },
              ],
            },
          },
          _source: ['id', 'permissions'],
        })
      );
      expect(
        (scopedClient.asCurrentUser as jest.Mocked<ElasticsearchClient>).search
      ).not.toHaveBeenCalled();
    });
  });

  describe('getDocuments', () => {
    it('fetches documents from ES and returns Map', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esClient.search.mockResolvedValue({
        hits: {
          total: 2,
          hits: [
            {
              _source: {
                id: 'doc-1',
                type: 'lens',
                title: 'Doc 1',
                origin_id: 'ref-1',
                origin: { uri: 'ref-1' },
                content: 'content 1',
                created_at: '2024-01-01',
                updated_at: '2024-01-02',
                spaces: ['default'],
                permissions: [],
              },
            },
            {
              _source: {
                id: 'doc-2',
                type: 'dashboard',
                title: 'Doc 2',
                origin_id: 'ref-2',
                origin: { uri: 'ref-2' },
                content: 'content 2',
                description: 'dash desc',
                user_id: 'u2',
                references: [{ uri: 'lens:x:y' }],
                created_at: '2024-01-01',
                updated_at: '2024-01-02',
                spaces: ['default'],
                permissions: [],
              },
            },
          ],
        },
      } as any);

      const result = await smlService.getDocuments({
        ids: ['doc-1', 'doc-2'],
        spaceId: 'default',
        esClient: scopedClient,
      });

      expect(result.size).toBe(2);
      expect(result.get('doc-1')).toEqual({
        id: 'doc-1',
        type: 'lens',
        title: 'Doc 1',
        origin_id: 'ref-1',
        origin: { uri: 'ref-1' },
        content: 'content 1',
        created_at: '2024-01-01',
        updated_at: '2024-01-02',
        spaces: ['default'],
        permissions: [],
      });
      expect(result.get('doc-2')).toEqual({
        id: 'doc-2',
        type: 'dashboard',
        title: 'Doc 2',
        origin_id: 'ref-2',
        origin: { uri: 'ref-2' },
        content: 'content 2',
        description: 'dash desc',
        user_id: 'u2',
        references: [{ uri: 'lens:x:y' }],
        created_at: '2024-01-01',
        updated_at: '2024-01-02',
        spaces: ['default'],
        permissions: [],
      });
    });

    it('round-trips all new schema fields (origin, tags, discovery_labels, extended_attrs)', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esClient.search.mockResolvedValue({
        hits: {
          total: 1,
          hits: [
            {
              _source: {
                id: 'doc-3',
                type: 'dashboard',
                title: 'Sales Q3',
                origin_id: 'dash-100',
                origin: { uri: 'dash-100' },
                content: 'sales content',
                description: 'sales summary',
                tags: ['sales', 'executive'],
                discovery_labels: [{ value: 'q3 sales', kind: 'tagline' }],
                extended_attrs: { owner_team: 'sales-ops' },
                user_id: 'user-7',
                references: [{ uri: 'category://sales' }],
                created_at: '2026-04-01T00:00:00.000Z',
                updated_at: '2026-04-02T00:00:00.000Z',
                spaces: ['default'],
                permissions: ['saved_object:dashboard/get'],
              },
            },
          ],
        },
      } as any);

      const result = await smlService.getDocuments({
        ids: ['doc-3'],
        spaceId: 'default',
        esClient: scopedClient,
      });

      expect(result.get('doc-3')).toEqual({
        id: 'doc-3',
        type: 'dashboard',
        title: 'Sales Q3',
        origin_id: 'dash-100',
        origin: { uri: 'dash-100' },
        content: 'sales content',
        description: 'sales summary',
        tags: ['sales', 'executive'],
        discovery_labels: [{ value: 'q3 sales', kind: 'tagline' }],
        extended_attrs: { owner_team: 'sales-ops' },
        user_id: 'user-7',
        references: [{ uri: 'category://sales' }],
        created_at: '2026-04-01T00:00:00.000Z',
        updated_at: '2026-04-02T00:00:00.000Z',
        spaces: ['default'],
        permissions: ['saved_object:dashboard/get'],
      });
    });

    it('returns empty map for empty ids', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      const result = await smlService.getDocuments({
        ids: [],
        spaceId: 'default',
        esClient: scopedClient,
      });

      expect(result.size).toBe(0);
      expect(esClient.search).not.toHaveBeenCalled();
    });

    it('handles 404 error gracefully', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esClient.search.mockRejectedValue(createNotFoundError());

      const result = await smlService.getDocuments({
        ids: ['doc-1'],
        spaceId: 'default',
        esClient: scopedClient,
      });

      expect(result.size).toBe(0);
    });

    it('handles other errors gracefully', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esClient.search.mockRejectedValue(new Error('Connection timeout'));

      const result = await smlService.getDocuments({
        ids: ['doc-1'],
        spaceId: 'default',
        esClient: scopedClient,
      });

      expect(result.size).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith('SML getDocuments failed: Connection timeout');
    });

    it('calls ES search with correct query', async () => {
      const service = createSmlService();
      service.setup({ logger });
      const smlService = service.start({ logger });

      esClient.search.mockResolvedValue({
        hits: { total: 0, hits: [] },
      } as any);

      await smlService.getDocuments({
        ids: ['id-1', 'id-2'],
        spaceId: 'my-space',
        esClient: scopedClient,
      });

      expect(esClient.search).toHaveBeenCalledWith(
        expect.objectContaining({
          index: smlIndexName,
          size: 2,
          allow_no_indices: true,
          ignore_unavailable: true,
          query: {
            bool: {
              filter: [
                { terms: { id: ['id-1', 'id-2'] } },
                {
                  bool: {
                    should: [{ term: { spaces: 'my-space' } }, { term: { spaces: '*' } }],
                    minimum_should_match: 1,
                  },
                },
              ],
            },
          },
        })
      );
      expect(
        (scopedClient.asCurrentUser as jest.Mocked<ElasticsearchClient>).search
      ).not.toHaveBeenCalled();
    });
  });
});
