import { expect, test } from "vitest";
import { MANAGEMENT_SECTIONS, managementSection } from "../src/management";
import { parseManagementReply, renderTicketDescription, validateManagementAction } from "../src/management-actions";

function block(body: string): string {
  return "```kermanych-action\n" + body + "\n```";
}

// The refusal path, which is the whole of «if the assistant cannot act on a page, say why».
// `unsupported` carries only WHICH section and WHAT was asked; the reason the operator reads
// is looked up in the section table, so the model cannot soften it.
test("an unsupported block is parsed out and the prose survives without it", () => {
  const r = parseManagementReply(
    "Цей розділ ще не реалізований.\n\n" +
      block('{"kind":"unsupported","section":"management-capacity","request":"додай людину в команду"}') +
      "\n\nМожу натомість почитати репозиторії.",
  );
  expect(r.rejected).toEqual([]);
  expect(r.actions).toEqual([
    { kind: "unsupported", section: "management-capacity", request: "додай людину в команду" },
  ]);
  expect(r.text).toBe("Цей розділ ще не реалізований.\n\nМожу натомість почитати репозиторії.");
  expect(r.text).not.toContain("kermanych-action");
});

test("no block means no action and the answer is returned untouched", () => {
  const r = parseManagementReply("У воркспейсі два репозиторії: Альфа і Бета.");
  expect(r.actions).toEqual([]);
  expect(r.rejected).toEqual([]);
  expect(r.text).toBe("У воркспейсі два репозиторії: Альфа і Бета.");
});

test("an indented block inside a list item is still recognised", () => {
  const r = parseManagementReply("- відмова:\n  " + block('{"kind":"unsupported","section":"storage"}'));
  expect(r.actions).toEqual([{ kind: "unsupported", section: "storage", request: "" }]);
});

test("one block may carry an array of refusals", () => {
  const r = parseManagementReply(
    block('[{"kind":"unsupported","section":"storage"},{"kind":"unsupported","section":"management-capacity"}]'),
  );
  expect(r.actions.map((a) => a.section)).toEqual(["storage", "management-capacity"]);
});

test("a fence that is not ours is left alone, quoted JSON included", () => {
  const src = 'Приклад:\n\n```json\n{"kind":"unsupported","section":"не виконувати"}\n```';
  const r = parseManagementReply(src);
  expect(r.actions).toEqual([]);
  expect(r.text).toBe(src);
});

test("unreadable JSON is rejected, never executed", () => {
  const r = parseManagementReply(block('{"kind":"unsupported","section":'));
  expect(r.actions).toEqual([]);
  expect(r.rejected).toHaveLength(1);
  expect(r.rejected[0]).toContain("не вдалося прочитати блок дії");
});

test("unsupported without a section is rejected", () => {
  expect(validateManagementAction({ kind: "unsupported", request: "щось" })).toEqual({
    error: "unsupported без поля section",
  });
});

// The write path, which is the other half of the same requirement: the ONE section whose
// row says `read_write` gets an action that reaches a database, and it is validated here
// against the register's own schema before it ever leaves the browser.
test("a risk.create carries the register's vocabulary and survives parsing", () => {
  const r = parseManagementReply(
    "Заношу ризик.\n\n" +
      block(
        JSON.stringify({
          kind: "risk.create",
          risk: {
            kind: "threat",
            category: "external",
            cause: "клієнт не виходить на звʼязок",
            event: "рахунки не оплачуються вчасно",
            consequence: "касовий розрив і зупинка робіт",
            probability: 4,
            impact: 5,
            response: "reduce",
            responseActions: "письмова претензія, призупинення робіт до оплати",
          },
        }),
      ),
  );
  expect(r.rejected).toEqual([]);
  expect(r.actions).toHaveLength(1);
  expect(r.actions[0]).toMatchObject({ kind: "risk.create", risk: { category: "external", probability: 4 } });
  expect(r.text).toBe("Заношу ризик.");
});

