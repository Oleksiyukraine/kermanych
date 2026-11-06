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
  expect(atOnce.map((a) => cukNeedsConfirm(a))).toEqual(atOnce.map(() => false));
  expect(onCard.map((a) => cukNeedsConfirm(a))).toEqual(onCard.map(() => true));
});

test("schedule.create: a reminder with «через», an agent task with skills", () => {
  expect(
    validateCukAction({ kind: "schedule.create", name: "Вода", type: "reminder", text: "випити воду", when: { type: "in", minutes: 2 } }),
  ).toEqual({ kind: "schedule.create", name: "Вода", type: "reminder", text: "випити воду", when: { type: "in", minutes: 2 } });
  expect(
    validateCukAction({
      kind: "schedule.create",
      name: "Звіт",
      type: "agent",
      text: "згенеруй звіт",
      project: "Альфа",
      skills: ["report"],
      when: { type: "daily", time: "19:00" },
    }),
  ).toEqual({
    kind: "schedule.create",
    name: "Звіт",
    type: "agent",
    text: "згенеруй звіт",
    project: "Альфа",
    skills: ["report"],
    when: { type: "daily", time: "19:00" },
  });
});

test.each<[Record<string, unknown>, string]>([
  [{ name: undefined }, "schedule_name_missing"],
  [{ type: "cron" }, "schedule_type_invalid"],
  [{ text: " " }, "schedule_text_missing"],
  [{ when: undefined }, "schedule_when_invalid"],
  [{ when: { type: "in", minutes: 0 } }, "schedule_in_invalid"],
  [{ when: { type: "daily", time: "7pm" } }, "schedule_time_invalid"],
  [{ project: "Альфа" }, "schedule_agent_only"],
  [{ skills: ["report"] }, "schedule_agent_only"],
  [{ model: "opus" }, "schedule_agent_only"],
  [{ skills: [""] }, "field_list_not_all_strings"],
])("a reminder schedule.create with %j is refused with %s", (patch, code) => {
  const base = { kind: "schedule.create", name: "Вода", type: "reminder", text: "випити воду", when: { type: "in", minutes: 2 } };
  expect(validateCukAction({ ...base, ...patch })).toMatchObject({ error: { code } });
});

test("schedule verbs need the task ref", () => {
  for (const kind of ["schedule.update", "schedule.pause", "schedule.resume", "schedule.run", "schedule.delete"]) {
    expect(validateCukAction({ kind })).toMatchObject({ error: { code: "schedule_ref_missing", params: { kind } } });
  }
  expect(validateCukAction({ kind: "schedule.pause", ref: "ab12cd34" })).toEqual({ kind: "schedule.pause", ref: "ab12cd34" });
  expect(validateCukAction({ kind: "schedule.update", ref: "ab12cd34", when: { type: "weekly", days: [4, 1], time: "9:00" } })).toEqual({
    kind: "schedule.update",
    ref: "ab12cd34",
    when: { type: "weekly", days: [1, 4], time: "09:00" },
  });
});

// Scheduled tasks, decision 7: a reminder at once, an agent task on a card, delete always a card.
test("schedule actions are weighed by the task's kind", () => {
  const kinds: Record<string, "reminder" | "agent"> = { rem00001: "reminder", agt00001: "agent" };
  const kindOf = (ref: string) => kinds[ref];
  const when = { type: "daily", time: "19:00" } as const;
  const weigh = (a: CukAction) => cukNeedsConfirm(a, kindOf);
  expect(weigh({ kind: "schedule.create", name: "Вода", type: "reminder", text: "x", when })).toBe(false);
  expect(weigh({ kind: "schedule.create", name: "Звіт", type: "agent", text: "x", when })).toBe(true);
  expect(weigh({ kind: "schedule.update", ref: "rem00001", when })).toBe(false);
  expect(weigh({ kind: "schedule.update", ref: "agt00001", when })).toBe(true);
  expect(weigh({ kind: "schedule.resume", ref: "rem00001" })).toBe(false);
  expect(weigh({ kind: "schedule.resume", ref: "agt00001" })).toBe(true);
  expect(weigh({ kind: "schedule.pause", ref: "agt00001" })).toBe(false);
  expect(weigh({ kind: "schedule.run", ref: "rem00001" })).toBe(true);
  expect(weigh({ kind: "schedule.delete", ref: "rem00001" })).toBe(true);
  // A ref nobody knows — or no resolver at all — is the safe side: a card.
  expect(weigh({ kind: "schedule.update", ref: "zzz00000" })).toBe(true);
  expect(cukNeedsConfirm({ kind: "schedule.resume", ref: "rem00001" })).toBe(true);
});
