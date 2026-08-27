// apps/api/src/preview/seed.ts
import { randomUUID } from "node:crypto";
import type { RegistryService } from "../registry/registry.service";
import type { SessionStatus, Usage } from "@kermanych/core";

// Demo data for a Kermanych-on-Kermanych preview. The previewed api boots on a fresh,
// isolated DB (KERMANYCH_DB in preview.service.ts), so without this the board comes up
// empty and there's nothing to eyeball. seedDemo fills the registry with INERT rows —
// no git, no omp, no cloud: projects carry no previewCommand, point at an unreachable
// localRepoPath and use synthetic UUIDs that exist on no Supabase project — covering
// every status, the archived filter and the discussion/review branches that hang off an
// agent, so the board, status dots, branch tags, fork elbows and the project switcher all
// render. Idempotent: it only touches an empty registry, so a persistent preview DB never
// accumulates duplicates.
type Demo = {
  name: string;
  branch: string;
  status: SessionStatus;
  worktree?: boolean; // default true; false = in-place (carries a baseBranch)
  archived?: boolean;
  baseBranch?: string;
  model?: string;
  // Lifetime accounting, as the supervisor would have counted it. Omitted on purpose for
  // one row: an agent whose turns were never counted must render no figure at all.
  usage?: Usage;
  // Branches forked off this agent's conversation, as branchSession/reviewSession make
  // them: no worktree, no branch of their own, and a name carrying the parent's. Seeded so
  // the board's one-level tree — the fork cards and their elbow — has something to draw.
  forks?: Fork[];
};

type Fork = {
  kind: "discussion" | "review";
  status: SessionStatus;
  model?: string;
  usage?: Usage;
};

export function seedDemo(registry: RegistryService): void {
  if (registry.listProjects().length > 0) return; // already populated — never duplicate

  const acme = registry.upsertProject({ id: randomUUID(), name: "Acme Web", localRepoPath: "/tmp/kermanych-demo/acme-web" });
  const kmq = registry.upsertProject({ id: randomUUID(), name: "Kermanych", localRepoPath: "/tmp/kermanych-demo/kermanych" });

  const seed = (projectId: string, d: Demo) => {
    const s = registry.createSession({
      projectId,
      name: d.name,
      task: d.name,
      // Unreachable path: opening the session shows the dormant notice, and a resume/create
      // attempt fails fast with a toast instead of spawning omp or touching disk.
      worktreePath: d.worktree === false ? "" : `/tmp/kermanych-demo/wt/${d.branch.replace(/\//g, "-")}`,
      branch: d.branch,
      status: d.status,
      worktree: d.worktree ?? true,
      baseBranch: d.baseBranch,
      model: d.model,
    });
    if (d.archived) registry.updateSession(s.id, { archived: true });
    if (d.usage) registry.addUsage(s.id, d.usage);
    for (const f of d.forks ?? []) {
      const child = registry.createSession({
        projectId,
        name: `${f.kind === "review" ? "ревізія" : "гілка"}: ${d.name}`,
        task: f.kind === "review" ? d.name : "",
        worktreePath: "",
        branch: "",
        worktree: false,
        status: f.status,
        kind: f.kind,
        parentSessionId: s.id,
        model: f.model,
      });
      if (f.usage) registry.addUsage(child.id, f.usage);
    }
  };

  // Acme Web covers all nine statuses, both isolation modes, and one archived row.
  const acmeRows: Demo[] = [
    { name: "Оновити залежності", branch: "chore/deps", status: "queued", model: "haiku" },
    { name: "Додати онбординг", branch: "feature/onboarding", status: "thinking", model: "opus-5", usage: { input: 18_400, output: 9_200, cacheRead: 1_240_000, cacheWrite: 62_000, cost: 3.18 } },
    { name: "Виправити CSP на iframe", branch: "fix/csp-iframe", status: "tool", model: "sonnet-4.5", usage: { input: 6_100, output: 3_400, cacheRead: 214_000, cacheWrite: 18_000, cost: 0.62 } },
    { name: "Рефактор стора", branch: "refactoring/store", status: "waiting_input", model: "opus-5", usage: { input: 9_800, output: 4_100, cacheRead: 480_000, cacheWrite: 27_000, cost: 1.41 }, forks: [{ kind: "discussion", status: "done", model: "opus-5", usage: { input: 2_100, output: 1_300, cacheRead: 88_000, cacheWrite: 0, cost: 0.21 } }] },
    { name: "Темна тема", branch: "feature/dark-theme", status: "done", model: "sonnet-4.5", usage: { input: 3_200, output: 1_900, cacheRead: 96_000, cacheWrite: 8_400, cost: 0.28 }, forks: [{ kind: "discussion", status: "thinking", model: "haiku", usage: { input: 410, output: 180, cacheRead: 6_200, cacheWrite: 0, cost: 0.004 } }, { kind: "review", status: "done", model: "opus-5", usage: { input: 7_400, output: 2_900, cacheRead: 132_000, cacheWrite: 9_600, cost: 0.88 } }] },
    { name: "Кеш API", branch: "feature/api-cache", status: "error", model: "haiku", usage: { input: 740, output: 210, cacheRead: 12_000, cacheWrite: 0, cost: 0.003 } },
    { name: "Хотфікс продакшена", branch: "fix/prod-hotfix", status: "stopped", worktree: false, baseBranch: "main", model: "sonnet-4.5", usage: { input: 1_100, output: 520, cacheRead: 34_000, cacheWrite: 2_100, cost: 0.11 } },
    { name: "Міграція БД", branch: "feature/db-migration", status: "conflict", model: "opus-5", usage: { input: 12_600, output: 5_800, cacheRead: 720_000, cacheWrite: 41_000, cost: 2.07 } },
    { name: "Логотип у хедері", branch: "feature/header-logo", status: "merged", model: "haiku", usage: { input: 620, output: 240, cacheRead: 9_100, cacheWrite: 0, cost: 0.02 } },
    { name: "Стара фіча", branch: "feature/legacy", status: "done", archived: true, model: "sonnet-4.5", usage: { input: 2_400, output: 800, cacheRead: 51_000, cacheWrite: 3_300, cost: 0.19 } },
  ];
  for (const r of acmeRows) seed(acme.id, r);

  // A second project so the project switcher has something to switch to.
  const kmqRows: Demo[] = [
    { name: "Секція архіву", branch: "feature/archive", status: "done", model: "opus-5", usage: { input: 5_400, output: 2_600, cacheRead: 168_000, cacheWrite: 11_000, cost: 0.74 } },
    { name: "Тумблер worktree", branch: "feature/worktree-toggle", status: "thinking", model: "sonnet-4.5", usage: { input: 1_800, output: 900, cacheRead: 42_000, cacheWrite: 3_100, cost: 0.16 } },
  ];
  for (const r of kmqRows) seed(kmq.id, r);
}
