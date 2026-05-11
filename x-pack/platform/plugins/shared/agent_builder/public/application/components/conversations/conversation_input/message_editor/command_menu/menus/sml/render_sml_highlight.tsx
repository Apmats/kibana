/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { Fragment } from 'react';

const EM_SPLIT_RE = /<em>(.*?)<\/em>/g;

const HTML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
};

const decodeBasicEntities = (text: string): string =>
  text.replace(/&(?:lt|gt|amp|quot|#39|#x27);/g, (match) => HTML_ENTITIES[match] ?? match);

/**
 * Parses an ES highlight snippet (with matched spans wrapped in
 * `<em>...</em>` by the unified highlighter, encoder `html`) into a React
 * fragment. Matched spans become `<strong>`; everything else is plain text.
 *
 * React's text rendering handles output escaping, so the matched span only
 * needs to lift out the `<em>` markers and reverse the entity encoding ES
 * applied to the source text.
 */
export const renderSmlHighlight = (snippet: string): React.ReactNode => {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of snippet.matchAll(EM_SPLIT_RE)) {
    const matchStart = match.index ?? 0;
    if (matchStart > lastIndex) {
      parts.push(
        <Fragment key={key++}>{decodeBasicEntities(snippet.slice(lastIndex, matchStart))}</Fragment>
      );
    }
    parts.push(<strong key={key++}>{decodeBasicEntities(match[1])}</strong>);
    lastIndex = matchStart + match[0].length;
  }
  if (lastIndex < snippet.length) {
    parts.push(<Fragment key={key++}>{decodeBasicEntities(snippet.slice(lastIndex))}</Fragment>);
  }
  return <>{parts}</>;
};
