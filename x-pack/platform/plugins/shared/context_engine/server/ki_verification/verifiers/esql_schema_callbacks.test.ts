/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { estypes } from '@elastic/elasticsearch';
import { elasticsearchServiceMock } from '@kbn/core/server/mocks';
import { createEsqlSchemaCallbacks } from './esql_schema_callbacks';

const mappingResponse = (
  mappings: Record<string, estypes.MappingTypeMapping>
): estypes.IndicesGetMappingResponse =>
  Object.fromEntries(
    Object.entries(mappings).map(([index, mapping]) => [index, { mappings: mapping }])
  );

describe('createEsqlSchemaCallbacks', () => {
  it('retrieves canonical ES|QL columns without mapping field-capability types', async () => {
    const esClient = elasticsearchServiceMock.createElasticsearchClient();
    esClient.fieldCaps.mockResolvedValue({ indices: ['logs-2026'], fields: {} });
    esClient.esql.query.mockResolvedValue({
      columns: [
        { name: 'count', type: 'integer' },
        { name: 'ratio', type: 'double' },
        { name: 'category', type: 'keyword' },
      ],
      values: [],
    });
    const abortSignal = new AbortController().signal;
    const { callbacks } = createEsqlSchemaCallbacks({ esClient, abortSignal });

    await expect(callbacks.getColumnsFor?.({ query: 'FROM logs-*' })).resolves.toEqual([
      { name: 'count', type: 'integer', userDefined: false, hasConflict: false },
      { name: 'ratio', type: 'double', userDefined: false, hasConflict: false },
      { name: 'category', type: 'keyword', userDefined: false, hasConflict: false },
    ]);
    expect(esClient.fieldCaps).toHaveBeenCalledWith(
      {
        index: 'logs-*',
        fields: ['_none_'],
        allow_no_indices: false,
        ignore_unavailable: false,
      },
      { signal: abortSignal }
    );
    expect(esClient.esql.query).toHaveBeenCalledWith(
      { query: 'FROM logs-* | LIMIT 0', format: 'json' },
      { signal: abortSignal }
    );
  });

  it('returns no columns when the callback receives no query', async () => {
    const esClient = elasticsearchServiceMock.createElasticsearchClient();
    const { callbacks } = createEsqlSchemaCallbacks({ esClient });

    await expect(callbacks.getColumnsFor?.()).resolves.toEqual([]);
    expect(esClient.fieldCaps).not.toHaveBeenCalled();
    expect(esClient.esql.query).not.toHaveBeenCalled();
  });

  it('propagates strict source-existence failures without requesting columns', async () => {
    const esClient = elasticsearchServiceMock.createElasticsearchClient();
    const error = new Error('no such index [missing-*]');
    esClient.fieldCaps.mockRejectedValue(error);
    const { callbacks } = createEsqlSchemaCallbacks({ esClient });

    await expect(callbacks.getColumnsFor?.({ query: 'FROM missing-*' })).rejects.toBe(error);
    expect(esClient.esql.query).not.toHaveBeenCalled();
  });

  it('deduplicates source-existence checks within one verification', async () => {
    const esClient = elasticsearchServiceMock.createElasticsearchClient();
    esClient.fieldCaps.mockResolvedValue({ indices: ['logs-2026'], fields: {} });
    esClient.esql.query.mockResolvedValue({ columns: [], values: [] });
    const { callbacks } = createEsqlSchemaCallbacks({ esClient });

    await callbacks.getColumnsFor?.({ query: 'FROM logs-*' });
    await callbacks.getColumnsFor?.({ query: 'FROM logs-* | KEEP message' });

    expect(esClient.fieldCaps).toHaveBeenCalledTimes(1);
    expect(esClient.esql.query).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an omitted root dynamic value', {}, true],
    ['root dynamic true', { dynamic: true }, true],
    ['root dynamic runtime', { dynamic: 'runtime' as const }, true],
    ['root dynamic false', { dynamic: false }, false],
    ['root dynamic strict', { dynamic: 'strict' as const }, false],
  ])('%s determines future-field eligibility', async (_description, mapping, eligible) => {
    const esClient = elasticsearchServiceMock.createElasticsearchClient();
    esClient.fieldCaps.mockResolvedValue({ indices: ['logs-2026'], fields: {} });
    esClient.indices.getMapping.mockResolvedValue(mappingResponse({ 'logs-2026': mapping }));
    const { callbacks } = createEsqlSchemaCallbacks({ esClient });

    const result = await callbacks.getFutureFieldsFor?.({
      query: 'FROM logs-*',
      fieldNames: ['future'],
    });

    expect(result).toEqual(
      eligible
        ? [{ name: 'future', state: 'eligible', hasMappedAncestor: false }]
        : [{ name: 'future', state: 'blocked', hasMappedAncestor: false }]
    );
  });

  it('inherits and overrides dynamic values along object paths', async () => {
    const esClient = elasticsearchServiceMock.createElasticsearchClient();
    esClient.fieldCaps.mockResolvedValue({ indices: ['logs-2026'], fields: {} });
    esClient.indices.getMapping.mockResolvedValue(
      mappingResponse({
        'logs-2026': {
          dynamic: false,
          properties: {
            inherited: {
              type: 'object',
              properties: { child: { type: 'object' } },
            },
            overridden: {
              type: 'object',
              dynamic: true,
              properties: { child: { type: 'object' } },
            },
          },
        },
      })
    );
    const { callbacks } = createEsqlSchemaCallbacks({ esClient });

    await expect(
      callbacks.getFutureFieldsFor?.({
        query: 'FROM logs-*',
        fieldNames: ['inherited.child.future', 'overridden.child.future'],
      })
    ).resolves.toEqual([
      {
        name: 'inherited.child.future',
        state: 'blocked',
        hasMappedAncestor: true,
      },
      {
        name: 'overridden.child.future',
        state: 'eligible',
        hasMappedAncestor: true,
      },
    ]);
  });

  it.each([
    ['a scalar', { type: 'keyword' as const }],
    ['an object with parsing disabled', { type: 'object' as const, enabled: false }],
    ['a flattened field', { type: 'flattened' as const }],
    ['a passthrough object', { type: 'passthrough' as const }],
  ])('blocks a future child beneath %s', async (_description, parent) => {
    const esClient = elasticsearchServiceMock.createElasticsearchClient();
    esClient.fieldCaps.mockResolvedValue({ indices: ['logs-2026'], fields: {} });
    esClient.indices.getMapping.mockResolvedValue(
      mappingResponse({
        'logs-2026': { dynamic: true, properties: { parent } },
      })
    );
    const { callbacks } = createEsqlSchemaCallbacks({ esClient });

    await expect(
      callbacks.getFutureFieldsFor?.({
        query: 'FROM logs-*',
        fieldNames: ['parent.future'],
      })
    ).resolves.toEqual([{ name: 'parent.future', state: 'blocked', hasMappedAncestor: true }]);
  });

  it('allows a field when any matched concrete index permits dynamic creation', async () => {
    const esClient = elasticsearchServiceMock.createElasticsearchClient();
    esClient.fieldCaps.mockResolvedValue({
      indices: ['logs-strict', 'logs-dynamic'],
      fields: {},
    });
    esClient.indices.getMapping.mockResolvedValue(
      mappingResponse({
        'logs-strict': { dynamic: 'strict' },
        'logs-dynamic': { dynamic: true },
      })
    );
    const { callbacks } = createEsqlSchemaCallbacks({ esClient });

    await expect(
      callbacks.getFutureFieldsFor?.({ query: 'FROM logs-*', fieldNames: ['future'] })
    ).resolves.toHaveLength(1);
    expect(esClient.indices.getMapping).toHaveBeenCalledWith(
      {
        index: ['logs-strict', 'logs-dynamic'],
        allow_no_indices: false,
        ignore_unavailable: false,
      },
      { signal: undefined }
    );
  });

  it('rejects a field when no matched concrete index permits dynamic creation', async () => {
    const esClient = elasticsearchServiceMock.createElasticsearchClient();
    esClient.fieldCaps.mockResolvedValue({
      indices: ['logs-strict', 'logs-disabled'],
      fields: {},
    });
    esClient.indices.getMapping.mockResolvedValue(
      mappingResponse({
        'logs-strict': { dynamic: 'strict' },
        'logs-disabled': { dynamic: false },
      })
    );
    const { callbacks } = createEsqlSchemaCallbacks({ esClient });

    await expect(
      callbacks.getFutureFieldsFor?.({ query: 'FROM logs-*', fieldNames: ['future'] })
    ).resolves.toEqual([{ name: 'future', state: 'blocked', hasMappedAncestor: false }]);
  });

  it('does not treat a field mapped in one index as future because another index is dynamic', async () => {
    const esClient = elasticsearchServiceMock.createElasticsearchClient();
    esClient.fieldCaps.mockResolvedValue({
      indices: ['logs-mapped', 'logs-dynamic'],
      fields: {},
    });
    esClient.indices.getMapping.mockResolvedValue(
      mappingResponse({
        'logs-mapped': { dynamic: false, properties: { future: { type: 'keyword' } } },
        'logs-dynamic': { dynamic: true },
      })
    );
    const { callbacks } = createEsqlSchemaCallbacks({ esClient });

    await expect(
      callbacks.getFutureFieldsFor?.({ query: 'FROM logs-*', fieldNames: ['future'] })
    ).resolves.toEqual([{ name: 'future', state: 'mapped', hasMappedAncestor: true }]);
  });

  it('deduplicates mapping requests within one verification and forwards cancellation', async () => {
    const esClient = elasticsearchServiceMock.createElasticsearchClient();
    esClient.fieldCaps.mockResolvedValue({ indices: ['logs-2026'], fields: {} });
    esClient.indices.getMapping.mockResolvedValue(
      mappingResponse({ 'logs-2026': { dynamic: true } })
    );
    const abortSignal = new AbortController().signal;
    const { callbacks } = createEsqlSchemaCallbacks({ esClient, abortSignal });

    await callbacks.getFutureFieldsFor?.({ query: 'FROM logs-*', fieldNames: ['first'] });
    await callbacks.getFutureFieldsFor?.({ query: 'FROM logs-*', fieldNames: ['second'] });

    expect(esClient.indices.getMapping).toHaveBeenCalledTimes(1);
    expect(esClient.indices.getMapping).toHaveBeenCalledWith(expect.anything(), {
      signal: abortSignal,
    });
  });

  it('does not share mapping requests across verifications', async () => {
    const esClient = elasticsearchServiceMock.createElasticsearchClient();
    esClient.fieldCaps.mockResolvedValue({ indices: ['logs-2026'], fields: {} });
    esClient.indices.getMapping.mockResolvedValue(
      mappingResponse({ 'logs-2026': { dynamic: true } })
    );

    for (let verification = 0; verification < 2; verification++) {
      const { callbacks } = createEsqlSchemaCallbacks({ esClient });
      await callbacks.getFutureFieldsFor?.({ query: 'FROM logs-*', fieldNames: ['future'] });
    }

    expect(esClient.indices.getMapping).toHaveBeenCalledTimes(2);
  });

  it('propagates mapping retrieval failures', async () => {
    const esClient = elasticsearchServiceMock.createElasticsearchClient();
    const error = new Error('mapping request failed');
    esClient.fieldCaps.mockResolvedValue({ indices: ['logs-2026'], fields: {} });
    esClient.indices.getMapping.mockRejectedValue(error);
    const { callbacks } = createEsqlSchemaCallbacks({ esClient });

    await expect(
      callbacks.getFutureFieldsFor?.({ query: 'FROM logs-*', fieldNames: ['future'] })
    ).rejects.toBe(error);
  });
});
