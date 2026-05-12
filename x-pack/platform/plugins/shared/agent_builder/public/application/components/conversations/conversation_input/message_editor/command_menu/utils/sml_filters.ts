/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentDefinition } from '@kbn/agent-builder-common/agents/definition';
import type { SmlSearchScoping } from '@kbn/agent-context-layer-plugin/public';
import { SmlSearchFilterType } from '@kbn/agent-context-layer-plugin/public';

// Three states: undefined → no scoping (all connectors visible),
// [] → no connectors allowed, ['id1', ...] → only those connectors.
//
// Produces the runtime-imposed `scoping` payload (Sean Story's #267333
// trust-boundary shape). Distinct from the agent-discoverable `filters`
// dimensions added in #14363 — those live in the LLM tool input, not the
// FE @ menu.
export const buildSmlScopingFromAgent = (
  agent: AgentDefinition | null
): SmlSearchScoping | undefined => {
  const connectorIds = agent?.configuration?.connector_ids;
  if (connectorIds === undefined) {
    return undefined;
  }
  return { [SmlSearchFilterType.connector]: { ids: connectorIds } };
};