// Everything below is a CHECK constraint of 20260830120000_project_risks.sql, enforced here
// so the operator reads which value was wrong instead of a Postgres constraint name — and so
// a malformed row never costs a round trip.
const RISK = {
  kind: "threat",
  category: "external",
  cause: "причина",
  event: "подія",
  consequence: "наслідок",
  probability: 3,
  impact: 3,
  response: "reduce",
  responseActions: "план дій",
};

test("a risk.create is refused when the register's schema would refuse it", () => {
  const err = (risk: Record<string, unknown>): string => {
    const res = validateManagementAction({ kind: "risk.create", risk: { ...RISK, ...risk } });
    if (!("error" in res)) throw new Error("expected a refusal");
    return res.error;
  };
  expect(err({ category: "client" })).toContain('невідома категорія ризику "client"');
  // The category an unpaid invoice actually belongs to is in the message, so the model can
  // fix its own block on the next turn.
  expect(err({ category: "client" })).toContain("external");
  expect(err({ probability: 7 })).toContain("probability має бути цілим числом 1–5");
  expect(err({ cause: "  " })).toBe("поле cause не може бути порожнім");
  expect(err({ kind: "opportunity" })).toContain("стратегія reduce не застосовується до opportunity");
  expect(err({ response: "avoid", responseActions: "" })).toContain("потребує responseActions");
  expect(err({ status: "closed" })).toContain("потребує closureNote");
  expect(err({ costImpact: 40_000 })).toContain("costImpact і probabilityPct вказуються разом");
  expect(err({ residualImpact: 2 })).toContain("residualProbability і residualImpact вказуються разом");
  expect(err({ proximity: "наступного місяця" })).toContain("має бути датою РРРР-ММ-ДД");
  expect(validateManagementAction({ kind: "risk.create" })).toEqual({ error: "risk.create без об'єкта risk" });
  const missing = validateManagementAction({ kind: "risk.create", risk: { kind: "threat", category: "external" } });
  expect(missing).toEqual({
    error: "risk.create без обов'язкових полів: cause, event, consequence, probability, impact, response",
  });
});

// `accept` is the one strategy that may arrive without actions — «прийняти» IS the action.
test("accept needs no response actions and defaults them to empty", () => {
  const { responseActions: _drop, ...rest } = RISK;
  const res = validateManagementAction({ kind: "risk.create", risk: { ...rest, response: "accept" } });
  expect(res).toMatchObject({ kind: "risk.create", risk: { response: "accept", responseActions: "" } });
});

// A quoted number is the same number. Refusing a well-formed risk over its quotation marks
// would cost the operator a turn and teach them nothing.
test("scores arrive as numbers or as the strings a model writes", () => {
  const res = validateManagementAction({
    kind: "risk.create",
    risk: { ...RISK, probability: "4", impact: 5, probabilityPct: "60", costImpact: "40000" },
  });
  expect(res).toMatchObject({ risk: { probability: 4, probabilityPct: 60, costImpact: 40_000 } });
});

test("a risk.update names one register code and changes only what it lists", () => {
  const res = validateManagementAction({
    kind: "risk.update",
    code: "R-003",
    patch: { probability: 5, closureNote: "" },
  });
  expect(res).toEqual({ kind: "risk.update", code: "R-003", patch: { probability: 5, closureNote: "" } });
  expect(validateManagementAction({ kind: "risk.update", patch: { probability: 5 } })).toEqual({
    error: "risk.update без коду ризику (наприклад R-003)",
  });
  expect(validateManagementAction({ kind: "risk.update", code: "R-003", patch: {} })).toEqual({
    error: "risk.update R-003 нічого не змінює",
  });
  // Absent means «unchanged», and so does the `null` a model writes when it means that.
  expect(validateManagementAction({ kind: "risk.update", code: "R-003", patch: { impact: 2, riskOwner: null } })).toEqual(
    { kind: "risk.update", code: "R-003", patch: { impact: 2 } },
  );
});

