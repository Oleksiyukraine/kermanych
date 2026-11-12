// apps/api/src/skills/skill-improvement.service.ts
// «Самовдосконалення скілів» (docs/specs/2026-11-04-skill-self-improvement.md): what the
// `improve_skill` tool does. The edits are applied at once to the operator's PERSONAL layer (an
// `ai_skills` row at user scope, under their own JWT), never to a team row, and every change is
// recorded in `skill_improvements` so the browser can list, diff and roll it back. Every refusal
// is a tool text the agent can act on; nothing here throws to the MCP caller.
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  SKILL_IMPROVEMENTS_PER_SESSION,
  SKILL_TEXT_MAX,
  applySkillEdits,
  skillTextBytes,
  validateImproveSkillArgs,
  type SkillEdit,
  type SkillTeamScope,
} from "@kermanych/core";
import {
  countSessionSkillImprovements,
  deleteAiSkill,
  getAiSkill,
  insertSkillImprovement,
  listAppliedSkillImprovements,
  upsertAiSkill,
} from "@kermanych/cloud";
import { RegistryService } from "../registry/registry.service";
import { AuthService } from "../auth/auth.service";
import { isTesterSession } from "../tester/tester-tools";
import { HandedSkills, SkillsService, repoSkillNames, resolveSkills, type AiScopeSet } from "./skills.service";

/** The cloud calls the service makes; a seam so specs pass fakes. */
export type SkillImprovementCloud = {
  getAiSkill: typeof getAiSkill;
  upsertAiSkill: typeof upsertAiSkill;
  deleteAiSkill: typeof deleteAiSkill;
  insertSkillImprovement: typeof insertSkillImprovement;
  countSessionSkillImprovements: typeof countSessionSkillImprovements;
  listAppliedSkillImprovements: typeof listAppliedSkillImprovements;
};

// A token nothing in the app provides: production gets the real calls, specs pass fakes.
export const SKILL_IMPROVEMENT_CLOUD = "SKILL_IMPROVEMENT_CLOUD";

const DEFAULT_CLOUD: SkillImprovementCloud = {
  getAiSkill,
  upsertAiSkill,
  deleteAiSkill,
  insertSkillImprovement,
  countSessionSkillImprovements,
  listAppliedSkillImprovements,
};

export type ImproveResult = { ok: boolean; text: string };

const no = (text: string): ImproveResult => ({ ok: false, text });
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const unreachable = (err: unknown) => no(`Not applied: the skill library is unreachable (${msg(err)}). Continue your task.`);

// Edits applied to `base`, or the refusal the agent gets — with the current text, so a stale
// `find` can be corrected in one more call.
function edited(name: string, base: string, edits: SkillEdit[]): { body: string } | ImproveResult {
  const r = applySkillEdits(base, edits);
  if (!r.ok) {
    const why =
      r.reason === "missing"
        ? "does not occur in the skill's current text. Copy it verbatim from the text below and try again."
        : "occurs more than once in the skill's current text. Include more of the surrounding text so it matches exactly once.";
    return no(`Not applied: edit ${r.index + 1}'s \`find\` ${why}\n\n--- current text of ${name} ---\n${base}`);
  }
  const bytes = skillTextBytes(r.text);
  if (bytes > SKILL_TEXT_MAX) return no(`Not applied: the result would be ${bytes} bytes; a skill may be at most ${SKILL_TEXT_MAX}.`);
  return { body: r.text };
}

@Injectable()
export class SkillImprovementService {
  // One in-flight improvement per user and skill: two calls racing on the same personal row
  // would each read the same base and the second write would silently drop the first's edits.
  private chains = new Map<string, Promise<unknown>>();
  private cloud: SkillImprovementCloud;

  constructor(
    private registry: RegistryService,
    private skills: SkillsService,
    private auth: AuthService,
    @Optional() @Inject(SKILL_IMPROVEMENT_CLOUD) cloud?: SkillImprovementCloud,
    // What each launch handed the agent (docs/specs/2026-11-07-skill-improvement-review.md,
    // decision 3). Optional and last so specs construct the service without it — then no call is
    // refused as stale.
    @Optional() private handed?: HandedSkills,
  ) {
    this.cloud = cloud ?? DEFAULT_CLOUD;
  }

  async improve(sessionId: string, rawArgs: unknown): Promise<ImproveResult> {
    const v = validateImproveSkillArgs(rawArgs);
    if (!v.ok) return no(`Not applied: ${v.error}.`);
    const args = v.args;
    const session = this.registry.listSessions().find((s) => s.id === sessionId);
    if (!session) return no("This session no longer exists.");
    if (session.native || (session.kind !== "agent" && session.kind !== "chat") || isTesterSession(session))
      return no("improve_skill is not available in this session.");
    if (this.registry.skillImprovementLevel() === "off")
      return no("Not applied: the operator has turned skill improvement off. Mention the lesson in your reply instead.");
    const userId = this.auth.current()?.userId;
    if (!userId) return no("Not applied: Kermanych is not signed in to the cloud, where the skill library lives. Continue your task.");

    const project = this.registry.listProjects().find((p) => p.id === session.projectId);
    // The same owners the session's launch read (SupervisorService.aiScope).
    const scope: AiScopeSet = { projectId: session.projectId, userId };
    if (project?.workspaceId) scope.workspaceId = project.workspaceId;
    const cwd = session.worktreePath || project?.localRepoPath || "";

    const key = `${userId}:${args.skill}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(() => this.apply(sessionId, session.name, scope, userId, cwd, args));
    const tail = run.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    try {
      return await run;
    } catch (err) {
      return unreachable(err);
    }
  }

  private async apply(
    sessionId: string,
    sessionName: string,
    scope: AiScopeSet,
    userId: string,
    cwd: string,
    args: { skill: string; edits: SkillEdit[]; summary: string; reason: string },
  ): Promise<ImproveResult> {
    const name = args.skill;
    // A repository skill outranks the library at materialisation, so a personal copy would
    // never reach a session: say so rather than write something dead.
    let repo: Map<string, string>;
    try {
      repo = await repoSkillNames(cwd);
    } catch (err) {
      return no(`Not applied: the repository's skill folders could not be read (${msg(err)}). Continue your task.`);
    }
    const repoPath = repo.get(name);
    if (repoPath !== undefined)
      return no(
        `Not applied: "${name}" is a repository skill (${repoPath}); it outranks the library, so a personal copy would never be used. Propose the change with report_finding instead.`,
      );

