// apps/api/test/management-controller.spec.ts
// The HTTP boundary carries a stable `code` (+ `params`) on every refusal so the UI can
// re-render it in the operator's locale, while keeping the Ukrainian sentence as `message`
// — the fallback a build that does not know the code still shows. Two paths reach the body:
// the controller's own validations (which throw `badRequest`) and a `CodedError` a service
// throws, relayed unchanged.
import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { ApiErrorBody, ManagementChatAsk, ReleaseNotesAsk } from "@kermanych/core";
import { ManagementController } from "../src/http/management.controller";
import { CodedError } from "../src/management/coded-error";
import type { ManagementChatService } from "../src/management/management-chat.service";
import type { ReleaseNotesService } from "../src/management/release-notes.service";

// The body Nest attaches to the 400. `getResponse()` is the object `badRequest` built.
async function refusal(run: () => Promise<unknown>): Promise<ApiErrorBody> {
  try {
    await run();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as ApiErrorBody;
  }
  throw new Error("expected the call to be refused");
}

function make(over: { chat?: Partial<ManagementChatService>; releases?: Partial<ReleaseNotesService> } = {}) {
  const chat = { ask: async () => ({}), reset: async () => ({ ok: true }), ...over.chat } as unknown as ManagementChatService;
  const releases = { generate: async () => ({}), ...over.releases } as unknown as ReleaseNotesService;
  return new ManagementController(chat, releases);
}

const chatAsk = (over: Partial<ManagementChatAsk> = {}): ManagementChatAsk =>
  ({ conversationId: "c1", workspaceId: "w1", workspaceProjects: [], text: "hi", context: { workspaceName: "A", section: "s", risks: [] }, ...over }) as ManagementChatAsk;

const relAsk = (over: Partial<ReleaseNotesAsk> = {}): ReleaseNotesAsk =>
  ({ projectId: "p1", workspaceName: "A", branch: "main", rangeFrom: "2026-08-01", rangeTo: "2026-08-31", ...over }) as ReleaseNotesAsk;

describe("ManagementController — chat validations", () => {
  it("codes a missing conversationId", async () => {
    const body = await refusal(() => make().ask(chatAsk({ conversationId: "" })));
    expect(body.code).toBe("conversation_id_missing");
    expect(body.message).toBe("не вказано розмову (conversationId)");
  });
  it("codes a blank message", async () => {
    expect((await refusal(() => make().ask(chatAsk({ text: "  " })))).code).toBe("message_empty");
  });
  it("codes a missing workspace", async () => {
    expect((await refusal(() => make().ask(chatAsk({ workspaceId: "" })))).code).toBe("workspace_missing");
  });
  it("codes a missing section context", async () => {
    expect((await refusal(() => make().ask(chatAsk({ context: undefined as never })))).code).toBe("section_context_missing");
  });
  it("codes a missing conversationId on reset", async () => {
    expect((await refusal(() => make().reset({ conversationId: "" }))).code).toBe("conversation_id_missing");
  });

  // Files without words ARE a turn («ось документ» often has none), while the caps are
  // refusals rather than silent drops — a dropped attachment is context the operator is
  // actively relying on.
  it("accepts a turn of files alone and hands the sanitized list to the service", async () => {
    let seen: ManagementChatAsk | undefined;
    const ctl = make({ chat: { ask: async (a: ManagementChatAsk) => ((seen = a), {}) } as never });
    await ctl.ask(chatAsk({ text: "", attachments: [{ name: " report.pdf ", mimeType: "application/pdf", data: "QUJD" }] }));
    expect(seen?.attachments).toEqual([{ name: "report.pdf", mimeType: "application/pdf", data: "QUJD" }]);
  });
  it("codes an oversized attachment", async () => {
    const big = { name: "big.pdf", mimeType: "application/pdf", data: "x".repeat(Math.ceil((20 * 1024 * 1024 * 4) / 3) + 1) };
    const body = await refusal(() => make().ask(chatAsk({ attachments: [big] })));
    expect(body.code).toBe("attachment_too_large");
    expect(body.params).toEqual({ name: "big.pdf" });
  });
  it("codes too many attachments", async () => {
    const one = { name: "a.pdf", mimeType: "application/pdf", data: "QQ==" };
    const body = await refusal(() => make().ask(chatAsk({ attachments: Array.from({ length: 11 }, () => one) })));
    expect(body.code).toBe("attachments_too_many");
    expect(body.params).toEqual({ count: 11, max: 10 });
  });
});

