// «Синергія» (docs/specs/2026-11-06-synergy.md): fast prototyping on the live app. An agent
// session stamped with `synergy`, run on a `synergy/<slug>` branch by a fast model with a narrow
// toolset. Kermanych commits a checkpoint after every turn; git is the only store of the steps,
// so the strip, a restore and the «Імплементувати» brief all read `git log <base>..HEAD`.

import type { ThinkingLevel } from "./thinking";

// Decision 3: the start form's defaults. The project default stands in when this model is not
// in the machine's catalogue.
export const SYNERGY_DEFAULT_MODEL = "claude-sonnet-5-5";
export const SYNERGY_DEFAULT_EFFORT: ThinkingLevel = "low";

// Decision 2: the comment that marks every stub the prototype hardcodes.
export const SYNERGY_MOCK_MARK = "synergy-mock";

// The block the UI appends to a request (decision 8): the page the operator looks at and the
// elements they pointed at. Everything before it is the operator's own words.
export const SYNERGY_CONTEXT_MARK = "[synergy-context]";

const SUBJECT_PREFIX = "synergy: ";
const SUBJECT_MAX = 72;
const PAGE_TRAILER = "Synergy-Page: ";
const RESTORE_TRAILER = "Synergy-Restore: ";

// One message as the agent receives it: the request, then the context block.
export function synergyMessage(request: string, ctx: { page?: string | undefined; picks?: string | undefined }): string {
  const lines: string[] = [];
  if (ctx.page) lines.push(`Current page: ${ctx.page}`);
  if (ctx.picks?.trim()) lines.push(ctx.picks.trim());
  const text = request.trim();
  if (!lines.length) return text;
  return `${text ? `${text}\n\n` : ""}${SYNERGY_CONTEXT_MARK}\n${lines.join("\n\n")}`;
}

// What the operator asked, without the context block, and the page it was asked on.
export function synergyRequestOf(message: string): { request: string; page?: string } {
  const at = message.indexOf(SYNERGY_CONTEXT_MARK);
  const request = (at < 0 ? message : message.slice(0, at)).trim();
  const page = at < 0 ? undefined : /^Current page: (\S+)$/m.exec(message.slice(at))?.[1];
  return page ? { request, page } : { request };
}

// The checkpoint commit of one turn: the requests it answered (a steer adds one), the last page.
export function synergyCheckpointMessage(requests: readonly { request: string; page?: string }[]): string {
  const asked = requests.map((r) => r.request.trim()).filter(Boolean);
  const request = asked.join("\n\n") || "зміни";
  const first = request.split("\n")[0]!.trim();
  const subject = SUBJECT_PREFIX + (first.length > SUBJECT_MAX ? `${first.slice(0, SUBJECT_MAX - 1)}…` : first);
  const page = [...requests].reverse().find((r) => r.page)?.page;
  return `${subject}\n\n${request}${page ? `\n\n${PAGE_TRAILER}${page}` : ""}`;
}

// «Повернутися сюди»: the commit that brings back the tree of step `n` (0 = the start).
export function synergyRestoreMessage(n: number, sha: string): string {
  return `${SUBJECT_PREFIX}повернуто до кроку ${n}\n\n${RESTORE_TRAILER}${sha}`;
}

export type SynergyCommit = { sha: string; at: string; message: string };

export type SynergyStep = {
  sha: string;
  // 1-based, in commit order; restores are steps too.
  n: number;
  at: string;
  kind: "change" | "restore";
  // A change: what the operator asked. A restore: its subject.
  request: string;
  page?: string;
  // A restore: the sha it brought back (the start's sha for step 0).
  restoreOf?: string;
};

// `GET /sessions/:id/synergy/steps`: the base branch, the fork point (step 0, «Початок») and
// the steps after it, oldest first.
export type SynergyStepsView = { base: string; startSha: string; steps: SynergyStep[] };

// The steps among a branch's commits, oldest first. Commits Kermanych did not write are skipped.
export function synergySteps(commits: readonly SynergyCommit[]): SynergyStep[] {
  const steps: SynergyStep[] = [];
  for (const c of commits) {
    const [subject = "", ...rest] = c.message.replace(/\r\n/g, "\n").split("\n");
    if (!subject.startsWith(SUBJECT_PREFIX)) continue;
    const body = rest.join("\n").trim();
    const restore = body.split("\n").find((l) => l.startsWith(RESTORE_TRAILER));
    const n = steps.length + 1;
    if (restore) {
      steps.push({ sha: c.sha, n, at: c.at, kind: "restore", request: subject.slice(SUBJECT_PREFIX.length), restoreOf: restore.slice(RESTORE_TRAILER.length).trim() });
      continue;
    }
    // The co-author trailer every Kermanych commit carries is not part of the request.
    const lines = body.split("\n").filter((l) => !/^Co-Authored-By:/i.test(l));
    const pageLine = lines.findIndex((l) => l.startsWith(PAGE_TRAILER));
    const page = pageLine >= 0 ? lines[pageLine]!.slice(PAGE_TRAILER.length).trim() : undefined;
    const request = (pageLine >= 0 ? lines.filter((_, i) => i !== pageLine) : lines).join("\n").trim() || subject.slice(SUBJECT_PREFIX.length);
    steps.push({ sha: c.sha, n, at: c.at, kind: "change", request, ...(page ? { page } : {}) });
  }
  return steps;
}

// The requests that survive in the tree at HEAD: a restore drops every change made after the
// step it went back to. `startSha` is the fork point (step 0).
export function synergyChronology(steps: readonly SynergyStep[], startSha: string): { request: string; page?: string }[] {
  const at = new Map<string, { request: string; page?: string }[]>([[startSha, []]]);
  let cur: { request: string; page?: string }[] = [];
  for (const s of steps) {
    if (s.kind === "restore") cur = at.get(s.restoreOf ?? "") ?? [];
    else cur = [...cur, s.page ? { request: s.request, page: s.page } : { request: s.request }];
    at.set(s.sha, cur);
  }
  return cur;
}

// The brief «Імплементувати» hands over (decision 6): the card's description and the
// implementer's `{{brief}}`. The diff is not in it: the agent reads it from git.
export function synergyBrief(input: { startPage?: string | undefined; requests: readonly { request: string; page?: string }[] }): string {
  const parts: string[] = [];
  if (input.startPage) parts.push(`Start page: ${input.startPage}`);
  const list = input.requests.map((r, i) => {
    const body = r.request.split("\n").map((l, j) => (j === 0 ? `${i + 1}. ${l}` : `   ${l}`)).join("\n");
    return r.page ? `${body}\n   Page: ${r.page}` : body;
  });
  parts.push(`Operator requests, in order (rolled-back steps excluded):\n${list.length ? list.join("\n") : "(none)"}`);
  return parts.join("\n\n");
}
