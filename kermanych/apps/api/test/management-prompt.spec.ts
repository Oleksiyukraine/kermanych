import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import {
  BRANCH_PREFIXES,
  MANAGEMENT_SECTIONS,
  PLATFORMS,
  RISK_CATEGORY_VALUES,
  RISK_RESPONSES_BY_KIND,
  RISK_STATUS_VALUES,
  type ManagementContext,
  type ManagementMember,
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
  members: [],
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

  // Rule ґ is the ONE line that varies with the operator's locale: the model is told which
  // language to answer in, while the rest of the contract stays a Ukrainian template.
  it("names the operator's locale in the answer directive, and defaults to Ukrainian", () => {
    const en = buildManagementTurn({ first: true, repos, context, today: TODAY, text: "?", locale: "en" });
    expect(en).toContain("(ґ) Відповідай англійською мовою (en).");
    const uk = buildManagementTurn({ first: true, repos, context, today: TODAY, text: "?", locale: "uk" });
    expect(uk).toContain("(ґ) Відповідай українською мовою (uk).");
    // No locale sent → the previous behaviour (Ukrainian), never a blank or English default.
    const bare = buildManagementTurn({ first: true, repos, context, today: TODAY, text: "?" });
    expect(bare).toContain("(ґ) Відповідай українською мовою (uk).");
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
    expect(out).toContain("Дозволені ТІЛЬКИ такі форми");
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

  // The board is not a section, so rule (б) — «capability is not read_write, refuse» — would
  // otherwise be the closest matching rule the model has for «створи тікет», and it would
  // refuse. Rule (в-1) exists to say so out loud, and the ticket protocol has to be in the
  // first turn beside it or the model has the permission and none of the vocabulary.
  it("teaches ticket creation as a cross-section action, not a section write", () => {
    const out = buildManagementTurn({ first: true, repos, context, today: TODAY, text: "?" });
    expect(out).toContain('"kind": "ticket.create"');
    expect(out).toContain('"kind": "jira.ticket.create"');
    expect(out).toContain('"kind": "ticket.questions"');
    expect(out).toContain("НІКОЛИ не відповідай unsupported");
    // The routing rule: one board is the default and the other is opt-in by name.
    expect(out).toContain("дошка ЗА ЗАМОВЧУВАННЯМ");
    expect(out).toContain("ТІЛЬКИ тоді, коли користувач прямо назвав Jira");
    // The two requirements a ticket cannot be filed without, and the two it must not carry.
    expect(out).toContain("acceptanceCriteria — обовʼязково");
    expect(out).toContain("НІЯКИХ технічних рішень і технічних порад");
    expect(out).toContain("Тікет з відкритим питанням не створюється");
    // The launch vocabulary is printed from the core constants, never hand-copied — the same
    // rule the risk vocabulary follows.
    expect(out).toContain(`prefix — тип роботи: ${BRANCH_PREFIXES.join(" | ")}`);
    expect(out).toContain(`platform — ${PLATFORMS.join(" | ")}`);
  });

  // The reported bug, one layer up from the executor that was already correct: asked to put
  // the operator's image on a Jira ticket, the assistant filed the ticket and answered that
  // «дія створення Jira-тікета не має поля для вкладень — прикріпити файл можна лише вручну
  // на екрані Jira». The field existed, the upload path existed, and the ONE authoritative
  // list of allowed forms — the one introduced by «Дозволені ТІЛЬКИ такі форми» — did not
  // mention it. So the menu carries it now, and the rule says out loud what must never be
  // claimed.
  it("lists attachments among the allowed forms and forbids denying the capability", () => {
    const out = buildManagementTurn({ first: true, repos, context, today: TODAY, text: "?" });
    // In the exhaustive menu itself, not only in the prose 170 lines below it.
    const menu = out.split("Не вигадуй інші `kind`")[0] ?? "";
    expect(menu).toContain('"attachments": ["імʼя файлу"]');
    expect(out).toContain("НІКОЛИ не пиши, що поля для вкладень немає");
    expect(out).toContain("Зображення — такий самий файл, як документ");
    // And the other board's truth, which is the opposite one: there is nowhere to put a file
    // on a native card, so that is stated instead of left to the model to improvise.
    expect(out).toContain("Вкладень у власної дошки НЕМАЄ");
  });

  // The block is the text closest to the decision, so it repeats the rule where the file is
  // named — and it distinguishes this message's files from the conversation's earlier ones,
  // because a ticket is routinely filed a turn or two after the image arrived.
  it("names the attachment vocabulary in the file block and marks earlier files as earlier", () => {
    const out = buildManagementTurn({
      first: false,
      repos,
      context,
      today: TODAY,
      text: "прикріпи це до тікета",
      attachments: [
        { name: "screen.png" },
        { name: "звіт.pdf", path: "/tmp/kermanych-management/management-w1/звіт.pdf" },
        { name: "старе.png", earlier: true },
      ],
    });
    expect(out).toContain("── ДОЛУЧЕНІ ФАЙЛИ ──");
    expect(out).toContain("вокабуляр поля `attachments` у jira.ticket.create");
    expect(out).toContain("- «screen.png» — зображення, додане до цього повідомлення");
    expect(out).toContain("- «старе.png» — зображення, з попереднього повідомлення цієї розмови");
    expect(out).toContain("- «звіт.pdf» — /tmp/kermanych-management/management-w1/звіт.pdf");
  });

  // The ticket's language is not the conversation's. Rule (ґ) tells the model to answer in the
  // user's language, and with nothing else said a Ukrainian request produced a Ukrainian
  // ticket — a card the rest of the team cannot read. Both halves are asserted: the ticket's
  // fields are English, and the prose the operator reads is still his.
  it("requires the ticket's own text in English regardless of the language of the request", () => {
    const out = buildManagementTurn({ first: true, repos, context, today: TODAY, text: "створи тікет" });
    expect(out).toContain("МОВА ТІКЕТА — АНГЛІЙСЬКА");
    expect(out).toContain("незалежно від мови розмови");
    expect(out).toContain("ТІЛЬКИ якщо користувач попросив її прямо");
    // The carve-out inside rule (ґ), without which the model has two rules that contradict.
    expect(out).toContain("ВИНЯТОК — текст тікета");
    // Chat prose and the questions stay the operator's language: a model told «English» once
    // starts answering him in English too.
    expect(out).toContain("питання ticket.questions читає користувач — їх пиши його мовою");
  });

  // The roster is the only way an assignee on the NATIVE board can be named:
  // `tasks.assignee_id` is a uuid, the model is shown names, and the browser matches one
  // back. A context block that printed no roster would leave it guessing profile ids.
  it("prints the roster a native-board assignee is named from", () => {
    const members: ManagementMember[] = [
      { name: "olya", role: "developer" },
      { name: "andrii", role: "owner" },
    ];
    const out = buildManagementTurn({ first: false, repos, context: { ...context, members }, today: TODAY, text: "?" });
    expect(out).toContain("Команда воркспейсу (2)");
    expect(out).toContain("- olya · developer");
    expect(out).toContain("- andrii · owner");
    // Named as the NATIVE board's list, because Jira's assignees are a different set and a
    // model that read this line as «the people a ticket may be assigned to» refused every
    // Jira assignee without a Kermanych account.
    expect(out).toContain("на ВЛАСНІЙ дошці");
  });

  // The regression this whole field exists for: a Jira issue is assigned to an ATLASSIAN
  // account, so the roster cannot answer it. With only the roster in the prompt the assistant
  // refused «створи тікет у Jira на Марину» because Maryna has no Kermanych seat — while the
  // same ticket filed by hand offers her, because Jira's own picker does.
  it("prints Jira's own assignable users and tells the model not to use the roster for them", () => {
    const out = buildManagementTurn({
      first: false,
      repos,
      context: {
        ...context,
        members: [{ name: "olya", role: "developer" }],
        jira: {
          projectKey: "KRM",
          boardName: "Kermanych board",
          canWrite: true,
          assignees: ["Maryna Koval", "Olya Petrenko"],
        },
      },
      today: TODAY,
      text: "?",
    });
    expect(out).toContain("Виконавці Jira (2)");
    expect(out).toContain("- Maryna Koval");
    expect(out).toContain("- Olya Petrenko");
    expect(out).toContain("а НЕ командою воркспейсу");
  });

  // Empty is a FAILED READ (no token this turn, Jira unreachable), never «nobody is
  // assignable». Read as the latter it becomes a refusal invented out of a network error —
  // the exact failure this feature was reported for, one layer down.
  it("says the Jira assignee list is unavailable rather than implying nobody is assignable", () => {
    const out = buildManagementTurn({
      first: false,
      repos,
      context: {
        ...context,
        jira: { projectKey: "KRM", boardName: "Kermanych board", canWrite: true, assignees: [] },
      },
      today: TODAY,
      text: "?",
    });
    expect(out).toContain("Виконавці Jira (0)");
    expect(out).toContain("список цього ходу недоступний");
  });

  // Three states, three different sentences — and they are not interchangeable: no board is
  // the owner's job in Integrations, no token is this operator's, and a writable board is the
  // only one of the three where a jira.ticket.create can succeed.
  it("states whether the Jira board exists and whether this machine may write to it", () => {
    const none = buildManagementTurn({ first: false, repos, context, today: TODAY, text: "?" });
    expect(none).toContain("Дошка Jira: не підключена");
    expect(none).not.toContain("Виконавці Jira");

    const readOnly = buildManagementTurn({
      first: false,
      repos,
      context: {
        ...context,
        jira: { projectKey: "KRM", boardName: "Kermanych board", canWrite: false, assignees: [] },
      },
      today: TODAY,
      text: "?",
    });
    expect(readOnly).toContain("Дошка Jira: Kermanych board · проєкт KRM");
    expect(readOnly).toContain("БЕЗ особистого токена Jira");
    // No token means no ticket to assign, so the list is not printed at all — an empty
    // «Виконавці Jira» beside «створити тікет неможливо» is two sentences for one fact.
    expect(readOnly).not.toContain("Виконавці Jira");

    const writable = buildManagementTurn({
      first: false,
      repos,
      context: {
        ...context,
        jira: { projectKey: "KRM", boardName: "Kermanych board", canWrite: true, assignees: ["Maryna Koval"] },
      },
      today: TODAY,
      text: "?",
    });
    expect(writable).toContain("можна створювати тікети");
  });

  // The contract half of the same fix. The rule the assistant follows must name TWO lists and
  // say outright that absence from the workspace is not a reason to refuse a Jira assignee,
  // otherwise the printed list above is one the model has no instruction to read.
  it("gives each board its own assignee list and forbids judging a Jira assignee by the roster", () => {
    const out = buildManagementTurn({ first: true, repos, context, today: TODAY, text: "?" });
    expect(out).toContain("У кожної дошки СВІЙ список людей");
    expect(out).toContain("«Виконавці Jira»");
    expect(out).toContain("НЕ причина відмовити чи спитати");
    // Jira's list is page-capped, so a name the operator gave explicitly is passed through
    // and checked against live Jira instead of being refused against a truncated list.
    expect(out).toContain("все одно постав це імʼя в assignee");
    // And a named assignee is never turned into a ticket.questions round trip.
    expect(out).toContain("користувач НАЗВАВ, теж не питання");
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
