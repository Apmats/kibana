/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { Parser, isColumn, isOptionNode } from '@elastic/esql';
import type { estypes } from '@elastic/elasticsearch';
import type { ElasticsearchClient } from '@kbn/core/server';
import {
  esqlFieldTypes,
  type ESQLCallbacks,
  type ESQLFieldWithMetadata,
  type EsqlFieldType,
} from '@kbn/esql-types';
import { getIndexPatternFromESQLQuery } from '@kbn/esql-utils';

const TYPE_NORMALIZATION: Readonly<Record<string, EsqlFieldType>> = {
  byte: 'integer',
  short: 'integer',
  half_float: 'double',
  float: 'double',
  scaled_float: 'double',
  constant_keyword: 'keyword',
  wildcard: 'keyword',
};

const ESQL_FIELD_TYPES = new Set<EsqlFieldType>(esqlFieldTypes);

const normalizeFieldType = (mappingType: string): EsqlFieldType =>
  TYPE_NORMALIZATION[mappingType] ??
  (ESQL_FIELD_TYPES.has(mappingType as EsqlFieldType)
    ? (mappingType as EsqlFieldType)
    : 'unsupported');

const getRequestedFields = (query: string): Set<string> | undefined => {
  const commands = Parser.parse(query).root.commands;
  const keepCommand =
    commands.length === 2 && commands[1]?.name === 'keep' ? commands[1] : undefined;
  if (!keepCommand || !keepCommand.args.every(isColumn)) {
    return undefined;
  }
  return new Set(keepCommand.args.map(({ name }) => name));
};

const getRequestedMetadataColumns = (query: string): ESQLFieldWithMetadata[] => {
  const sourceCommand = Parser.parse(query).root.commands[0];
  const metadataOption = sourceCommand?.args.find(
    (argument) => isOptionNode(argument) && argument.name === 'metadata'
  );
  if (!metadataOption || !isOptionNode(metadataOption)) {
    return [];
  }
  return metadataOption.args.filter(isColumn).map(({ name }) => ({
    name,
    type: 'keyword',
    userDefined: false,
  }));
};

/** Converts field-capability metadata into the column model used by ES|QL validation. */
export const fieldCapsToEsqlColumns = (
  fields: estypes.FieldCapsResponse['fields']
): ESQLFieldWithMetadata[] =>
  Object.entries(fields).flatMap(([name, capabilities]) => {
    const originalTypes = Object.keys(capabilities).filter((type) => type !== 'unmapped');
    if (originalTypes.length === 0) {
      return [];
    }

    const normalizedTypes = [...new Set(originalTypes.map(normalizeFieldType))];
    const hasConflict = normalizedTypes.length > 1;
    return [
      {
        name,
        type: hasConflict ? 'unsupported' : normalizedTypes[0],
        userDefined: false,
        hasConflict,
        ...(hasConflict ? { originalTypes } : {}),
      },
    ];
  });

interface CreateEsqlSchemaCallbacksParams {
  esClient: ElasticsearchClient;
  abortSignal?: AbortSignal;
}

export interface EsqlSchemaCallbacks {
  callbacks: Pick<ESQLCallbacks, 'getColumnsFor' | 'getPolicies'>;
  ensureSourcesExist(query: string): Promise<void>;
}

/** Creates metadata-only ES|QL callbacks scoped to one KI verification. */
export const createEsqlSchemaCallbacks = ({
  esClient,
  abortSignal,
}: CreateEsqlSchemaCallbacksParams): EsqlSchemaCallbacks => {
  const columnsBySource = new Map<string, Promise<ESQLFieldWithMetadata[]>>();
  type EsqlPolicies = Awaited<ReturnType<NonNullable<ESQLCallbacks['getPolicies']>>>;
  let policiesPromise: Promise<EsqlPolicies> | undefined;

  const getColumnsFor: NonNullable<ESQLCallbacks['getColumnsFor']> = async (context) => {
    abortSignal?.throwIfAborted();
    const index = getIndexPatternFromESQLQuery(context?.query);
    if (!index) {
      return [];
    }

    let columnsPromise = columnsBySource.get(index);
    if (!columnsPromise) {
      columnsPromise = esClient
        .fieldCaps(
          {
            index,
            fields: '*',
            allow_no_indices: false,
            ignore_unavailable: false,
          },
          { signal: abortSignal }
        )
        .then(({ fields }) => fieldCapsToEsqlColumns(fields));
      columnsBySource.set(index, columnsPromise);
    }
    const columns = [
      ...(await columnsPromise),
      ...getRequestedMetadataColumns(context?.query ?? ''),
    ];
    const requestedFields = getRequestedFields(context?.query ?? '');
    return requestedFields ? columns.filter(({ name }) => requestedFields.has(name)) : columns;
  };

  const getPolicies: NonNullable<ESQLCallbacks['getPolicies']> = async () => {
    abortSignal?.throwIfAborted();
    if (!policiesPromise) {
      policiesPromise = esClient.enrich
        .getPolicy({}, { signal: abortSignal })
        .then(({ policies }) =>
          policies.flatMap(({ config }) => {
            const policy = config.match ?? config.range ?? config.geo_match;
            if (!policy?.name) {
              return [];
            }
            return [
              {
                name: policy.name,
                sourceIndices: Array.isArray(policy.indices) ? policy.indices : [policy.indices],
                matchField: policy.match_field,
                enrichFields: Array.isArray(policy.enrich_fields)
                  ? policy.enrich_fields
                  : [policy.enrich_fields],
              },
            ];
          })
        );
    }
    return policiesPromise;
  };

  return {
    callbacks: { getColumnsFor, getPolicies },
    ensureSourcesExist: async (query) => {
      await getColumnsFor({ query });
    },
  };
};
