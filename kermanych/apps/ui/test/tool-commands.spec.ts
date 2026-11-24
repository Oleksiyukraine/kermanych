import { describe, expect, it } from 'vitest';
import { toolCommandGroup } from '../src/lib/tool-commands';

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
