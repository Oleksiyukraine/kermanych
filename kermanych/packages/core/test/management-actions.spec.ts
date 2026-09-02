import { expect, test } from "vitest";
import { MANAGEMENT_SECTIONS, managementSection } from "../src/management";
import { parseManagementReply, validateManagementAction } from "../src/management-actions";
import type { ManagementRejection } from "../src/i18n-codes";

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
  expect(r.rejected[0].code).toBe("block_unreadable");
  expect(r.rejected[0].text).toContain("не вдалося прочитати блок дії");
});

test("unsupported without a section is rejected", () => {
  const res = validateManagementAction({ kind: "unsupported", request: "щось" });
  if (!("error" in res)) throw new Error("expected a refusal");
  expect(res.error).toMatchObject({ code: "unsupported_no_section", text: "unsupported без поля section" });
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
  const fail = (risk: Record<string, unknown>): ManagementRejection => {
    const res = validateManagementAction({ kind: "risk.create", risk: { ...RISK, ...risk } });
    if (!("error" in res)) throw new Error("expected a refusal");
    return res.error;
  };
  expect(fail({ category: "client" })).toMatchObject({
    code: "risk_category_unknown",
    params: { value: '"client"', allowed: expect.stringContaining("external") },
  });
  expect(fail({ category: "client" }).text).toContain('невідома категорія ризику "client"');
  // The category an unpaid invoice actually belongs to is in the message, so the model can
  // fix its own block on the next turn.
  expect(fail({ category: "client" }).text).toContain("external");
  expect(fail({ probability: 7 })).toMatchObject({ code: "risk_score_range", params: { field: "probability", min: 1, max: 5 } });
  expect(fail({ probability: 7 }).text).toContain("probability має бути цілим числом 1–5");
  expect(fail({ cause: "  " })).toMatchObject({ code: "risk_field_blank", params: { field: "cause" } });
  expect(fail({ cause: "  " }).text).toBe("поле cause не може бути порожнім");
  expect(fail({ kind: "opportunity" })).toMatchObject({ code: "risk_response_kind_mismatch", params: { response: "reduce", kind: "opportunity" } });
  expect(fail({ kind: "opportunity" }).text).toContain("стратегія reduce не застосовується до opportunity");
  expect(fail({ response: "avoid", responseActions: "" })).toMatchObject({ code: "risk_response_actions_required", params: { response: "avoid" } });
  expect(fail({ response: "avoid", responseActions: "" }).text).toContain("потребує responseActions");
  expect(fail({ status: "closed" })).toMatchObject({ code: "risk_closure_note_required", params: { status: "closed" } });
  expect(fail({ status: "closed" }).text).toContain("потребує closureNote");
  expect(fail({ costImpact: 40_000 })).toMatchObject({ code: "emv_pair_required" });
  expect(fail({ costImpact: 40_000 }).text).toContain("costImpact і probabilityPct вказуються разом");
  expect(fail({ residualImpact: 2 })).toMatchObject({ code: "residual_pair_required" });
  expect(fail({ residualImpact: 2 }).text).toContain("residualProbability і residualImpact вказуються разом");
  expect(fail({ proximity: "наступного місяця" })).toMatchObject({ code: "risk_date_format", params: { field: "proximity" } });
  expect(fail({ proximity: "наступного місяця" }).text).toContain("має бути датою РРРР-ММ-ДД");
  const noRisk = validateManagementAction({ kind: "risk.create" });
  if (!("error" in noRisk)) throw new Error("expected a refusal");
  expect(noRisk.error).toMatchObject({ code: "risk_create_no_risk", text: "risk.create без об'єкта risk" });
  const missing = validateManagementAction({ kind: "risk.create", risk: { kind: "threat", category: "external" } });
  if (!("error" in missing)) throw new Error("expected a refusal");
  expect(missing.error).toMatchObject({
    code: "risk_create_missing_fields",
    params: { missing: "cause, event, consequence, probability, impact, response" },
  });
  expect(missing.error.text).toBe(
    "risk.create без обов'язкових полів: cause, event, consequence, probability, impact, response",
  );
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
  const noCode = validateManagementAction({ kind: "risk.update", patch: { probability: 5 } });
  if (!("error" in noCode)) throw new Error("expected a refusal");
  expect(noCode.error).toMatchObject({ code: "risk_update_no_code", text: "risk.update без коду ризику (наприклад R-003)" });
  const empty = validateManagementAction({ kind: "risk.update", code: "R-003", patch: {} });
  if (!("error" in empty)) throw new Error("expected a refusal");
  expect(empty.error).toMatchObject({ code: "risk_update_empty", params: { code: "R-003" }, text: "risk.update R-003 нічого не змінює" });
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
  expect(r.rejected).toHaveLength(1);
  expect(r.rejected[0]).toMatchObject({
    code: "action_kind_unknown",
    params: { value: '"release.publish"' },
    text: 'невідома дія "release.publish"',
  });
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
  const noProject = validateManagementAction({ kind: "release.notes", ...RANGE, project: "  " });
  if (!("error" in noProject)) throw new Error("expected a refusal");
  expect(noProject.error).toMatchObject({
    code: "release_no_project",
    text: "release.notes без проєкту — назви його так, як він стоїть у списку репозиторіїв",
  });
  const noBranch = validateManagementAction({ kind: "release.notes", ...RANGE, branch: undefined });
  if (!("error" in noBranch)) throw new Error("expected a refusal");
  expect(noBranch.error).toMatchObject({ code: "release_no_branch", params: { project: "Альфа" }, text: "release.notes для «Альфа» без гілки" });
});

// A model asked for «за останній тиждень» writes exactly that into a date field often enough
// that the refusal has to quote it back — the operator can only re-ask if they can see it.
// And the bounds are the month's and the day's, not merely the shape: git parses `2026-08-32`
// permissively into a period nobody picked.
test("a release.notes range must be two real calendar dates in order", () => {
  const relFail = (over: Record<string, unknown>): ManagementRejection => {
    const res = validateManagementAction({ kind: "release.notes", ...RANGE, ...over });
    if (!("error" in res)) throw new Error("expected a refusal");
    return res.error;
  };
  expect(relFail({ rangeFrom: "останній тиждень" })).toMatchObject({
    code: "release_date_format",
    params: { field: "rangeFrom", value: '"останній тиждень"' },
  });
  expect(relFail({ rangeFrom: "останній тиждень" }).text).toBe(
    'release.notes: rangeFrom="останній тиждень" — це не дата у форматі РРРР-ММ-ДД',
  );
  expect(relFail({ rangeTo: "2026-08-32" })).toMatchObject({ code: "release_date_format", params: { field: "rangeTo" } });
  expect(relFail({ rangeFrom: "2026-13-01" })).toMatchObject({ code: "release_date_format", params: { field: "rangeFrom" } });
  expect(relFail({ rangeTo: undefined })).toMatchObject({
    code: "release_no_range",
    text: "release.notes для «Альфа» без періоду — потрібні rangeFrom і rangeTo",
  });
  expect(relFail({ rangeFrom: "2026-08-31", rangeTo: "2026-08-01" })).toMatchObject({
    code: "release_range_reversed",
    params: { from: "2026-08-31", to: "2026-08-01" },
  });
  expect(relFail({ rangeFrom: "2026-08-31", rangeTo: "2026-08-01" }).text).toBe(
    "release.notes: початок періоду (2026-08-31) пізніший за його кінець (2026-08-01)",
  );
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
