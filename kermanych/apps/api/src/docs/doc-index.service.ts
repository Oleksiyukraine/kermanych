// apps/api/src/docs/doc-index.service.ts
// The local half of documentation indexing. It walks the project's PUBLISHED doc folders in
// the bound checkout, hashes each file, diffs against the cloud index state, chunks the
// files whose content changed, and hands the changes to the docs-rag Edge Function to be
// embedded and written.
//
// Division of labour (do not collapse it):
//   • Path access stays behind SupervisorService.resolveDocsDir(), so this inherits the
//     bound-project + published-folder + `..`/absolute guards and never opens a second path
//     into the checkout.
//   • Chunking is @kermanych/core's chunkMarkdown, unit-tested without a repo.
//   • Embedding and the cloud WRITE happen in the Edge Function under the OPERATOR's JWT
//     (AuthService.cloudClient) — the api holds no service-role key and never writes chunks
//     directly, so RLS is the isolation surface.
import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { chunkMarkdown, isDocPath } from "@kermanych/core";
import {
  getDocIndexState,
  indexProjectDocs,
  type DocIndexDelete,
  type DocIndexUpsert,
} from "@kermanych/cloud";
import { SupervisorService } from "../supervisor/supervisor.service";
import { WorktreeService } from "../worktree/worktree.service";
import { RegistryService } from "../registry/registry.service";
import { AuthService } from "../auth/auth.service";

// One file found in the checkout that is worth indexing.
type LocalDocFile = { folder: string; path: string; content: string; hash: string };

export type DocReindexResult = {
  indexedFiles: number;
  deletedFiles: number;
  unchangedFiles: number;
  chunkCount: number;
  embeddingModel: string;
};

// One Edge Function call carries at most this many chunks, so a large re-index is split into
// several bounded requests rather than one payload that could exceed the function's limits.
const CHUNK_BATCH = 100;

@Injectable()
export class DocIndexService {
  private readonly log = new Logger(DocIndexService.name);

  constructor(
    private sup: SupervisorService,
    private worktree: WorktreeService,
    private registry: RegistryService,
    private auth: AuthService,
  ) {}

  // Re-index a project's documentation. `full` re-embeds every file regardless of hash (the
  // manual "reindex everything" action); the default is incremental — only files whose hash
  // differs from the cloud state, plus deletions for files that vanished from the checkout.
  async reindex(projectId: string, opts: { full?: boolean } = {}): Promise<DocReindexResult> {
    const client = this.auth.cloudClient();
    const local = await this.collectLocalFiles(projectId);
    const state = await getDocIndexState(client, projectId);

    const prevByKey = new Map(state.files.map((f) => [key(f.folder, f.path), f.fileHash]));
    const localKeys = new Set(local.map((f) => key(f.folder, f.path)));

    const upserts: DocIndexUpsert[] = [];
    let unchangedFiles = 0;
    for (const f of local) {
      if (!opts.full && prevByKey.get(key(f.folder, f.path)) === f.hash) {
        unchangedFiles++;
        continue;
      }
      upserts.push({ folder: f.folder, path: f.path, fileHash: f.hash, chunks: chunkMarkdown(f.content) });
    }

    const deletes: DocIndexDelete[] = state.files
      .filter((f) => !localKeys.has(key(f.folder, f.path)))
      .map((f) => ({ folder: f.folder, path: f.path }));

    let indexedFiles = 0;
    let deletedFiles = 0;
    let chunkCount = 0;
    let embeddingModel = "voyage-4-lite";

    // Deletes ride the first request so a re-index that only removed files still round-trips
    // once; then upserts are flushed in chunk-bounded batches.
    let pendingDeletes = deletes;
    let batch: DocIndexUpsert[] = [];
    let batchChunks = 0;
    const flush = async () => {
      if (batch.length === 0 && pendingDeletes.length === 0) return;
      const res = await indexProjectDocs(client, { projectId, upserts: batch, deletes: pendingDeletes });
      indexedFiles += res.indexedFiles;
      deletedFiles += res.deletedFiles;
      chunkCount += res.chunkCount;
      embeddingModel = res.embeddingModel;
      pendingDeletes = [];
      batch = [];
      batchChunks = 0;
    };

    for (const u of upserts) {
      // A single file larger than the batch still goes on its own request rather than being
      // split across two (its chunks are one file's rows).
      if (batch.length > 0 && batchChunks + u.chunks.length > CHUNK_BATCH) await flush();
      batch.push(u);
      batchChunks += u.chunks.length;
    }
    await flush();

    this.log.debug(`docs reindex ${projectId}: +${indexedFiles} ~${unchangedFiles} -${deletedFiles} (${chunkCount} chunks)`);
    return { indexedFiles, deletedFiles, unchangedFiles, chunkCount, embeddingModel };
  }

  // Every indexable documentation file under the project's published folders, with content
  // and a content hash. Non-doc files (images, source), binary blobs, oversized files and
  // empty files are skipped — the index holds prose only.
  private async collectLocalFiles(projectId: string): Promise<LocalDocFile[]> {
    const project = this.registry.listProjects().find((p) => p.id === projectId);
    if (!project) throw new Error("project not found");
    const out: LocalDocFile[] = [];
    for (const folder of project.docFolders ?? []) {
      // resolveDocsDir re-validates the folder (published + no escape) and throws for an
      // unbound project — the same guard the preview uses.
      const dir = this.sup.resolveDocsDir(projectId, folder);
      await this.walk(dir, folder, "", out);
    }
    return out;
  }

  private async walk(dir: string, folder: string, rel: string, out: LocalDocFile[]): Promise<void> {
    let entries: { name: string; type: "dir" | "file" }[];
    try {
      entries = await this.worktree.listTree(dir, rel);
    } catch {
      // A configured folder absent from THIS checkout is nothing to index, not an error.
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.type === "dir") {
        await this.walk(dir, folder, childRel, out);
        continue;
      }
      // isDocPath excludes images and source: only markup-family and conventional doc names
      // pass, which is exactly the "index prose, skip binaries/images/code" scope.
      if (!isDocPath(childRel)) continue;
      const fc = await this.worktree.readFileContent(dir, childRel).catch(() => null);
      if (!fc || fc.binary || fc.truncated || fc.content.trim() === "") continue;
      out.push({
        folder,
        path: childRel,
        content: fc.content,
        hash: createHash("sha256").update(fc.content).digest("hex"),
      });
    }
  }
}

// The (folder, path) identity of a file. NUL-joined so no folder/path pair can collide with
// another by concatenation.
function key(folder: string, path: string): string {
  return `${folder}\u0000${path}`;
}