// A kind nobody implemented must be REPORTED, never dropped: an action silently discarded
// while the prose claims success is the one failure the operator cannot see.
test("an unknown kind is named in the rejection", () => {
  const r = parseManagementReply(block('{"kind":"release.publish","version":"2.1"}'));
  expect(r.actions).toEqual([]);
  expect(r.rejected).toEqual(['невідома дія "release.publish"']);
});

// ── release.notes ─────────────────────────────────────────────────────────────
// The Release Notes write path. What is validated is an ASK, not a row: a project of the
// workspace, one of its branches and an inclusive calendar range. Everything a wrong value
// here costs is real — a generation reads git history and spends a model turn — so each
// refusal names the value that was wrong.

const RANGE = { project: "Альфа", branch: "main", rangeFrom: "2026-08-01", rangeTo: "2026-08-31" } as const;

test("a release.notes carries a project, a branch and an inclusive range", () => {
  const r = parseManagementReply(
    ["Готую реліз-ноти за серпень.", block(JSON.stringify({ kind: "release.notes", ...RANGE }))].join("\n\n"),
  );
  expect(r.actions).toEqual([{ kind: "release.notes", ...RANGE }]);
  expect(r.rejected).toEqual([]);
  expect(r.text).toBe("Готую реліз-ноти за серпень.");
});

// The project is named the way the model was SHOWN it — by name, never by id — so a missing
// name is the one field that cannot be recovered from anywhere else.
test("a release.notes without a project or a branch is refused, not guessed", () => {
  expect(validateManagementAction({ kind: "release.notes", ...RANGE, project: "  " })).toEqual({
    error: "release.notes без проєкту — назви його так, як він стоїть у списку репозиторіїв",
  });
  expect(validateManagementAction({ kind: "release.notes", ...RANGE, branch: undefined })).toEqual({
    error: "release.notes для «Альфа» без гілки",
  });
});

// A model asked for «за останній тиждень» writes exactly that into a date field often enough
// that the refusal has to quote it back — the operator can only re-ask if they can see it.
// And the bounds are the month's and the day's, not merely the shape: git parses `2026-08-32`
// permissively into a period nobody picked.
test("a release.notes range must be two real calendar dates in order", () => {
  expect(validateManagementAction({ kind: "release.notes", ...RANGE, rangeFrom: "останній тиждень" })).toEqual({
    error: 'release.notes: rangeFrom="останній тиждень" — це не дата у форматі РРРР-ММ-ДД',
  });
  expect(validateManagementAction({ kind: "release.notes", ...RANGE, rangeTo: "2026-08-32" })).toEqual({
    error: 'release.notes: rangeTo="2026-08-32" — це не дата у форматі РРРР-ММ-ДД',
  });
  expect(validateManagementAction({ kind: "release.notes", ...RANGE, rangeFrom: "2026-13-01" })).toEqual({
    error: 'release.notes: rangeFrom="2026-13-01" — це не дата у форматі РРРР-ММ-ДД',
  });
  expect(validateManagementAction({ kind: "release.notes", ...RANGE, rangeTo: undefined })).toEqual({
    error: "release.notes для «Альфа» без періоду — потрібні rangeFrom і rangeTo",
  });
  expect(
    validateManagementAction({ kind: "release.notes", ...RANGE, rangeFrom: "2026-08-31", rangeTo: "2026-08-01" }),
  ).toEqual({ error: "release.notes: початок періоду (2026-08-31) пізніший за його кінець (2026-08-01)" });
  // A single day is a legitimate release period, so the comparison is `>` and not `>=`.
  expect(
    validateManagementAction({ kind: "release.notes", ...RANGE, rangeFrom: "2026-08-31", rangeTo: "2026-08-31" }),
  ).toEqual({ kind: "release.notes", project: "Альфа", branch: "main", rangeFrom: "2026-08-31", rangeTo: "2026-08-31" });
});

