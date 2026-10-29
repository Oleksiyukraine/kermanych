// apps/ui/src/lib/agents-board.ts
// The Агенти board's list decisions, kept out of the .vue file (the tasks-view.ts rule):
// what the search box matches, and what «newest at the top» means for the two kinds of row
// the column holds — a local session and a cloud backlog card. Pure functions over the two
// types; no store, no i18n, no DOM.
import type { Session } from '@kermanych/core';
import type { Task } from '@kermanych/cloud';

// Both filters tokenise the way every other list in the app does (menu.ts's filterByQuery,
// jira-view's filterIssues): whitespace splits the query and EVERY token must appear
// somewhere in the row, in any order — so «auth opus» finds the auth agent that also runs
// Opus, with the two words landing in different fields.
//
// Sessions: the haystack is what the card SHOWS — its name, its branch, its model — plus the brief
// the agent was launched with. `task` is the operator's own plain text, unlike the
// server-rendered markup filterIssues deliberately refuses, and «what did I ask that one to
// do» is the question a board of thirty rows gets searched with. The status is NOT in it:
// the word on screen («працює», «помилка») is an i18n lookup this module has no business
// making, and the rail's buckets already filter by exactly that.
//
// An empty query returns the input array itself, not a copy: this runs on every keystroke
// and the resting state is «nothing typed yet».
export function filterSessions(sessions: readonly Session[], query: string): readonly Session[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return sessions;
  return sessions.filter((s) => {
    const hay = `${s.name} ${s.branch} ${s.model ?? ''} ${s.task}`.toLowerCase();
    return tokens.every((tok) => hay.includes(tok));
  });
}

// The backlog inbox's half of the same box. A card has no branch of its own to name (its
// `branch` is the BASE branch it would fork from) and no activity — title, description and
// model are everything it carries.
export function filterTaskCards(tasks: readonly Task[], query: string): readonly Task[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return tasks;
  return tasks.filter((c) => {
    const hay = `${c.title} ${c.description ?? ''} ${c.model ?? ''}`.toLowerCase();
    return tokens.every((tok) => hay.includes(tok));
  });
}

// Timestamps arrive from two sources — the api's `new Date().toISOString()` and Postgres
// `timestamptz` — whose text forms differ in the fraction and the zone suffix
// («…:00Z» vs «…:00.123456+00:00»). Parsed rather than compared as strings, so rows from the
// two never order by punctuation. An unparseable stamp sorts as the epoch instead of
// poisoning the comparator with NaN, which would leave the whole list in arbitrary order.
function instant(iso: string): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
}

/**
 * Newest first: the freshest row leads, the stalest closes the list.
 *
 * A session's freshness is `lastActivityAt` — the api stamps it on every event — so the row
 * the operator is most likely to want is the one under the cursor, and a finished agent
 * sinks as newer work arrives. `createdAt` breaks a tie, which is what keeps two rows
 * stamped in the same millisecond (a batch launch) in a stable order rather than swapping
 * places on every re-render.
 */
export function byNewestSession(a: Session, b: Session): number {
  const byActivity = instant(b.lastActivityAt) - instant(a.lastActivityAt);
  return byActivity !== 0 ? byActivity : instant(b.createdAt) - instant(a.createdAt);
}

/**
 * Launch order, newest first: the order inside each group of the «Агенти» tab.
 *
 * Every running agent stamps `lastActivityAt` on each event, so ordering live rows by it made
 * two agents working at once swap places on every tool call — the card under the cursor
 * jumped away. `createdAt` never moves while an agent runs: a row keeps its slot for the
 * whole run, and only a new launch (which lands at the top) or a change of group changes the
 * list. The id breaks a same-millisecond tie (a batch launch), so the
 * order never depends on the order the store happened to hand the rows over.
 */
