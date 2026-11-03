// apps/ui/src/lib/agentMap.ts
// «Карта агентів» (spec docs/specs/2026-10-22-agent-map.md): every agent on this machine as
// one top-down tree — workspace → project → session → fork → subagent → nested subagent.
// The decisions (what is on the map, what starts folded, where each node sits) live here as
// pure functions, because apps/ui has no component tests (see lib/scope.ts:1-3); AgentMap.vue
// only hands the result to Vue Flow.
import { ACTIVE_STATUSES, type Session, type SubagentNode } from '@kermanych/core';
import { bucketOf, readBucket, type Bucket } from './buckets';
import { byNewestLaunch } from './agents-board';

// The chips above the map: the «Агенти» tabs minus «Задачі» — a backlog card has no agent
// behind it. Same rule as the tabs (bucketOf), so a fork follows its parent's bucket.
export type MapBucket = Exclude<Bucket, 'tasks'>;
export const MAP_BUCKETS: readonly MapBucket[] = ['agents', 'completed'];
// Everything still in play; the finished history is one chip away.
export const DEFAULT_MAP_BUCKETS: readonly MapBucket[] = ['agents'];

// The chip choice as stored in localStorage. Anything unreadable — absent, not JSON, from an
// older build — reads as the default; an EMPTY list is a real choice (every chip off) and stays.
// A choice stored before the three agent buckets merged («active», «waiting», «errors») reads
// through readBucket as «agents»: dropping those names would turn the usual stored value into
// an empty list, and the map would open blank after the update.
export function parseMapBuckets(raw: string | null): MapBucket[] {
  if (raw === null) return [...DEFAULT_MAP_BUCKETS];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [...DEFAULT_MAP_BUCKETS];
    const chosen = new Set(value.map(readBucket));
    return MAP_BUCKETS.filter((b) => chosen.has(b));
  } catch {
    return [...DEFAULT_MAP_BUCKETS];
  }
}

export type MapWorkspace = { id: string; name: string; color?: string | undefined; icon?: string | undefined };

export type MapInput = {
  sessions: readonly Session[];
  subagents: Readonly<Record<string, readonly SubagentNode[]>>;
  // Local project rows: the name a project reads as, online or not.
  projects: readonly { id: string; name: string }[];
  // projectId → workspaceId, the store's map (cloud, or the cached tree while offline).
  projectWorkspace: Readonly<Record<string, string>>;
  // In the sidebar's order.
  workspaces: readonly MapWorkspace[];
  buckets: readonly MapBucket[];
  // The name of a project with no local row.
  unknownProject: string;
};

type Base = { id: string; children: TreeNode[] };
export type WorkspaceNode = Base & { kind: 'workspace'; workspace: MapWorkspace | null; active: number };
export type ProjectNode = Base & { kind: 'project'; projectId: string; name: string; color: string | undefined; active: number };
export type SessionNode = Base & { kind: 'session'; session: Session };
export type SubagentTreeNode = Base & { kind: 'subagent'; sessionId: string; subagent: SubagentNode };
export type TreeNode = WorkspaceNode | ProjectNode | SessionNode | SubagentTreeNode;
export type NodeKind = TreeNode['kind'];

// Node ids, one namespace for the whole map: Vue Flow keys nodes and edges by them, and the
// collapse overrides outlive a re-render by them.
export const workspaceNodeId = (id: string | null): string => `ws:${id ?? '-'}`;
export const projectNodeId = (id: string): string => `p:${id}`;
export const sessionNodeId = (id: string): string => `s:${id}`;
export const subagentNodeId = (sessionId: string, id: string): string => `a:${sessionId}:${id}`;

export function isActiveSession(s: Session): boolean {
  return !s.archived && ACTIVE_STATUSES.includes(s.status);
}

// The button's «N активних»: machine-wide, the same «active» the sidebar means. Chats are not
// agents on this page, so they do not count.
export function activeAgentCount(sessions: readonly Session[]): number {
  return sessions.filter((s) => s.kind !== 'chat' && isActiveSession(s)).length;
}

// An agent that is working right now (or blocked on the operator).
function isLive(n: TreeNode): boolean {
  if (n.kind === 'session') return isActiveSession(n.session);
  if (n.kind === 'subagent') return n.subagent.status === 'running';
  return false;
}

export function hasLive(n: TreeNode): boolean {
  return isLive(n) || n.children.some(hasLive);
}

function countActive(n: TreeNode): number {
  const own = n.kind === 'session' && isActiveSession(n.session) ? 1 : 0;
  return own + n.children.reduce((sum, c) => sum + countActive(c), 0);
}

