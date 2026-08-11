import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyCarryFiles } from "../src/env/carry-files";

let proj: string;
let wt: string;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), "kmq-carry-proj-"));
  wt = mkdtempSync(join(tmpdir(), "kmq-carry-wt-"));
});
afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(wt, { recursive: true, force: true });
});

test("copies existing files (incl. nested), skips missing", async () => {
  writeFileSync(join(proj, ".env"), "A=1\n");
  mkdirSync(join(proj, "config"));
  writeFileSync(join(proj, "config", "svc.json"), "{}\n");
  await copyCarryFiles(proj, wt, [".env", "config/svc.json", ".env.local"]);
  expect(readFileSync(join(wt, ".env"), "utf8")).toBe("A=1\n");
  expect(readFileSync(join(wt, "config", "svc.json"), "utf8")).toBe("{}\n");
  expect(existsSync(join(wt, ".env.local"))).toBe(false);
});

test("skips entries that escape projectDir; still copies confined files", async () => {
  writeFileSync(join(proj, ".env"), "A=1\n");
  const outside = join(tmpdir(), "kmq-carry-outside-secret.txt");
  writeFileSync(outside, "SECRET\n");
  try {
    await copyCarryFiles(proj, wt, ["../kmq-carry-outside-secret.txt", ".env"]);
    // escaping entry copied nowhere inside wt; wt holds only the confined .env
    expect(readdirSync(wt)).toEqual([".env"]);
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("A=1\n");
    // outside file untouched (not overwritten/consumed by the copy)
    expect(readFileSync(outside, "utf8")).toBe("SECRET\n");
  } finally {
    rmSync(outside, { force: true });
  }
});
