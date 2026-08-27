/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { ESQLCallbacks, ESQLFutureField, IndexAutocompleteItem } from '@kbn/esql-types';
import type {
  ESQLAstItem,
  ESQLAstJoinCommand,
  ESQLAstPromqlCommand,
  ESQLAstCommand,
} from '@elastic/esql/types';
import {
  BasicPrettyPrinter,
  isFunctionExpression,
  isSource,
  isSubQuery,
  SOURCE_COMMANDS,
  synth,
  Walker,
} from '@elastic/esql';
import { esqlCommandRegistry, TRANSFORMATIONAL_COMMANDS } from '../..';
import {
  UnmappedFieldsStrategy,
  type ESQLColumnData,
  type ESQLPolicy,
} from '../commands/registry/types';
import type { IAdditionalFields } from '../commands/registry/registry';
import { enrichFieldsWithECSInfo } from './enrich_fields_with_ecs';
import { columnIsPresent } from '../commands/definitions/utils/columns';
import { getUnmappedFieldType } from '../commands/definitions/utils/settings';
import { getLookupJoinSource } from '../commands/definitions/utils/sources';
import { getIndexFromPromQLParams } from '../commands/definitions/utils/promql';

async function getEcsMetadata(resourceRetriever?: ESQLCallbacks) {
  if (!resourceRetriever?.getFieldsMetadata) {
    return undefined;
  }
  const client = await resourceRetriever?.getFieldsMetadata;
  if (client.find) {
    // Fetch full list of ECS field
    // This list should be cached already by fieldsMetadataClient
    const results = await client.find({ attributes: ['type'] });
    return results?.fields;
  }
}

function createGetJoinFields(fetchFields: (query: string) => Promise<ESQLColumnData[]>) {
  return (command: ESQLAstCommand): Promise<ESQLColumnData[]> => {
    const joinTarget = getLookupJoinSource(command as ESQLAstJoinCommand);
    if (joinTarget) {
      const joinFieldQuery = synth.cmd`FROM ${joinTarget}`.toString();
      return fetchFields(joinFieldQuery);
    }
    return Promise.resolve([]);
  };
}

function createGetEnrichFields(
  fetchFields: (query: string) => Promise<ESQLColumnData[]>,
  getPolicies: () => Promise<Map<string, ESQLPolicy>>
) {
  return async (command: ESQLAstCommand): Promise<ESQLColumnData[]> => {
    if (!isSource(command.args[0])) {
      return [];
    }

    const policyName = command.args[0].name;

    const policies = await getPolicies();
    const policy = policies.get(policyName);

    if (policy) {
      const fieldsQuery = `FROM ${policy.sourceIndices.join(
        ', '
      )} | KEEP ${policy.enrichFields.join(', ')}`;
      return fetchFields(fieldsQuery);
    }

    return [];
  };
}

function createGetFromFields(fetchFields: (query: string) => Promise<ESQLColumnData[]>) {
  return (command: ESQLAstCommand): Promise<ESQLColumnData[]> => {
    return fetchFields(BasicPrettyPrinter.command(command));
  };
}

function createGetPromqlFields(
  fetchFields: (query: string) => Promise<ESQLColumnData[]>,
  getTimeseriesIndices?: () => Promise<{ indices: IndexAutocompleteItem[] }>
) {
  return async (command: ESQLAstCommand): Promise<ESQLColumnData[]> => {
    if (command.name !== 'promql') {
      return [];
    }

    const indexName = getIndexFromPromQLParams(command as ESQLAstPromqlCommand);

    if (!indexName) {
      const indices = (await getTimeseriesIndices?.())?.indices ?? [];
      const indexNames = indices.map(({ name }) => name);

      if (indexNames.length > 0) {
        return fetchFields(synth.cmd`FROM ${indexNames.join(',')}`.toString());
      }

      return [];
    }

    return fetchFields(synth.cmd`FROM ${indexName}`.toString());
  };
}
// Get the fields from the FROM clause, enrich them with ECS metadata
export async function getFieldsFromES(query: string, resourceRetriever?: ESQLCallbacks) {
  const [metadata, fieldsOfType] = await Promise.all([
    getEcsMetadata(resourceRetriever),
    resourceRetriever?.getColumnsFor?.({ query }),
  ]);
  return enrichFieldsWithECSInfo(fieldsOfType || [], metadata);
}

