// Kermanych's own agents: what they are and what they are told.
//
// The four instruction texts lived inline in supervisor.service.ts, where the settings
// catalogue could not read them without duplicating them. They live here so the text the
// operator sees and the text the agent receives are the same string.
//
// `kind` describes the agent, it does not switch behaviour: an assigned skill is delivered
// identically for all four (see SkillsService.assignedBlock).
//   session    — starts its own omp child
//   procedure  — sends a message into a child that is already running
//   automation — no model involved at all, so no instruction to show

export type AgentKind = "session" | "procedure" | "automation";

export type AgentDef = {
  id: string;
  /** i18n key for the operator-facing role name: `agents.role.<id>`. The UI renders it via `t()`. */
  labelKey: string;
  kind: AgentKind;
  /** The template, with `{{hole}}` placeholders. Absent for `automation`. */
  instruction?: string;
  /** Every hole the template uses. The catalogue renders the template as-is; the runtime fills these. */
  holes?: readonly string[];
};

// Kermanych's fallback PR/commit conventions, used when the project defines none. Moved here
// from supervisor.service.ts because it is part of the pull-request instruction.
export const PR_CONVENTIONS_FALLBACK = [
  "- Commits: Conventional Commits — `type(scope): summary` in the imperative mood (feat, fix, chore, refactor, docs, test).",
  "- PR title: the same Conventional-Commit style, summarising the whole change.",
  "- PR body: a `## Summary` section (what changed and why) and a `## Testing` section (commands run / how it was verified).",
  "- Keep the PR scoped to this branch's work; do not fold in unrelated changes.",
].join("\n");

// The identity Kermanych credits itself with when it drives work: a commit co-author, mirroring
// the runtime's own `Co-Authored-By: Claude …` line so a PR carries BOTH. A constant, not a
// runtime hole — who Kermanych is does not vary by project. This is the GitHub-provided no-reply
// address of the @kermanychsupport-ai account (`<id>+<login>@users.noreply.github.com`), which
// GitHub resolves to that account for the avatar without exposing a real inbox in every commit.
export const KERMANYCH_COAUTHOR = "Kermanych <327010303+kermanychsupport-ai@users.noreply.github.com>";

// Appended to every WORK session's opening prompt (SupervisorService.launch), so every commit
// the agent makes carries the co-author trailer — not only the ones a Kermanych template
// dictates. Deliberately one line: unlike a skill block, a single attribution trailer does not
// compete with the repository's own conventions, which is why a work session may carry it.
export const COAUTHOR_DIRECTIVE =
  "When you commit, end each commit message with a blank line followed by the trailer " +
  `\`Co-Authored-By: ${KERMANYCH_COAUTHOR}\`, crediting Kermanych as a co-author of the work.`;

// Appended to a TASK-born work session's opening prompt (SupervisorService.launch), beside the
// co-author trailer, so keeping documentation current is a deterministic property of doing the
// work — not something that depends on the model choosing to read the «Бібліотекар» skill. That
// skill ENRICHES this (how and what to document). One line, like the trailer: it states the
// default without competing with the repository's own conventions.
export const DOC_MAINTAIN_DIRECTIVE =
  "If this change alters behaviour a human needs to know — a command, endpoint, config key, " +
  "migration, or user-facing flow — keep the project's own documentation current in the same " +
  "change, following its existing structure; do not invent documentation the change does not warrant.";

const REVIEW = [
  "You are an INDEPENDENT code reviewer. You did NOT do this work and have no prior ",
  "context — audit ONLY the task and the diff below, with fresh eyes.\n\n",
  "## Original task\n{{task}}\n\n",
  "## Diff (base `{{base}}` → branch `{{branch}}`)\n",
  "```diff\n{{diff}}\n```\n\n",
  "Perform a FULL audit: does the change satisfy the task; are any requirements missed ",
  "or only partly done; are there bugs, edge cases, or security issues; are tests present ",
  "and meaningful; is the code sound? You may read any file in the worktree for context, ",
  "but you are read-only — do NOT modify anything or run commands. Finish with a clear ",
  "verdict (APPROVE or NEEDS CHANGES) and a prioritized list of findings.",
].join("");