describe("ManagementController — release-notes validations", () => {
  it("codes a missing project", async () => {
    expect((await refusal(() => make().releaseNotes(relAsk({ projectId: "" })))).code).toBe("project_missing");
  });
  it("codes a missing branch", async () => {
    expect((await refusal(() => make().releaseNotes(relAsk({ branch: "" })))).code).toBe("branch_missing");
  });
  it("codes a malformed period", async () => {
    expect((await refusal(() => make().releaseNotes(relAsk({ rangeFrom: "nope" })))).code).toBe("period_format_invalid");
  });
  it("codes a reversed period", async () => {
    const body = await refusal(() => make().releaseNotes(relAsk({ rangeFrom: "2026-08-31", rangeTo: "2026-08-01" })));
    expect(body.code).toBe("period_start_after_end");
  });
});

describe("ManagementController — CodedError relay", () => {
  it("relays a service CodedError's code, params and message onto the body", async () => {
    const controller = make({
      releases: {
        generate: async () => {
          throw new CodedError("branch_not_in_repo", "гілки «main» немає в локальному репозиторії", { branch: "main" });
        },
      },
    });
    const body = await refusal(() => controller.releaseNotes(relAsk()));
    expect(body.code).toBe("branch_not_in_repo");
    expect(body.params).toEqual({ branch: "main" });
    expect(body.message).toBe("гілки «main» немає в локальному репозиторії");
  });

  it("relays a chat CodedError (e.g. a turn timeout) onto the body", async () => {
    const controller = make({
      chat: {
        ask: async () => {
          throw new CodedError("assistant_no_reply_timeout", "асистент не відповів за 240 с", { seconds: 240 });
        },
      },
    });
    const body = await refusal(() => controller.ask(chatAsk()));
    expect(body.code).toBe("assistant_no_reply_timeout");
    expect(body.params).toEqual({ seconds: 240 });
  });
});

describe("ManagementController — capacity context", () => {
  it("rebuilds the capacity digest with caps and drops a malformed one", async () => {
    let seen: ManagementChatAsk | undefined;
    const ctl = make({ chat: { ask: async (a: ManagementChatAsk) => ((seen = a), {}) } as Partial<ManagementChatService> });
    const weeks = Array.from({ length: 20 }, (_, i) => ({ week: `2026-01-${String(i + 1).padStart(2, "0")}`, capacityH: 40, plannedH: -3, loggedH: 1.26 }));
    await ctl.ask(
      chatAsk({
        context: {
          workspaceName: "A",
          section: "s",
          risks: [],
          members: [],
          capacity: {
            from: "2026-08-17",
            to: "2026-10-11",
            hoursPerDay: 8,
            team: weeks,
            persons: [{ name: " Марина ", weeks, openIssues: 2.7, unscheduled: -1, overdue: 1 }, { name: 7 }],
            unscheduled: 1,
            overdue: "x",
          },
        } as unknown as ManagementChatAsk["context"],
      }),
    );
    const c = seen!.context.capacity!;
    expect(c.team).toHaveLength(12);
    expect(c.team[0]).toEqual({ week: "2026-01-01", capacityH: 40, plannedH: 0, loggedH: 1.3 });
    expect(c.persons).toHaveLength(2);
    expect(c.persons[0]).toMatchObject({ name: "Марина", openIssues: 2, unscheduled: 0, overdue: 1 });
    expect(c.persons[1]).toMatchObject({ name: "", weeks: [] });
    expect(c.overdue).toBe(0);

    await ctl.ask(chatAsk({ context: { workspaceName: "A", section: "s", risks: [], members: [], capacity: { from: "не дата" } } as unknown as ManagementChatAsk["context"] }));
    expect("capacity" in seen!.context).toBe(false);
  });
});