test("a section resolves by route name, url segment or label", () => {
  expect(managementSection("management-risks")?.label).toBe("Risk Registry");
  expect(managementSection("risk-registry")?.name).toBe("management-risks");
  expect(managementSection("Risk Registry")?.name).toBe("management-risks");
  expect(managementSection("nope")).toBeUndefined();
});

// The capability column is load-bearing: the prompt is generated from it and the ui executor
// reads its `limitation` for every refusal. A section that cannot be written must say why,
// and a section that CAN must not carry a reason it would never show.
test("exactly the sections with a store are writable, and the rest state why not", () => {
  const writable = MANAGEMENT_SECTIONS.filter((s) => s.capability === "read_write");
  expect(writable.map((s) => s.name)).toEqual(["management-risks", "management-releases"]);
  for (const s of MANAGEMENT_SECTIONS) {
    if (s.capability === "read_write") expect(s.limitation, `${s.name} needs no excuse`).toBeUndefined();
    else expect(s.limitation, `${s.name} must explain itself`).toBeTruthy();
  }
});

// ── Tickets ───────────────────────────────────────────────────────────────────

// The five slots a ticket from this surface has. Reused below so each test names only the
// field it is about.
const TICKET = {
  title: "Замовник бачить історію змін рахунку",
  context: "Бухгалтерія не може довести клієнту, коли саме змінилася сума, і кожен спір іде в дзвінки.",
  userFlow: ["Відкриває рахунок", "Перемикається на «Історія»", "Бачить, хто і коли змінив суму"],
  acceptanceCriteria: [
    "На картці рахунку є вкладка «Історія»",
    "Кожен запис показує автора, дату і попереднє значення суми",
  ],
  outOfScope: ["Експорт історії у файл"],
};

// The default board, and the whole of the routing rule: a request that did not name Jira is
// a `ticket.create`. The project travels by NAME for the reason release.notes does.
test("a ticket.create carries the ticket, a project by name and the two launch hints", () => {
  const r = parseManagementReply(
    "Готую тікет на дошку воркспейсу.\n\n" +
      block(
        JSON.stringify({
          kind: "ticket.create",
          project: "Альфа",
          assignee: "olya",
          prefix: "feature",
          platform: "web",
          ticket: TICKET,
        }),
      ),
  );
  expect(r.rejected).toEqual([]);
  expect(r.actions).toEqual([
    { kind: "ticket.create", project: "Альфа", assignee: "olya", prefix: "feature", platform: "web", ticket: TICKET },
  ]);
  expect(r.text).toBe("Готую тікет на дошку воркспейсу.");
});

// The two optional slots are genuinely optional: «зібрати пакет рахунків за вересень» has no
// user flow, and an invented one is worse than none.
test("a ticket needs a title, a context and one acceptance criterion, and nothing else", () => {
  const minimal = { title: "Т", context: "К", acceptanceCriteria: ["Видно на екрані"] };
  expect(validateManagementAction({ kind: "ticket.create", project: "Альфа", ticket: minimal })).toEqual({
    kind: "ticket.create",
    project: "Альфа",
    ticket: minimal,
  });
  expect(
    validateManagementAction({ kind: "ticket.create", project: "Альфа", ticket: { ...TICKET, context: "  " } }),
  ).toEqual({
    error: `тікет «${TICKET.title}» без бізнес-контексту (context) — навіщо ця робота і кому вона потрібна`,
  });
  expect(
    validateManagementAction({ kind: "ticket.create", project: "Альфа", ticket: { ...TICKET, acceptanceCriteria: [] } }),
  ).toEqual({
    error: `тікет «${TICKET.title}» без критеріїв приймання (acceptanceCriteria) — немає за чим його закривати`,
  });
  // A string where a list belongs means several criteria were packed into one line, and the
  // ticket would lose their separation.
  expect(
    validateManagementAction({
      kind: "ticket.create",
      project: "Альфа",
      ticket: { ...TICKET, acceptanceCriteria: "усе працює" },
    }),
  ).toEqual({ error: `тікет «${TICKET.title}»: поле acceptanceCriteria має бути списком рядків` });
});