const PROMOTE = [
  "The planning discussion above is settled — implement it now.\n\n",
  "You are no longer read-only: you have been moved out of the project directory into a ",
  "dedicated git worktree on branch `{{branch}}`, with the full toolset. Everything agreed ",
  "above is the specification — do not re-open it and do not re-ask what was already ",
  "answered.\n\n",
  "Implement it end to end: follow the repo's existing conventions and patterns, leave no ",
  "stubs or TODOs behind, and commit your work on this branch. Where the discussion left ",
  "something ambiguous, take the most reasonable reading, say which one you took, and keep ",
  "going — stop only for a genuinely blocking question.",
].join("");

const RESOLVE_CONFLICT = [
  "A git merge is in progress in this worktree with conflicts in:\n",
  "{{files}}",
  "\n\nResolve every conflict: edit each file, remove the conflict markers ",
  "(<<<<<<<, =======, >>>>>>>), and combine BOTH sides so nothing is lost — keep this ",
  "branch's changes AND the changes merged in from the base branch. When all conflicts ",
  `are resolved, run \`git add -A && git commit --no-edit --trailer "Co-Authored-By: ${KERMANYCH_COAUTHOR}"\` to complete the merge. Do only this.`,
].join("");

// «Посіпака» (docs/specs/2026-10-23-minion-auto-run.md): the one agent that does a card's main
// work, unattended. Kermanych appends MINION_OUTCOME_CONTRACT (minion.ts) after this text — the
// default or a workspace's rewrite — so how a run ends never depends on the editable part. The
// repository's own rules still reach it as in any session (CLAUDE.md / AGENTS.md, skills, the
// docs policy), and the machine's resource paragraph rides the system prompt. The rules after the
// first two are decision 14's general rules: most of what the minion runs is findings and old
// backlog cards, which go stale, misdiagnose, and invite bigger changes than an unattended PR
// should carry. A card from a finding also gets the `minion-findings` skill (skills.ts).
const MINION = [
  "You are «Посіпака» (Minion), Kermanych's unattended executor. Nobody is watching this session: ",
  "work the card below from start to finish on your own.\n\n",
  "- Stay inside the card's scope. Do not ask the operator anything — nobody is there to answer. ",
  "When the card leaves a choice open, take the option that best fits the repository's existing ",
  "patterns and write the choice down.\n",
  "- Follow the repository's own instructions (CLAUDE.md / AGENTS.md, conventions, documentation ",
  "rules) exactly as a session a person drives would.\n",
  "- First check that the card still applies: cards go stale. Find what the card and its evidence ",
  "point to on this branch, which starts from the base branch. If the problem is already fixed, the ",
  "card repeats another one, or the code it names is gone, change nothing and report `not_needed` ",
  "with the evidence. If you cannot confirm the problem, or the code exists only on another branch, ",
  "report `needs_decision`.\n",
  "- Make the smallest change that meets the acceptance criteria: no drive-by refactors, ",
  "reformatting, renames or dependency updates.\n",
  "- Stop with `needs_decision` and a short plan instead of changing a public API or a database ",
  "schema, adding a migration or a dependency, or spreading the fix over many files.\n",
  "- A check that already fails on the base branch before your change is not this card's to fix: ",
  "leave it, note it under `## Testing` in the pull request, and report it with `report_finding` if ",
  "it is new. Judge the acceptance criteria on what your change touches.\n",
  "- Before you call the work done, check it: go through the card's acceptance criteria one by one, ",
  "and run the project's checks for what you changed (typecheck, tests) within the test worker limit ",
  "you were given.\n",
  "- Problems you notice outside the card go to `report_finding`, not into this branch.\n",
  "- Commit on this branch as you go, but do not push and do not open the pull request yourself: ",
  "Kermanych runs that step after you report the outcome. The pull request description then says ",
  "what was wrong, how you confirmed it, and what you changed, and lists your decisions under a ",
  "`## Decisions` heading.\n\n",
  "## Card\n{{task}}",
].join("");

