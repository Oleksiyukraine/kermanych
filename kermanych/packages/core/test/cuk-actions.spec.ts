import { expect, test } from "vitest";
import { cukNeedsConfirm, parseCukReply, validateCukAction, type CukAction } from "../src/cuk-actions";

function block(body: string): string {
  return "```kermanych-action\n" + body + "\n```";
}

test("a navigate block is parsed out and the prose survives without it", () => {
  const r = parseCukReply("Відкриваю.\n\n" + block('{"kind":"navigate","place":"settings:app-keymap"}'));
  expect(r.rejected).toEqual([]);
  expect(r.actions).toEqual([{ kind: "navigate", place: "settings:app-keymap" }]);
  expect(r.text).toBe("Відкриваю.");
});

// Decision 3: nothing irreversible exists in the vocabulary, so a model that names one is
// refused rather than executed — whatever the Менеджмент vocabulary or the app has.
test.each(["session.delete", "session.finish", "pr.create", "branch.merge", "task.delete", "risk.create", "ticket.create"])(
  "%s is not a ЦУК action",
  (kind) => {
    const r = parseCukReply(block(JSON.stringify({ kind, session: "abc12345" })));
    expect(r.actions).toEqual([]);
    expect(r.rejected.map((x) => x.code)).toEqual(["action_kind_unknown"]);
  },
);

test("agent.start needs a project and the task text; the title is optional and capped", () => {
  expect(validateCukAction({ kind: "agent.start", task: "x" })).toMatchObject({ error: { code: "cuk_project_missing" } });
  expect(validateCukAction({ kind: "agent.start", project: "Альфа", task: "  " })).toMatchObject({
    error: { code: "cuk_task_missing" },
  });
  expect(validateCukAction({ kind: "agent.start", project: "Альфа", task: "x", title: "t".repeat(121) })).toMatchObject({
    error: { code: "ticket_title_too_long" },
  });
  expect(validateCukAction({ kind: "agent.start", project: " Альфа ", task: " полагодь вхід ", deepAnalysis: "true" })).toEqual({
    kind: "agent.start",
    project: "Альфа",
    task: "полагодь вхід",
    deepAnalysis: true,
  });
});

test("session verbs need the session; a message needs its text", () => {
  expect(validateCukAction({ kind: "session.stop" })).toMatchObject({ error: { code: "cuk_session_missing" } });
  expect(validateCukAction({ kind: "session.message", session: "abc" })).toMatchObject({
    error: { code: "cuk_message_missing" },
  });
  expect(validateCukAction({ kind: "preview.start", session: "abc" })).toEqual({ kind: "preview.start", session: "abc" });
});

test("scope.select names a workspace, a project, or both — not neither", () => {
  expect(validateCukAction({ kind: "scope.select" })).toMatchObject({ error: { code: "cuk_select_empty" } });
  expect(validateCukAction({ kind: "scope.select", project: "Бета" })).toEqual({ kind: "scope.select", project: "Бета" });
});

// The notepad is the Менеджмент Action List, so its blocks obey that list's rules exactly.
test("todo blocks are validated by the Action List rules", () => {
  expect(validateCukAction({ kind: "todo.create", items: [] })).toMatchObject({ error: { code: "todo_create_empty" } });
  expect(validateCukAction({ kind: "todo.delete", index: 0 })).toMatchObject({ error: { code: "todo_index_range" } });
  expect(validateCukAction({ kind: "todo.create", items: [{ text: "купити каву" }] })).toEqual({
    kind: "todo.create",
    items: [{ text: "купити каву", kind: "check" }],
  });
});

// Decision 4: moving around and the operator's own list run at once; anything that spends the
// plan or touches an agent waits for «Виконати».
test("only navigation and the notepad run without a confirmation card", () => {
  const atOnce: CukAction[] = [
    { kind: "navigate", place: "board" },
    { kind: "scope.select", project: "Альфа" },
    { kind: "session.open", session: "abc" },
    { kind: "todo.delete", index: 1 },
  ];
  const onCard: CukAction[] = [
    { kind: "task.create", project: "Альфа", task: "x" },
    { kind: "agent.start", project: "Альфа", task: "x" },
    { kind: "session.message", session: "abc", text: "далі" },
    { kind: "session.stop", session: "abc" },
    { kind: "session.archive", session: "abc" },
    { kind: "preview.start", session: "abc" },
  ];
  expect(atOnce.map(cukNeedsConfirm)).toEqual(atOnce.map(() => false));
  expect(onCard.map(cukNeedsConfirm)).toEqual(onCard.map(() => true));
});
