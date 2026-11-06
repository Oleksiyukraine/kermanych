// apps/api/test/cuk-controller.spec.ts
// The ЦУК endpoint rebuilds the browser's digest before it reaches a prompt: images only
// (ЦУК has no file tools), every list capped with the cut added to its omitted count, and
// the conversation keyed by the guard's user, never by the body.
import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { ApiErrorBody, CukChatAsk } from "@kermanych/core";
import { CukController } from "../src/http/cuk.controller";
import type { CukChatService } from "../src/cuk/cuk-chat.service";

async function refusal(run: () => Promise<unknown>): Promise<ApiErrorBody> {
  try {
    await run();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as ApiErrorBody;
  }
  throw new Error("expected the call to be refused");
}

function make() {
  const seen: { ask?: CukChatAsk; user?: string; reset?: string } = {};
  const chat = {
    ask: async (a: CukChatAsk, user: string) => ((seen.ask = a), (seen.user = user), {}),
    reset: async (user: string) => ((seen.reset = user), { ok: true }),
  } as unknown as CukChatService;
  return { ctl: new CukController(chat), seen };
}

const REQ = { user: { id: "u1" } };

const body = (over: Record<string, unknown> = {}): CukChatAsk =>
  ({
    text: "hi",
    context: { view: "agents", workspaces: [], projects: [], sessions: [], sessionsOmitted: 0, board: [], boardOmitted: 0, places: [] },
    ...over,
  }) as CukChatAsk;

