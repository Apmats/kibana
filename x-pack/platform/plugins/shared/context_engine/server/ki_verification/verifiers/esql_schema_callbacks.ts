/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { ESQLCallbacks } from '@kbn/esql-types';
import { EsqlService } from '@kbn/esql-server-utils';
import { getIndexPatternFromESQLQuery } from '@kbn/esql-utils';

interface CreateEsqlSchemaCallbacksParams {
  esClient: ElasticsearchClient;
  abortSignal?: AbortSignal;
}

export interface EsqlSchemaCallbacks {
  callbacks: Pick<ESQLCallbacks, 'getColumnsFor' | 'getPolicies'>;
}

/** Creates ES|QL resource callbacks scoped to one KI verification. */
export const createEsqlSchemaCallbacks = ({
  esClient,
  abortSignal,
}: CreateEsqlSchemaCallbacksParams): EsqlSchemaCallbacks => {
  const esqlService = new EsqlService({ client: esClient });
  const sourceExistenceChecks = new Map<string, Promise<void>>();

  const ensureSourcesExist = async (query: string): Promise<void> => {
    const index = getIndexPatternFromESQLQuery(query);
    if (!index) {
      return;
    }

    const existingCheck = sourceExistenceChecks.get(index);
    if (existingCheck) {
      return existingCheck;
    }

    const check = esClient
      .fieldCaps(
        {
          index,
          fields: ['_none_'],
          allow_no_indices: false,
          ignore_unavailable: false,
        },
        { signal: abortSignal }
      )
      .then(() => undefined);
    sourceExistenceChecks.set(index, check);
    return check;
  };

  const getColumnsFor: NonNullable<ESQLCallbacks['getColumnsFor']> = async (context) => {
    abortSignal?.throwIfAborted();
    const query = context?.query;
    if (!query) {
      return [];
    }
    await ensureSourcesExist(query);
    return esqlService.getColumns(query, abortSignal);
  };

  const getPolicies: NonNullable<ESQLCallbacks['getPolicies']> = async () => {
    abortSignal?.throwIfAborted();
    return esqlService.getPolicies(abortSignal);
  };

  return {
    callbacks: { getColumnsFor, getPolicies },
  };
};
