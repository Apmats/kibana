/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { errors, type estypes } from '@elastic/elasticsearch';
import { coreMock, elasticsearchServiceMock, loggingSystemMock } from '@kbn/core/server/mocks';
import { elasticsearchClientMock } from '@kbn/core-elasticsearch-client-server-mocks';
import { createVerifyKiStepDefinition } from './verify_ki_step';
import {
  ESQL_VALID_RUNTIME_VERIFIER_ID,
  ESQL_VALID_SCHEMA_VERIFIER_ID,
  ESQL_VALID_SYNTAX_VERIFIER_ID,
} from '../ki_verification';

type VerifyKiHandler = ReturnType<typeof createVerifyKiStepDefinition>['handler'];
type VerifyKiHandlerContext = Parameters<VerifyKiHandler>[0];
type EsClientMock = ReturnType<typeof elasticsearchServiceMock.createElasticsearchClient>;
interface HandlerOptions {
  esqlAttributes?: string[];
  verifiers?: string[];
  options?: VerifyKiHandlerContext['input']['options'];
  abortSignal?: AbortSignal;
}

const createPolicyResponse = (): estypes.EnrichGetPolicyResponse => ({ policies: [] });

const esResponseError = (type: string, reason: string, statusCode: number) =>
  new errors.ResponseError(
    elasticsearchClientMock.createApiResponse({ statusCode, body: { error: { type, reason } } })
  );

const makeHandlerContext = (
  ki: VerifyKiHandlerContext['input']['ki'],
  esClient: EsClientMock,
  { esqlAttributes, verifiers, options, abortSignal }: HandlerOptions = {}
): VerifyKiHandlerContext =>
  ({
    input: { ki, esql_attributes: esqlAttributes, verifiers, options },
    config: {},
    rawInput: { ki, esql_attributes: esqlAttributes, verifiers, options },
    contextManager: {
      getFakeRequest: jest.fn(),
      getScopedEsClient: jest.fn().mockReturnValue(esClient),
    },
    logger: loggingSystemMock.createLogger(),
    abortSignal: abortSignal ?? new AbortController().signal,
    stepId: 'verify_ki',
    stepType: 'context-engine.verifyKi',
  } as unknown as VerifyKiHandlerContext);

