/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { estypes } from '@elastic/elasticsearch';
import { fieldCapsToEsqlColumns } from './esql_schema_callbacks';

describe('fieldCapsToEsqlColumns', () => {
  it('normalizes Elasticsearch mapping types', () => {
    const fields: estypes.FieldCapsResponse['fields'] = {
      count: {
        short: { type: 'short', searchable: true, aggregatable: true },
      },
      ratio: {
        scaled_float: { type: 'scaled_float', searchable: true, aggregatable: true },
      },
      category: {
        constant_keyword: { type: 'constant_keyword', searchable: true, aggregatable: true },
      },
    };

    expect(fieldCapsToEsqlColumns(fields)).toEqual([
      { name: 'count', type: 'integer', userDefined: false, hasConflict: false },
      { name: 'ratio', type: 'double', userDefined: false, hasConflict: false },
      { name: 'category', type: 'keyword', userDefined: false, hasConflict: false },
    ]);
  });

  it('preserves incompatible original types as a conflict', () => {
    const fields: estypes.FieldCapsResponse['fields'] = {
      value: {
        keyword: { type: 'keyword', searchable: true, aggregatable: true },
        long: { type: 'long', searchable: true, aggregatable: true },
      },
    };

    expect(fieldCapsToEsqlColumns(fields)).toEqual([
      {
        name: 'value',
        type: 'unsupported',
        userDefined: false,
        hasConflict: true,
        originalTypes: ['keyword', 'long'],
      },
    ]);
  });

  it('does not report a conflict when raw types normalize to the same ES|QL type', () => {
    const fields: estypes.FieldCapsResponse['fields'] = {
      value: {
        byte: { type: 'byte', searchable: true, aggregatable: true },
        short: { type: 'short', searchable: true, aggregatable: true },
      },
    };

    expect(fieldCapsToEsqlColumns(fields)).toEqual([
      { name: 'value', type: 'integer', userDefined: false, hasConflict: false },
    ]);
  });
});