describe("CukController", () => {
  it("keeps only image attachments", async () => {
    const { ctl, seen } = make();
    await ctl.ask(
      body({
        attachments: [
          { name: "shot.png", mimeType: "image/png", data: "QUJD" },
          { name: "plan.pdf", mimeType: "application/pdf", data: "QUJD" },
        ],
      }),
      REQ,
    );
    expect(seen.ask?.attachments).toEqual([{ name: "shot.png", mimeType: "image/png", data: "QUJD" }]);
    expect(seen.user).toBe("u1");
  });

  it("refuses a turn whose only files were documents", async () => {
    const { ctl } = make();
    const r = await refusal(() =>
      ctl.ask(body({ text: " ", attachments: [{ name: "plan.pdf", mimeType: "application/pdf", data: "QUJD" }] }), REQ),
    );
    expect(r.code).toBe("message_empty");
  });

  it("accepts an image with no words", async () => {
    const { ctl, seen } = make();
    await ctl.ask(body({ text: "", attachments: [{ name: "shot.png", mimeType: "image/png", data: "QUJD" }] }), REQ);
    expect(seen.ask?.text).toBe("");
    expect(seen.ask?.attachments).toHaveLength(1);
  });

  it("refuses a missing context", async () => {
    const { ctl } = make();
    expect((await refusal(() => ctl.ask(body({ context: undefined }), REQ))).code).toBe("section_context_missing");
  });

  it("caps every list and counts what the cap cut", async () => {
    const { ctl, seen } = make();
    const many = <T>(n: number, row: (i: number) => T) => Array.from({ length: n }, (_, i) => row(i));
    await ctl.ask(
      body({
        context: {
          view: "  agents  ",
          workspace: " Acme ",
          workspaces: many(60, (i) => ({ name: `w${i}`, role: "owner", selected: false })),
          projects: many(120, (i) => ({ name: `p${i}`, workspace: "Acme", bound: true, selected: false })),
          sessions: [
            ...many(90, (i) => ({ ref: `s${i}`, project: "p0", name: "n", kind: "agent", status: "thinking", waiting: false, archived: false })),
          ],
          sessionsOmitted: 5,
          board: many(70, (i) => ({ title: `t${i}`, project: "p0", status: "backlog", assignee: "" })),
          boardOmitted: 0,
          places: many(100, (i) => ({ id: `place${i}`, label: "L" })),
          notes: many(250, (i) => ({ text: `n${i}`, kind: "check", done: false })),
        },
      }),
      REQ,
    );
    const c = seen.ask!.context;
    expect(c.view).toBe("agents");
    expect(c.workspace).toBe("Acme");
    expect(c.project).toBeUndefined();
    expect(c.workspaces).toHaveLength(50);
    expect(c.projects).toHaveLength(100);
    expect(c.sessions).toHaveLength(80);
    expect(c.sessionsOmitted).toBe(15);
    expect(c.board).toHaveLength(60);
    expect(c.boardOmitted).toBe(10);
    expect(c.places).toHaveLength(80);
    expect(c.notes).toHaveLength(200);
  });

  it("drops rows it cannot print as fact", async () => {
    const { ctl, seen } = make();
    await ctl.ask(
      body({
        context: {
          view: "agents",
          workspaces: [{ name: "  " }, { name: "Acme", role: 3 }],
          projects: [{ name: "Альфа", bound: "yes" }],
          sessions: [
            { ref: "", status: "thinking" },
            { ref: "a1", status: "exploding" },
            { ref: "b2", project: "Альфа", name: "x", kind: "agent", status: "waiting_input", waiting: true, archived: false, preview: true },
          ],
          board: [{ title: "" }],
          places: [{ label: "без id" }],
        },
      }),
      REQ,
    );
    const c = seen.ask!.context;
    expect(c.workspaces).toEqual([{ name: "Acme", role: "", selected: false }]);
    expect(c.projects).toEqual([{ name: "Альфа", workspace: "", bound: false, selected: false }]);
    expect(c.sessions).toEqual([
      { ref: "b2", project: "Альфа", name: "x", kind: "agent", status: "waiting_input", waiting: true, archived: false, preview: true },
    ]);
    expect(c.board).toEqual([]);
    expect(c.places).toEqual([]);
    // No notes in the body = no workspace selected, which the prompt says in words.
    expect(c.notes).toBeUndefined();
    expect(c.sessionsOmitted).toBe(0);
  });

  it("caps the scheduled tasks and skills, drops unaddressable rows, and fills the clock", async () => {
    const { ctl, seen } = make();
    const many = <T>(n: number, row: (i: number) => T) => Array.from({ length: n }, (_, i) => row(i));
    await ctl.ask(
      body({
        context: {
          view: "agents",
          workspaces: [],
          projects: [],
          sessions: [],
          board: [],
          places: [],
          timeZone: "Europe/Kyiv",
          now: "2026-11-06T18:42+02:00",
          schedules: [
            { ref: "", name: "без ref", type: "reminder", when: "щодня о 19:00", enabled: true },
            { ref: "x1", name: "дивний", type: "cron", when: "?", enabled: true },
            ...many(60, (i) => ({ ref: `r${i}`, name: `t${i}`, type: "agent", project: "Альфа", when: "щодня о 09:00", next: "2026-11-07T09:00", enabled: i % 2 === 0 })),
          ],
          skills: [" weekly-report ", "weekly-report", "", 7, ...many(120, (i) => `skill-${i}`)],
        },
      }),
      REQ,
    );
    const c = seen.ask!.context;
    expect(c.now).toBe("2026-11-06T18:42+02:00");
    expect(c.timeZone).toBe("Europe/Kyiv");
    // The two bad rows count toward the cap of 50 and are dropped.
    expect(c.schedules).toHaveLength(48);
    expect(c.schedules[0]).toEqual({ ref: "r0", name: "t0", type: "agent", project: "Альфа", when: "щодня о 09:00", next: "2026-11-07T09:00", enabled: true });
    expect(c.skills[0]).toBe("weekly-report");
    expect(new Set(c.skills).size).toBe(c.skills.length);
    expect(c.skills.length).toBeLessThanOrEqual(100);
  });

  it("gives a digest without a clock this machine's zone and time", async () => {
    const { ctl, seen } = make();
    await ctl.ask(body(), REQ);
    const c = seen.ask!.context;
    expect(c.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(c.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(c.schedules).toEqual([]);
    expect(c.skills).toEqual([]);
  });

  it("resets the caller's own conversation", async () => {
    const { ctl, seen } = make();
    expect(await ctl.reset(REQ)).toEqual({ ok: true });
    expect(seen.reset).toBe("u1");
  });
});
