// packages/cloud/test/doc-rag.spec.ts
// Integration suite for the documentation RAG index against a LOCAL Supabase stack
// (`supabase start`). Skipped unless the three SUPABASE_TEST_* variables are set, exactly
// like rls.spec.ts, so `pnpm -r test` stays green on a machine without Docker.
//
// The two isolation tests here are a HARD requirement of the feature: documentation indexed
// for one workspace must never be reachable from another — a violation is a data breach
// between customers. They exist from the first commit and use IDENTICAL document text in the
// two workspaces on purpose, because identical text is what catches both a missing RLS
// filter and any cross-project deduplication.
//
// The service-role key mints test users (the same thing GitHub OAuth would do) and NOTHING
// else — every assertion runs through a public-key client carrying a real user JWT, so RLS
// is under test, never bypassed.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { getDocIndexState } from "../src/doc-rag";

const URL = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;

type TestUser = { id: string; email: string; client: SupabaseClient };

// A chunk row as the Edge Function would write it, minus the embedding: these tests exercise
// RLS and the full-text arm of the search, both of which are model-independent, so a null
// embedding is both valid (the column is nullable) and sufficient. The identical text across
// two projects is the whole point of the isolation tests.
const IDENTICAL_TEXT = "Deployment runbook. The staging rollback code is R-004. Restart the worker pool.";

function chunkRow(projectId: string, chunkIx: number, content: string) {
  return {
    project_id: projectId,
    folder: "docs",
    path: "runbook.md",
    chunk_ix: chunkIx,
    heading_path: "# Runbook",
    start_line: 1,
    end_line: 3,
    content,
    embedding: null,
    embedding_model: "voyage-4-lite",
  };
}

