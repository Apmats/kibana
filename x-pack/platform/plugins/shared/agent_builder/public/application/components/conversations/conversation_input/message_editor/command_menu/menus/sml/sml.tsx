/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { forwardRef, useCallback, useMemo } from 'react';
import { css } from '@emotion/react';
import { useEuiTheme } from '@elastic/eui';
import type { SmlMatchedDiscoveryLabel } from '@kbn/agent-context-layer-plugin/public';
import { useSmlAutocomplete } from '../../../../../../../hooks/sml/use_sml_autocomplete';
import { useAgentId } from '../../../../../../../hooks/use_conversation';
import { useAgentBuilderAgentById } from '../../../../../../../hooks/agents/use_agent_by_id';
import type { CommandMenuComponentProps, CommandMenuHandle } from '../../types';
import { CommandId } from '../../types';
import { buildSmlFiltersFromAgent } from '../../utils/sml_filters';
import { CommandMenuList } from '../components/command_menu_list';
import type { CommandMenuListOption } from '../components/command_menu_list';
import { renderSmlHighlight } from './render_sml_highlight';

const TITLE_KIND = 'title';
const TYPE_KIND = 'type';

const pickMatchByKind = (
  matched: SmlMatchedDiscoveryLabel[] | undefined,
  kind: string
): SmlMatchedDiscoveryLabel | undefined => matched?.find((m) => m.kind === kind);

export const Sml = forwardRef<CommandMenuHandle, CommandMenuComponentProps>(
  ({ query, onSelect }, ref) => {
    const agentId = useAgentId();
    const { agent } = useAgentBuilderAgentById(agentId);
    const filters = useMemo(() => buildSmlFiltersFromAgent(agent), [agent]);
    const { euiTheme } = useEuiTheme();
    const { results, isLoading } = useSmlAutocomplete(query, { filters });

    const styles = useMemo(
      () => ({
        root: css`
          display: flex;
          flex-direction: column;
          gap: ${euiTheme.size.xxs};
          word-break: break-word;
        `,
        primary: css`
          display: inline;
        `,
        typeSegment: css`
          font-weight: ${euiTheme.font.weight.medium};
        `,
        matches: css`
          color: ${euiTheme.colors.subduedText};
          font-size: ${euiTheme.size.m};
        `,
        matchEntry: css`
          margin-right: ${euiTheme.size.s};
        `,
      }),
      [euiTheme.colors.subduedText, euiTheme.font.weight.medium, euiTheme.size]
    );

    const options: CommandMenuListOption[] = useMemo(
      () =>
        results.map((item) => {
          const titleMatch = pickMatchByKind(item.matched_discovery_labels, TITLE_KIND);
          const typeMatch = pickMatchByKind(item.matched_discovery_labels, TYPE_KIND);
          const otherMatches = (item.matched_discovery_labels ?? []).filter(
            (m) => m.kind !== TITLE_KIND && m.kind !== TYPE_KIND
          );

          const titleNode = titleMatch?.highlighted
            ? renderSmlHighlight(titleMatch.highlighted)
            : item.title;
          const typeNode = typeMatch?.highlighted
            ? renderSmlHighlight(typeMatch.highlighted)
            : item.type;

          return {
            key: item.id,
            label: `${item.type}/${item.title}`,
            renderLabel: (
              <span css={styles.root}>
                <span css={styles.primary}>
                  <span css={styles.typeSegment}>{typeNode}</span>
                  <span>/</span>
                  <span>{titleNode}</span>
                </span>
                {otherMatches.length > 0 && (
                  <span css={styles.matches}>
                    {otherMatches.map((match, idx) => (
                      <span key={`${match.kind}-${idx}`} css={styles.matchEntry}>
                        {match.kind}:{' '}
                        {match.highlighted ? renderSmlHighlight(match.highlighted) : match.value}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            ),
          };
        }),
      [results, styles]
    );

    const handleSelect = useCallback(
      (option: CommandMenuListOption) => {
        onSelect({
          commandId: CommandId.Sml,
          label: option.label,
          id: option.key,
          metadata: {},
        });
      },
      [onSelect]
    );

    return (
      <CommandMenuList
        ref={ref}
        options={options}
        isLoading={isLoading}
        onSelect={handleSelect}
        data-test-subj="smlMenu"
      />
    );
  }
);
