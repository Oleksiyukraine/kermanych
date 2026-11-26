import { describe, expect, it } from 'vitest';
import { mcpToCodex, type McpServerDef } from '@kermanych/core';
import { emptyMcpDraft, mcpDraftFrom, mcpDraftToSave, type McpDraft, type McpPair } from '../src/lib/mcp';
import { MCP_CATALOG, mcpCatalogDraft } from '../src/lib/mcp-catalog';

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

describe('MCP catalog', () => {
  it('every entry saves as it is listed and reaches codex too', () => {
    for (const entry of MCP_CATALOG) {
      const out = mcpDraftToSave(mcpCatalogDraft(entry));
      if (!('body' in out)) throw new Error(`${entry.id}: ${out.problem}`);
      expect(out.body.def, entry.id).toEqual(entry.def);
      expect(mcpToCodex(out.body.def), entry.id).toHaveProperty('table');
    }
    expect(new Set(MCP_CATALOG.map((e) => e.name)).size).toBe(MCP_CATALOG.length);
  });

  // docs/specs/2026-11-26-agentic-maturity-quick-wins.md: `npx -y` runs whatever the registry
  // serves, so a local entry must name an exact release, not `@latest` or a range.
  it('pins every local server to an exact package version', () => {
    for (const entry of MCP_CATALOG) {
      if (entry.def.kind !== 'stdio') continue;
      expect(entry.def.args[1], entry.id).toMatch(/^(@[^/]+\/)?[^@]+@\d+\.\d+\.\d+$/);
    }
  });

  it('asks for the key instead of offering to keep one, and stores a pasted token alone', () => {
    const github = mcpCatalogDraft(MCP_CATALOG.find((e) => e.id === 'github')!);
    const [header] = github.pairs;
    expect(header).toMatchObject({ key: 'Authorization', secret: true, varName: 'GITHUB_PAT', stored: false, placeholder: 'github_pat_…' });
    header!.value = 'Bearer github_pat_123';
    expect(mcpDraftToSave(github)).toMatchObject({ body: { def: { headers: { Authorization: 'Bearer ${GITHUB_PAT}' } }, secrets: { GITHUB_PAT: 'github_pat_123' } } });
  });
});
