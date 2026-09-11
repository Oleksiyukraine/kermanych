// apps/api/test/doc-index.spec.ts
// The diff/chunk/batch logic of DocIndexService — the acceptance criterion "re-embeds only
// files whose hash changed", plus the full-reindex and deletion paths. The cloud write
// (@kermanych/cloud) is mocked so this asserts WHAT the service decides to send, not the
// Edge Function round trip (which the cloud integration suite covers against a real stack).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { DocIndexRequest, DocIndexState } from "@kermanych/cloud";

// vi.hoisted so these exist when the hoisted vi.mock factory runs (a plain const would be
// referenced before initialization).
const { getDocIndexState, indexProjectDocs } = vi.hoisted(() => ({
  getDocIndexState:
    vi.fn<(client: unknown, projectId: string) => Promise<DocIndexState>>(),
  indexProjectDocs:
    vi.fn<(client: unknown, req: DocIndexRequest) => Promise<{ indexedFiles: number; deletedFiles: number; chunkCount: number; embeddingModel: string }>>(),
}));

vi.mock("@kermanych/cloud", () => ({ getDocIndexState, indexProjectDocs }));

import { DocIndexService } from "../src/docs/doc-index.service";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

// A tiny virtual checkout: folder -> path -> file content.
type Vfs = Record<string, Record<string, string>>;

function makeService(vfs: Vfs, docFolders: string[]) {
  const registry = { listProjects: () => [{ id: "p1", docFolders, localRepoPath: "/repo" }] };
  const sup = { resolveDocsDir: (_id: string, folder: string) => `/repo/${folder}` };
  const worktree = {
    listTree: (dir: string, rel: string) => {
      const folder = dir.slice("/repo/".length);
      if (rel !== "") return Promise.resolve([]); // flat fixture: no subdirectories
      const files = Object.keys(vfs[folder] ?? {});
      return Promise.resolve(files.map((name) => ({ name, type: "file" as const })));
    },
    readFileContent: (dir: string, rel: string) => {
      const folder = dir.slice("/repo/".length);
      const content = vfs[folder]?.[rel];
      if (content === undefined) return Promise.reject(new Error("not a file"));
      return Promise.resolve({ path: rel, content, binary: false, truncated: false });
    },
  };
  const auth = { cloudClient: () => ({}) };
  // Test seam: the four collaborators are exercised only through the narrow surface above.
  return new DocIndexService(
    sup as unknown as ConstructorParameters<typeof DocIndexService>[0],
    worktree as unknown as ConstructorParameters<typeof DocIndexService>[1],
    registry as unknown as ConstructorParameters<typeof DocIndexService>[2],
    auth as unknown as ConstructorParameters<typeof DocIndexService>[3],
  );
}

function state(files: { folder: string; path: string; fileHash: string }[]): DocIndexState {
  return {
    files: files.map((f) => ({ ...f, chunkCount: 1, indexedAt: "2026-09-10T00:00:00Z" })),
    fileCount: files.length,
    chunkCount: files.length,
    lastIndexedAt: files.length ? "2026-09-10T00:00:00Z" : null,
  };
}

beforeEach(() => {
  getDocIndexState.mockReset();
  indexProjectDocs.mockReset();
  indexProjectDocs.mockImplementation((_c, req) =>
    Promise.resolve({
      indexedFiles: req.upserts.length,
      deletedFiles: req.deletes.length,
      chunkCount: req.upserts.reduce((n, u) => n + u.chunks.length, 0),
      embeddingModel: "voyage-4-lite",
    }),
  );
});

describe("DocIndexService.reindex — incremental", () => {
  it("re-embeds only files whose hash changed, deletes files gone from the checkout, and skips the rest", async () => {
    const vfs: Vfs = { docs: { "a.md": "# A\nunchanged body", "b.md": "# B\nnew body" } };
    // a.md matches its stored hash (unchanged); b.md's stored hash is stale (changed); c.md is
    // in the index but no longer on disk (deleted).
    getDocIndexState.mockResolvedValue(
      state([
        { folder: "docs", path: "a.md", fileHash: sha("# A\nunchanged body") },
        { folder: "docs", path: "b.md", fileHash: "stale" },
        { folder: "docs", path: "c.md", fileHash: "whatever" },
      ]),
    );

    const svc = makeService(vfs, ["docs"]);
    const res = await svc.reindex("p1");

    expect(indexProjectDocs).toHaveBeenCalledTimes(1);
    const req = indexProjectDocs.mock.calls[0]![1];
    expect(req.upserts.map((u) => u.path)).toEqual(["b.md"]); // only the changed file
    expect(req.deletes).toEqual([{ folder: "docs", path: "c.md" }]); // the vanished file
    expect(res.unchangedFiles).toBe(1); // a.md
    expect(res.indexedFiles).toBe(1);
    expect(res.deletedFiles).toBe(1);
  });

  it("does not call the Edge Function at all when nothing changed", async () => {
    const vfs: Vfs = { docs: { "a.md": "# A\nbody" } };
    getDocIndexState.mockResolvedValue(state([{ folder: "docs", path: "a.md", fileHash: sha("# A\nbody") }]));

    const res = await makeService(vfs, ["docs"]).reindex("p1");
    expect(indexProjectDocs).not.toHaveBeenCalled();
    expect(res).toMatchObject({ indexedFiles: 0, deletedFiles: 0, unchangedFiles: 1 });
  });
});

describe("DocIndexService.reindex — full", () => {
  it("re-embeds every file regardless of hash", async () => {
    const vfs: Vfs = { docs: { "a.md": "# A\nbody", "b.md": "# B\nbody" } };
    getDocIndexState.mockResolvedValue(
      state([
        { folder: "docs", path: "a.md", fileHash: sha("# A\nbody") }, // hash matches, but full ignores that
        { folder: "docs", path: "b.md", fileHash: sha("# B\nbody") },
      ]),
    );

    const res = await makeService(vfs, ["docs"]).reindex("p1", { full: true });
    const req = indexProjectDocs.mock.calls[0]![1];
    expect(req.upserts.map((u) => u.path).sort()).toEqual(["a.md", "b.md"]);
    expect(res.unchangedFiles).toBe(0);
  });
});

describe("DocIndexService — file selection", () => {
  it("skips non-documentation files (images, source) and never sends them", async () => {
    const vfs: Vfs = { docs: { "guide.md": "# Guide\nprose", "logo.png": "PNGDATA", "app.ts": "export const x = 1" } };
    getDocIndexState.mockResolvedValue(state([]));

    await makeService(vfs, ["docs"]).reindex("p1", { full: true });
    const req = indexProjectDocs.mock.calls[0]![1];
    expect(req.upserts.map((u) => u.path)).toEqual(["guide.md"]);
  });
});
