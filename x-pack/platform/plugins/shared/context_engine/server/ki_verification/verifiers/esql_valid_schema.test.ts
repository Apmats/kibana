/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { errors, type estypes } from '@elastic/elasticsearch';
import { elasticsearchServiceMock, loggingSystemMock } from '@kbn/core/server/mocks';
import { elasticsearchClientMock } from '@kbn/core-elasticsearch-client-server-mocks';
import { createEsqlValidSchemaVerifier, ESQL_VALID_SCHEMA_VERIFIER_ID } from './esql_valid_schema';
import type { KiVerifierContext, KnowledgeIndicator } from '../types';

const makeKi = (esql: unknown): KnowledgeIndicator => ({
  type: 'detection',
  attributes: { esql },
});

const createFieldCapsResponse = (fields: Record<string, string>): estypes.FieldCapsResponse => ({
  indices: ['logs-000001'],
  fields: Object.fromEntries(
    Object.entries(fields).map(([name, type]) => [
      name,
      {
        [type]: {
          type,
          searchable: true,
          aggregatable: true,
        },
      },
    ])
  ),
});

const createPolicyResponse = (
  enrichFields: string[],
  type: 'match' | 'range' | 'geo_match' = 'match'
): estypes.EnrichGetPolicyResponse => ({
  policies: [
    {
      config: {
        [type]: {
          name: 'geo_policy',
          indices: ['geo-index'],
          match_field: 'client.ip',
          enrich_fields: enrichFields,
        },
      },
    },
  ],
});

const esResponseError = (type: string, reason: string, statusCode = 404) =>
  new errors.ResponseError(
    elasticsearchClientMock.createApiResponse({ statusCode, body: { error: { type, reason } } })
  );