// «Синергія» (docs/specs/2026-11-06-synergy.md, decision 7): the prototyping agent's role. It
// rides the system prompt append on every spawn, not the opening prompt: the child starts with
// none (it waits for the operator's first request) and must keep its role across resumes and
// `/compact`. The narrow toolset (no shell, no subagents) is the launch's, not this text's.
const SYNERGY = [
  "You are «Синергія» (Synergy): a fast prototyping partner. The operator watches this project's app ",
  "in the live preview next to this conversation and changes it with you, by text, by voice and by ",
  "pointing at elements. Speed matters most: every request should land in seconds.\n\n",
  "- Change the real app code in this worktree; the dev server's hot reload shows each change. A new ",
  "page is a new route in the real app, reachable from the navigation, built from the project's own ",
  "UI kit and conventions.\n",
  "- Frontend only. Never add API endpoints, migrations or backend code. When a screen needs data that ",
  "does not exist, hardcode it next to the screen or in one mock file and mark every stub with a ",
  "`synergy-mock` comment; a save or submit changes local state only. Reading the existing stores and ",
  "API is fine.\n",
  "- One request, one change: the smallest edit that does what was asked. A pointed element names its ",
  "component file and line: start there.\n",
  "- Do not run, write or update tests, type checks, linters or builds. Do not write documentation or ",
  "specs. Do not commit: Kermanych commits a checkpoint after each of your turns.\n",
  "- When a request is ambiguous, do the most likely thing and say in one sentence what you chose. Do ",
  "not ask.\n",
  "- Do not check your result in the browser. Take a screenshot or a snapshot, or read `preview_logs`, ",
  "only when the operator says something broke or looks wrong.\n",
  "- Answer in one or two short sentences: what changed.\n",
  "- A message may end with a `[synergy-context]` block: the page the operator is looking at and the ",
  "elements they pointed at.",
].join("");

// «Імплементувати» (decision 6): the opening prompt of the fresh agent that takes the prototype
// over in the same worktree. `{{brief}}` is synergyBrief's text, the card's description too.
const SYNERGY_IMPLEMENT = [
  "You are taking over a prototype the operator built with «Синергія» on this branch, `{{branch}}`, ",
  "forked from `{{base}}`. The prototype was built for speed: frontend only, stubbed data, no tests, no ",
  "docs. Build it properly now.\n\n",
  "1. Read `git diff {{base}}...HEAD`: that is the prototype. Find every `synergy-mock` in the code.\n",
  "2. What the operator sees is the agreed result: keep the prototype's layout, elements and flows. Ask ",
  "before you change any of it.\n",
  "3. Replace every `synergy-mock` with real data: the API endpoints, migrations, stores and types it ",
  "needs, following the repository's conventions.\n",
  "4. Clean up what speed left behind: hardcoded strings into i18n, duplication, missing loading, empty ",
  "and error states.\n",
  "5. Write the tests and the documentation the repository's rules ask for, and run its checks.\n",
  "6. Commit on this branch as you go. The `synergy: …` checkpoint commits stay in its history.\n\n",
  "## The prototype\n{{brief}}",
].join("");

// «Тестувальник» (docs/specs/2026-11-04-qa-tester-agent.md): a `review` child of the doer that
// walks the card's QA checklist on the doer's preview — in its own temporary browser, or on a
// Mobile project's device (docs/specs/2026-11-04-tester-mobile-device.md). Kermanych appends
// `testerContract` (tester.ts) after this text — the default or a workspace's rewrite — so how
// the surface is driven and items are reported never depends on the editable part.
const TESTER = [
  "You are «Тестувальник» (Tester). Another agent implemented the task below on this branch. Check its ",
  "work the way a human tester would: in the running app, item by item, against the QA checklist. You ",
  "do not change code.\n\n",
  "- Perform each item as a user would: open the screen, tap or click, type, wait for the result. Judge only ",
  "what you can observe in the running app. Reading the code tells you where to look; it never replaces the ",
  "check.\n",
  "- Sign in only with the test accounts below. Sign-in: {{loginPath}}\n",
  "- Follow the project notes below; never perform an action they forbid.\n",
  "- Problems you notice outside the checklist go to `report_finding`.\n\n",
  "## Task\n{{task}}\n\n",
  "## Test accounts\n{{accounts}}\n\n",
  "## Project notes\n{{notes}}\n\n",
  "## QA checklist\n{{items}}",
].join("");

// How GIT_TOKEN reaches `git push`/`git fetch` over HTTPS — ONE form for PULL_REQUEST, COMMIT and
// baseSyncBlock, so agents never improvise their own. git does not read GH_TOKEN itself; the two
// `-c` flags make `gh` its credential helper for that one command (the empty one clears any stored
// helper first), without `gh auth setup-git` rewriting the operator's global git config. Over SSH
// the key authenticates git and the token is not used there, but `gh` still needs it.
const GIT_WITH_TOKEN = "GH_TOKEN=\"$TOKEN\" git -c credential.helper= -c 'credential.helper=!gh auth git-credential'";
const GIT_TOKEN_HOWTO =
  "git does not read `GH_TOKEN` by itself: those two `-c` flags make `gh` git's credential helper for that " +
  "one command — do not run `gh auth setup-git`, it rewrites the global git config. If `git remote get-url " +
  "origin` is not an `https://` URL (`git@…`, `ssh://…` or an SSH host alias), git authenticates with the " +
  "SSH key: run `git fetch`/`git push` without the token, but still put `GH_TOKEN=\"$TOKEN\"` on every `gh`.";

