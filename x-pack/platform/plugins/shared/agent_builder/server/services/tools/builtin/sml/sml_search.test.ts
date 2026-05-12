/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { platformCoreTools, ToolType } from '@kbn/agent-builder-common';
import { ToolResultType, type OtherResult } from '@kbn/agent-builder-common/tools/tool_result';
import type { ToolHandlerContext } from '@kbn/agent-builder-server/tools/handler';
import type { SmlSearchResult } from '@kbn/agent-context-layer-plugin/server';
import { createSmlSearchTool } from './sml_search';

const mockSearch = jest.fn();
const getAgentContextLayer = jest.fn(() => ({
  search: mockSearch,
  checkItemsAccess: jest.fn(),
  indexAttachment: jest.fn(),
  getDocuments: jest.fn(),
  getTypeDefinition: jest.fn(),
  resolveSmlAttachItems: jest.fn(),
}));

const mockContext = {
  spaceId: 'default',
  esClient: { asCurrentUser: {}, asInternalUser: {} },
  request: {},
  savedObjectsClient: {},
  attachments: { add: jest.fn() },
};

describe('createSmlSearchTool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('has correct id and tags', () => {
    const tool = createSmlSearchTool({ getAgentContextLayer });
    expect(tool.id).toBe(platformCoreTools.smlSearch);
    expect(tool.type).toBe(ToolType.builtin);
    expect(tool.tags).toEqual(['sml', 'search']);
  });

  it('description mentions workflows, wildcard query, and the types/tags filters', () => {
    const tool = createSmlSearchTool({ getAgentContextLayer });
    expect(tool.description).toContain('workflows');
    expect(tool.description).toContain('"*"');
    expect(tool.description).toContain('types');
    expect(tool.description).toContain('tags');
    expect(tool.description).toContain('sml_read');
  });

  it('calls search with correct params (no scoping, no filters by default)', async () => {
    mockSearch.mockResolvedValue({ results: [], total: 0 });
    const tool = createSmlSearchTool({ getAgentContextLayer });
    await tool.handler(
      { query: 'cpu usage', size: 20 },
      mockContext as unknown as ToolHandlerContext
    );
    expect(getAgentContextLayer).toHaveBeenCalled();
    expect(mockSearch).toHaveBeenCalledWith({
      query: 'cpu usage',
      size: 20,
      spaceId: 'default',
      esClient: mockContext.esClient,
      request: mockContext.request,
      scoping: undefined,
      filters: undefined,
    });
  });

  it('forwards agent-supplied types and tags as `filters` to the service', async () => {
    mockSearch.mockResolvedValue({ results: [], total: 0 });
    const tool = createSmlSearchTool({ getAgentContextLayer });
    await tool.handler(
      { query: 'sales', types: ['dashboard'], tags: ['production'] },
      mockContext as unknown as ToolHandlerContext
    );
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: { types: ['dashboard'], tags: ['production'] },
      })
    );
  });

  it('omits filters when types/tags are empty arrays (treated as no constraint)', async () => {
    mockSearch.mockResolvedValue({ results: [], total: 0 });
    const tool = createSmlSearchTool({ getAgentContextLayer });
    await tool.handler(
      { query: 'sales', types: [], tags: [] },
      mockContext as unknown as ToolHandlerContext
    );
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ filters: undefined }));
  });

  it('maps document fields to the compact LLM-friendly hit shape', async () => {
    const hits: SmlSearchResult[] = [
      {
        id: 'chunk-1',
        origin_id: 'ref-1',
        type: 'visualization',
        title: 'CPU Chart',
        description: 'A CPU chart',
        tags: ['perf'],
        references: ['dashboard://abc'],
        score: 0.95,
        spaces: ['default'],
        permissions: [],
        more_content: true,
      },
    ];
    mockSearch.mockResolvedValue({ results: hits, total: 1 });
    const tool = createSmlSearchTool({ getAgentContextLayer });
    const result = (await tool.handler(
      { query: 'cpu' },
      mockContext as unknown as ToolHandlerContext
    )) as {
      results: unknown[];
    };
    expect(result.results).toHaveLength(1);
    const data = (result.results[0] as OtherResult<{ total: number; items: unknown[] }>).data;
    expect(data.total).toBe(1);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toEqual({
      chunk_id: 'chunk-1',
      attachment_id: 'ref-1',
      attachment_type: 'visualization',
      type: 'visualization',
      title: 'CPU Chart',
      description: 'A CPU chart',
      tags: ['perf'],
      references: ['dashboard://abc'],
      more_content: true,
      score: 0.95,
    });
    expect((result.results[0] as { type: string }).type).toBe(ToolResultType.other);
  });

  it('returns "No results found" when empty', async () => {
    mockSearch.mockResolvedValue({ results: [], total: 0 });
    const tool = createSmlSearchTool({ getAgentContextLayer });
    const result = (await tool.handler(
      { query: 'nonexistent' },
      mockContext as unknown as ToolHandlerContext
    )) as {
      results: unknown[];
    };
    expect(result.results).toHaveLength(1);
    const data = (
      result.results[0] as OtherResult<{
        message: string;
        query: string;
        total: number;
        items: unknown[];
      }>
    ).data;
    expect(data.message).toBe('No results found in the Semantic Metadata Layer.');
    expect(data.query).toBe('nonexistent');
    expect(data.total).toBe(0);
    expect(data.items).toEqual([]);
    expect((result.results[0] as { type: string }).type).toBe(ToolResultType.other);
  });

  it('uses default size when not provided', async () => {
    mockSearch.mockResolvedValue({ results: [], total: 0 });
    const tool = createSmlSearchTool({ getAgentContextLayer });
    await tool.handler({ query: 'test' }, mockContext as unknown as ToolHandlerContext);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'test',
        size: undefined,
      })
    );
  });

  it('passes connector_ids as `scoping` (runtime-imposed) from agentConfiguration', async () => {
    mockSearch.mockResolvedValue({ results: [], total: 0 });
    const contextWithConnectors = {
      ...mockContext,
      agentConfiguration: { connector_ids: ['conn-1', 'conn-2'], tools: [] },
    };

    const tool = createSmlSearchTool({ getAgentContextLayer });
    await tool.handler({ query: 'test' }, contextWithConnectors as unknown as ToolHandlerContext);

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        scoping: { connector: { ids: ['conn-1', 'conn-2'] } },
        filters: undefined,
      })
    );
  });

  it('does not pass scoping when agentConfiguration has no connector_ids', async () => {
    mockSearch.mockResolvedValue({ results: [], total: 0 });
    const contextWithoutConnectors = {
      ...mockContext,
      agentConfiguration: { tools: [] },
    };

    const tool = createSmlSearchTool({ getAgentContextLayer });
    await tool.handler(
      { query: 'test' },
      contextWithoutConnectors as unknown as ToolHandlerContext
    );

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        scoping: undefined,
      })
    );
  });

  it('passes empty connector ids scoping when connector_ids is []', async () => {
    mockSearch.mockResolvedValue({ results: [], total: 0 });
    const contextWithEmptyConnectors = {
      ...mockContext,
      agentConfiguration: { connector_ids: [], tools: [] },
    };

    const tool = createSmlSearchTool({ getAgentContextLayer });
    await tool.handler(
      { query: 'test' },
      contextWithEmptyConnectors as unknown as ToolHandlerContext
    );

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        scoping: { connector: { ids: [] } },
      })
    );
  });

  it('does not pass scoping when agentConfiguration is undefined', async () => {
    mockSearch.mockResolvedValue({ results: [], total: 0 });

    const tool = createSmlSearchTool({ getAgentContextLayer });
    await tool.handler({ query: 'test' }, mockContext as unknown as ToolHandlerContext);

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        scoping: undefined,
      })
    );
  });

  it('combines runtime scoping (connectors) with agent-supplied filters', async () => {
    mockSearch.mockResolvedValue({ results: [], total: 0 });
    const contextWithConnectors = {
      ...mockContext,
      agentConfiguration: { connector_ids: ['conn-1'], tools: [] },
    };

    const tool = createSmlSearchTool({ getAgentContextLayer });
    await tool.handler(
      { query: 'test', types: ['connector'], tags: ['prod'] },
      contextWithConnectors as unknown as ToolHandlerContext
    );

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        scoping: { connector: { ids: ['conn-1'] } },
        filters: { types: ['connector'], tags: ['prod'] },
      })
    );
  });
});
