import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { FEEDBACK_IMAGE_BUCKET, FeedbackRateLimitedError, sendFeedback } from "../src/feedback";

type Err = { message: string } | null;

// Storage and one insert, recording what reached each. `uploadErrors` answer the uploads in order.
function fakeClient(opts: { insertError?: Err; uploadErrors?: Err[] } = {}) {
  const uploads: { bucket: string; path: string }[] = [];
  const removed: string[][] = [];
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const uploadErrors = [...(opts.uploadErrors ?? [])];
  const client = {
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string) {
            const error = uploadErrors.shift() ?? null;
            if (!error) uploads.push({ bucket, path });
            return { data: error ? null : { path }, error };
          },
          async remove(paths: string[]) {
            removed.push(paths);
            return { data: [], error: null };
          },
        };
      },
    },
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return Promise.resolve({ data: null, error: opts.insertError ?? null });
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, uploads, removed, inserts };
}

const png = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

describe("sendFeedback", () => {
  it("uploads screenshots under the author's folder and names them on the row", async () => {
    const fake = fakeClient();
    await sendFeedback(
      fake.client,
      "u1",
      { kind: "bug", message: "  Кнопка не працює  ", appVersion: "1.2.0", client: "desktop", locale: "uk", screen: "agents" },
      [png("screen shot.png"), png("b.png")],
    );
    expect(fake.uploads.map((u) => u.bucket)).toEqual([FEEDBACK_IMAGE_BUCKET, FEEDBACK_IMAGE_BUCKET]);
    expect(fake.uploads[0]?.path).toMatch(/^u1\/[0-9a-f-]{36}-screen-shot\.png$/);
    expect(fake.uploads[1]?.path).toMatch(/^u1\/[0-9a-f-]{36}-b\.png$/);
    expect(fake.inserts).toEqual([
      {
        table: "app_feedback",
        row: {
          kind: "bug",
          message: "Кнопка не працює",
          image_paths: fake.uploads.map((u) => u.path),
          app_version: "1.2.0",
          client: "desktop",
          user_agent: null,
          locale: "uk",
          screen: "agents",
        },
      },
    ]);
    expect(fake.removed).toEqual([]);
  });

  it("removes the uploads when the row is refused, and rethrows the database's message", async () => {
    const fake = fakeClient({ insertError: { message: "new row violates check constraint" } });
    await expect(sendFeedback(fake.client, "u1", { kind: "idea", message: "x" }, [png("a.png")])).rejects.toThrow(
      "new row violates check constraint",
    );
    expect(fake.removed).toEqual([fake.uploads.map((u) => u.path)]);
  });

  it("turns the rate-limit refusal into FeedbackRateLimitedError", async () => {
    const fake = fakeClient({ insertError: { message: "feedback_rate_limited" } });
    await expect(sendFeedback(fake.client, "u1", { kind: "other", message: "x" })).rejects.toBeInstanceOf(
      FeedbackRateLimitedError,
    );
    expect(fake.removed).toEqual([]);
  });

  it("stops at a failed upload, removes the earlier ones and inserts nothing", async () => {
    const fake = fakeClient({ uploadErrors: [null, { message: "The object exceeded the maximum allowed size" }] });
    await expect(
      sendFeedback(fake.client, "u1", { kind: "bug", message: "x" }, [png("a.png"), png("b.png")]),
    ).rejects.toThrow("maximum allowed size");
    expect(fake.removed).toEqual([[fake.uploads[0]?.path]]);
    expect(fake.inserts).toEqual([]);
  });
});