export function byNewestLaunch(a: Session, b: Session): number {
  const byLaunch = instant(b.createdAt) - instant(a.createdAt);
  if (byLaunch !== 0) return byLaunch;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The same order for backlog cards, whose only activity is being edited: `updatedAt`. */
export function byNewestTask(a: Task, b: Task): number {
  const byUpdate = instant(b.updatedAt) - instant(a.updatedAt);
  return byUpdate !== 0 ? byUpdate : instant(b.createdAt) - instant(a.createdAt);
}

/**
 * How fresh a whole group is — the newest row in it — so that under a workspace scope the
 * per-project runs of cards keep the same «newest at the top» promise the rows inside them
 * do. Empty group: the epoch, i.e. last.
 */
export function newestActivityAt(rows: readonly Session[]): number {
  let newest = 0;
  for (const s of rows) {
    const at = instant(s.lastActivityAt);
    if (at > newest) newest = at;
  }
  return newest;
}

/** The launch-order equivalent: a group leads on its newest launch, which never moves mid-run. */
export function newestLaunchAt(rows: readonly Session[]): number {
  let newest = 0;
  for (const s of rows) {
    const at = instant(s.createdAt);
    if (at > newest) newest = at;
  }
  return newest;
}

/** The card equivalent, over `updatedAt`. */
export function newestUpdateAt(rows: readonly Task[]): number {
  let newest = 0;
  for (const c of rows) {
    const at = instant(c.updatedAt);
    if (at > newest) newest = at;
  }
  return newest;
}

// The states in which an agent cannot move on without the operator: it asked a question, it
// crashed, or its worktree is mid-merge. «Агенти» puts these first — with the sidebar's
// «Помилки N» gone, the list's top is the one place such an agent is shown without the
// operator having to spot a red dot among twenty green ones.
const NEEDS_HUMAN: readonly Session['status'][] = ['waiting_input', 'error', 'conflict'];
export function needsHuman(s: Session): boolean {
  return NEEDS_HUMAN.includes(s.status);
}

/**
 * The order of the «Агенти» tab: the rows that need a human first, then the rest, each part
 * in launch order. A card moves only when it enters or leaves the first part — exactly the
 * moment worth noticing — and two agents working at once never trade places.
 *
 * A fork stays right under its parent, so it is the FAMILY that is ranked: a parent leads the
 * first part when it or any fork under it needs the operator (a discussion waiting for an
 * answer is the operator's business as much as its parent's question). Inside a family the
 * forks follow in launch order. A fork whose parent is not in `rows` heads its own family.
 */
export function agentsOrder(rows: readonly Session[]): Session[] {
  const ids = new Set(rows.map((s) => s.id));
  const children = new Map<string, Session[]>();
  const heads: Session[] = [];
  for (const s of rows) {
    const parent = s.parentSessionId;
    if (parent && ids.has(parent)) {
      const list = children.get(parent);
      if (list) list.push(s);
      else children.set(parent, [s]);
    } else {
      heads.push(s);
    }
  }
  const rank = new Map<string, number>(
    heads.map((h) => [h.id, needsHuman(h) || children.get(h.id)?.some(needsHuman) ? 0 : 1]),
  );
  heads.sort((a, b) => rank.get(a.id)! - rank.get(b.id)! || byNewestLaunch(a, b));
  const out: Session[] = [];
  for (const head of heads) {
    out.push(head);
    const forks = children.get(head.id);
    if (forks) out.push(...forks.sort(byNewestLaunch));
  }
  return out;
}

/**
 * Group order for the «Агенти» tab under a workspace scope: a project with a row that needs
 * the operator leads, the rest follow by their newest launch — the tab's own rule one level
 * up, so the top of the column is the top of the list inside it.
 */
export function byAgentsGroup(a: readonly Session[], b: readonly Session[]): number {
  const urgent = Number(b.some(needsHuman)) - Number(a.some(needsHuman));
  return urgent !== 0 ? urgent : newestLaunchAt(b) - newestLaunchAt(a);
}
