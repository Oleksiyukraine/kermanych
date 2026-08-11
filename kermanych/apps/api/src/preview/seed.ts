// apps/api/src/preview/seed.ts
import type { RegistryService } from "../registry/registry.service";
import type { SessionStatus } from "@kermanych/core";

// Demo data for a Kermanych-on-Kermanych preview. The previewed api boots on a fresh,
// isolated DB (KERMANYCH_DB in preview.service.ts), so without this the board comes up
// empty and there's nothing to eyeball. seedDemo fills the registry with INERT rows —
// no git, no omp, groups carry no previewCommand and point at an unreachable projectDir —
// covering every status plus the archived filter so the board, status dots, branch tags
// and project switcher all render. Idempotent: it only touches an empty registry, so a
// persistent preview DB never accumulates duplicates.
type Demo = {
  name: string;
  branch: string;
  status: SessionStatus;
  worktree?: boolean; // default true; false = in-place (carries a baseBranch)
  archived?: boolean;
  baseBranch?: string;
};

export function seedDemo(registry: RegistryService): void {
  if (registry.listGroups().length > 0) return; // already populated — never duplicate

  const acme = registry.createGroup({ name: "Acme Web", projectDir: "/tmp/kermanych-demo/acme-web" });
  const kmq = registry.createGroup({ name: "Kermanych", projectDir: "/tmp/kermanych-demo/kermanych" });

  const seed = (groupId: string, d: Demo) => {
    const s = registry.createSession({
      groupId,
      name: d.name,
      task: d.name,
      // Unreachable path: opening the session shows the dormant notice, and a resume/create
      // attempt fails fast with a toast instead of spawning omp or touching disk.
      worktreePath: d.worktree === false ? "" : `/tmp/kermanych-demo/wt/${d.branch.replace(/\//g, "-")}`,
      branch: d.branch,
      status: d.status,
      worktree: d.worktree ?? true,
      baseBranch: d.baseBranch,
    });
    if (d.archived) registry.updateSession(s.id, { archived: true });
  };

  // Acme Web covers all nine statuses, both isolation modes, and one archived row.
  const acmeRows: Demo[] = [
    { name: "Оновити залежності", branch: "chore/deps", status: "queued" },
    { name: "Додати онбординг", branch: "feature/onboarding", status: "thinking" },
    { name: "Виправити CSP на iframe", branch: "fix/csp-iframe", status: "tool" },
    { name: "Рефактор стора", branch: "refactoring/store", status: "waiting_input" },
    { name: "Темна тема", branch: "feature/dark-theme", status: "done" },
    { name: "Кеш API", branch: "feature/api-cache", status: "error" },
    { name: "Хотфікс продакшена", branch: "fix/prod-hotfix", status: "stopped", worktree: false, baseBranch: "main" },
    { name: "Міграція БД", branch: "feature/db-migration", status: "conflict" },
    { name: "Логотип у хедері", branch: "feature/header-logo", status: "merged" },
    { name: "Стара фіча", branch: "feature/legacy", status: "done", archived: true },
  ];
  for (const r of acmeRows) seed(acme.id, r);

  // A second group so the project switcher has something to switch to.
  const kmqRows: Demo[] = [
    { name: "Секція архіву", branch: "feature/archive", status: "done" },
    { name: "Тумблер worktree", branch: "feature/worktree-toggle", status: "thinking" },
  ];
  for (const r of kmqRows) seed(kmq.id, r);
}
