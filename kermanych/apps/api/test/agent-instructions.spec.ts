import { expect, test } from "vitest";
import { agentById, renderInstruction, PR_CONVENTIONS_FALLBACK } from "@kermanych/core";

test("the review instruction is byte-identical to the text the supervisor used", () => {
  const out = renderInstruction(agentById("review")!, {
    task: "TASK", base: "dev", branch: "feature/x", diff: "DIFF",
  });
  expect(out).toBe(
    `You are an INDEPENDENT code reviewer. You did NOT do this work and have no prior ` +
      `context — audit ONLY the task and the diff below, with fresh eyes.\n\n` +
      `## Original task\nTASK\n\n` +
      `## Diff (base \`dev\` → branch \`feature/x\`)\n` +
      "```diff\nDIFF\n```\n\n" +
      `Perform a FULL audit: does the change satisfy the task; are any requirements missed ` +
      `or only partly done; are there bugs, edge cases, or security issues; are tests present ` +
      `and meaningful; is the code sound? You may read any file in the worktree for context, ` +
      `but you are read-only — do NOT modify anything or run commands. Finish with a clear ` +
      `verdict (APPROVE or NEEDS CHANGES) and a prioritized list of findings.`,
  );
});

test("the conflict instruction is byte-identical", () => {
  const out = renderInstruction(agentById("resolve-conflict")!, { files: "- a.ts\n- b.ts" });
  expect(out).toBe(
    `A git merge is in progress in this worktree with conflicts in:\n` +
      `- a.ts\n- b.ts` +
      `\n\nResolve every conflict: edit each file, remove the conflict markers ` +
      `(<<<<<<<, =======, >>>>>>>), and combine BOTH sides so nothing is lost — keep this ` +
      `branch's changes AND the changes merged in from the base branch. When all conflicts ` +
      `are resolved, run \`git add -A && git commit --no-edit\` to complete the merge. Do only this.`,
  );
});

test("the pull-request instruction keeps the conventions fallback and the base sentence", () => {
  const out = renderInstruction(agentById("pull-request")!, {
    branch: "feature/x",
    conventions: PR_CONVENTIONS_FALLBACK,
    baseLine: "Target the PR at `dev`, unless the repo's PR conventions dictate a different base.",
  });
  expect(out.startsWith("Open a pull request for this session's branch `feature/x`.")).toBe(true);
  expect(out).toContain(PR_CONVENTIONS_FALLBACK);
  expect(out).toContain("2. Push `feature/x` to `origin` (set the upstream).");
  expect(out.endsWith("Reply with the PR URL when done. Do only this.")).toBe(true);
});

test("the promote instruction keeps its branch hole", () => {
  const out = renderInstruction(agentById("promote")!, { branch: "feature/x" });
  expect(out).toContain("dedicated git worktree on branch `feature/x`, with the full toolset.");
});