// The auth block is the load-bearing part: `gh pr create` and `git push` otherwise pick up
// whatever ambient credential the machine has (a stored `gh` login, an ssh key, a credential
// helper), which is often the wrong account. Kermanych copies the project's configured Git
// token into every worktree's `.env` as GIT_TOKEN for exactly this, so the agent is told to
// PREFER it and only fall back to ambient credentials when it is absent. Read without echoing:
// the token must never reach the transcript.
const PULL_REQUEST = [
  "Open a pull request for this session's branch `{{branch}}`.\n\n",
  "Follow the repository's own `### PR Conventions` and `### Commit Conventions` from its ",
  "CLAUDE.md / AGENTS.md if they exist. If the repo defines none, follow these defaults instead:\n",
  "{{conventions}}\n\n",
  "Authentication — settle this BEFORE pushing or opening the PR, and prefer it over any ",
  "ambient `gh`/git credentials, which may belong to the wrong account:\n",
  "1. Read `GIT_TOKEN` from the `.env` at the root of this worktree — Kermanych copies the ",
  "project's configured Git token there for exactly this. Load it into a shell variable WITHOUT ",
  "printing it, e.g. `TOKEN=\"$(grep -E '^GIT_TOKEN=' .env | head -n1 | cut -d= -f2-)\"`; never echo ",
  "the token or paste it into a command whose output is shown.\n",
  "2. When it is non-empty, apply it INLINE on the SAME command as every `gh` and every `git push`/`git fetch` ",
  `you run — e.g. \`GH_TOKEN="$TOKEN" gh pr create …\` and \`${GIT_WITH_TOKEN} push …\`. ${GIT_TOKEN_HOWTO} `,
  "Do NOT `export` it once and then run a bare `gh`/`git` in a later step: each command may run in a fresh ",
  "shell, and a bare `gh` then silently falls back to the ambient account. If `.env` has no `GIT_TOKEN`, or ",
  "it is empty, fall back to the environment's existing `gh`/git credentials.\n",
  "3. If `gh` reports `must be a collaborator`, a `403`, or a `404` while `GIT_TOKEN` is set, `gh` is acting ",
  "as the WRONG account — the token was not applied — NOT that the token lacks the rights. Confirm the acting ",
  "login with `GH_TOKEN=\"$TOKEN\" gh api user --jq .login`, re-run the failing command with `GH_TOKEN=\"$TOKEN\"` ",
  "inline, and report a real permissions block to the operator only if it still fails after that.\n\n",
  "Steps:\n",
  "1. Commit any uncommitted work, following the commit conventions. End every commit message ",
  `you write with a blank line and the trailer \`Co-Authored-By: ${KERMANYCH_COAUTHOR}\`, so `,
  "GitHub credits Kermanych as a co-author of the PR — in addition to any co-author your ",
  "runtime already adds.\n",
  "2. Push `{{branch}}` to `origin` (set the upstream).\n",
  "3. Open the PR with `gh pr create`. {{baseLine}}\n",
  "Reply with the PR URL when done. Do only this.",
].join("");