describe('verify_ki workflow step', () => {
  let coreSetup: ReturnType<typeof coreMock.createSetup>;
  let uiSettingsGet: jest.Mock;
  let esClient: EsClientMock;

  const setContextEngineEnabled = (isEnabled: boolean) => {
    uiSettingsGet.mockResolvedValue(isEnabled);
  };

  beforeEach(() => {
    coreSetup = coreMock.createSetup();
    const startServices = coreMock.createStart();
    uiSettingsGet = jest.fn();
    startServices.uiSettings.asScopedToClient.mockReturnValue({
      get: uiSettingsGet,
    } as unknown as ReturnType<typeof startServices.uiSettings.asScopedToClient>);
    coreSetup.getStartServices.mockResolvedValue([startServices, {}, undefined]);
    esClient = elasticsearchServiceMock.createElasticsearchClient();
    esClient.fieldCaps.mockResolvedValue({ indices: ['logs-2026'], fields: {} });
    esClient.esql.query.mockImplementation(async (request) => ({
      columns: request?.query.includes('LIMIT 0')
        ? [{ name: 'event.outcome', type: 'keyword' }]
        : [],
      values: [],
    }));
    esClient.enrich.getPolicy.mockResolvedValue(createPolicyResponse());
    esClient.indices.getMapping.mockResolvedValue({
      'logs-2026': { mappings: { dynamic: true } },
    });
  });

  const runHandler = async (
    ki: VerifyKiHandlerContext['input']['ki'],
    opts: HandlerOptions = {}
  ) => {
    const definition = createVerifyKiStepDefinition(coreSetup, loggingSystemMock.createLogger());
    const { output } = await definition.handler(makeHandlerContext(ki, esClient, opts));
    if (!output) {
      throw new Error('step returned no output');
    }
    return output;
  };

  const ALL_ESQL_VERIFIERS = [
    ESQL_VALID_SYNTAX_VERIFIER_ID,
    ESQL_VALID_RUNTIME_VERIFIER_ID,
    ESQL_VALID_SCHEMA_VERIFIER_ID,
  ];

  it('runs no verification when verifiers is not specified', async () => {
    setContextEngineEnabled(true);

    const output = await runHandler({
      attributes: { esql: 'FROM logs-* | LIMIT 10' },
    });

    expect(output).toEqual({ passed: true, results: [] });
    expect(esClient.esql.query).not.toHaveBeenCalled();
  });

  it('passes a KI with valid ES|QL', async () => {
    setContextEngineEnabled(true);

    const output = await runHandler(
      {
        type: 'detection',
        attributes: { esql: 'FROM logs-* | WHERE event.outcome == "failure" | LIMIT 10' },
      },
      { verifiers: ALL_ESQL_VERIFIERS }
    );

    expect(output.passed).toBe(true);
    expect(output.results).toEqual([
      { verifier: ESQL_VALID_SYNTAX_VERIFIER_ID, passed: true },
      { verifier: ESQL_VALID_RUNTIME_VERIFIER_ID, passed: true },
      { verifier: ESQL_VALID_SCHEMA_VERIFIER_ID, passed: true },
    ]);
  });

  it('hands the scoped Elasticsearch client to the verifiers that need one', async () => {
    setContextEngineEnabled(true);

    await runHandler(
      { attributes: { esql: 'FROM logs-* | LIMIT 10' } },
      { verifiers: [ESQL_VALID_RUNTIME_VERIFIER_ID] }
    );

    expect(esClient.esql.query).toHaveBeenCalledTimes(1);
  });

  it('forwards schema options and still verifies index existence when fields are disabled', async () => {
    setContextEngineEnabled(true);

    const output = await runHandler(
      { attributes: { esql: 'FROM logs-* | WHERE missing > 0' } },
      {
        verifiers: [ESQL_VALID_SCHEMA_VERIFIER_ID],
        options: { 'esql-valid-schema': { field_verification: 'disabled' } },
      }
    );

    expect(output).toEqual({
      passed: true,
      results: [{ verifier: ESQL_VALID_SCHEMA_VERIFIER_ID, passed: true }],
    });
    expect(esClient.esql.query).toHaveBeenCalled();
    expect(esClient.fieldCaps).toHaveBeenCalled();
  });

  it('allows only structurally eligible future fields in dynamic mode', async () => {
    setContextEngineEnabled(true);
    esClient.esql.query.mockResolvedValue({ columns: [], values: [] });

    const eligible = await runHandler(
      { attributes: { esql: 'FROM logs-* | KEEP future_field' } },
      {
        verifiers: [ESQL_VALID_SCHEMA_VERIFIER_ID],
        options: { 'esql-valid-schema': { field_verification: 'dynamic' } },
      }
    );
    expect(eligible).toEqual({
      passed: true,
      results: [{ verifier: ESQL_VALID_SCHEMA_VERIFIER_ID, passed: true }],
    });

    esClient.indices.getMapping.mockResolvedValue({
      'logs-2026': { mappings: { dynamic: false } },
    });
    const rejected = await runHandler(
      { attributes: { esql: 'FROM logs-* | KEEP future_field' } },
      {
        verifiers: [ESQL_VALID_SCHEMA_VERIFIER_ID],
        options: { 'esql-valid-schema': { field_verification: 'dynamic' } },
      }
    );
    expect(rejected.passed).toBe(false);
    expect(rejected.results[0]).toEqual({
      verifier: ESQL_VALID_SCHEMA_VERIFIER_ID,
      passed: false,
      reason: expect.stringContaining('future_field'),
    });
  });

  it('still rejects a missing source in dynamic mode', async () => {
    setContextEngineEnabled(true);
    esClient.fieldCaps.mockRejectedValue(
      esResponseError('index_not_found_exception', 'no such index [missing-*]', 404)
    );

    const output = await runHandler(
      { attributes: { esql: 'FROM missing-* | KEEP future_field' } },
      {
        verifiers: [ESQL_VALID_SCHEMA_VERIFIER_ID],
        options: { 'esql-valid-schema': { field_verification: 'dynamic' } },
      }
    );

    expect(output.passed).toBe(false);
    expect(output.results[0].reason).toContain('no such index [missing-*]');
  });

  it('propagates infrastructure failures raised during semantic validation', async () => {
    setContextEngineEnabled(true);
    esClient.esql.query.mockImplementation(async (request) => {
      if (request?.query.includes('lookup_index')) {
        throw esResponseError('too_many_requests', 'metadata throttled', 429);
      }
      return { columns: [{ name: 'event.outcome', type: 'keyword' }], values: [] };
    });

    await expect(
      runHandler(
        {
          attributes: {
            esql: 'FROM logs-* | LOOKUP JOIN lookup_index ON event.outcome',
          },
        },
        { verifiers: [ESQL_VALID_SCHEMA_VERIFIER_ID] }
      )
    ).rejects.toBeInstanceOf(errors.ResponseError);
  });

  it('propagates cancellation during schema metadata retrieval', async () => {
    setContextEngineEnabled(true);
    const abortController = new AbortController();
    esClient.esql.query.mockImplementation(async (_request, options) => {
      abortController.abort();
      options?.signal?.throwIfAborted();
      return { columns: [], values: [] };
    });

    await expect(
      runHandler(
        { attributes: { esql: 'FROM logs-*' } },
        {
          verifiers: [ESQL_VALID_SCHEMA_VERIFIER_ID],
          abortSignal: abortController.signal,
        }
      )
    ).rejects.toThrow(/abort/i);
  });

  it('fails a KI with invalid ES|QL and reports the reason', async () => {
    setContextEngineEnabled(true);

    const output = await runHandler(
      { attributes: { esql: 'FROM logs-* | EVAL x = NOT_A_FUNCTION(1)' } },
      { verifiers: ALL_ESQL_VERIFIERS }
    );

    expect(output.passed).toBe(false);
    expect(output.results).toEqual([
      {
        verifier: ESQL_VALID_SYNTAX_VERIFIER_ID,
        passed: false,
        reason: expect.stringContaining('NOT_A_FUNCTION'),
      },
      { verifier: ESQL_VALID_RUNTIME_VERIFIER_ID, passed: true },
      {
        verifier: ESQL_VALID_SCHEMA_VERIFIER_ID,
        passed: false,
        reason: expect.stringContaining('NOT_A_FUNCTION'),
      },
    ]);
  });

  it('verifies the attributes named in esql_attributes instead of the default', async () => {
    setContextEngineEnabled(true);

    const output = await runHandler(
      {
        attributes: {
          esql: 'FROM logs-* | EVAL x = NOT_A_FUNCTION(1)',
          aggregation_query: 'FROM logs-* | STATS c = COUNT(*)',
        },
      },
      { esqlAttributes: ['aggregation_query'], verifiers: ALL_ESQL_VERIFIERS }
    );

    expect(output.passed).toBe(true);
    expect(esClient.esql.query).toHaveBeenCalled();
  });

  it('passes a KI carrying none of the named attributes, without running any verifier', async () => {
    setContextEngineEnabled(true);

    const output = await runHandler(
      { attributes: { esql: 'FROM logs-* | LIMIT 1' } },
      { esqlAttributes: ['aggregation_query'], verifiers: ALL_ESQL_VERIFIERS }
    );

    expect(output).toEqual({ passed: true, results: [] });
    expect(esClient.esql.query).not.toHaveBeenCalled();
  });

  it('skips KIs with no applicable verifiers', async () => {
    setContextEngineEnabled(true);

    const output = await runHandler({ title: 'no esql here' }, { verifiers: ALL_ESQL_VERIFIERS });

    expect(output).toEqual({ passed: true, results: [] });
  });

  it('runs only the listed verifier when a subset is specified', async () => {
    setContextEngineEnabled(true);

    const output = await runHandler(
      { attributes: { esql: 'FROM logs-* | LIMIT 10' } },
      { verifiers: [ESQL_VALID_SYNTAX_VERIFIER_ID] }
    );

    expect(output.results).toEqual([{ verifier: ESQL_VALID_SYNTAX_VERIFIER_ID, passed: true }]);
    expect(esClient.esql.query).not.toHaveBeenCalled();
  });

  it('throws when the Context Engine setting is off', async () => {
    setContextEngineEnabled(false);

    await expect(
      runHandler({ attributes: { esql: 'FROM logs-* | EVAL x = NOT_A_FUNCTION(1)' } })
    ).rejects.toThrow('Context Engine is disabled');
  });
});
