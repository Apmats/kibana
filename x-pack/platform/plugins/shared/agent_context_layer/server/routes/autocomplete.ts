/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { CoreSetup, IRouter, Logger } from '@kbn/core/server';
import type { RouteSecurity } from '@kbn/core-http-server';
import { AGENT_CONTEXT_LAYER_EXPERIMENTAL_FEATURES_SETTING_ID } from '@kbn/management-settings-ids';
import { apiPrivileges } from '../../common/features';
import type {
  SmlAutocompleteHttpResponse,
  SmlAutocompleteHttpResultItem,
} from '../../common/http_api/sml';
import {
  SML_HTTP_AUTOCOMPLETE_QUERY_MAX_LENGTH,
  SmlSearchFilterType,
} from '../../common/http_api/sml';
import { smlAutocompletePath } from '../../common/constants';
import type { SmlService } from '../services/sml/types';
import type { AgentContextLayerStartDependencies, AgentContextLayerPluginStart } from '../types';

const SML_AUTOCOMPLETE_SIZE_MAX = 50;

const AGENT_CONTEXT_LAYER_READ_SECURITY: RouteSecurity = {
  authz: { requiredPrivileges: [apiPrivileges.readAgentContextLayer] },
};

export const registerAutocompleteRoute = ({
  router,
  coreSetup,
  logger,
  getSmlService,
}: {
  router: IRouter;
  coreSetup: CoreSetup<AgentContextLayerStartDependencies, AgentContextLayerPluginStart>;
  logger: Logger;
  getSmlService: () => SmlService;
}) => {
  router.post(
    {
      path: smlAutocompletePath,
      validate: {
        body: schema.object({
          query: schema.string({ minLength: 1, maxLength: SML_HTTP_AUTOCOMPLETE_QUERY_MAX_LENGTH }),
          size: schema.maybe(schema.number({ min: 1, max: SML_AUTOCOMPLETE_SIZE_MAX })),
          // Runtime-imposed per-type scoping (e.g. agent-centric connector
          // allow-list). Same shape as the `scoping` field on POST /sml/_search
          // so a single FE scope-builder can feed either route.
          scoping: schema.maybe(
            schema.recordOf(
              schema.literal(SmlSearchFilterType.connector),
              schema.object({
                ids: schema.maybe(schema.arrayOf(schema.string(), { maxSize: 100 })),
              })
            )
          ),
          // Caller-supplied type/tag refinements — same shape as on POST /sml/_search.
          // Useful for specialized UI pickers (e.g. connectors-only @ menu).
          filters: schema.maybe(
            schema.object({
              types: schema.maybe(schema.arrayOf(schema.string(), { maxSize: 100 })),
              tags: schema.maybe(schema.arrayOf(schema.string(), { maxSize: 100 })),
            })
          ),
        }),
      },
      options: { access: 'internal' },
      security: AGENT_CONTEXT_LAYER_READ_SECURITY,
    },
    async (ctx, request, response) => {
      try {
        const coreContext = await ctx.core;
        const uiSettingsClient = coreContext.uiSettings.client;

        const isEnabled = await uiSettingsClient.get<boolean>(
          AGENT_CONTEXT_LAYER_EXPERIMENTAL_FEATURES_SETTING_ID
        );
        if (!isEnabled) {
          return response.notFound();
        }

        const sml = getSmlService();
        const { query, size, scoping, filters } = request.body;
        const esClient = coreContext.elasticsearch.client;

        const [, startDeps] = await coreSetup.getStartServices();
        const spaceId = startDeps.spaces?.spacesService?.getSpaceId(request) ?? 'default';

        const { results } = await sml.autocomplete({
          query,
          size,
          spaceId,
          esClient,
          request,
          scoping,
          filters,
        });

        const body: SmlAutocompleteHttpResponse = {
          results: results.map(({ id, type, origin_id, title, matched_discovery_labels }) => {
            const item: SmlAutocompleteHttpResultItem = { id, type, origin_id, title };
            if (matched_discovery_labels && matched_discovery_labels.length > 0) {
              item.matched_discovery_labels = matched_discovery_labels;
            }
            return item;
          }),
        };

        return response.ok({ body });
      } catch (error) {
        logger.error(`SML autocomplete route error: ${(error as Error).message}`);
        throw error;
      }
    }
  );
};
