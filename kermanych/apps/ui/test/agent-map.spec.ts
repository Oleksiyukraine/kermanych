import { describe, it, expect } from 'vitest';
import type { Session, SubagentNode } from '@kermanych/core';
import {
  NODE_SIZE,
  activeAgentCount,
  ancestorIds,
  buildAgentTree,
  layoutAgentTree,
  parseMapBuckets,
  visibleSubtreeIds,
  type MapInput,
  type TreeNode,
} from '../src/lib/agentMap';

function session(over: Partial<Session> & { id: string }): Session {
  return {
    projectId: 'p1',
    name: over.id,
    task: '',
    worktreePath: '',
    branch: '',
    worktree: false,
    kind: 'agent',
    status: 'thinking',
    createdAt: '2026-10-22T10:00:00.000Z',
    lastActivityAt: '2026-10-22T10:00:00.000Z',
    ...over,
  } as Session;
}

function input(over: Partial<MapInput>): MapInput {
  return {
    sessions: [],
    subagents: {},
    projects: [
      { id: 'p1', name: 'BE' },
      { id: 'p2', name: 'FE' },
      { id: 'p3', name: 'Local' },
    ],
    projectWorkspace: { p1: 'w1', p2: 'w1' },
    workspaces: [{ id: 'w1', name: 'FS', color: '#36f' }],
    buckets: ['active', 'waiting', 'errors'],
    unknownProject: '?',
    ...over,
  };
}

// The tree as nested ids, so one assertion states its whole shape.
type Shape = { id: string; children?: Shape[] };
function shape(nodes: readonly TreeNode[]): Shape[] {
  return nodes.map((n) => (n.children.length ? { id: n.id, children: shape(n.children) } : { id: n.id }));
}

