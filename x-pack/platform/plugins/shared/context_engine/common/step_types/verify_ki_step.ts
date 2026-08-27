/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import { StepCategory } from '@kbn/workflows';
import { z } from '@kbn/zod/v4';
import type { CommonStepDefinition } from '@kbn/workflows-extensions/common';
import { kiPartialFieldsSchema, MAX_KI_ATTRIBUTE_KEY_LENGTH } from './ki';

export const VERIFY_KI_STEP_TYPE_ID = 'context-engine.verifyKi';

export const DEFAULT_ESQL_ATTRIBUTE = 'esql';

export const MAX_ESQL_ATTRIBUTES = 20;
export const MAX_VERIFIER_IDS = 20;

export interface VerifyKiOptions {
  'esql-valid-schema'?: {
    field_verification?: 'enabled' | 'dynamic' | 'disabled';
  };
  [verifierId: string]: Record<string, unknown> | undefined;
}

export const VerifyKiInputSchema = z.object({
  ki: kiPartialFieldsSchema,
  esql_attributes: z
    .array(z.string().min(1).max(MAX_KI_ATTRIBUTE_KEY_LENGTH))
    .max(MAX_ESQL_ATTRIBUTES)
    .optional()
    .describe(
      `Names of the KI attributes carrying ES|QL to verify, defaulting to '${DEFAULT_ESQL_ATTRIBUTE}'. A listed attribute the KI does not carry is skipped, not failed.`
    ),
  verifiers: z
    .array(z.string().min(1).max(100))
    .max(MAX_VERIFIER_IDS)
    .optional()
    .describe(
      'Verifier ids to run. Required: no verifiers listed means no verification runs. Unknown ids are silently ignored.'
    ),
  options: z
    .object({
      'esql-valid-schema': z
        .object({
          field_verification: z
            .enum(['enabled', 'dynamic', 'disabled'])
            .optional()
            .describe(
              "Controls ES|QL field verification for the 'esql-valid-schema' verifier. 'enabled' (default): checks index existence and semantically validates source, pipeline, join, and ENRICH fields. 'dynamic': performs the same validation while allowing absent source fields whose mappings permit dynamic creation, without assuming a future type. 'disabled': checks index existence only."
            ),
        })
        .optional(),
    })
    .optional()
    .describe('Per-verifier configuration options, keyed by verifier id.'),
});

export const VerifyKiOutputSchema = z.object({
  passed: z.boolean(),
  results: z.array(
    z.object({
      verifier: z.string(),
      passed: z.boolean(),
      reason: z.string().optional(),
    })
  ),
});

export type VerifyKiInputSchemaType = typeof VerifyKiInputSchema;
export type VerifyKiOutputSchemaType = typeof VerifyKiOutputSchema;

export const VerifyKiStepCommonDefinition: CommonStepDefinition<
  VerifyKiInputSchemaType,
  VerifyKiOutputSchemaType
> = {
  id: VERIFY_KI_STEP_TYPE_ID,
  category: StepCategory.Kibana,
  inputSchema: VerifyKiInputSchema,
  outputSchema: VerifyKiOutputSchema,
  label: i18n.translate('xpack.contextEngine.verifyKiStep.label', {
    defaultMessage: 'Verify Knowledge Indicator',
  }),
  description: i18n.translate('xpack.contextEngine.verifyKiStep.description', {
    defaultMessage: 'Runs the Context Engine KI verifiers against a knowledge indicator',
  }),
  documentation: {
    details: i18n.translate('xpack.contextEngine.verifyKiStep.documentation.details', {
      defaultMessage:
        'The {stepTypeId} step runs applicable Context Engine verifiers and returns a pass/fail result for each one. Three verifiers apply to ES|QL: `esql-valid-syntax` performs local parsing and static language checks; `esql-valid-schema` uses cluster metadata and enrich policies without running the complete query; and `esql-valid-runtime` performs bounded query execution. Schema and runtime checks use the permissions of the workflow user, including for cross-cluster search, so authorization failures are execution errors rather than missing-resource results. Set `options.esql-valid-schema.field_verification` to `dynamic` to allow structurally eligible future dynamic fields or to `disabled` to check only index existence; it defaults to `enabled`. The verifiers read the attributes listed in `esql_attributes`, defaulting to `attributes.{defaultAttribute}`. Missing configured attributes are skipped, and if the knowledge indicator carries none, the step passes with empty results. Requires the Context Engine advanced setting.',
      values: { stepTypeId: VERIFY_KI_STEP_TYPE_ID, defaultAttribute: DEFAULT_ESQL_ATTRIBUTE },
    }),
    examples: [
      `## Verify a knowledge indicator's ES|QL
\`\`\`yaml
- name: verify_ki
  type: ${VERIFY_KI_STEP_TYPE_ID}
  with:
    ki:
      type: detection
      title: Failed login burst
      attributes:
        esql: 'FROM logs-* | WHERE event.outcome == "failure" | STATS c = COUNT(*) BY user.name'
\`\`\``,
      `## Verify ES|QL held in custom attributes
\`\`\`yaml
- name: verify_ki
  type: ${VERIFY_KI_STEP_TYPE_ID}
  with:
    esql_attributes:
      - aggregation_query
      - sampling_query
    ki: "{{ steps.construct_ki.output }}"
\`\`\``,
    ],
  },
};
