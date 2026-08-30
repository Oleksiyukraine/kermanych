import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { MANAGEMENT_SECTIONS, type ManagementContext, type ManagementRepo, type Project } from "@kermanych/core";
import { buildManagementTurn, managementCwd, managementRepos } from "../src/management/management-prompt";

function project(p: Partial<Project> & { id: string }): Project {
  return { name: p.id, localRepoPath: "", createdAt: "2026-08-30T00:00:00.000Z", ...p };
}

const context: ManagementContext = {
  workspaceName: "Acme",
  section: "management-risks",
};

describe("managementRepos", () => {
  it("keeps the requested order and drops ids the local registry does not know", () => {
    const projects = [
      project({ id: "a", name: "Альфа", localRepoPath: "/repos/alpha" }),
      project({ id: "b", name: "Бета", localRepoPath: "/repos/beta", defaultBranch: "main", conventions: "squash" }),
    ];
    const repos = managementRepos(projects, [
      { id: "b", gitRemoteUrl: "git@github.com:acme/beta.git" },
      { id: "zzz" },
      { id: "a" },
    ]);
    expect(repos.map((r) => r.projectId)).toEqual(["b", "a"]);
    expect(repos[0]).toEqual({
      projectId: "b",
      name: "Бета",
      localRepoPath: "/repos/beta",
      gitRemoteUrl: "git@github.com:acme/beta.git",
      defaultBranch: "main",
      conventions: "squash",
    });
    // The remote is the browser's half of the join and the path is the api's: a project the
    // cloud knows a remote for but nobody bound here keeps the remote and reports no path,
    // rather than having a directory invented for it.
    expect("gitRemoteUrl" in repos[1]!).toBe(false);
    expect(managementRepos([project({ id: "a" })], [{ id: "a" }])[0]?.localRepoPath).toBe("");
  });
});

describe("managementCwd", () => {
  it("prefers the first bound repo and falls back to the home directory", () => {
    const unbound: ManagementRepo = { projectId: "a", name: "Альфа", localRepoPath: "" };
    const bound: ManagementRepo = { projectId: "b", name: "Бета", localRepoPath: "/repos/beta" };
    expect(managementCwd([unbound, bound])).toBe("/repos/beta");
    expect(managementCwd([unbound])).toBe(homedir());
    expect(managementCwd([])).toBe(homedir());
  });
});

describe("buildManagementTurn", () => {
  const repos: ManagementRepo[] = [
    { projectId: "a", name: "Альфа", localRepoPath: "/repos/alpha", defaultBranch: "main" },
    { projectId: "b", name: "Бета", localRepoPath: "" },
  ];

  it("states every section's limitation on the first turn", () => {
    const out = buildManagementTurn({ first: true, repos, context, text: "що тут?" });
    for (const s of MANAGEMENT_SECTIONS) {
      expect(out).toContain(`${s.name} · ${s.label} · capability=${s.capability}`);
      // Verbatim: the refusal the user reads must be the sentence the section table owns.
      if (s.limitation) expect(out).toContain(s.limitation);
    }
    expect(out).toContain("```kermanych-action");
    expect(out).toContain('"kind": "unsupported"');
  });

  // The protocol must not advertise a write while no section can take one — a model told it
  // may create things then reports having created them, and the operator believes it.
  it("offers no writing action while every section is read-only", () => {
    const out = buildManagementTurn({ first: true, repos, context, text: "?" });
    expect(out).not.toContain("risk.create");
    expect(out).not.toContain("risk.update");
    expect(out).toContain("Жодного розділу з capability=read_write зараз немає");
    expect(MANAGEMENT_SECTIONS.some((s) => s.capability === "read_write")).toBe(false);
  });

  it("omits the contract on a follow-up but keeps the context and the message", () => {
    const later = buildManagementTurn({ first: false, repos, context, text: "а тепер поясни" });
    expect(later).not.toContain("ПРОТОКОЛ ДІЙ");
    expect(later).not.toContain("```kermanych-action");
    expect(later).toContain("── КОНТЕКСТ ──");
    expect(later).toContain("а тепер поясни");
    // The contract is ~2 KB of rules; re-sending it every turn would debit the plan for
    // text the same omp child already has.
    expect(later.length).toBeLessThan(
      buildManagementTurn({ first: true, repos, context, text: "а тепер поясни" }).length,
    );
  });

  it("renders every repository of the workspace, bound and unbound", () => {
    const out = buildManagementTurn({ first: false, repos, context, text: "?" });
    expect(out).toContain("- Альфа · /repos/alpha · гілка: main");
    expect(out).toContain("- Бета · не привʼязаний на цій машині");
    // Risk Registry has a real screen since the register merged, so it is `read` — the
    // assistant may describe it and must still refuse to write it.
    expect(out).toContain("Активний розділ: management-risks (Risk Registry, capability=read)");
    expect(out.trimEnd().endsWith("?")).toBe(true);
  });

  // Regression guard for the workspace re-scope: the context block names the Воркспейс and
  // nothing else. A `Проєкт:` line would put a scope in the transcript that the tab no
  // longer has, and the assistant would answer as if one project of the group were «the»
  // subject.
  it("names the workspace and never a project", () => {
    const out = buildManagementTurn({ first: false, repos, context, text: "?" });
    expect(out).not.toContain("Проєкт:");
    expect(out).toContain("Воркспейс: Acme");
  });
});
