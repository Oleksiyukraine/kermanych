import { expect, test } from "vitest";
import { MANAGEMENT_SECTIONS, managementSection } from "../src/management";
import { parseManagementReply, validateManagementAction } from "../src/management-actions";

function block(body: string): string {
  return "```kermanych-action\n" + body + "\n```";
}

// The refusal path, which is the whole of «if the assistant cannot act on a page, say why».
// `unsupported` carries only WHICH section and WHAT was asked; the reason the operator reads
// is looked up in the section table, so the model cannot soften it.
test("an unsupported block is parsed out and the prose survives without it", () => {
  const r = parseManagementReply(
    "Цей розділ ще не реалізований.\n\n" +
      block('{"kind":"unsupported","section":"management-releases","request":"додай нотатку релізу"}') +
      "\n\nМожу натомість почитати репозиторії.",
  );
  expect(r.rejected).toEqual([]);
  expect(r.actions).toEqual([
    { kind: "unsupported", section: "management-releases", request: "додай нотатку релізу" },
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
    block('[{"kind":"unsupported","section":"storage"},{"kind":"unsupported","section":"management-releases"}]'),
  );
  expect(r.actions.map((a) => a.section)).toEqual(["storage", "management-releases"]);
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
  expect(writable.map((s) => s.name)).toEqual(["management-risks"]);
  for (const s of MANAGEMENT_SECTIONS) {
    if (s.capability === "read_write") expect(s.limitation, `${s.name} needs no excuse`).toBeUndefined();
    else expect(s.limitation, `${s.name} must explain itself`).toBeTruthy();
  }
});