export function getReferencedInputColumns(command: ESQLAstCommand): string[] {
  const outputColumns = new Set<ESQLAstItem>();
  Walker.walk(command, {
    visitFunction: (node) => {
      if (!isFunctionExpression(node)) {
        return;
      }
      const output =
        node.name === '=' ? node.args[0] : node.name === 'as' ? node.args[1] : undefined;
      if (output && !Array.isArray(output)) {
        outputColumns.add(output);
      }
    },
    visitParens: (node, _parent, walker) => {
      if (isSubQuery(node)) {
        walker.skipChildren();
      }
    },
  });

  const names = new Set<string>();
  Walker.walk(command, {
    visitColumn: (node) => {
      const name = node.parts.join('.');
      if (!outputColumns.has(node) && name !== '*' && !name.includes('*')) {
        names.add(name);
      }
    },
    visitParens: (node, _parent, walker) => {
      if (isSubQuery(node)) {
        walker.skipChildren();
      }
    },
  });
  return [...names];
}

export function getApplicableSourceQueries(commands: ESQLAstCommand[]): string[] {
  const queries = new Set<string>();
  const commandsBeforeCurrent = commands.slice(0, -1);

  for (const command of commandsBeforeCurrent) {
    if (SOURCE_COMMANDS.has(command.name.toUpperCase())) {
      const args = command.args.filter((arg) => Array.isArray(arg) || !isSubQuery(arg));
      if (args.length > 0) {
        queries.add(BasicPrettyPrinter.command({ ...command, args }));
      }
    }

    if (command.name === 'join') {
      const joinTarget = getLookupJoinSource(command as ESQLAstJoinCommand);
      if (joinTarget) {
        queries.add(synth.cmd`FROM ${joinTarget}`.toString());
      }
    }
  }

  return [...queries];
}

export async function getFutureFields(
  commands: ESQLAstCommand[],
  previousColumns: ESQLColumnData[],
  resourceRetriever: ESQLCallbacks
): Promise<ESQLFutureField[]> {
  const currentCommand = commands[commands.length - 1];
  if (!currentCommand || !resourceRetriever.getFutureFieldsFor) {
    return [];
  }

  const previousCommands = commands.slice(0, -1);
  if (!areNewUnmappedFieldsAllowed(previousCommands)) {
    return [];
  }

  const existingNames = new Set(previousColumns.map(({ name }) => name));
  const removedNames = new Set(
    previousCommands
      .filter(({ name }) => name === 'drop' || name === 'rename')
      .flatMap((command) => getReferencedInputColumns(command))
  );
  const fieldNames = getReferencedInputColumns(currentCommand).filter(
    (name) => !existingNames.has(name) && !removedNames.has(name)
  );
  if (fieldNames.length === 0) {
    return [];
  }

  const sourceQueries = getApplicableSourceQueries(commands);
  const sourceResolutions = await Promise.all(
    sourceQueries.map(async (query) => ({
      resolutions: (await resourceRetriever.getFutureFieldsFor?.({ query, fieldNames })) ?? [],
    }))
  );

  return fieldNames.flatMap<ESQLFutureField>((name) => {
    const resolutions = sourceResolutions.map(({ resolutions: sourceResults }) => ({
      resolution: sourceResults.find((result) => result.name === name),
    }));
    const eligibleResolutions = resolutions.filter(
      ({ resolution }) => resolution?.state === 'eligible'
    );

    if (sourceQueries.length === 1 && eligibleResolutions.length === 1) {
      return [{ name, type: 'unknown', userDefined: false, isFutureField: true }];
    }

    if (resolutions.some(({ resolution }) => resolution?.state === 'mapped')) {
      return [];
    }

    const resolutionsWithMappedAncestor = resolutions.filter(
      ({ resolution }) => resolution?.hasMappedAncestor
    );
    return resolutionsWithMappedAncestor.length === 1 &&
      resolutionsWithMappedAncestor[0].resolution?.state === 'eligible'
      ? [{ name, type: 'unknown', userDefined: false, isFutureField: true }]
      : [];
  });
}

