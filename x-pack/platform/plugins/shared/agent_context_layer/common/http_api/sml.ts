/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Allowed type keys for the `filters` parameter in SML search.
 * Extend this enum when adding new filterable SML types.
 */
export enum SmlSearchFilterType {
  connector = 'connector',
}

/**
 * Per-type filter criteria for SML search.
 * Keys must be values of {@link SmlSearchFilterType}.
 */
export type SmlSearchFilters = Partial<Record<SmlSearchFilterType, { ids?: string[] }>>;

/**
 * Max length of `query` for POST `/internal/agent_context_layer/sml/_search`.
 */
export const SML_HTTP_SEARCH_QUERY_MAX_LENGTH = 512;

/**
 * Response body for `POST /internal/agent_context_layer/sml/_search`.
 */
export interface SmlSearchHttpResponse {
  total: number;
  results: SmlSearchHttpResultItem[];
}

export interface SmlSearchHttpResultItem {
  id: string;
  type: string;
  origin_id: string;
  title: string;
  score: number;
  content?: string;
}

/**
 * Max length of `query` for POST `/internal/agent_context_layer/sml/_autocomplete`.
 * Autocomplete payloads are user-typed prefixes — shorter than full retrieval queries.
 */
export const SML_HTTP_AUTOCOMPLETE_QUERY_MAX_LENGTH = 256;

/**
 * Response body for `POST /internal/agent_context_layer/sml/_autocomplete`.
 */
export interface SmlAutocompleteHttpResponse {
  total: number;
  results: SmlAutocompleteHttpResultItem[];
}

/**
 * One row in the @ menu / typeahead. Results are returned in score order;
 * consumers iterate without re-sorting.
 */
export interface SmlAutocompleteHttpResultItem {
  id: string;
  type: string;
  origin_id: string;
  title: string;
  /**
   * The specific `discovery_labels` entries that matched the typed prefix,
   * with their `kind` so the UI can render the matched label in context
   * (e.g. for `kind: 'title'` the UI may bold the matched span in the title;
   * for `kind: 'tagline'` it may render the value as a chip).
   *
   * Title and type are reachable as discovery_labels (indexer auto-prepends
   * `{value: title, kind: 'title'}` and `{value: type, kind: 'type'}`).
   */
  matched_discovery_labels?: SmlMatchedDiscoveryLabel[];
}

export interface SmlMatchedDiscoveryLabel {
  value: string;
  kind: string;
  /**
   * The matched span within `value`, wrapped in `<em>...</em>` tags. Present
   * when ES returned a highlight snippet for this entry. UI renders the tags
   * as appropriate (e.g. mapping `<em>` to a bolded span). Example: typed
   * prefix `"git"` against value `"github"` produces `"<em>git</em>hub"`.
   */
  highlighted?: string;
}
