/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { estypes } from '@elastic/elasticsearch';
import type { ElasticsearchClient } from '@kbn/core/server';
import type { ESQLCallbacks, ESQLFutureFieldResolution } from '@kbn/esql-types';
import { EsqlService } from '@kbn/esql-server-utils';
import { getIndexPatternFromESQLQuery } from '@kbn/esql-utils';

interface CreateEsqlSchemaCallbacksParams {
  esClient: ElasticsearchClient;
  abortSignal?: AbortSignal;
}

export interface EsqlSchemaCallbacks {
  callbacks: Pick<ESQLCallbacks, 'getColumnsFor' | 'getFutureFieldsFor' | 'getPolicies'>;
}

const dynamicMappingPermitsFields = (dynamic: estypes.MappingDynamicMapping | undefined): boolean =>
  dynamic === undefined || dynamic === true || dynamic === 'true' || dynamic === 'runtime';

const isObjectProperty = (property: estypes.MappingProperty): boolean =>
  property.type === undefined || property.type === 'object' || property.type === 'nested';

type MappingFieldResult = Omit<ESQLFutureFieldResolution, 'name'>;

const findMatchingProperty = (
  properties: Record<string, estypes.MappingProperty>,
  path: string[]
): { property: estypes.MappingProperty; consumedParts: number } | undefined => {
  for (let consumedParts = path.length; consumedParts > 0; consumedParts--) {
    const property = properties[path.slice(0, consumedParts).join('.')];
    if (property) {
      return { property, consumedParts };
    }
  }
};

const getMappingFieldState = (
  mapping: estypes.MappingTypeMapping,
  fieldName: string
): MappingFieldResult => {
  if (mapping.enabled === false) {
    return { state: 'blocked', hasMappedAncestor: false };
  }

  const path = fieldName.split('.');
  if (!fieldName) {
    return { state: 'blocked', hasMappedAncestor: false };
  }

  for (const runtimeField of Object.keys(mapping.runtime ?? {})) {
    if (fieldName === runtimeField) {
      return { state: 'mapped', hasMappedAncestor: true };
    }
    if (fieldName.startsWith(`${runtimeField}.`)) {
      return { state: 'blocked', hasMappedAncestor: true };
    }
  }

  let properties = mapping.properties ?? {};
  let remainingPath = path;
  let effectiveDynamic = mapping.dynamic;
  let hasMappedAncestor = false;

  while (remainingPath.length > 0) {
    const match = findMatchingProperty(properties, remainingPath);
    if (!match) {
      return {
        state: dynamicMappingPermitsFields(effectiveDynamic) ? 'eligible' : 'blocked',
        hasMappedAncestor,
      };
    }

    const { property, consumedParts } = match;
    if (consumedParts === remainingPath.length) {
      return { state: 'mapped', hasMappedAncestor: true };
    }
    hasMappedAncestor = true;
    if (
      property.type === 'flattened' ||
      ('enabled' in property && property.enabled === false) ||
      !isObjectProperty(property)
    ) {
      return { state: 'blocked', hasMappedAncestor };
    }

    const propertyDynamic = 'dynamic' in property ? property.dynamic : undefined;
    const childProperties = 'properties' in property ? property.properties : undefined;
    effectiveDynamic = propertyDynamic ?? effectiveDynamic;
    properties = childProperties ?? {};
    remainingPath = remainingPath.slice(consumedParts);
  }

  return { state: 'blocked', hasMappedAncestor };
};

/** Creates ES|QL resource callbacks scoped to one KI verification. */
export const createEsqlSchemaCallbacks = ({
  esClient,
  abortSignal,
}: CreateEsqlSchemaCallbacksParams): EsqlSchemaCallbacks => {
  const esqlService = new EsqlService({ client: esClient });
  const sourceExistenceChecks = new Map<string, Promise<string[]>>();
  const mappingRequests = new Map<string, Promise<estypes.IndicesGetMappingResponse>>();

  const ensureSourcesExist = async (query: string): Promise<string[]> => {
    const index = getIndexPatternFromESQLQuery(query);
    if (!index) {
      return [];
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
      .then(({ indices }) => (typeof indices === 'string' ? [indices] : indices ?? []));
    sourceExistenceChecks.set(index, check);
    return check;
  };

  const getMappings = async (query: string): Promise<estypes.IndicesGetMappingResponse> => {
    const index = getIndexPatternFromESQLQuery(query);
    if (!index) {
      return {};
    }

    const existingRequest = mappingRequests.get(index);
    if (existingRequest) {
      return existingRequest;
    }

    const request = ensureSourcesExist(query).then((indices) =>
      esClient.indices.getMapping(
        {
          index: indices,
          allow_no_indices: false,
          ignore_unavailable: false,
        },
        { signal: abortSignal }
      )
    );
    mappingRequests.set(index, request);
    return request;
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

  const getFutureFieldsFor: NonNullable<ESQLCallbacks['getFutureFieldsFor']> = async (context) => {
    abortSignal?.throwIfAborted();
    const { query, fieldNames } = context ?? {};
    if (!query || !fieldNames?.length) {
      return [];
    }

    const mappings = Object.values(await getMappings(query));
    return fieldNames.map<ESQLFutureFieldResolution>((name) => {
      const results = mappings.map(({ mappings: mapping }) => getMappingFieldState(mapping, name));
      const hasMappedAncestor = results.some((result) => result.hasMappedAncestor);
      if (results.some(({ state }) => state === 'mapped')) {
        return { name, state: 'mapped', hasMappedAncestor };
      }
      return results.some(({ state }) => state === 'eligible')
        ? { name, state: 'eligible', hasMappedAncestor }
        : { name, state: 'blocked', hasMappedAncestor };
    });
  };

  const getPolicies: NonNullable<ESQLCallbacks['getPolicies']> = async () => {
    abortSignal?.throwIfAborted();
    return esqlService.getPolicies(abortSignal);
  };

  return {
    callbacks: { getColumnsFor, getFutureFieldsFor, getPolicies },
  };
};
