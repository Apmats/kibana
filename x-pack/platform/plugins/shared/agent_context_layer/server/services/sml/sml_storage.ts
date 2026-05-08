/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger, ElasticsearchClient } from '@kbn/core/server';
import type { IndicesIndexSettingsAnalysis } from '@elastic/elasticsearch/lib/api/types';
import type { IndexStorageSettings } from '@kbn/storage-adapter';
import { StorageIndexAdapter, types } from '@kbn/storage-adapter';
import { chatSystemIndex } from '../../../common/indices';
import type { SmlDocument } from './types';

export const smlIndexName = chatSystemIndex('sml-data');

/**
 * Custom analyzers for the autocomplete field on `discovery_labels.value`.
 *
 * `sml_edge_ngram_index` (index-time): standard tokenizer + lowercase + edge_ngram
 * filter (1–20 chars). Each word in the value gets indexed as its edge-ngrams,
 * keeping each ngram anchored to the original word's offsets — that's what
 * makes ES's highlighter able to wrap the matched word for prefix queries.
 *
 * `sml_edge_ngram_search` (search-time): standard tokenizer + lowercase only
 * (no ngram). The user's typed prefix is matched against the index-time ngrams
 * as a plain term lookup.
 *
 * SAYT was the obvious first choice for this field but produces no useful
 * highlight for prefix queries (open ES bug elastic/elasticsearch#53744). The
 * community-validated workaround is exactly this analyzer setup.
 */
const smlIndexAnalysis: IndicesIndexSettingsAnalysis = {
  analyzer: {
    sml_edge_ngram_index: {
      type: 'custom',
      tokenizer: 'standard',
      filter: ['lowercase', 'sml_edge_ngram_filter'],
    },
    sml_edge_ngram_search: {
      type: 'custom',
      tokenizer: 'standard',
      filter: ['lowercase'],
    },
  },
  filter: {
    sml_edge_ngram_filter: {
      type: 'edge_ngram',
      min_gram: 1,
      max_gram: 20,
    },
  },
};

/**
 * Single source of truth for SML data index field mappings (storage + Elasticsearch).
 *
 * Each text source field copies into a dedicated `semantic_text` mirror so the RRF retriever
 * can address them independently (`title_semantic`, `description_semantic`, `content_semantic`).
 */
const smlStorageSchemaProperties = {
  id: types.keyword({}),
  type: types.keyword({}),
  title: types.text({ copy_to: 'title_semantic' }),
  title_semantic: types.semantic_text({}),
  origin_id: types.keyword({}),
  content: types.text({ copy_to: 'content_semantic' }),
  content_semantic: types.semantic_text({}),
  description: types.text({ copy_to: 'description_semantic' }),
  description_semantic: types.semantic_text({}),
  tags: types.keyword({}),
  /**
   * Autocomplete surface. The indexer auto-prepends two entries on every record:
   *   { value: chunk.title, kind: 'title' }
   *   { value: chunk.type,  kind: 'type'  }
   * plus any entries the producer provides (taglines, nicknames, categories, etc.).
   * The @ menu queries `discovery_labels.value.autocomplete` and reads `inner_hits`
   * (with ES-generated highlights) to render which entry matched.
   *
   * `.autocomplete` is a plain `text` field with the custom edge-ngram analyzer
   * defined in `smlIndexAnalysis` above — *not* `search_as_you_type`. See that
   * comment for why.
   */
  discovery_labels: types.nested({
    properties: {
      value: {
        type: 'keyword',
        fields: {
          autocomplete: {
            type: 'text',
            analyzer: 'sml_edge_ngram_index',
            search_analyzer: 'sml_edge_ngram_search',
          },
        },
      },
      kind: types.keyword({}),
    },
  }),
  references: types.keyword({}),
  payload: types.flattened({}),
  user_id: types.keyword({}),
  created_at: types.date({}),
  updated_at: types.date({}),
  spaces: types.keyword({}),
  permissions: types.keyword({}),
};

export const storageSettings = {
  name: smlIndexName,
  schema: {
    properties: smlStorageSchemaProperties,
  },
  analysis: smlIndexAnalysis,
} satisfies IndexStorageSettings;

/**
 * Elasticsearch `mappings` block for the SML data index (e.g. integration tests, tooling).
 * Field definitions match `smlStorageSchemaProperties` / `storageSettings`.
 */
export const smlElasticsearchIndexMappings = {
  dynamic: 'strict' as const,
  properties: smlStorageSchemaProperties,
};

/**
 * Elasticsearch index `settings.analysis` block. Used by tooling / integration
 * tests that create the SML index directly (without going through the storage
 * adapter, which wires this in automatically).
 */
export const smlElasticsearchIndexAnalysis = smlIndexAnalysis;

export type SmlStorageSettings = typeof storageSettings;

export type SmlStorage = StorageIndexAdapter<SmlStorageSettings, SmlDocument>;

export const createSmlStorage = ({
  logger,
  esClient,
}: {
  logger: Logger;
  esClient: ElasticsearchClient;
}): SmlStorage => {
  return new StorageIndexAdapter<SmlStorageSettings, SmlDocument>(
    esClient,
    logger,
    storageSettings
  );
};