function subagentChildren(sessionId: string, rows: readonly SubagentNode[]): TreeNode[] {
  const nodes = new Map<string, SubagentTreeNode>();
  for (const r of rows) nodes.set(r.id, { kind: 'subagent', id: subagentNodeId(sessionId, r.id), sessionId, subagent: r, children: [] });
  const roots: TreeNode[] = [];
  for (const r of rows) {
    const node = nodes.get(r.id)!;
    // A child whose parent the registry has not reported (yet) hangs off the session rather
    // than vanishing.
    const parent = r.parentId !== undefined && r.parentId !== r.id ? nodes.get(r.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

// The tree for the chosen chips. Empty branches are not drawn: a project with no session on
// the map is absent, a workspace with no such project too.
export function buildAgentTree(input: MapInput): WorkspaceNode[] {
  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  const parent = (id: string) => byId.get(id);
  const chosen = new Set<Bucket>(input.buckets);
  const shown = input.sessions
    .filter((s) => s.kind !== 'chat' && s.status !== 'backlog' && chosen.has(bucketOf(s, parent)))
    .sort(byNewestLaunch);
  const shownIds = new Set(shown.map((s) => s.id));

  const sessionNodes = new Map<string, SessionNode>();
  for (const s of shown) {
    sessionNodes.set(s.id, { kind: 'session', id: sessionNodeId(s.id), session: s, children: [] });
  }
  // Forks first (newest first, as `shown`), then the subagents the session itself spawned.
  const projectRoots = new Map<string, SessionNode[]>();
  for (const s of shown) {
    const node = sessionNodes.get(s.id)!;
    const p = s.parentSessionId;
    // A fork whose parent is not on the map (a chat, or filtered out) stands on its own.
    if (p && p !== s.id && shownIds.has(p)) sessionNodes.get(p)!.children.push(node);
    else {
      const list = projectRoots.get(s.projectId) ?? [];
      list.push(node);
      projectRoots.set(s.projectId, list);
    }
  }
  for (const node of sessionNodes.values()) {
    node.children.push(...subagentChildren(node.session.id, input.subagents[node.session.id] ?? []));
  }

  const projectNames = new Map(input.projects.map((p) => [p.id, p.name]));
  const workspaceById = new Map(input.workspaces.map((w) => [w.id, w]));
  const byWorkspace = new Map<string | null, ProjectNode[]>();
  for (const [projectId, children] of projectRoots) {
    const wsId = input.projectWorkspace[projectId];
    const ws = wsId !== undefined ? workspaceById.get(wsId) : undefined;
    const project: ProjectNode = {
      kind: 'project',
      id: projectNodeId(projectId),
      projectId,
      name: projectNames.get(projectId) ?? input.unknownProject,
      color: ws?.color,
      active: 0,
      children,
    };
    project.active = countActive(project);
    const key = ws ? ws.id : null;
    const list = byWorkspace.get(key) ?? [];
    list.push(project);
    byWorkspace.set(key, list);
  }

  const order: (MapWorkspace | null)[] = [...input.workspaces, null];
  const roots: WorkspaceNode[] = [];
  for (const ws of order) {
    const projects = byWorkspace.get(ws ? ws.id : null);
    if (!projects?.length) continue;
    projects.sort((a, b) => a.name.localeCompare(b.name));
    const node: WorkspaceNode = { kind: 'workspace', id: workspaceNodeId(ws ? ws.id : null), workspace: ws, active: 0, children: projects };
    node.active = countActive(node);
    roots.push(node);
  }
  return roots;
}

// Whether a node starts folded. Structure (workspace, project) is always open: folding it
// would turn a chip of waiting agents into a row of bare project names. An agent with
// children is open while anything under it works, folded once all of it has finished.
export function collapsedByDefault(n: TreeNode): boolean {
  if (n.kind === 'workspace' || n.kind === 'project') return false;
  return n.children.length > 0 && !hasLive(n);
}

// The operator's own toggles win over the default, by node id.
export function isCollapsed(n: TreeNode, overrides: ReadonlyMap<string, boolean>): boolean {
  if (!n.children.length) return false;
  return overrides.get(n.id) ?? collapsedByDefault(n);
}

// A node's ancestors, root first — what a focus has to unfold so that the target is on
// screen. `undefined` when the node is not on the map at all.
export function ancestorIds(roots: readonly TreeNode[], id: string): string[] | undefined {
  for (const r of roots) {
    if (r.id === id) return [];
    const below = ancestorIds(r.children, id);
    if (below) return [r.id, ...below];
  }
  return undefined;
}

// Card sizes, shared with AgentMap.vue: the layout needs them before anything renders, so the
// components take these as fixed boxes rather than sizing to their content.
export const NODE_SIZE: Record<NodeKind, { w: number; h: number }> = {
  workspace: { w: 220, h: 52 },
  project: { w: 220, h: 52 },
  session: { w: 264, h: 96 },
  subagent: { w: 244, h: 84 },
};
export const H_GAP = 28;
export const V_GAP = 64;

export type PlacedNode = {
  node: TreeNode;
  // Top-left, as Vue Flow positions a node.
  x: number;
  y: number;
  depth: number;
  collapsed: boolean;
  // Every descendant a fold hides; 0 when open.
  hidden: number;
  live: boolean;
};
export type EdgeKind = 'belongs' | 'spawned';
export type PlacedEdge = { id: string; source: string; target: string; kind: EdgeKind; live: boolean };
export type MapLayout = { nodes: PlacedNode[]; edges: PlacedEdge[] };

function descendants(n: TreeNode): number {
  return n.children.reduce((sum, c) => sum + 1 + descendants(c), 0);
}

// A tidy top-down tree: a subtree is as wide as its children's subtrees side by side (or its
// own card, if wider), a parent sits centred over its children, levels share one baseline per
// depth (the tallest card of that depth plus V_GAP), and the roots stand side by side.
export function layoutAgentTree(roots: readonly TreeNode[], overrides: ReadonlyMap<string, boolean>): MapLayout {
  const widths = new Map<string, number>();
  const measure = (n: TreeNode): number => {
    let w = NODE_SIZE[n.kind].w;
    if (n.children.length && !isCollapsed(n, overrides)) {
      const kids = n.children.reduce((sum, c) => sum + measure(c), 0) + H_GAP * (n.children.length - 1);
      w = Math.max(w, kids);
    }
    widths.set(n.id, w);
    return w;
  };

  const placed: Omit<PlacedNode, 'y'>[] = [];
  const edges: PlacedEdge[] = [];
  const levelHeight: number[] = [];
  // Returns the node's centre x, so the parent can sit over its children's centres rather
  // than over the middle of their subtrees — a wide subtree on one side would otherwise pull
  // the parent off its own children. Clamped to its subtree, so it never crosses a neighbour.
  const place = (n: TreeNode, left: number, depth: number): number => {
    const width = widths.get(n.id)!;
    const size = NODE_SIZE[n.kind];
    const collapsed = isCollapsed(n, overrides);
    levelHeight[depth] = Math.max(levelHeight[depth] ?? 0, size.h);
    let centre = left + width / 2;
    if (n.children.length && !collapsed) {
      const kids = n.children.reduce((sum, c) => sum + widths.get(c.id)!, 0) + H_GAP * (n.children.length - 1);
      let x = left + (width - kids) / 2;
      const centres: number[] = [];
      for (const c of n.children) {
        edges.push({
          id: `${n.id}>${c.id}`,
          source: n.id,
          target: c.id,
          kind: n.kind === 'workspace' || n.kind === 'project' ? 'belongs' : 'spawned',
          // The whole path down to a working agent flows, so a busy branch reads from the top.
          live: hasLive(c),
        });
        centres.push(place(c, x, depth + 1));
        x += widths.get(c.id)! + H_GAP;
      }
      const half = size.w / 2;
      centre = Math.min(Math.max((centres[0]! + centres[centres.length - 1]!) / 2, left + half), left + width - half);
    }
    placed.push({ node: n, x: centre - size.w / 2, depth, collapsed, hidden: collapsed ? descendants(n) : 0, live: isLive(n) });
    return centre;
  };

  // Roots stand apart by twice the sibling gap, so two workspaces never read as one row.
  let left = 0;
  for (const r of roots) {
    const width = measure(r);
    place(r, left, 0);
    left += width + H_GAP * 2;
  }

  const top: number[] = [];
  let y = 0;
  for (let d = 0; d < levelHeight.length; d++) {
    top[d] = y;
    y += (levelHeight[d] ?? 0) + V_GAP;
  }
  return { nodes: placed.map((p) => ({ ...p, y: top[p.depth]! })), edges };
}

// The ids a focus fits into view: the node and whatever of its subtree is drawn.
export function visibleSubtreeIds(layout: MapLayout, id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const e of layout.edges) if (e.source === out[i]) out.push(e.target);
  }
  return out;
}
