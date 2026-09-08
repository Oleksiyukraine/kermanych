import { describe, expect, it } from "vitest";
import { toCloudProject, toProjectRow } from "../src/projects";

describe("doc_folders mapping", () => {
  it("maps a doc_folders row to docFolders", () => {
    const p = toCloudProject({
      id: "p1", name: "P", workspace_id: "w1", git_remote_url: null,
      conventions: null, preview_command: null, api_command: null,
      default_branch: null, default_model: null, default_effort: null,
      carry_files: [".env"], env_keys: [], color: null,
      doc_folders: ["docs", "packages/core/docs"], created_at: "t",
    });
    expect(p.docFolders).toEqual(["docs", "packages/core/docs"]);
  });

  it("defaults a null doc_folders to []", () => {
    const p = toCloudProject({
      id: "p1", name: "P", workspace_id: "w1", git_remote_url: null,
      conventions: null, preview_command: null, api_command: null,
      default_branch: null, default_model: null, default_effort: null,
      carry_files: null, env_keys: null, color: null,
      doc_folders: null, created_at: "t",
    });
    expect(p.docFolders).toEqual([]);
  });

  it("sends doc_folders only when present in the patch", () => {
    expect(toProjectRow({}).doc_folders).toBeUndefined();
    expect(toProjectRow({ docFolders: ["docs"] }).doc_folders).toEqual(["docs"]);
    expect(toProjectRow({ docFolders: [] }).doc_folders).toEqual([]);
  });
});