    // The editor's read: the edits apply to the cloud's text, not to a launch's cached copy of it
    // (SkillsService.readSkills), which may predate an improvement or a rollback made seconds ago.
    let rows;
    try {
      rows = await this.skills.readSkills(scope, true);
    } catch (err) {
      return unreachable(err);
    }
    const entry = resolveSkills(rows).find((r) => r.def.name === name);
    if (!entry)
      return no(`Not applied: "${name}" is not a skill of the Kermanych library. Skills from home folders or harness plugins are not Kermanych's to change.`);

    // The skill changed after this session's launch handed it (another session, an edit in
    // «Навички», a rollback): the agent's lesson may be there already. Refused once, with what is
    // there now; the next call goes through.
    const held = this.handed?.get(sessionId, name);
    if (held && held.body !== entry.def.body) {
      this.handed?.set(sessionId, name, entry.def.body);
      let since: string[] = [];
      try {
        since = (await this.cloud.listAppliedSkillImprovements(this.auth.cloudClient(), name))
          .filter((r) => r.sessionId !== sessionId && Date.parse(r.createdAt) > held.at)
          .map((r) => `«${r.summary}»`);
      } catch { /* the current text below says enough */ }
      return no(
        `Not applied: "${name}" changed after this session was launched${since.length ? ` (${since.join("; ")})` : ""}. ` +
          "Check whether the text below already covers your lesson. Call again only if it does not, with `find` copied from this text." +
          `\n\n--- current text of ${name} ---\n${entry.def.body}`,
      );
    }

    // What the operator's teammates see: the skill with the personal layer removed. Recorded so
    // the browser can offer to share the change back to the right owner.
    const team = resolveSkills(rows.filter((r) => r.owner.scope !== "user")).find((r) => r.def.name === name);
    let teamScope: SkillTeamScope = "none";
    let teamOwnerId: string | undefined;
    if (team?.source === "default") teamScope = "default";
    else if (team?.source === "workspace") {
      teamScope = "workspace";
      teamOwnerId = scope.workspaceId;
    } else if (team?.source === "project") {
      teamScope = "project";
      teamOwnerId = scope.projectId;
    }
    const seenCopy = rows.find((r) => r.owner.scope === "user" && r.name === name);
    let createdCopy = !seenCopy;

    let client;
    let count: number;
    try {
      client = this.auth.cloudClient();
      count = await this.cloud.countSessionSkillImprovements(client, userId, sessionId);
    } catch (err) {
      return unreachable(err);
    }
    if (count >= SKILL_IMPROVEMENTS_PER_SESSION)
      return no(`Not applied: this session already made ${count} skill improvements, the most one session may. Mention further lessons in your reply.`);

    let base = entry.def.body;
    let out = edited(name, base, args.edits);
    if (!("body" in out)) return out;

    // The personal row may have moved since the read above (another machine, the browser's
    // rollback). Re-based once on what is there now, so the write never undoes that change.
    const owner = { scope: "user" as const, id: userId };
    let fresh;
    try {
      fresh = await this.cloud.getAiSkill(client, owner, name);
    } catch (err) {
      return unreachable(err);
    }
    if (fresh?.body !== seenCopy?.body || !fresh !== !seenCopy) {
      if (fresh) {
        base = fresh.body;
        createdCopy = false;
      } else {
        base = team?.def.body ?? entry.def.body;
        createdCopy = true;
      }
      out = edited(name, base, args.edits);
      if (!("body" in out)) return out;
    }

    try {
      await this.cloud.upsertAiSkill(client, { owner, name, description: entry.def.description, body: out.body, enabled: true });
    } catch (err) {
      return unreachable(err);
    }
    // The operator's next launch reads the improved text, not a cached read from before the write.
    this.skills.forgetLibrary(owner);
    let id: string;
    try {
      id = await this.cloud.insertSkillImprovement(client, {
        userId,
        skillName: name,
        teamScope,
        ...(teamOwnerId ? { teamOwnerId } : {}),
        createdCopy,
        beforeBody: base,
        edits: args.edits,
        summary: args.summary,
        reason: args.reason,
        sessionId,
        sessionName,
        projectId: scope.projectId,
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      });
    } catch (err) {
      // An unrecorded change cannot be seen or rolled back by the operator: undo it.
      try {
        if (createdCopy) await this.cloud.deleteAiSkill(client, owner, name);
        else await this.cloud.upsertAiSkill(client, { owner, name, description: fresh?.description ?? entry.def.description, body: base, enabled: true });
      } catch { /* best-effort; the refusal below still tells the agent nothing was recorded */ }
      this.skills.forgetLibrary(owner);
      return no(`Not applied: the change could not be recorded (${msg(err)}); the skill was left as it was.`);
    }
    // This session's own change is not a change «under» it.
    this.handed?.set(sessionId, name, out.body);
    return {
      ok: true,
      text: `Improved skill "${name}" in the operator's personal layer (change ${id}). Their sessions launched from now on use it; they were notified and can roll it back. Continue your task.`,
    };
  }
}
