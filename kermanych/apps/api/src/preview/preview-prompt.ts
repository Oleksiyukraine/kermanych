// apps/api/src/preview/preview-prompt.ts
// «Доручити агенту» (docs/specs/2026-11-03-session-browser-preview.md, decision 4): the Kermanych
// prompt that asks the session's own agent for `.kermanych/preview.json`. The supervisor appends
// the resolved `preview-config` skill block (a project or repository override wins), the same
// path «Написати хендоф» takes (writeDoc).
import { PREVIEW_CONFIG_PATH } from "@kermanych/core";

// The default skill (packages/core/src/skills.ts) the prompt inlines.
export const PREVIEW_CONFIG_SKILL = "preview-config";

// `error`: the file's current validation error; absent when the file is missing.
export function previewConfigPrompt(error?: string): string {
  const state = error
    ? `This repository's \`${PREVIEW_CONFIG_PATH}\` is invalid: ${error}`
    : `This repository has no \`${PREVIEW_CONFIG_PATH}\` yet, so its live preview cannot start.`;
  return [
    "The operator asks you to set up the live preview of this session now, while the task is still in progress.",
    "",
    state,
    "",
    `${error ? "Fix" : "Write"} the file by the skill below: read how this repository runs its app in development (package scripts, README, docker files) rather than guessing. ` +
      "Then call `preview_start`, and fix the file until the preview runs. Commit the file on this branch. The task continues after this.",
  ].join("\n");
}
