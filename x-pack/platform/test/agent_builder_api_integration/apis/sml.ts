/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import expect from '@kbn/expect';
import { v4 as uuidv4 } from 'uuid';
import { smlElasticsearchIndexMappings, smlIndexName } from '@kbn/agent-builder-plugin/server';
import type { SmlAttachHttpResponse } from '@kbn/agent-builder-plugin/common/http_api/sml';
import type {
  SmlSearchHttpResponse,
  SmlAutocompleteHttpResponse,
} from '@kbn/agent-context-layer-plugin/common/http_api/sml';
import type { FtrProviderContext } from '../../api_integration/ftr_provider_context';
import { createLlmProxy, type LlmProxy } from '../utils/llm_proxy';
import { setupAgentDirectAnswer } from '../utils/proxy_scenario';
import {
  createLlmProxyActionConnector,
  deleteActionConnector,
} from '../utils/llm_proxy/llm_proxy_action_connector';
import { createAgentBuilderApiClient } from '../utils/agent_builder_client';

export default function ({ getService }: FtrProviderContext) {
  const supertest = getService('supertest');
  const es = getService('es');
  const log = getService('log');
  const agentBuilderApiClient = createAgentBuilderApiClient(supertest);

  describe('SML internal API', function () {
    this.tags(['skipServerless']);

    describe('POST /internal/agent_context_layer/sml/_search', () => {
      const runId = uuidv4();
      const chunkId = `sml-ftr-search-${runId}`;
      const originId = `sml-ftr-origin-${runId}`;
      const indexedTitle = `sml ftr search pacific bluefin ${runId}`;

      before(async () => {
        const exists = await es.indices.exists({ index: smlIndexName });
        if (!exists) {
          await es.indices.create({
            index: smlIndexName,
            mappings: smlElasticsearchIndexMappings,
          });
        }

        const now = '2024-06-01T12:00:00.000Z';
        await es.index({
          index: smlIndexName,
          id: chunkId,
          refresh: 'wait_for',
          document: {
            id: chunkId,
            type: 'visualization',
            title: indexedTitle,
            origin_id: originId,
            content: 'pacific bluefin tuna content for sml ftr',
            created_at: now,
            updated_at: now,
            spaces: ['default'],
            permissions: [],
          },
        });
      });

      after(async () => {
        try {
          await es.delete({
            index: smlIndexName,
            id: chunkId,
            refresh: true,
          });
        } catch {
          // ignore cleanup failures
        }
      });

      it('returns a hit when a full-term query matches the title (BM25)', async () => {
        const response = await supertest
          .post('/internal/agent_context_layer/sml/_search')
          .set('kbn-xsrf', 'kibana')
          .set('x-elastic-internal-origin', 'kibana')
          .send({ query: 'pacific', size: 20 })
          .expect(200);

        const body = response.body as SmlSearchHttpResponse;
        expect(body.total).to.be.greaterThan(0);
        const match = body.results.find((r) => r.id === chunkId);
        expect(match).to.be.ok();
        expect(match!.title).to.contain('pacific');
        expect(match!.origin_id).to.be(originId);
        expect(match!.type).to.be('visualization');
      });

      it('returns total and a compact item shape (no content blob) for wildcard', async () => {
        const response = await supertest
          .post('/internal/agent_context_layer/sml/_search')
          .set('kbn-xsrf', 'kibana')
          .set('x-elastic-internal-origin', 'kibana')
          .send({ query: '*', size: 10 })
          .expect(200);

        const body = response.body as SmlSearchHttpResponse;

        expect(body).to.have.property('total');
        expect(body.total).to.be.a('number');
        expect(body).to.have.property('results');
        expect(body.results).to.be.an('array');

        for (const item of body.results) {
          expect(item).to.have.property('id');
          expect(item.id).to.be.a('string');
          expect(item).to.have.property('origin_id');
          expect(item).to.have.property('type');
          expect(item).to.have.property('title');
          expect(item).to.have.property('score');
          expect(item.score).to.be.a('number');
          // Compact LLM-shape: full content blob is intentionally not returned
          // on search hits; callers fetch via sml_read when more_content is true.
          expect(item).not.to.have.property('content');
        }
      });

      it('rejects an empty query string', async () => {
        await supertest
          .post('/internal/agent_context_layer/sml/_search')
          .set('kbn-xsrf', 'kibana')
          .set('x-elastic-internal-origin', 'kibana')
          .send({ query: '' })
          .expect(400);
      });
    });

    describe('POST /internal/agent_context_layer/sml/_autocomplete', () => {
      const runId = uuidv4();
      const chunkId = `sml-ftr-autocomp-${runId}`;
      const originId = `sml-ftr-ac-origin-${runId}`;
      const recordType = `ftrtype${runId.replace(/-/g, '').slice(0, 8)}`;
      // Distinct tokens chosen so the prefix queries below match only this record.
      const titleValue = `unicornsprocket ${runId}`;
      const taglineValue = `ferromagnetic-${runId}`;

      before(async () => {
        const exists = await es.indices.exists({ index: smlIndexName });
        if (!exists) {
          await es.indices.create({
            index: smlIndexName,
            mappings: smlElasticsearchIndexMappings,
          });
        }
        const now = '2024-06-01T12:00:00.000Z';
        await es.index({
          index: smlIndexName,
          id: chunkId,
          refresh: 'wait_for',
          document: {
            id: chunkId,
            type: recordType,
            title: titleValue,
            origin_id: originId,
            content: `autocomplete content for ${runId}`,
            // Indexer auto-prepends title + type into discovery_labels at write
            // time. Here we index via raw `es.index` so we mirror that shape
            // explicitly to exercise the route end-to-end.
            discovery_labels: [
              { value: titleValue, kind: 'title' },
              { value: recordType, kind: 'type' },
              { value: taglineValue, kind: 'tagline' },
            ],
            created_at: now,
            updated_at: now,
            spaces: ['default'],
            permissions: [],
          },
        });
      });

      after(async () => {
        try {
          await es.delete({ index: smlIndexName, id: chunkId, refresh: true });
        } catch {
          // ignore cleanup failures
        }
      });

      it('matches a short prefix against the auto-prepended title label', async () => {
        const response = await supertest
          .post('/internal/agent_context_layer/sml/_autocomplete')
          .set('kbn-xsrf', 'kibana')
          .set('x-elastic-internal-origin', 'kibana')
          .send({ query: 'unicorn', size: 10 })
          .expect(200);

        const body = response.body as SmlAutocompleteHttpResponse;
        const match = body.results.find((r) => r.id === chunkId);
        expect(match).to.be.ok();
        expect(match!.type).to.be(recordType);
        expect(match!.title).to.be(titleValue);
        expect(match!.origin_id).to.be(originId);

        const titleLabel = match!.matched_discovery_labels?.find((l) => l.kind === 'title');
        expect(titleLabel).to.be.ok();
        expect(titleLabel!.value).to.be(titleValue);
        // `highlighted` is omitted here because SAYT + bool_prefix + nested
        // inner_hits doesn't return useful highlight snippets in current ES
        // (bug elastic/elasticsearch#53744). The route is forward-compatible:
        // UI handles `highlighted` when present, plain `value` otherwise.
        expect(titleLabel!.highlighted).to.be(undefined);
      });

      it('matches a producer-supplied tagline label and surfaces its kind', async () => {
        const response = await supertest
          .post('/internal/agent_context_layer/sml/_autocomplete')
          .set('kbn-xsrf', 'kibana')
          .set('x-elastic-internal-origin', 'kibana')
          .send({ query: 'ferro', size: 10 })
          .expect(200);

        const body = response.body as SmlAutocompleteHttpResponse;
        const match = body.results.find((r) => r.id === chunkId);
        expect(match).to.be.ok();
        const taglineLabel = match!.matched_discovery_labels?.find((l) => l.kind === 'tagline');
        expect(taglineLabel).to.be.ok();
        expect(taglineLabel!.value).to.be(taglineValue);
        expect(taglineLabel!.highlighted).to.be(undefined);
      });

      it('matches a prefix of the auto-prepended type label', async () => {
        const typePrefix = recordType.slice(0, 5);
        const response = await supertest
          .post('/internal/agent_context_layer/sml/_autocomplete')
          .set('kbn-xsrf', 'kibana')
          .set('x-elastic-internal-origin', 'kibana')
          .send({ query: typePrefix, size: 10 })
          .expect(200);

        const body = response.body as SmlAutocompleteHttpResponse;
        const match = body.results.find((r) => r.id === chunkId);
        expect(match).to.be.ok();
        const typeLabel = match!.matched_discovery_labels?.find((l) => l.kind === 'type');
        expect(typeLabel).to.be.ok();
        expect(typeLabel!.value).to.be(recordType);
      });

      it('returns the result with the expected shape (no content, no permissions)', async () => {
        const response = await supertest
          .post('/internal/agent_context_layer/sml/_autocomplete')
          .set('kbn-xsrf', 'kibana')
          .set('x-elastic-internal-origin', 'kibana')
          .send({ query: 'unicorn', size: 10 })
          .expect(200);

        const body = response.body as SmlAutocompleteHttpResponse;
        const match = body.results.find((r) => r.id === chunkId);
        expect(match).to.be.ok();
        // Autocomplete responses are deliberately narrow — these belong to
        // /sml/_search, not /sml/_autocomplete.
        expect(match).not.to.have.property('content');
        expect(match).not.to.have.property('description');
        expect(match).not.to.have.property('permissions');
        expect(match).not.to.have.property('spaces');
        expect(match).not.to.have.property('score');
      });

      it('rejects an empty query string', async () => {
        await supertest
          .post('/internal/agent_context_layer/sml/_autocomplete')
          .set('kbn-xsrf', 'kibana')
          .set('x-elastic-internal-origin', 'kibana')
          .send({ query: '' })
          .expect(400);
      });
    });

    describe('POST /internal/agent_builder/sml/_attach', () => {
      let llmProxy: LlmProxy;
      let connectorId: string;
      const runId = uuidv4();
      const chunkId = `sml-ftr-attach-${runId}`;
      const indexedTitle = `sml ftr attach ${runId}`;

      before(async () => {
        llmProxy = await createLlmProxy(log);
        connectorId = await createLlmProxyActionConnector(getService, { port: llmProxy.getPort() });

        const exists = await es.indices.exists({ index: smlIndexName });
        if (!exists) {
          await es.indices.create({
            index: smlIndexName,
            mappings: smlElasticsearchIndexMappings,
          });
        }

        const now = '2024-06-01T12:00:00.000Z';
        await es.index({
          index: smlIndexName,
          id: chunkId,
          refresh: 'wait_for',
          document: {
            id: chunkId,
            type: 'connector',
            title: indexedTitle,
            origin_id: connectorId,
            content: `attach content for ${runId}`,
            created_at: now,
            updated_at: now,
            spaces: ['default'],
            permissions: [],
          },
        });
      });

      after(async () => {
        llmProxy.close();
        await deleteActionConnector(getService, { actionId: connectorId });

        try {
          await es.delete({
            index: smlIndexName,
            id: chunkId,
            refresh: true,
          });
        } catch {
          // ignore cleanup failures
        }
      });

      it('returns 404 when the conversation does not exist', async () => {
        const response = await supertest
          .post('/internal/agent_builder/sml/_attach')
          .set('kbn-xsrf', 'kibana')
          .set('x-elastic-internal-origin', 'kibana')
          .send({
            conversation_id: 'non-existent-conversation-id-for-sml-attach-ftr',
            chunk_ids: ['irrelevant-chunk-id-for-sml-attach-ftr'],
          })
          .expect(404);

        expect(response.body).to.have.property('message');
      });

      it('attaches SML items and persists conversation attachment refs', async () => {
        await setupAgentDirectAnswer({
          proxy: llmProxy,
          title: `SML attach title ${runId}`,
          response: 'SML attach response',
        });

        const converseResponse = await agentBuilderApiClient.converse({
          input: 'Create round for SML attach',
          attachments: [
            {
              type: 'text',
              data: {
                content: `existing text attachment ${runId}`,
              },
            },
          ],
          connector_id: connectorId,
        });

        await llmProxy.waitForAllInterceptorsToHaveBeenCalled();

        const attachResponse = await supertest
          .post('/internal/agent_builder/sml/_attach')
          .set('kbn-xsrf', 'kibana')
          .set('x-elastic-internal-origin', 'kibana')
          .send({
            conversation_id: converseResponse.conversation_id,
            chunk_ids: [chunkId],
          })
          .expect(200);

        // Assert the attachment was created successfully
        const attachBody = attachResponse.body as SmlAttachHttpResponse;
        expect(attachBody.results).to.have.length(1);
        expect(attachBody.results[0].success).to.be(true);

        // Assert all attachments are present in the conversation
        const conversation = await agentBuilderApiClient.getConversation(
          converseResponse.conversation_id
        );
        const attachments = conversation.attachments ?? [];
        expect(attachments[0].type).to.be('text');
        expect(attachments[1].type).to.be('connector');

        // Assert the attachment refs are present
        const lastRound = conversation.rounds[conversation.rounds.length - 1];
        expect(lastRound.input.attachment_refs?.[0].attachment_id).to.be(attachments[0].id);
        expect(lastRound.input.attachment_refs?.[1].attachment_id).to.be(attachments[1].id);
      });
    });
  });
}
