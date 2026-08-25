/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ESQLCallbacks, ESQLFieldWithMetadata } from '@kbn/esql-types';
import { validateQuery } from '../language/validation/validation';
import { QueryColumns } from '.';

const columns: ESQLFieldWithMetadata[] = [{ name: 'message', type: 'keyword', userDefined: false }];

const createCallbacks = () => {
  const getColumnsFor = jest.fn<ReturnType<NonNullable<ESQLCallbacks['getColumnsFor']>>, []>();
  getColumnsFor.mockResolvedValue(columns);
  return { getColumnsFor };
};

describe('QueryColumns cache options', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the cache by default', async () => {
    const callbacks = createCallbacks();
    const query = 'FROM cache_default | WHERE message == "ok"';

    await validateQuery(query, callbacks);
    await validateQuery(query, callbacks);

    expect(callbacks.getColumnsFor).toHaveBeenCalledTimes(1);
  });

  it('preserves invalidation behavior', async () => {
    const callbacks = createCallbacks();
    const query = 'FROM cache_invalidation | WHERE message == "ok"';

    await validateQuery(query, callbacks, { invalidateColumnsCache: true });
    await validateQuery(query, callbacks, { invalidateColumnsCache: true });

    expect(callbacks.getColumnsFor).toHaveBeenCalledTimes(2);
  });

  it('fetches on every validation when caching is disabled', async () => {
    const callbacks = createCallbacks();
    const query = 'FROM cache_disabled | WHERE message == "ok"';

    await validateQuery(query, callbacks, { disableColumnsCache: true });
    await validateQuery(query, callbacks, { disableColumnsCache: true });

    expect(callbacks.getColumnsFor).toHaveBeenCalledTimes(2);
  });

  it('neither reads nor writes an existing entry when caching is disabled', async () => {
    const query = 'FROM cache_isolated | EVAL copy = message | WHERE copy == "ok"';
    await validateQuery(query, createCallbacks());
    const fromCache = jest.spyOn(QueryColumns, 'fromCache');
    const setCache = jest.spyOn(QueryColumns, 'setCache');
    const callbacks = createCallbacks();

    await validateQuery(query, callbacks, {
      disableColumnsCache: true,
      invalidateColumnsCache: false,
    });

    expect(callbacks.getColumnsFor).toHaveBeenCalled();
    expect(fromCache).not.toHaveBeenCalled();
    expect(setCache).not.toHaveBeenCalled();
  });
});