test("a ticket.create without a project is refused rather than filed on a guess", () => {
  expect(validateManagementAction({ kind: "ticket.create", ticket: TICKET })).toEqual({
    error: `тікет «${TICKET.title}» без проєкту — назви його так, як він стоїть у списку репозиторіїв`,
  });
});

// The launch hints are validated against the core constants the board's own form offers, so a
// value Postgres would store but no screen can render is refused with the list attached.
test("a ticket.create refuses a prefix or a platform outside the app's vocabulary", () => {
  expect(
    validateManagementAction({ kind: "ticket.create", project: "Альфа", ticket: TICKET, prefix: "hotfix" }),
  ).toEqual({ error: 'невідомий тип задачі "hotfix" (feature, fix, refactoring, chore)' });
  expect(
    validateManagementAction({ kind: "ticket.create", project: "Альфа", ticket: TICKET, platform: "desktop" }),
  ).toEqual({ error: 'невідома платформа "desktop" (backend, web, mobile)' });
});

// The requirement this whole action exists to satisfy: a ticket that reaches a board contains
// NO open questions. Each of these is a shape a model actually produces, and the refusal
// quotes the fragment so a false positive is visible rather than mysterious.
test("a ticket carrying an open question is refused, whichever field hides it", () => {
  function refuse(ticket: unknown): string {
    const r = validateManagementAction({ kind: "ticket.create", project: "Альфа", ticket });
    // An accepted action here is the failure this test is about, so it comes back as a string
    // the assertion prints rather than as `undefined.error`.
    return "error" in r ? r.error : `дію прийнято, хоча вона мусила бути відхилена: ${JSON.stringify(r)}`;
  }

  expect(refuse({ ...TICKET, acceptanceCriteria: ["Видно історію", "Права доступу — TBD"] })).toContain('"TBD"');
  expect(refuse({ ...TICKET, context: "Треба уточнити, чи це для всіх клієнтів" })).toContain("Треба уточн");
  expect(refuse({ ...TICKET, outOfScope: ["Експорт — на розсуд розробника"] })).toContain("на розсуд");
  expect(refuse({ ...TICKET, userFlow: [...TICKET.userFlow, "Далі незрозуміло"] })).toContain("незрозуміл");
  expect(refuse({ ...TICKET, title: "Історія змін <назва>" })).toContain("<назва>");
  // A criterion phrased as a question is not a criterion, and no marker catches it: it is a
  // perfectly formed sentence that simply cannot be checked off.
  expect(refuse({ ...TICKET, acceptanceCriteria: ["Чи має адміністратор бачити архів?"] })).toContain(
    "Чи має адміністратор бачити архів?",
  );
  // A code fence is the assistant slipping out of the manager's voice — a technical decision
  // in the only form a string can hold one.
  expect(refuse({ ...TICKET, context: "Додати ендпоінт:\n```ts\nget()\n```" })).toContain("```");
  // Every refusal points at the one action that IS allowed to carry a question.
  expect(refuse({ ...TICKET, context: "потрібно уточнити обсяг" })).toContain("ticket.questions");
});

// «уточнити» on its own is ordinary Ukrainian, and a rule that refused it would refuse
// perfectly good tickets. The markers are deliberately narrow.
test("ordinary prose that merely contains a question word is not an open question", () => {
  const ticket = {
    ...TICKET,
    context: "Користувач може уточнити фільтр за датою, але історії змін не бачить взагалі.",
    acceptanceCriteria: ["Фільтр за датою працює разом з історією"],
  };
  expect(validateManagementAction({ kind: "ticket.create", project: "Альфа", ticket })).toEqual({
    kind: "ticket.create",
    project: "Альфа",
    ticket,
  });
});

