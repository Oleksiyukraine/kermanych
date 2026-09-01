import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import {
  MANAGEMENT_SECTIONS,
  RISK_CATEGORY_VALUES,
  RISK_RESPONSES_BY_KIND,
  RISK_STATUS_VALUES,
  type ManagementContext,
  type ManagementRepo,
  type ManagementRiskRow,
  type Project,
} from "@kermanych/core";
import { buildManagementTurn, managementCwd, managementRepos, todayIso } from "../src/management/management-prompt";

function project(p: Partial<Project> & { id: string }): Project {
  return { name: p.id, localRepoPath: "", createdAt: "2026-08-30T00:00:00.000Z", ...p };
}

const context: ManagementContext = {
  workspaceName: "Acme",
  section: "management-risks",
  risks: [],
};

// A fixed «today». The context block now anchors relative periods («реліз-ноти за останній
// тиждень») to this date, so a test that read the real clock would assert a different string
// tomorrow.
const TODAY = "2026-09-01";

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
    const out = buildManagementTurn({ first: true, repos, context, today: TODAY, text: "що тут?" });
    for (const s of MANAGEMENT_SECTIONS) {
      expect(out).toContain(`${s.name} · ${s.label} · capability=${s.capability}`);
      // Verbatim: the refusal the user reads must be the sentence the section table owns.
      if (s.limitation) expect(out).toContain(s.limitation);
    }
    expect(out).toContain("```kermanych-action");
    expect(out).toContain('"kind": "unsupported"');
  });

  // The write protocol must describe EXACTLY what the validator accepts. A vocabulary that
  // drifts from @kermanych/core is how the assistant starts filing risks that are refused
  // one round trip later, or — worse — stops offering a category the register needs.
  it("teaches the write protocol from the register's own vocabulary", () => {
    const out = buildManagementTurn({ first: true, repos, context, today: TODAY, text: "?" });
    expect(out).toContain('"kind": "risk.create"');
    expect(out).toContain('"kind": "risk.update"');
    for (const c of RISK_CATEGORY_VALUES) expect(out).toContain(c);
    for (const s of RISK_STATUS_VALUES) expect(out).toContain(s);
    expect(out).toContain(`threat → ${RISK_RESPONSES_BY_KIND.threat.join(", ")}`);
    expect(out).toContain(`opportunity → ${RISK_RESPONSES_BY_KIND.opportunity.join(", ")}`);
    // Server-owned columns are never offered: a model that sends `code` is guessing at a
    // value the trigger mints under an advisory lock.
    expect(out).toContain("Не передавай code, exposure, emv");
  });

  it("omits the contract on a follow-up but keeps the context and the message", () => {
    const later = buildManagementTurn({ first: false, repos, context, today: TODAY, text: "а тепер поясни" });
    expect(later).not.toContain("ПРОТОКОЛ ДІЙ");
    expect(later).not.toContain("```kermanych-action");
    expect(later).toContain("── КОНТЕКСТ ──");
    expect(later).toContain("а тепер поясни");
    // The contract is ~2 KB of rules; re-sending it every turn would debit the plan for
    // text the same omp child already has.
    expect(later.length).toBeLessThan(
      buildManagementTurn({ first: true, repos, context, today: TODAY, text: "а тепер поясни" }).length,
    );
  });

  it("renders every repository of the workspace, bound and unbound", () => {
    const out = buildManagementTurn({ first: false, repos, context, today: TODAY, text: "?" });
    expect(out).toContain("- Альфа · /repos/alpha · гілка: main");
    expect(out).toContain("- Бета · не привʼязаний на цій машині");
    // The active section is named in the token rule (б) compares against, so the model can
    // tell «may write» from «may only describe» without translating a word.
    expect(out).toContain("Активний розділ: management-risks (Risk Registry, capability=read_write)");
    expect(out.trimEnd().endsWith("?")).toBe(true);
  });

  // The release protocol must describe EXACTLY what `validateManagementAction` accepts, for
  // the same reason the risk one must: the two fields a wrong action costs real money for are
  // the project (the wrong repository writes about somebody else's work) and the range (prose
  // left in a date field is refused a round trip later).
  it("teaches the release-notes action and anchors relative periods to today", () => {
    const out = buildManagementTurn({ first: true, repos, context, today: TODAY, text: "?" });
    expect(out).toContain('"kind": "release.notes"');
    expect(out).toContain("рівно чотири форми");
    expect(out).toContain('"rangeFrom": "РРРР-ММ-ДД"');
    // The anchor itself, re-sent every turn because the answer changes at midnight.
    expect(out).toContain(`Сьогодні: ${TODAY}`);
    expect(buildManagementTurn({ first: false, repos, context, today: TODAY, text: "?" })).toContain(
      `Сьогодні: ${TODAY}`,
    );
    // Ambiguity is a question, never a guess: one branch of one repository is what gets read.
    expect(out).toContain("спитай прозою, не вгадуй");
    // The operations that stayed on the screen say so here, because a writable row carries no
    // `limitation` for the ui to print.
    expect(out).toContain("Редагувати, копіювати чи видаляти вже збережену нотатку ти не можеш");
  });

  // Rule (а) names the writable sections, and it must name them from the table. The sentence
  // it replaced («сьогодні це лише management-risks») was true for exactly as long as one
  // section had a store, and the drift showed up as the assistant refusing a section it could
  // in fact write.
  it("names every writable section in the rules, from the table", () => {
    const out = buildManagementTurn({ first: true, repos, context, today: TODAY, text: "?" });
    const writable = MANAGEMENT_SECTIONS.filter((s) => s.capability === "read_write").map((s) => s.name);
    expect(writable).toContain("management-releases");
    expect(out).toContain(`capability=read_write (${writable.join(", ")})`);
  });

  // The register is state, not contract: it is re-sent every turn, because the assistant
  // filing R-004 on turn two must see R-004 on turn three instead of filing it again.
  it("sends the register with every turn, empty or not", () => {
    const empty = buildManagementTurn({ first: false, repos, context, today: TODAY, text: "?" });
    expect(empty).toContain("Реєстр ризиків воркспейсу (0)");
    expect(empty).toContain("- реєстр порожній");

    const risks: ManagementRiskRow[] = [
      {
        code: "R-001",
        kind: "threat",
        category: "external",
        event: "рахунки не оплачуються",
        probability: 4,
        impact: 5,
        response: "reduce",
        status: "open",
      },
    ];
    const filled = buildManagementTurn({
      first: false,
      repos,
      context: { ...context, risks },
      today: TODAY,
      text: "?",
    });
    expect(filled).toContain("Реєстр ризиків воркспейсу (1)");
    expect(filled).toContain("- R-001 · threat · external · «рахунки не оплачуються» · 4×5=20 · reduce · open");
  });

  // Regression guard for the workspace re-scope: the context block names the Воркспейс and
  // nothing else. A `Проєкт:` line would put a scope in the transcript that the tab no
  // longer has, and the assistant would answer as if one project of the group were «the»
  // subject.
  it("names the workspace and never a project", () => {
    const out = buildManagementTurn({ first: false, repos, context, today: TODAY, text: "?" });
    expect(out).not.toContain("Проєкт:");
    expect(out).toContain("Воркспейс: Acme");
  });
});

// The anchor the model resolves «за останній тиждень» against. LOCAL, not UTC: the range a
// person means is the one on their own wall calendar, and a UTC date is a day off for half
// the planet for part of every day — which would silently shift a release note's period.
describe("todayIso", () => {
  it("formats the local calendar date, zero-padded", () => {
    expect(todayIso(new Date(2026, 8, 1, 23, 30))).toBe("2026-09-01");
    expect(todayIso(new Date(2026, 11, 31, 0, 5))).toBe("2026-12-31");
  });
});