describe('buildAgentTree', () => {
  it('nests workspace → project → session → fork / subagent → nested subagent', () => {
    const subs: SubagentNode[] = [
      { id: 'T', status: 'running' },
      { id: 'T.C', parentId: 'T', status: 'running' },
      { id: 'U', status: 'done' },
    ];
    const tree = buildAgentTree(
      input({
        sessions: [
          session({ id: 'a' }),
          session({ id: 'f', kind: 'discussion', status: 'done', parentSessionId: 'a', createdAt: '2026-10-22T11:00:00.000Z' }),
        ],
        subagents: { a: subs },
      }),
    );
    expect(shape(tree)).toEqual([
      {
        id: 'ws:w1',
        children: [
          {
            id: 'p:p1',
            children: [
              {
                id: 's:a',
                children: [
                  { id: 's:f' },
                  { id: 'a:a:T', children: [{ id: 'a:a:T.C' }] },
                  { id: 'a:a:U' },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('hangs a subagent whose parent is unknown off its session rather than dropping it', () => {
    const tree = buildAgentTree(input({ sessions: [session({ id: 'a' })], subagents: { a: [{ id: 'X.Y', parentId: 'X' }] } }));
    expect(shape(tree)[0]!.children![0]!.children![0]).toEqual({ id: 's:a', children: [{ id: 'a:a:X.Y' }] });
  });

  it('files sessions by the chips: a fork follows its parent, chats and backlog never show', () => {
    const sessions = [
      session({ id: 'live' }),
      // Its own status is done, its parent's is live — it rides with «Активні».
      session({ id: 'fork', kind: 'review', status: 'done', parentSessionId: 'live' }),
      session({ id: 'idle', status: 'done' }),
      session({ id: 'broken', status: 'conflict' }),
      session({ id: 'old', status: 'merged' }),
      session({ id: 'aside', status: 'done', archived: true }),
      session({ id: 'chat', kind: 'chat' }),
      session({ id: 'todo', kind: 'task', status: 'backlog' }),
    ];
    const ids = (buckets: MapInput['buckets']) => {
      const out: string[] = [];
      const walk = (ns: readonly TreeNode[]) => ns.forEach((n) => { if (n.kind === 'session') out.push(n.session.id); walk(n.children); });
      walk(buildAgentTree(input({ sessions, buckets })));
      return out.sort();
    };
    expect(ids(['active'])).toEqual(['fork', 'live']);
    expect(ids(['waiting'])).toEqual(['idle']);
    expect(ids(['errors'])).toEqual(['broken']);
    expect(ids(['completed'])).toEqual(['aside', 'old']);
    expect(ids([])).toEqual([]);
  });

  it('lets a fork whose parent is off the map stand on its own under the project', () => {
    const tree = buildAgentTree(
      input({
        sessions: [
          session({ id: 'c', kind: 'chat' }),
          session({ id: 'f', kind: 'discussion', parentSessionId: 'c' }),
        ],
      }),
    );
    expect(shape(tree)).toEqual([{ id: 'ws:w1', children: [{ id: 'p:p1', children: [{ id: 's:f' }] }] }]);
  });

  it('prunes empty branches and puts projects without a known workspace under «no workspace», last', () => {
    const tree = buildAgentTree(
      input({
        sessions: [
          session({ id: 'local', projectId: 'p3' }),
          session({ id: 'ghost', projectId: 'gone' }),
          session({ id: 'stale', projectId: 'p2' }),
        ],
        // p2 claims a workspace the user cannot see any more.
        projectWorkspace: { p1: 'w1', p2: 'w9' },
      }),
    );
    // w1 has no session on the map, so neither it nor BE is drawn.
    expect(tree.map((n) => n.id)).toEqual(['ws:-']);
    const projects = tree[0]!.children.map((p) => (p.kind === 'project' ? p.name : ''));
    expect(projects).toEqual(['?', 'FE', 'Local']);
    expect(tree[0]!.workspace).toBeNull();
  });

  it('counts active sessions per project and workspace', () => {
    const tree = buildAgentTree(
      input({
        sessions: [
          session({ id: 'a' }),
          session({ id: 'b', status: 'waiting_input' }),
          session({ id: 'c', status: 'done' }),
          session({ id: 'd', projectId: 'p2' }),
        ],
      }),
    );
    expect(tree[0]!.active).toBe(3);
    expect(tree[0]!.children.map((p) => (p.kind === 'project' ? p.active : -1))).toEqual([2, 1]);
  });
});

describe('activeAgentCount', () => {
  it('counts working or blocked agents machine-wide, never chats or archived rows', () => {
    expect(
      activeAgentCount([
        session({ id: 'a' }),
        session({ id: 'b', status: 'queued', projectId: 'elsewhere' }),
        session({ id: 'c', kind: 'chat' }),
        session({ id: 'd', status: 'done' }),
        session({ id: 'e', archived: true }),
      ]),
    ).toBe(2);
  });
});

describe('parseMapBuckets', () => {
  it('falls back to the default for anything unreadable and keeps an empty choice', () => {
    expect(parseMapBuckets(null)).toEqual(['active', 'waiting', 'errors']);
    expect(parseMapBuckets('nope')).toEqual(['active', 'waiting', 'errors']);
    expect(parseMapBuckets('{"a":1}')).toEqual(['active', 'waiting', 'errors']);
    expect(parseMapBuckets('[]')).toEqual([]);
    expect(parseMapBuckets('["completed","tasks","active"]')).toEqual(['active', 'completed']);
  });
});

describe('layoutAgentTree', () => {
  const tree = () =>
    buildAgentTree(
      input({
        sessions: [
          session({ id: 'live', createdAt: '2026-10-22T12:00:00.000Z' }),
          session({ id: 'idle', status: 'done' }),
          session({ id: 'other', projectId: 'p2' }),
        ],
        subagents: {
          live: [{ id: 'A', status: 'running' }, { id: 'B', status: 'done' }],
          idle: [{ id: 'A', status: 'done' }, { id: 'A.B', parentId: 'A', status: 'done' }],
        },
      }),
    );

  it('folds finished agents by default and counts what the fold hides', () => {
    const layout = layoutAgentTree(tree(), new Map());
    const byId = new Map(layout.nodes.map((n) => [n.node.id, n]));
    expect(byId.get('s:live')).toMatchObject({ collapsed: false, hidden: 0, live: true });
    expect(byId.get('s:idle')).toMatchObject({ collapsed: true, hidden: 2, live: false });
    expect(byId.has('a:idle:A')).toBe(false);
    expect(byId.has('a:live:B')).toBe(true);
  });

  it('lets the operator unfold and fold against the default', () => {
    const layout = layoutAgentTree(tree(), new Map([['s:idle', false], ['s:live', true]]));
    const ids = new Set(layout.nodes.map((n) => n.node.id));
    expect(ids.has('a:idle:A')).toBe(true);
    // A's own subtree finished too, so it starts folded inside the unfolded session.
    expect(ids.has('a:idle:A.B')).toBe(false);
    expect(ids.has('a:live:A')).toBe(false);
  });

  it('places children below their parent, centred, with no overlap on a level', () => {
    const layout = layoutAgentTree(tree(), new Map([['s:idle', false], ['a:idle:A', false]]));
    const byId = new Map(layout.nodes.map((n) => [n.node.id, n]));
    const centre = (id: string) => {
      const n = byId.get(id)!;
      return n.x + NODE_SIZE[n.node.kind].w / 2;
    };
    for (const e of layout.edges) {
      const s = byId.get(e.source)!;
      const t = byId.get(e.target)!;
      expect(t.y).toBeGreaterThanOrEqual(s.y + NODE_SIZE[s.node.kind].h);
    }
    // A parent sits over the middle of its children's span.
    const kids = layout.edges.filter((e) => e.source === 'p:p1').map((e) => centre(e.target));
    expect(centre('p:p1')).toBeCloseTo((Math.min(...kids) + Math.max(...kids)) / 2);
    const levels = new Map<number, typeof layout.nodes>();
    for (const n of layout.nodes) levels.set(n.y, [...(levels.get(n.y) ?? []), n]);
    for (const row of levels.values()) {
      const sorted = [...row].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]!.x).toBeGreaterThanOrEqual(sorted[i - 1]!.x + NODE_SIZE[sorted[i - 1]!.node.kind].w);
      }
    }
  });

  it('marks edges by kind and makes the path down to a working agent flow', () => {
    const layout = layoutAgentTree(tree(), new Map());
    const edge = (id: string) => layout.edges.find((e) => e.id === id)!;
    expect(edge('ws:w1>p:p1')).toMatchObject({ kind: 'belongs', live: true });
    expect(edge('p:p1>s:live')).toMatchObject({ kind: 'belongs', live: true });
    expect(edge('p:p1>s:idle')).toMatchObject({ kind: 'belongs', live: false });
    expect(edge('s:live>a:live:A')).toMatchObject({ kind: 'spawned', live: true });
    expect(edge('s:live>a:live:B')).toMatchObject({ kind: 'spawned', live: false });
  });

  it('finds what a focus has to unfold and what it fits into view', () => {
    const roots = tree();
    expect(ancestorIds(roots, 'a:idle:A.B')).toEqual(['ws:w1', 'p:p1', 's:idle', 'a:idle:A']);
    expect(ancestorIds(roots, 's:nope')).toBeUndefined();
    const layout = layoutAgentTree(roots, new Map());
    expect(visibleSubtreeIds(layout, 's:live').sort()).toEqual(['a:live:A', 'a:live:B', 's:live']);
    expect(visibleSubtreeIds(layout, 's:idle')).toEqual(['s:idle']);
  });
});
