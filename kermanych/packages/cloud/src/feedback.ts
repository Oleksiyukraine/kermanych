// Feedback from the app's users (docs/specs/2026-11-13-feedback-form.md): one insert-only
// `app_feedback` row per report, screenshots in the private `feedback-images` bucket under the
// author's own folder (supabase/migrations/20261113090000_app_feedback.sql). Nothing here reads
// the table back: the maintainers read it in the Supabase dashboard.
import type { SupabaseClient } from "@supabase/supabase-js";
import { safeName } from "./tasks";

export const FEEDBACK_KINDS = ["bug", "idea", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
// The table's checks, mirrored so the form refuses before the database does.
export const FEEDBACK_MAX_LENGTH = 5000;
export const FEEDBACK_MAX_IMAGES = 3;
// The bucket's file_size_limit: 10 MiB.
export const FEEDBACK_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const FEEDBACK_IMAGE_BUCKET = "feedback-images";

export type FeedbackInput = {
  kind: FeedbackKind;
  message: string;
  appVersion?: string | undefined;
  client?: "desktop" | "web" | undefined;
  userAgent?: string | undefined;
  locale?: string | undefined;
  screen?: string | undefined;
};

/** The table's rate limit (10 reports per user per hour) refused this one. */
export class FeedbackRateLimitedError extends Error {
  constructor() {
    super("feedback_rate_limited");
    this.name = "FeedbackRateLimitedError";
  }
}

/**
 * Send one report. Screenshots upload first, under `{userId}/{uuid}-{name}`; when an upload or the
 * row insert fails, the objects already uploaded are removed, so the bucket never keeps a
 * screenshot no report names.
 */
export async function sendFeedback(
  client: SupabaseClient,
  userId: string,
  input: FeedbackInput,
  files: File[] = [],
): Promise<void> {
  const bucket = client.storage.from(FEEDBACK_IMAGE_BUCKET);
  const paths: string[] = [];
  try {
    for (const file of files) {
      const path = `${userId}/${crypto.randomUUID()}-${safeName(file.name)}`;
      const { error } = await bucket.upload(path, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (error) throw new Error(error.message);
      paths.push(path);
    }
    // No `.select()`: the author has no SELECT on the table, and nothing needs the row back.
    const { error } = await client.from("app_feedback").insert({
      kind: input.kind,
      message: input.message.trim(),
      image_paths: paths,
      app_version: input.appVersion ?? null,
      client: input.client ?? null,
      user_agent: input.userAgent?.slice(0, 500) ?? null,
      locale: input.locale ?? null,
      screen: input.screen?.slice(0, 100) ?? null,
    });
    if (error) {
      if (error.message.includes("feedback_rate_limited")) throw new FeedbackRateLimitedError();
      throw new Error(error.message);
    }
  } catch (e) {
    if (paths.length) await bucket.remove(paths).catch(() => {});
    throw e;
  }
}
