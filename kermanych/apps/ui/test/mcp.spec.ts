import { describe, expect, it } from 'vitest';
import type { McpServerDef } from '@kermanych/core';
import { emptyMcpDraft, mcpDraftFrom, mcpDraftToSave, type McpDraft, type McpPair } from '../src/lib/mcp';

const pair = (over: Partial<McpPair>): McpPair => ({ key: '', value: '', secret: false, varName: '', bearer: false, stored: false, ...over });
const draft = (over: Partial<McpDraft>): McpDraft => ({ ...emptyMcpDraft(), name: 'linear', ...over });

describe('mcpDraftToSave', () => {
  it('stores a pasted Bearer token alone and writes `Bearer ${VAR}` into the header', () => {
    const out = mcpDraftToSave(
      draft({ kind: 'http', url: 'https://mcp.linear.app/mcp', pairs: [pair({ key: 'Authorization', value: 'Bearer lin_123', secret: true })] }),
    );
    expect(out).toEqual({
      body: {
        def: { kind: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${LINEAR_AUTHORIZATION}' } },
        secrets: { LINEAR_AUTHORIZATION: 'lin_123' },
      },
    });
  });

  it('names an env secret after its own key, so codex can forward it', () => {
    const out = mcpDraftToSave(
      draft({ name: 'db', command: 'npx', args: '-y\n@modelcontextprotocol/server-postgres\n', pairs: [pair({ key: 'DATABASE_URL', value: 'pg://x', secret: true })] }),
    );
    expect(out).toEqual({
      body: {
        def: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'], env: { DATABASE_URL: '${DATABASE_URL}' } },
        secrets: { DATABASE_URL: 'pg://x' },
      },
    });
  });

  it('keeps a stored secret when its value is left empty', () => {
    const def: McpServerDef = { kind: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${TOKEN}', 'X-Region': 'eu' } };
    const form = mcpDraftFrom('x', def);
    expect(form.pairs).toEqual([
      pair({ key: 'Authorization', secret: true, varName: 'TOKEN', bearer: true, stored: true }),
      pair({ key: 'X-Region', value: 'eu' }),
    ]);
    expect(mcpDraftToSave(form)).toEqual({ body: { def } });
  });

  it.each([
    [draft({ name: 'bad name', command: 'x' }), 'name'],
    [draft({ command: ' ' }), 'command'],
    [draft({ kind: 'http', url: '' }), 'url'],
    [draft({ command: 'x', pairs: [pair({ value: 'v' })] }), 'key'],
    [draft({ command: 'x', pairs: [pair({ key: 'A' }), pair({ key: 'A' })] }), 'duplicateKey'],
    [draft({ command: 'x', pairs: [pair({ key: 'A', secret: true, varName: '1BAD' })] }), 'varName'],
  ])('refuses a form with a %#th problem', (form, problem) => {
    expect(mcpDraftToSave(form)).toMatchObject({ problem });
  });

  it('drops a row added and left blank', () => {
    expect(mcpDraftToSave(draft({ command: 'x', pairs: [pair({})] }))).toEqual({ body: { def: { kind: 'stdio', command: 'x', args: [], env: {} } } });
  });
});