describe('esql-valid-schema verifier', () => {
  const verifier = createEsqlValidSchemaVerifier();
  let esClient: ReturnType<typeof elasticsearchServiceMock.createElasticsearchClient>;
  let context: KiVerifierContext;

  beforeEach(() => {
    esClient = elasticsearchServiceMock.createElasticsearchClient();
    esClient.fieldCaps.mockResolvedValue(
      createFieldCapsResponse({
        'event.outcome': 'keyword',
        source: 'long',
        foo: 'long',
        'client.ip': 'ip',
        message: 'text',
        'geo.city': 'keyword',
        department: 'keyword',
      })
    );
    esClient.enrich.getPolicy.mockResolvedValue(createPolicyResponse(['geo.city', 'department']));
    context = { esClient, logger: loggingSystemMock.createLogger() };
  });

  it('has the expected id and applies to configured ES|QL', () => {
    expect(verifier.id).toBe(ESQL_VALID_SCHEMA_VERIFIER_ID);
    expect(verifier.applies(makeKi('FROM logs-*'), context)).toBe(true);
    expect(verifier.applies({ attributes: {} }, context)).toBe(false);
  });

  it('reports static validation errors returned by validateQuery', async () => {
    const outcome = await verifier.verify(
      makeKi('FROM logs-* | EVAL result = NOT_A_FUNCTION(1)'),
      context
    );

    expect(outcome).toEqual({
      passed: false,
      reason: expect.stringContaining('NOT_A_FUNCTION'),
    });
  });

  it('uses field_caps metadata without executing the query', async () => {
    await expect(
      verifier.verify(makeKi('FROM logs-* | WHERE event.outcome == "failure" | LIMIT 10'), context)
    ).resolves.toEqual({ passed: true });

    expect(esClient.fieldCaps).toHaveBeenCalledWith(
      {
        index: 'logs-*',
        fields: '*',
        allow_no_indices: false,
        ignore_unavailable: false,
      },
      { signal: undefined }
    );
    expect(esClient.esql.query).not.toHaveBeenCalled();
  });

  it('preserves selectors and cross-cluster source expressions', async () => {
    await verifier.verify(makeKi('FROM logs-*::data,remote-cluster:metrics-* | LIMIT 1'), context);

    expect(esClient.fieldCaps).toHaveBeenCalledWith(
      expect.objectContaining({ index: 'logs-*::data,remote-cluster:metrics-*' }),
      expect.anything()
    );
  });

  it('reports missing concrete and wildcard indices', async () => {
    esClient.fieldCaps.mockRejectedValue(
      esResponseError('index_not_found_exception', 'no such index [missing-*]')
    );

    const outcome = await verifier.verify(makeKi('FROM missing-* | LIMIT 1'), context);

    expect(outcome).toEqual({
      passed: false,
      reason: expect.stringContaining('no such index [missing-*]'),
    });
  });

  it('propagates authorization, throttling, and server failures', async () => {
    for (const statusCode of [403, 429, 500]) {
      esClient.fieldCaps.mockRejectedValueOnce(
        esResponseError('security_exception', `status ${statusCode}`, statusCode)
      );

      await expect(verifier.verify(makeKi('FROM logs-*'), context)).rejects.toBeInstanceOf(
        errors.ResponseError
      );
    }
  });

  it('propagates transport errors and cancellation', async () => {
    esClient.fieldCaps.mockRejectedValueOnce(new errors.ConnectionError('socket hang up'));
    await expect(verifier.verify(makeKi('FROM logs-*'), context)).rejects.toThrow('socket hang up');

    const abortController = new AbortController();
    abortController.abort();
    await expect(
      verifier.verify(makeKi('FROM logs-*'), {
        ...context,
        abortSignal: abortController.signal,
      })
    ).rejects.toThrow('Aborted');
  });

  it('reports a source field used before a later overwrite', async () => {
    esClient.fieldCaps.mockResolvedValue(createFieldCapsResponse({}));

    const outcome = await verifier.verify(
      makeKi('FROM logs-* | WHERE missing > 0 | EVAL missing = 1'),
      context
    );

    expect(outcome).toEqual({
      passed: false,
      reason: expect.stringContaining('missing'),
    });
  });

  it('requires the source of a self-overwriting assignment', async () => {
    esClient.fieldCaps.mockResolvedValue(createFieldCapsResponse({}));

    const outcome = await verifier.verify(makeKi('FROM logs-* | EVAL foo = foo + 1'), context);

    expect(outcome).toEqual({
      passed: false,
      reason: expect.stringContaining('foo'),
    });
  });

  it.each([
    'FROM logs-* | EVAL derived = source | WHERE derived > 0',
    'FROM logs-* | RENAME source AS renamed | WHERE renamed > 0',
    'FROM logs-* | STATS total = SUM(source) | WHERE total > 0',
    'FROM logs-* | DISSECT message "%{parsed_first} %{parsed_second}" | WHERE parsed_first == "ok"',
    'FROM logs-* | GROK message "%{WORD:parsed_first}" | WHERE parsed_first == "ok"',
    'FROM logs-* METADATA _id | WHERE _id IS NOT NULL',
  ])('accepts pipeline-generated fields: %s', async (query) => {
    await expect(verifier.verify(makeKi(query), context)).resolves.toEqual({ passed: true });
  });

  it('makes lookup-join fields available downstream', async () => {
    esClient.fieldCaps.mockImplementation(async (request) =>
      createFieldCapsResponse(
        request?.index === 'lookup_index' ? { source: 'long', joined: 'long' } : { source: 'long' }
      )
    );

    const outcome = await verifier.verify(
      makeKi('FROM logs-* | LOOKUP JOIN lookup_index ON source | WHERE joined > 0'),
      context
    );

    expect(outcome).toEqual({ passed: true });
  });

  it('reports a missing lookup-join index as an invalid KI schema', async () => {
    esClient.fieldCaps
      .mockResolvedValueOnce(createFieldCapsResponse({ source: 'long' }))
      .mockRejectedValueOnce(
        esResponseError('index_not_found_exception', 'no such index [lookup_index]')
      );

    const outcome = await verifier.verify(
      makeKi('FROM logs-* | LOOKUP JOIN lookup_index ON source'),
      context
    );

    expect(outcome).toEqual({
      passed: false,
      reason: expect.stringContaining('no such index [lookup_index]'),
    });
    if (!outcome.passed) {
      expect(outcome.reason).toContain('references indices that do not exist');
    }
  });

  it('propagates infrastructure failures raised while validating a lookup join', async () => {
    esClient.fieldCaps
      .mockResolvedValueOnce(createFieldCapsResponse({ source: 'long' }))
      .mockRejectedValueOnce(esResponseError('too_many_requests', 'busy', 429));

    await expect(
      verifier.verify(makeKi('FROM logs-* | LOOKUP JOIN lookup_index ON source'), context)
    ).rejects.toBeInstanceOf(errors.ResponseError);
  });

  it('does not accept an unknown dotted field because its object prefix exists', async () => {
    esClient.fieldCaps.mockResolvedValue(createFieldCapsResponse({ event: 'object' }));

    const outcome = await verifier.verify(
      makeKi('FROM logs-* | WHERE event.outcome == "failure"'),
      context
    );

    expect(outcome).toEqual({
      passed: false,
      reason: expect.stringContaining('event.outcome'),
    });
  });

  it.each(['match', 'range', 'geo_match'] as const)(
    'normalizes %s enrich policies and makes WITH aliases available downstream',
    async (type) => {
      esClient.enrich.getPolicy.mockResolvedValue(
        createPolicyResponse(['geo.city', 'department'], type)
      );

      const outcome = await verifier.verify(
        makeKi(
          'FROM logs-* | ENRICH geo_policy ON client.ip WITH city = geo.city, department | WHERE city IS NOT NULL'
        ),
        context
      );

      expect(outcome).toEqual({ passed: true });
    }
  );

  it('makes all enrich fields available downstream when WITH is omitted', async () => {
    const outcome = await verifier.verify(
      makeKi('FROM logs-* | ENRICH geo_policy ON client.ip | WHERE department == "engineering"'),
      context
    );

    expect(outcome).toEqual({ passed: true });
  });

  it('reports missing policies and explicit enrich fields', async () => {
    esClient.enrich.getPolicy.mockResolvedValue({ policies: [] });
    const missingPolicy = await verifier.verify(
      makeKi('FROM logs-* | ENRICH missing_policy ON client.ip'),
      context
    );
    expect(missingPolicy).toEqual({
      passed: false,
      reason: expect.stringContaining('missing_policy'),
    });

    esClient.enrich.getPolicy.mockResolvedValue(createPolicyResponse(['geo.city']));
    const missingField = await verifier.verify(
      makeKi('FROM logs-* | ENRICH geo_policy ON client.ip WITH department'),
      context
    );
    expect(missingField).toEqual({
      passed: false,
      reason: expect.stringContaining('department'),
    });
  });

  it('retrieves policies once and reuses source metadata within one verification', async () => {
    const query = 'FROM logs-* | ENRICH geo_policy ON client.ip WITH department';

    await verifier.verify(makeKi([query, query]), context);

    expect(esClient.enrich.getPolicy).toHaveBeenCalledTimes(1);
    expect(esClient.fieldCaps).toHaveBeenCalledTimes(1);
  });

  it('disables field and enrich checks while still checking index existence', async () => {
    esClient.fieldCaps.mockResolvedValue(createFieldCapsResponse({}));

    const outcome = await verifier.verify(
      makeKi('FROM logs-* | WHERE missing > 0 | ENRICH missing_policy ON missing'),
      {
        ...context,
        options: { 'esql-valid-schema': { field_verification: 'disabled' } },
      }
    );

    expect(outcome).toEqual({ passed: true });
    expect(esClient.fieldCaps).toHaveBeenCalledTimes(1);
    expect(esClient.enrich.getPolicy).not.toHaveBeenCalled();
  });

  it('forwards abort signals to metadata requests', async () => {
    const abortSignal = new AbortController().signal;

    await verifier.verify(makeKi('FROM logs-* | ENRICH geo_policy ON client.ip WITH department'), {
      ...context,
      abortSignal,
    });

    expect(esClient.fieldCaps).toHaveBeenCalledWith(expect.anything(), { signal: abortSignal });
    expect(esClient.enrich.getPolicy).toHaveBeenCalledWith({}, { signal: abortSignal });
  });

  it('enforces extraction, query count, and query length limits before metadata retrieval', async () => {
    for (const value of [42, '', [], Array.from({ length: 101 }, () => 'FROM logs-*')]) {
      const outcome = await verifier.verify(makeKi(value), context);
      expect(outcome.passed).toBe(false);
    }
    const oversized = await verifier.verify(
      makeKi(`FROM logs-* | EVAL x = "${'x'.repeat(10_001)}"`),
      context
    );
    expect(oversized.passed).toBe(false);
    expect(esClient.fieldCaps).not.toHaveBeenCalled();
  });
});
