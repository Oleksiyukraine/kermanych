import { describe, expect, it } from 'vitest';
import type { NoticeEntry } from '@kermanych/core';
import { toolCommandGroup, toolCommandServers } from '../src/lib/tool-commands';

const notice = (code: 'tool_commands_added' | 'tool_commands_removed', ...names: string[]): NoticeEntry => ({
  kind: 'notice', id: names.join(), at: 0, level: 'info', text: '', code, params: { names: names.join(', '), count: names.length },
});

describe('toolCommandGroup', () => {
  it('lifts one server batch prefix into the label and keeps the tool part as the item', () => {
    expect(
      toolCommandGroup('mcp__supabase_v1_execute_sql, mcp__supabase_v1_get_advisors, mcp__supabase_v1_list_tables'),
    ).toEqual({ prefix: 'supabase_v1', items: ['execute_sql', 'get_advisors', 'list_tables'] });
  });

  it('never cuts a name mid-word: the label ends at an underscore both names share', () => {
    expect(toolCommandGroup('mcp__docs_search_api, mcp__docs_searchx')).toEqual({
      prefix: 'docs',
      items: ['search_api', 'searchx'],
    });
  });

  it('keeps a lone name whole and mixed names unlabelled', () => {
    expect(toolCommandGroup('mcp__context7_query_docs')).toEqual({ prefix: '', items: ['context7_query_docs'] });
    expect(toolCommandGroup('mcp__a_x, mcp__b_y')).toEqual({ prefix: '', items: ['a_x', 'b_y'] });
  });
});

describe('toolCommandServers', () => {
  it('gives one pill per server batch, in arrival order, with its tools', () => {
    expect(
      toolCommandServers([
        notice('tool_commands_added', 'mcp__nestjs_docs_get_spec', 'mcp__nestjs_docs_search_api'),
        notice('tool_commands_added', 'mcp__supabase_v1_execute_sql', 'mcp__supabase_v1_list_tables'),
      ]),
    ).toEqual([
      { server: 'nestjs_docs', tools: ['get_spec', 'search_api'], state: 'added' },
      { server: 'supabase_v1', tools: ['execute_sql', 'list_tables'], state: 'added' },
    ]);
  });

  it('files a lone tool under a server the run already named, else lets it stand alone', () => {
    expect(
      toolCommandServers([
        notice('tool_commands_added', 'mcp__docs_get', 'mcp__docs_search'),
        notice('tool_commands_added', 'mcp__docs_list'),
        notice('tool_commands_removed', 'mcp__context7_query_docs'),
      ]),
    ).toEqual([
      { server: 'docs', tools: ['get', 'search', 'list'], state: 'added' },
      { server: 'context7_query_docs', tools: [], state: 'removed' },
    ]);
  });

  it('reports where a server ended up when it was mounted and then unmounted', () => {
    expect(
      toolCommandServers([
        notice('tool_commands_added', 'mcp__docs_get', 'mcp__docs_search'),
        notice('tool_commands_removed', 'mcp__docs_get', 'mcp__docs_search'),
      ]),
    ).toEqual([{ server: 'docs', tools: ['get', 'search'], state: 'removed' }]);
  });
});
