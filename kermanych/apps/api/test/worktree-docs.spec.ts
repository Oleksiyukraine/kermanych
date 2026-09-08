import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorktreeService } from "../src/worktree/worktree.service";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wt-docs-"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return dir;
}

describe("WorktreeService.readFileBytes", () => {
  const svc = new WorktreeService();

  it("returns bytes + a content-type for a known extension", async () => {
    const dir = fixture();
    const r = await svc.readFileBytes(dir, "docs/logo.png");
    expect(r).not.toBeNull();
    expect(r!.contentType).toBe("image/png");
    expect(r!.bytes.length).toBe(4);
  });

  it("rejects a path that escapes the dir", async () => {
    const dir = fixture();
    await expect(svc.readFileBytes(dir, "../secret")).rejects.toThrow("invalid path");
  });

  it("returns null for a missing file", async () => {
    const dir = fixture();
    expect(await svc.readFileBytes(dir, "docs/nope.png")).toBeNull();
  });
});