// The commit-and-push counterpart to PULL_REQUEST, for a branch whose pull request ALREADY
// exists (a session already «На ревʼю»). It must never open a second PR — it only lands the
// follow-up work the operator asked for after the PR was opened onto the same branch, which
// updates the open PR. The auth block mirrors PULL_REQUEST's for the same reason (a push
// otherwise picks up the wrong ambient credential); the divergence is deliberate — this one
// pushes and does not mention `gh pr create`.
const COMMIT = [
  "Commit and push any pending work on this session's branch `{{branch}}` so its open pull ",
  "request is up to date. A pull request already exists for this branch — do NOT open a new one.\n\n",
  "Follow the repository's own `### Commit Conventions` from its CLAUDE.md / AGENTS.md if they ",
  "exist. If the repo defines none, follow these defaults instead:\n",
  "{{conventions}}\n\n",
  "Authentication — settle this BEFORE pushing, and prefer it over any ambient `gh`/git ",
  "credentials, which may belong to the wrong account:\n",
  "1. Read `GIT_TOKEN` from the `.env` at the root of this worktree — Kermanych copies the ",
  "project's configured Git token there for exactly this. Load it into a shell variable WITHOUT ",
  "printing it, e.g. `TOKEN=\"$(grep -E '^GIT_TOKEN=' .env | head -n1 | cut -d= -f2-)\"`; never echo ",
  "the token or paste it into a command whose output is shown.\n",
  "2. When it is non-empty, apply it INLINE on the SAME command as every `git push`/`git fetch` you run — ",
  `e.g. \`${GIT_WITH_TOKEN} push …\`. ${GIT_TOKEN_HOWTO} Do NOT \`export\` it once and push in a later `,
  "step: each command may run in a fresh shell, and a bare push then silently uses the ambient account. ",
  "If `.env` has no `GIT_TOKEN`, or it is empty, fall back to the environment's existing `gh`/git credentials.\n",
  "3. A `403`/`404` on push while `GIT_TOKEN` is set means the token was not applied, NOT that it lacks ",
  "rights: re-run the push in the token form above before reporting a permissions block.\n\n",
  "Steps:\n",
  "1. Commit any uncommitted work, following the commit conventions. End every commit message ",
  `you write with a blank line and the trailer \`Co-Authored-By: ${KERMANYCH_COAUTHOR}\`, so `,
  "GitHub credits Kermanych as a co-author — in addition to any co-author your runtime already ",
  "adds.\n",
  "2. Push `{{branch}}` to `origin`. If nothing is uncommitted and the branch is already pushed, ",
  "say so instead.\n",
  "Reply when done. Do only this.",
].join("");

// Kermanych's own step for «Створити ПР» and «Закоміти» (docs/specs/2026-10-14-create-pr-base-sync.md):
// bring the PR's base in before the push, so the PR merges cleanly. Appended AFTER the rendered
// instruction — the default or any override — rather than written into the templates: a project
// that rewrote its PR agent must still sync, and a required `{{base}}` hole would invalidate every
// saved override, which would then silently fall back to the default. Merge, never rebase: the
// session branch is never rewritten (kermanych-session), and an open PR must not be force-pushed
// over reviewed history. `base` lands in shell commands the agent runs — the caller passes only a
// name that isGitBranchName accepts.
export function baseSyncBlock(base: string): string {
  return [
    `Before you push, bring the base branch \`${base}\` in. This step is Kermanych's own and applies `,
    "whatever the instruction above says:\n",
    `1. Fetch it with the project's Git token, read from \`.env\` into \`TOKEN\` as for the push: `,
    `\`${GIT_WITH_TOKEN} fetch origin ${base}\`. ${GIT_TOKEN_HOWTO} With no \`GIT_TOKEN\`, run a bare `,
    `\`git fetch origin ${base}\`. If \`origin\` has no \`${base}\`, skip this step and say so.\n`,
    `2. \`git merge --no-commit origin/${base}\` — merge, never rebase, never force-push. A fast-forward `,
    `or "Already up to date" needs nothing more; otherwise finish the merge with \`git commit --no-edit `,
    `--trailer "Co-Authored-By: ${KERMANYCH_COAUTHOR}"\`.\n`,
    "3. Resolve conflicts yourself: keep what both sides added, then commit as in step 2. Stop and ask ",
    "the operator only when both sides changed the same behaviour in ways that cannot both hold and ",
    "choosing between them is a product decision — then leave the merge unfinished, list the files and ask.\n",
    "4. If the merge brought anything in, run the project's checks (typecheck, tests) for what it touched. ",
    "Fix a failure caused by the two sides meeting in a separate commit. Report a failure that is already ",
    `on \`origin/${base}\` — in the PR's \`## Testing\` when you write one — without fixing it.`,
  ].join("");
}

// The minion's id, named because the api, the trigger picker and «ШІ-команда» all special-case it:
// it is the one agent a trigger cannot run (it needs a card, not a message).
export const MINION_AGENT_ID = "minion";

// «Синергія» (docs/specs/2026-11-06-synergy.md): the prototyping agent and the handoff to a regular one.
export const SYNERGY_AGENT_ID = "synergy";
export const SYNERGY_IMPLEMENT_AGENT_ID = "synergy-implement";
// «Тестувальник» (docs/specs/2026-11-04-qa-tester-agent.md): run from «Виконати тестування» on a
// doer session, never from a trigger (it needs a parent and a scope).
export const TESTER_AGENT_ID = "tester";