/**
 * After KEEP or STATS, no new unmapped fields are added as they were erased by those destructive commands.
 */
export function areNewUnmappedFieldsAllowed(previousCommands: ESQLAstCommand[]): boolean {
  return !previousCommands.find((cmd) =>
    TRANSFORMATIONAL_COMMANDS.includes(cmd.name.toLowerCase())
  );
}

export function getUnmappedFields(
  command: ESQLAstCommand,
  previousCommands: ESQLAstCommand[],
  previousPipeFields: ESQLColumnData[],
  unmappedFieldsStrategy?: UnmappedFieldsStrategy
): ESQLColumnData[] {
  // Not collect unmmaped fields if the strategy is DEFAULT or undefined
  if (!unmappedFieldsStrategy || unmappedFieldsStrategy === UnmappedFieldsStrategy.DEFAULT) {
    return [];
  }

  // No unmaped fields can be collected after certain commands
  if (!areNewUnmappedFieldsAllowed(previousCommands)) {
    return [];
  }

  const unmappedFields: ESQLColumnData[] = [];
  const columsSet = new Set(previousPipeFields.map((col) => col.name));

  Walker.walk(command, {
    visitColumn: (node) => {
      if (
        !columnIsPresent(node, columsSet) &&
        unmappedFields.findIndex((f) => f.name === node.name) === -1
      ) {
        unmappedFields.push({
          name: node.parts.join('.'),
          type: getUnmappedFieldType(unmappedFieldsStrategy),
          isUnmappedField: true,
          userDefined: false,
        });
      }
    },
  });

  return unmappedFields;
}

/**
 * @param query, the ES|QL query
 * @param commands, the AST commands
 * @param previousPipeFields, the fields from the previous pipe
 * @returns a list of fields that are available for the current pipe
 */
export async function getCurrentQueryAvailableColumns(
  commands: ESQLAstCommand[],
  previousPipeFields: ESQLColumnData[],
  fetchFields: (query: string) => Promise<ESQLColumnData[]>,
  getPolicies: () => Promise<Map<string, ESQLPolicy>>,
  getTimeseriesIndices: () => Promise<{ indices: IndexAutocompleteItem[] }>,
  originalQueryText: string,
  unmappedFieldsStrategy?: UnmappedFieldsStrategy,
  resourceRetriever?: ESQLCallbacks
) {
  if (commands.length === 0) {
    return previousPipeFields;
  }
  const lastCommand = commands[commands.length - 1];
  const commandDef = esqlCommandRegistry.getCommandByName(lastCommand.name);

  const getJoinFields = createGetJoinFields(fetchFields);
  const getEnrichFields = createGetEnrichFields(fetchFields, getPolicies);
  const getFromFields = createGetFromFields(fetchFields);
  const getPromqlFields = createGetPromqlFields(fetchFields, getTimeseriesIndices);

  const additionalFields: IAdditionalFields = {
    fromJoin: getJoinFields,
    fromEnrich: getEnrichFields,
    fromFrom: getFromFields,
    fromPromql: getPromqlFields,
    ...(resourceRetriever?.getFutureFieldsFor
      ? {
          fromFuture: (pipelineCommands, columns) =>
            getFutureFields(pipelineCommands, columns, resourceRetriever),
        }
      : {}),
  };

  const previousCommands = commands.slice(0, -1);
  const unmappedFields = getUnmappedFields(
    lastCommand,
    previousCommands,
    previousPipeFields,
    unmappedFieldsStrategy
  );

  const futureFields = (await additionalFields.fromFuture?.(commands, previousPipeFields)) ?? [];
  const fields = [...previousPipeFields, ...futureFields, ...unmappedFields];

  if (commandDef?.methods.columnsAfter) {
    return commandDef.methods.columnsAfter(
      lastCommand,
      fields,
      originalQueryText,
      additionalFields,
      unmappedFieldsStrategy ?? UnmappedFieldsStrategy.DEFAULT
    );
  }
  return fields;
}