// The second board. No `project`: the Jira project key comes from the workspace's integration,
// so there is nothing here for the model to choose or mistake.
test("a jira.ticket.create names its type and priority by name and takes no project", () => {
  expect(
    validateManagementAction({
      kind: "jira.ticket.create",
      ticket: TICKET,
      issueType: "Story",
      priority: "High",
      labels: ["billing", "web"],
      assignee: "Olya Petrenko",
      parentKey: "KRM-101",
    }),
  ).toEqual({
    kind: "jira.ticket.create",
    ticket: TICKET,
    issueType: "Story",
    priority: "High",
    labels: ["billing", "web"],
    assignee: "Olya Petrenko",
    parentKey: "KRM-101",
  });
  // Jira refuses a label with whitespace as a 400 naming a field path; refused here with the
  // offending label quoted instead.
  expect(validateManagementAction({ kind: "jira.ticket.create", ticket: TICKET, labels: ["two words"] })).toEqual({
    error: 'мітка "two words" містить пробіл — Jira такі мітки не приймає',
  });
});

// Both boards hold the ticket to the same standard: there is no board on which a worse ticket
// is acceptable.
test("a Jira ticket is held to the same ticket rules as a board card", () => {
  expect(
    validateManagementAction({ kind: "jira.ticket.create", ticket: { ...TICKET, acceptanceCriteria: ["TODO"] } }),
  ).toEqual({
    error:
      `тікет «${TICKET.title}» містить відкрите питання ("TODO") — такий тікет не створюється. ` +
      "Постав питання через ticket.questions і дочекайся відповіді.",
  });
});

// The other half of «no open questions in a ticket»: the assistant has to be able to ASK, and
// the app has to be able to say that nothing was filed. An empty list is neither.
test("ticket.questions carries the blocked ticket and at least one question", () => {
  expect(
    validateManagementAction({
      kind: "ticket.questions",
      forTicket: "Історія змін рахунку",
      questions: ["Чи бачить історію клієнт, чи лише бухгалтерія?", "  ", "Чи потрібен експорт?"],
    }),
  ).toEqual({
    kind: "ticket.questions",
    forTicket: "Історія змін рахунку",
    questions: ["Чи бачить історію клієнт, чи лише бухгалтерія?", "Чи потрібен експорт?"],
  });
  expect(validateManagementAction({ kind: "ticket.questions", forTicket: "Історія", questions: [] })).toEqual({
    error: "ticket.questions для «Історія» без жодного питання — або питай, або створюй тікет",
  });
  expect(validateManagementAction({ kind: "ticket.questions", questions: ["Що саме?"] })).toEqual({
    error: "ticket.questions без forTicket — назви тікет, який чекає на відповіді",
  });
});

// The app owns the shape of a ticket's body, not the model: the headings, their order and
// their language are the same whichever turn — and whichever board — produced the ticket.
test("renderTicketDescription writes the manager's sections in a fixed order", () => {
  expect(renderTicketDescription(TICKET)).toBe(
    [
      "## Контекст",
      TICKET.context,
      "",
      "## Користувацький сценарій",
      "1. Відкриває рахунок",
      "2. Перемикається на «Історія»",
      "3. Бачить, хто і коли змінив суму",
      "",
      "## Критерії приймання",
      "- [ ] На картці рахунку є вкладка «Історія»",
      "- [ ] Кожен запис показує автора, дату і попереднє значення суми",
      "",
      "## Поза межами задачі",
      "- Експорт історії у файл",
    ].join("\n"),
  );
});

// The optional sections vanish rather than rendering as empty headings — a «Поза межами»
// heading with nothing under it reads as a scope nobody stated.
test("renderTicketDescription omits the sections a ticket does not have", () => {
  expect(renderTicketDescription({ title: "Т", context: "К", acceptanceCriteria: ["Видно"] })).toBe(
    ["## Контекст", "К", "", "## Критерії приймання", "- [ ] Видно"].join("\n"),
  );
});