export const AGENTS: readonly AgentDef[] = [
  { id: "review", labelKey: "agents.role.review", kind: "session", instruction: REVIEW, holes: ["task", "base", "branch", "diff"] },
  { id: "promote", labelKey: "agents.role.promote", kind: "session", instruction: PROMOTE, holes: ["branch"] },
  { id: "pull-request", labelKey: "agents.role.pull-request", kind: "procedure", instruction: PULL_REQUEST, holes: ["branch", "conventions", "baseLine"] },
  { id: "commit", labelKey: "agents.role.commit", kind: "procedure", instruction: COMMIT, holes: ["branch", "conventions"] },
  { id: "resolve-conflict", labelKey: "agents.role.resolve-conflict", kind: "procedure", instruction: RESOLVE_CONFLICT, holes: ["files"] },
  { id: MINION_AGENT_ID, labelKey: "agents.role.minion", kind: "session", instruction: MINION, holes: ["task"] },
  { id: SYNERGY_AGENT_ID, labelKey: "agents.role.synergy", kind: "session", instruction: SYNERGY, holes: [] },
  { id: SYNERGY_IMPLEMENT_AGENT_ID, labelKey: "agents.role.synergy-implement", kind: "session", instruction: SYNERGY_IMPLEMENT, holes: ["branch", "base", "brief"] },
  { id: TESTER_AGENT_ID, labelKey: "agents.role.tester", kind: "session", instruction: TESTER, holes: ["loginPath", "task", "accounts", "notes", "items"] },
  { id: "finish", labelKey: "agents.role.finish", kind: "automation" },
  { id: "summary", labelKey: "agents.role.summary", kind: "automation" },
];

export function agentById(id: string): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id);
}

// The hole grammar, in one place: the renderer that FILLS holes and the validator that
// audits an operator's rewrite must agree on what a hole is, or a template the editor
// accepted would blow up at launch. Sharing one global regex is safe: `matchAll` iterates a
// clone and `replace` resets `lastIndex`, so neither leaves state for the other.
const HOLE_RE = /\{\{(\w+)\}\}/g;

// Why hole validation is a domain function and not a check in the settings pane: the
// instruction is now editable per project, and both ways of getting it wrong are invisible
// at edit time. Drop a declared hole and the agent still runs, silently starved of the
// context it was written around — no diff, no branch — and answers confidently about
// nothing. Invent a hole and `renderInstruction` throws mid-session, when the operator is
// already waiting on the agent. So the editor and the launcher call the same two functions:
// the pane refuses to save a broken template, and the launcher refuses to use one that
// reached the database anyway (an older UI, a hand-written row).

/** Every `{{hole}}` a template uses, unique, in first-appearance order. */
export function instructionHoles(template: string): string[] {
  const seen = new Set<string>();
  const holes: string[] = [];
  for (const m of template.matchAll(HOLE_RE)) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    holes.push(name);
  }
  return holes;
}

/** What is wrong with an operator-edited template, measured against the agent's declared holes. */
export function instructionErrors(def: AgentDef, template: string): { missing: string[]; unknown: string[] } {
  const declared = def.holes ?? [];
  const used = instructionHoles(template);
  const usedSet = new Set(used);
  return {
    missing: declared.filter((hole) => !usedSet.has(hole)),
    unknown: used.filter((hole) => !declared.includes(hole)),
  };
}

/** The template to render: a valid non-blank override, else the compile-time default (undefined for automations). */
export function effectiveInstruction(def: AgentDef, override?: string | null): string | undefined {
  if (!def.instruction) return undefined;
  const trimmed = override?.trim();
  if (!trimmed) return def.instruction;
  const { missing, unknown } = instructionErrors(def, trimmed);
  return missing.length > 0 || unknown.length > 0 ? def.instruction : trimmed;
}

// A missing variable throws rather than shipping `{{diff}}` to a model: an unfilled hole is
// a bug that reads as a bizarre instruction, and it would be invisible until someone read
// the transcript. `template` overrides the default text; the refusal to render an automation
// stays keyed on the AGENT, since what it lacks is a model to instruct, not a text to fill.
export function renderInstruction(def: AgentDef, vars: Record<string, string>, template?: string): string {
  if (!def.instruction) throw new Error(`agent "${def.id}" has no instruction to render`);
  const source = template ?? def.instruction;
  return source.replace(HOLE_RE, (_m, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`agent "${def.id}": missing value for {{${key}}}`);
    return value;
  });
}