describe.skipIf(!URL || !ANON || !SERVICE)("documentation RAG index — isolation and search", () => {
  let admin: SupabaseClient;
  let owner: TestUser; // owns BOTH workspaces, so it can perform the project move in test 2
  let memberA: TestUser; // member of workspace A only
  let wsA: string;
  let wsB: string;
  let projectA: string; // in A, identical text
  let projectB: string; // in B, identical text
  let projectMove: string; // in A, moved to B in test 2

  async function makeUser(tag: string): Promise<TestUser> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handle = `${tag}-${stamp}`;
    const email = `${handle}@kermanych.test`;
    const password = "kermanych-test-password";
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { user_name: handle, full_name: `${tag} Tester`, avatar_url: `https://example.test/${tag}.png` },
    });
    if (created.error) throw created.error;
    const client = createClient(URL ?? "", ANON ?? "", { auth: { autoRefreshToken: false, persistSession: false } });
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw signedIn.error;
    return { id: created.data.user.id, email, client };
  }

  async function makeWorkspace(u: TestUser, name: string): Promise<string> {
    const ws = await u.client.from("workspaces").insert({ name, owner_id: u.id }).select("id").single();
    if (ws.error) throw ws.error;
    return ws.data.id as string;
  }

  async function makeProject(u: TestUser, workspaceId: string, name: string): Promise<string> {
    const p = await u.client.from("projects").insert({ name, workspace_id: workspaceId }).select("id").single();
    if (p.error) throw p.error;
    return p.data.id as string;
  }

  beforeAll(async () => {
    admin = createClient(URL ?? "", SERVICE ?? "", { auth: { autoRefreshToken: false, persistSession: false } });
    owner = await makeUser("docowner");
    memberA = await makeUser("docmember");

    wsA = await makeWorkspace(owner, "docs-ws-a");
    wsB = await makeWorkspace(owner, "docs-ws-b");

    // memberA joins workspace A only.
    const seated = await owner.client.rpc("invite_workspace_member", { p_workspace_id: wsA, p_email: memberA.email });
    if (seated.error) throw seated.error;

    projectA = await makeProject(owner, wsA, "proj-a");
    projectB = await makeProject(owner, wsB, "proj-b");
    projectMove = await makeProject(owner, wsA, "proj-move");

    // Identical text into A and B. Written by memberA into A (proving member write) and by the
    // owner into B.
    const insA = await memberA.client.from("project_doc_chunks").insert(chunkRow(projectA, 0, IDENTICAL_TEXT));
    if (insA.error) throw insA.error;
    const insB = await owner.client.from("project_doc_chunks").insert(chunkRow(projectB, 0, IDENTICAL_TEXT));
    if (insB.error) throw insB.error;
    const insMove = await memberA.client.from("project_doc_chunks").insert(chunkRow(projectMove, 0, "Move me. token-xyzzy."));
    if (insMove.error) throw insMove.error;

    // Index-state rows so getDocIndexState has something to report.
    const stateRows = [
      { project_id: projectA, folder: "docs", path: "runbook.md", file_hash: "hashA", chunk_count: 1, indexed_by: memberA.id },
      { project_id: projectMove, folder: "docs", path: "runbook.md", file_hash: "hashM", chunk_count: 1, indexed_by: memberA.id },
    ];
    const insState = await memberA.client.from("project_doc_index_state").insert(stateRows);
    if (insState.error) throw insState.error;
    const insStateB = await owner.client
      .from("project_doc_index_state")
      .insert({ project_id: projectB, folder: "docs", path: "runbook.md", file_hash: "hashB", chunk_count: 1, indexed_by: owner.id });
    if (insStateB.error) throw insStateB.error;
  }, 30_000);

  // ── ISOLATION TEST 1: identical text, two workspaces, one is invisible ─────────
  it("a member of workspace A cannot retrieve workspace B's chunks even though the text is identical", async () => {
    // The member's own project is visible.
    const own = await memberA.client.from("project_doc_chunks").select("project_id, content").eq("project_id", projectA);
    expect(own.error).toBeNull();
    expect(own.data).toHaveLength(1);
    expect(own.data?.[0]?.content).toBe(IDENTICAL_TEXT);

    // The other workspace's project is invisible — a missing RLS filter or a cross-project
    // dedup that shared the identical row would surface here as a leaked row.
    const foreign = await memberA.client.from("project_doc_chunks").select("project_id").eq("project_id", projectB);
    expect(foreign.error).toBeNull();
    expect(foreign.data).toEqual([]);

    // And the search RPC (security invoker) respects the same policy: pointing it at B from a
    // member of A returns nothing, so an attacker cannot search around the row filter.
    const search = await memberA.client.rpc("match_project_doc_chunks", {
      p_project_id: projectB,
      p_query_embedding: null,
      p_query_text: "rollback code R-004",
      p_match_count: 10,
      p_embedding_model: "voyage-4-lite",
    });
    expect(search.error).toBeNull();
    expect(search.data).toEqual([]);

    // The same search against A DOES find A's chunk (full-text arm), proving the empty B
    // result is isolation and not a broken query.
    const hit = await memberA.client.rpc("match_project_doc_chunks", {
      p_project_id: projectA,
      p_query_embedding: null,
      p_query_text: "rollback code R-004",
      p_match_count: 10,
      p_embedding_model: "voyage-4-lite",
    });
    expect(hit.error).toBeNull();
    expect(hit.data).toHaveLength(1);
  });

  // ── ISOLATION TEST 2: a moved project takes its visibility with it ─────────────
  it("moving a project to another workspace revokes the old workspace member's access to its chunks", async () => {
    // Before the move, memberA (in A) can see projectMove's chunk.
    const before = await memberA.client.from("project_doc_chunks").select("project_id").eq("project_id", projectMove);
    expect(before.error).toBeNull();
    expect(before.data).toHaveLength(1);

    // The owner (a member of both A and B) re-parents the project into B.
    const moved = await owner.client.from("projects").update({ workspace_id: wsB }).eq("id", projectMove).select("id").single();
    expect(moved.error).toBeNull();

    // memberA is not in B, so the chunks are now invisible. A denormalised workspace_id on the
    // chunk row would still read "A" and leak here — that is why this test exists.
    const after = await memberA.client.from("project_doc_chunks").select("project_id").eq("project_id", projectMove);
    expect(after.error).toBeNull();
    expect(after.data).toEqual([]);

    // The owner, now the only one who can reach it, still can — the chunks were not destroyed,
    // only re-homed.
    const ownerSees = await owner.client.from("project_doc_chunks").select("project_id").eq("project_id", projectMove);
    expect(ownerSees.error).toBeNull();
    expect(ownerSees.data).toHaveLength(1);
  });

  // ── The hybrid search RPC fuses full-text hits (Voyage-down fallback path) ──────
  it("match_project_doc_chunks returns full-text hits when the embedding is null (Voyage fallback)", async () => {
    const res = await memberA.client.rpc("match_project_doc_chunks", {
      p_project_id: projectA,
      p_query_embedding: null,
      p_query_text: "worker pool restart",
      p_match_count: 5,
      p_embedding_model: "voyage-4-lite",
    });
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1);
    const row = res.data?.[0];
    expect(row?.path).toBe("runbook.md");
    expect(row?.heading_path).toBe("# Runbook");
    expect(row?.start_line).toBe(1);
  });

  // ── getDocIndexState reports the aggregates the tab shows ───────────────────────
  it("getDocIndexState reports per-file rows and aggregates for a member, nothing for an outsider", async () => {
    const state = await getDocIndexState(memberA.client, projectA);
    expect(state.fileCount).toBe(1);
    expect(state.chunkCount).toBe(1);
    expect(state.lastIndexedAt).not.toBeNull();
    expect(state.files[0]?.path).toBe("runbook.md");
    expect(state.files[0]?.fileHash).toBe("hashA");

    // projectB belongs to a workspace memberA is not in: its state is invisible, i.e. reads
    // as never-indexed.
    const foreign = await getDocIndexState(memberA.client, projectB);
    expect(foreign.fileCount).toBe(0);
    expect(foreign.lastIndexedAt).toBeNull();
  });
});
