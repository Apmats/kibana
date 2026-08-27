/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ESQLCallbacks, ESQLFieldWithMetadata } from '@kbn/esql-types';
import { EsqlQuery } from '@elastic/esql';
import {
  getApplicableSourceQueries,
  getReferencedInputColumns,
} from '../../../query_columns_service/helpers';
import { validateQuery } from '../validation';

const knownFields: ESQLFieldWithMetadata[] = [
  { name: 'key', type: 'keyword', userDefined: false },
  { name: 'knownLong', type: 'long', userDefined: false },
  { name: 'knownKeyword', type: 'keyword', userDefined: false },
];

const createCallbacks = (): ESQLCallbacks => ({
  getColumnsFor: jest.fn(async () => knownFields),
  getFutureFieldsFor: jest.fn(async ({ query, fieldNames } = { query: '', fieldNames: [] }) => {
    const allowed =
      query.includes('dynamic_inner') || query.includes('dynamic_lookup') || query === 'FROM index';
    return fieldNames.map((name) => ({
      name,
      state: allowed ? ('eligible' as const) : ('blocked' as const),
      hasMappedAncestor: query.includes('dynamic_lookup') && name.startsWith('lookup.'),
    }));
  }),
  getJoinIndices: jest.fn(async () => ({
    indices: [{ name: 'dynamic_lookup', mode: 'Lookup', aliases: [] }],
  })),
});

const errorTexts = async (
  query: string,
  callbacks: ESQLCallbacks,
  allowFutureFields: boolean
): Promise<string[]> => {
  const { errors } = await validateQuery(query, callbacks, {
    allowFutureFields,
    disableColumnsCache: true,
  });
  return errors.map((error) => ('text' in error ? error.text : error.message));
};

describe('future dynamic field validation', () => {
  it('identifies input columns and their applicable source', () => {
    const { commands } = EsqlQuery.fromSrc('FROM index | KEEP futureField').ast;

    expect(getReferencedInputColumns(commands[1])).toEqual(['futureField']);
    expect(getApplicableSourceQueries(commands)).toEqual(['FROM index']);
  });

  it('keeps strict validation as the default and requires the future-field callback', async () => {
    const callbacks = createCallbacks();

    expect(await errorTexts('FROM index | KEEP futureField', callbacks, false)).toContain(
      'Unknown column "futureField"'
    );
    expect(callbacks.getFutureFieldsFor).not.toHaveBeenCalled();

    const { getFutureFieldsFor: _missing, ...callbacksWithoutFutureFields } = callbacks;
    expect(
      await errorTexts('FROM index | KEEP futureField', callbacksWithoutFutureFields, true)
    ).toContain('Unknown column "futureField"');
  });

  it('accepts an eligible future field without assigning a concrete type', async () => {
    const callbacks = createCallbacks();

    const errors = await errorTexts('FROM index | KEEP futureField', callbacks, true);
    expect(callbacks.getFutureFieldsFor).toHaveBeenCalledWith({
      query: 'FROM index',
      fieldNames: ['futureField'],
    });
    expect(errors).toEqual([]);
  });

  it('defers dependent type checks while preserving known-field errors', async () => {
    const callbacks = createCallbacks();

    expect(await errorTexts('FROM index | EVAL result = futureField + 1', callbacks, true)).toEqual(
      []
    );
    expect(
      await errorTexts('FROM index | EVAL result = futureField + knownKeyword', callbacks, true)
    ).toEqual([expect.stringContaining('Invalid input types for +')]);
    expect(
      await errorTexts('FROM index | EVAL result = TO_UPPER(knownLong)', callbacks, true)
    ).toEqual([expect.stringContaining('Invalid input types for TO_UPPER')]);
  });

  it('propagates, drops, and renames future fields through the pipeline', async () => {
    const callbacks = createCallbacks();

    expect(
      await errorTexts(
        'FROM index | KEEP futureField | RENAME futureField AS renamed | EVAL result = renamed + 1',
        callbacks,
        true
      )
    ).toEqual([]);
    expect(
      await errorTexts('FROM index | DROP futureField | KEEP futureField', createCallbacks(), true)
    ).toContain('Unknown column "futureField"');
    expect(
      await errorTexts(
        'FROM index | RENAME futureField AS renamed | KEEP futureField',
        createCallbacks(),
        true
      )
    ).toContain('Unknown column "futureField"');
  });

  it('keeps derived fields governed by pipeline semantics', async () => {
    expect(
      await errorTexts(
        'FROM strict_main | EVAL derived = 1 | KEEP derived',
        createCallbacks(),
        true
      )
    ).toEqual([]);
  });

  it('isolates nested and lookup source policies', async () => {
    expect(
      await errorTexts(
        'FROM strict_main, (FROM dynamic_inner | KEEP innerFuture) | KEEP innerFuture',
        createCallbacks(),
        true
      )
    ).toEqual([]);
    expect(
      await errorTexts(
        'FROM strict_main | WHERE mainFuture IS NOT NULL | LOOKUP JOIN dynamic_lookup ON key',
        createCallbacks(),
        true
      )
    ).toContain('Unknown column "mainFuture"');
    expect(
      await errorTexts(
        'FROM strict_main | LOOKUP JOIN dynamic_lookup ON key | KEEP lookup.future',
        createCallbacks(),
        true
      )
    ).toEqual([]);
    expect(
      await errorTexts(
        'FROM strict_main | LOOKUP JOIN dynamic_lookup ON key | KEEP ambiguousFuture',
        createCallbacks(),
        true
      )
    ).toContain('Unknown column "ambiguousFuture"');
  });
});
