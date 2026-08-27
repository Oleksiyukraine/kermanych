// packages/cloud/test/rls.spec.ts
// Integration suite against a LOCAL Supabase stack (`supabase start`). Skipped
// unless the three SUPABASE_TEST_* variables are set, so `pnpm -r test` stays
// green on a machine without Docker. Those three names are LOCAL-STACK ONLY
// fixtures: they keep the legacy spelling `supabase status` labels them with, no
// hosted project's keys belong here, and SUPABASE_TEST_ANON_KEY takes either key
// format (the local stack's `PUBLISHABLE_KEY` works here as well as `ANON_KEY`).
//
// The service-role key is used ONLY to mint test users through the admin API —
// the same thing GitHub OAuth would do — and never to bypass a policy under
// test. Every assertion below runs through a public-key client carrying a real
// user JWT, exactly like the shipped app.
//
// Sign-in is open, so no handle needs pre-seeding: makeUser mints users straight
// through the admin API — the same provisioning path GitHub OAuth drives.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

const URL = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;

type TestUser = { id: string; email: string; client: SupabaseClient };

describe.skipIf(!URL || !ANON || !SERVICE)("supabase RLS and triggers", () => {
  // `describe.skipIf` still EXECUTES this callback at collection time — it only
  // marks the tests it registers as skipped. So the clients must not be built
  // here: createClient("") throws, which would fail the file on a machine
  // without the env vars. Everything real happens in beforeAll, which is the
  // hook skipIf actually suppresses.
  let admin: SupabaseClient;

  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let projectId: string;
  let workspaceId: string;
  let taskId: string;

  async function makeUser(tag: string): Promise<TestUser> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handle = `${tag}-${stamp}`;
    const email = `${handle}@kermanych.test`;
    const password = "kermanych-test-password";
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        user_name: handle,
        full_name: `${tag} Tester`,
        avatar_url: `https://example.test/${tag}.png`,
      },
    });
    if (created.error) throw created.error;
    const client = createClient(URL ?? "", ANON ?? "", {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw signedIn.error;
    return { id: created.data.user.id, email, client };
  }

  beforeAll(async () => {
    admin = createClient(URL ?? "", SERVICE ?? "", {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    owner = await makeUser("owner");
    member = await makeUser("member");
    outsider = await makeUser("outsider");

    const workspace = await owner.client
      .from("workspaces")
      .insert({ name: "rls-ws", owner_id: owner.id })
      .select()
      .single();
    if (workspace.error) throw workspace.error;
    workspaceId = workspace.data.id as string;

    // `member` joins the workspace in the fixture rather than in a test: the
    // project-level invite test that used to grant this access is gone with
    // invite_project_member, and the workspace-level one runs after the task tests
    // that need `member` to reach the board.
    const seatedMember = await owner.client.rpc("invite_workspace_member", {
      p_workspace_id: workspaceId,
      p_email: member.email,
    });
    if (seatedMember.error) throw seatedMember.error;

    const project = await owner.client
      .from("projects")
      .insert({ name: "rls-suite", workspace_id: workspaceId })
      .select()
      .single();
    if (project.error) throw project.error;
    projectId = project.data.id as string;

    const task = await owner.client
      .from("tasks")
      .insert({ project_id: projectId, title: "rls task", created_by: owner.id })
      .select()
      .single();
    if (task.error) throw task.error;
    taskId = task.data.id as string;
  }, 30_000);

  it("handle_new_user fills profiles from the GitHub metadata", async () => {
    const { data, error } = await owner.client
      .from("profiles")
      .select("id, github_username, display_name, avatar_url")
      .eq("id", owner.id)
      .single();
    expect(error).toBeNull();
    expect(data?.display_name).toBe("owner Tester");
    expect(data?.github_username).toMatch(/^owner-/);
    expect(data?.avatar_url).toBe("https://example.test/owner.png");
  });

  // Open sign-in: any GitHub account may become a user. The gate that used to
  // reject unlisted handles is gone (migration 20260823120000 drops
  // allowed_github_users); RLS still isolates a new user to their own projects
  // (proven by the non-member test below).
  it("any GitHub handle can become a user and gets a profile", async () => {
    const fresh = await makeUser("newcomer");
    const { data, error } = await fresh.client
      .from("profiles")
      .select("id, github_username")
      .eq("id", fresh.id)
      .single();
    expect(error).toBeNull();
    expect(data?.github_username).toMatch(/^newcomer-/);
  });

  // Re-publishing a project whose cloud row exists but is invisible to this user (membership
  // revoked, or a teammate published it first). The UI turns this specific refusal into
  // «попросіть власника додати вас», so it must stay a primary-key collision and not, say, a
  // silent no-op that would look like success.
  it("publishing an id that already exists in the cloud is refused as a duplicate key", async () => {
    const stranger = await makeUser("stranger");
    const strangerWs = await stranger.client
      .from("workspaces")
      .insert({ name: "stranger-ws", owner_id: stranger.id })
      .select("id")
      .single();
    if (strangerWs.error) throw strangerWs.error;

    // A direct insert, not createProject(): the payload builder is TypeScript's concern,
    // while the property under test — the database refusing a duplicate project id — is
    // the database's alone. WITH CHECK is evaluated before the index insert, so a
    // workspace the stranger genuinely owns is what lets the collision be the answer.
    const hijack = await stranger.client
      .from("projects")
      .insert({ id: projectId, name: "hijack", workspace_id: strangerWs.data.id })
      .select("id")
      .single();
    expect(hijack.error?.message).toMatch(/duplicate key/);
  });

  it("a non-member sees zero projects and zero tasks", async () => {
    const projects = await outsider.client.from("projects").select("id").eq("id", projectId);
    expect(projects.error).toBeNull();
    expect(projects.data).toEqual([]);

    const tasks = await outsider.client.from("tasks").select("id").eq("project_id", projectId);
    expect(tasks.error).toBeNull();
    expect(tasks.data).toEqual([]);
  });

  it("the anon key with no session sees nothing", async () => {
    const anonymous = createClient(URL ?? "", ANON ?? "", {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await anonymous.from("tasks").select("id");
    // Either a permission error or an empty set is acceptable; a row is not.
    expect(error ? [] : data).toEqual([]);
  });

  // The whole point of the wrapper: a workspace member reaches a project they were
  // never a "project member" of, because that concept no longer exists.
  it("a workspace member sees the workspace's projects and their tasks", async () => {
    const projects = await member.client.from("projects").select("id").eq("id", projectId);
    expect(projects.error).toBeNull();
    expect(projects.data).toHaveLength(1);

    const tasks = await member.client.from("tasks").select("id").eq("id", taskId);
    expect(tasks.error).toBeNull();
    expect(tasks.data).toHaveLength(1);
  });

  it("a non-member sees no projects and no tasks", async () => {
    const projects = await outsider.client.from("projects").select("id").eq("id", projectId);
    expect(projects.data).toEqual([]);
    const tasks = await outsider.client.from("tasks").select("id").eq("id", taskId);
    expect(tasks.data).toEqual([]);
  });

  // USING sees the OLD row and WITH CHECK the NEW one, so one update policy demands
  // membership of BOTH workspaces. No rpc needed.
  it("moving a project requires membership of the source AND the destination", async () => {
    const foreign = await outsider.client
      .from("workspaces")
      .insert({ name: "foreign-ws", owner_id: outsider.id })
      .select("id")
      .single();
    if (foreign.error) throw foreign.error;

    // The two refusals are NOT the same error, and this is verified Postgres 17
    // behaviour, not a guess: WITH CHECK is evaluated against the NEW row and
    // RAISES on violation, while USING simply does not match the OLD row.
    //
    // Member of the source only -> the destination fails WITH CHECK -> 42501
    // "new row violates row-level security policy for table \"projects\"".
    const pushOut = await member.client
      .from("projects")
      .update({ workspace_id: foreign.data.id })
      .eq("id", projectId)
      .select("id")
      .single();
    expect(pushOut.error?.code).toBe("42501");
    expect(pushOut.error?.message).toMatch(/violates row-level security policy/);

    // Non-member of the source -> USING never matches the row, so zero rows come
    // back WITHOUT a Postgres error and `.single()` reports PGRST116.
    const pullOut = await outsider.client
      .from("projects")
      .update({ workspace_id: foreign.data.id })
      .eq("id", projectId)
      .select("id")
      .single();
    expect(pullOut.error?.code).toBe("PGRST116");

    // Owner invites the outsider to a shared destination, then the move lands.
    const shared = await owner.client
      .from("workspaces")
      .insert({ name: "shared-ws", owner_id: owner.id })
      .select("id")
      .single();
    if (shared.error) throw shared.error;
    const invited = await owner.client.rpc("invite_workspace_member", {
      p_workspace_id: shared.data.id,
      p_email: member.email,
    });
    expect(invited.error).toBeNull();

    const moved = await member.client
      .from("projects")
      .update({ workspace_id: shared.data.id })
      .eq("id", projectId)
      .select("workspace_id")
      .single();
    expect(moved.error).toBeNull();
    expect(moved.data?.workspace_id).toBe(shared.data.id);

    // Put it back so later tests keep their fixture.
    const back = await owner.client
      .from("projects")
      .update({ workspace_id: workspaceId })
      .eq("id", projectId)
      .select("workspace_id")
      .single();
    expect(back.error).toBeNull();
  });

  it("only the workspace owner may delete a project", async () => {
    const doomed = await member.client
      .from("projects")
      .insert({ name: "doomed", workspace_id: workspaceId })
      .select("id")
      .single();
    if (doomed.error) throw doomed.error;

    // A refused DELETE matches zero rows WITHOUT an error, so confirm by re-reading.
    await member.client.from("projects").delete().eq("id", doomed.data.id);
    const survived = await owner.client.from("projects").select("id").eq("id", doomed.data.id);
    expect(survived.data).toHaveLength(1);

    await owner.client.from("projects").delete().eq("id", doomed.data.id);
    const gone = await owner.client.from("projects").select("id").eq("id", doomed.data.id);
    expect(gone.data).toEqual([]);
  });

  it("a workspace holding projects cannot be deleted", async () => {
    await owner.client.from("workspaces").delete().eq("id", workspaceId);
    const survived = await owner.client.from("workspaces").select("id").eq("id", workspaceId);
    expect(survived.data).toHaveLength(1);

    const empty = await owner.client
      .from("workspaces")
      .insert({ name: "empty-ws", owner_id: owner.id })
      .select("id")
      .single();
    if (empty.error) throw empty.error;
    await owner.client.from("workspaces").delete().eq("id", empty.data.id);
    const emptyGone = await owner.client.from("workspaces").select("id").eq("id", empty.data.id);
    expect(emptyGone.data).toEqual([]);
  });

  // tasks_guard's single escape hatch now resolves the WORKSPACE owner.
  it("force-stop is the workspace owner's, not a plain member's", async () => {
    const stuck = await owner.client
      .from("tasks")
      .insert({ project_id: projectId, title: "stuck", created_by: owner.id, assignee_id: outsider.id })
      .select("id")
      .single();
    if (stuck.error) throw stuck.error;
    await owner.client.from("tasks").update({ status: "thinking" }).eq("id", stuck.data.id);

    const memberTry = await member.client
      .from("tasks")
      .update({ status: "stopped" })
      .eq("id", stuck.data.id);
    expect(memberTry.error?.message).toMatch(/only the assignee can change status/);

    const ownerForce = await owner.client
      .from("tasks")
      .update({ status: "stopped" })
      .eq("id", stuck.data.id)
      .select("status")
      .single();
    expect(ownerForce.error).toBeNull();
    expect(ownerForce.data?.status).toBe("stopped");
  });

  it("the workspace owner may force only 'stopped', nothing else", async () => {
    const other = await owner.client
      .from("tasks")
      .insert({ project_id: projectId, title: "not yours", created_by: owner.id, assignee_id: outsider.id })
      .select("id")
      .single();
    if (other.error) throw other.error;
    await owner.client.from("tasks").update({ status: "thinking" }).eq("id", other.data.id);

    const ownerTry = await owner.client
      .from("tasks")
      .update({ status: "done" })
      .eq("id", other.data.id);
    expect(ownerTry.error?.message).toMatch(/only the assignee can change status/);
  });

  it("a non-assignee cannot change a task's status", async () => {
    const assigned = await owner.client
      .from("tasks")
      .update({ assignee_id: member.id })
      .eq("id", taskId);
    expect(assigned.error).toBeNull();

    // owner is a member (so the UPDATE policy lets the row through) but not the
    // assignee, so tasks_guard raises.
    const { error } = await owner.client.from("tasks").update({ status: "queued" }).eq("id", taskId);
    expect(error?.message).toContain("only the assignee can change status");
  });

  it("an active task cannot be reassigned", async () => {
    const started = await member.client
      .from("tasks")
      .update({ status: "thinking" })
      .eq("id", taskId);
    expect(started.error).toBeNull();

    const { error } = await owner.client
      .from("tasks")
      .update({ assignee_id: owner.id })
      .eq("id", taskId);
    expect(error?.message).toContain("task is active");
  });

  it("an active task cannot be deleted", async () => {
    const { error } = await owner.client.from("tasks").delete().eq("id", taskId);
    expect(error?.message).toContain("task is active");
  });

  // The recovery path. The task is still 'thinking' from the reassign test above and its
  // assignee is `member` — exactly the shape of a card whose machine crashed: there is no
  // heartbeat, so nothing will ever move it, and the two tests above prove it can neither
  // be reassigned nor deleted in that state.
  it("the project owner can force a stuck active task to stopped", async () => {
    const forced = await owner.client.from("tasks").update({ status: "stopped" }).eq("id", taskId);
    expect(forced.error).toBeNull();

    const { data } = await owner.client.from("tasks").select("status").eq("id", taskId).single();
    expect(data?.status).toBe("stopped");
  });

  // 'stopped' and nothing else: the escape hatch must not become a way for an owner to
  // drive someone else's task around the board.
  it("the project owner cannot force any status other than stopped", async () => {
    const restarted = await owner.client
      .from("tasks")
      .update({ status: "thinking" })
      .eq("id", taskId);
    expect(restarted.error?.message).toContain("only the assignee can change status");

    const finished = await owner.client.from("tasks").update({ status: "done" }).eq("id", taskId);
    expect(finished.error?.message).toContain("only the assignee can change status");
  });

  it("a finished task can be deleted", async () => {
    const finished = await member.client.from("tasks").update({ status: "done" }).eq("id", taskId);
    expect(finished.error).toBeNull();

    const { error } = await owner.client.from("tasks").delete().eq("id", taskId);
    expect(error).toBeNull();
  });

  // handle_new_workspace() is the mirror of the retired handle_new_project(): the
  // creator is owner AND first member in one round trip.
  it("handle_new_workspace inserts the owner's membership row", async () => {
    const { data, error } = await owner.client
      .from("workspace_members")
      .select("workspace_id, user_id, role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", owner.id)
      .single();
    expect(error).toBeNull();
    expect(data?.role).toBe("owner");
  });

  // The `owner_id = auth.uid() or` disjunct in workspaces_select_member is
  // load-bearing: INSERT … RETURNING evaluates the SELECT policy for the new row
  // BEFORE the AFTER-INSERT trigger has written the membership row.
  it("createWorkspace().select() returns the row it just inserted", async () => {
    const fresh = await owner.client
      .from("workspaces")
      .insert({ name: "returning-check", owner_id: owner.id })
      .select("id, name")
      .single();
    expect(fresh.error).toBeNull();
    expect(fresh.data?.name).toBe("returning-check");
  });

  it("a non-member sees no workspaces", async () => {
    const { data, error } = await outsider.client
      .from("workspaces")
      .select("id")
      .eq("id", workspaceId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  // No INSERT policy AND no INSERT grant: the rpc and the trigger are the only
  // writers, so nobody can forge a row with role='owner' or a user_id that never
  // agreed to anything.
  it("nobody can insert a workspace member directly, not even the owner", async () => {
    const ownerTry = await owner.client
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: member.id, role: "member" });
    expect(ownerTry.error?.code).toBe("42501");

    const outsiderTry = await outsider.client
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: outsider.id, role: "member" });
    expect(outsiderTry.error?.code).toBe("42501");
  });

  it("invite_workspace_member refuses an email with no account", async () => {
    const { error } = await owner.client.rpc("invite_workspace_member", {
      p_workspace_id: workspaceId,
      p_email: "nobody@kermanych.test",
    });
    expect(error?.message).toMatch(/no Kermanych account/);
  });

  it("invite_workspace_member refuses a blank address before looking anything up", async () => {
    const { error } = await owner.client.rpc("invite_workspace_member", {
      p_workspace_id: workspaceId,
      p_email: "   ",
    });
    expect(error?.message).toMatch(/email is required/);
  });

  it("invite_workspace_member refuses a plain member and accepts the owner", async () => {
    const added = await owner.client.rpc("invite_workspace_member", {
      p_workspace_id: workspaceId,
      p_email: member.email,
    });
    expect(added.error).toBeNull();
    // Guarded rather than cast through, mirroring inviteMember() in src/projects.ts: if
    // the rpc's `do nothing` re-select fallback ever regressed to null, this fails with
    // a readable assertion instead of a TypeError.
    const addedRow = added.data as { user_id: string } | null;
    expect(addedRow).not.toBeNull();
    expect(addedRow?.user_id).toBe(member.id);

    // Requirement 2: inviting is OWNER-only here, unlike the project-level rule it
    // replaces — one invitation now opens every project in the workspace.
    const memberTry = await member.client.rpc("invite_workspace_member", {
      p_workspace_id: workspaceId,
      p_email: outsider.email,
    });
    expect(memberTry.error?.message).toMatch(/only the workspace owner can invite/);
  });

  // Requirement 2's actual payload, and the only test that exercises the
  // `is_workspace_member` disjunct of workspaces_select_member: the owner path
  // short-circuits on owner_id, so without this the disjunct is dead code as far as
  // the suite knows.
  it("an invited member reads the workspace and its roster; an outsider reads neither", async () => {
    const seen = await member.client.from("workspaces").select("id").eq("id", workspaceId);
    expect(seen.error).toBeNull();
    expect(seen.data).toHaveLength(1);

    const roster = await member.client
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId);
    expect(roster.error).toBeNull();
    expect((roster.data ?? []).map((r) => r.user_id).sort()).toEqual([member.id, owner.id].sort());

    const denied = await outsider.client
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId);
    expect(denied.error).toBeNull();
    expect(denied.data).toEqual([]);
  });

  it("re-inviting the same person is an idempotent no-op", async () => {
    // The "already a member" precondition is established here rather than inherited
    // from the test above, so this holds under `.only` and under reordering: the
    // composite primary key makes a duplicate row impossible, so the proof is that a
    // SECOND invite still succeeds and reports the existing row instead of raising.
    const first = await owner.client.rpc("invite_workspace_member", {
      p_workspace_id: workspaceId,
      p_email: member.email,
    });
    expect(first.error).toBeNull();

    const again = await owner.client.rpc("invite_workspace_member", {
      p_workspace_id: workspaceId,
      p_email: member.email,
    });
    expect(again.error).toBeNull();
    const againRow = again.data as { user_id: string } | null;
    expect(againRow).not.toBeNull();
    expect(againRow?.user_id).toBe(member.id);

    const { data } = await owner.client
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", member.id);
    expect(data).toHaveLength(1);
  });

  it("workspaces_insert_own refuses a forged owner_id", async () => {
    const forged = await member.client
      .from("workspaces")
      .insert({ name: "forged", owner_id: owner.id })
      .select("id")
      .single();
    expect(forged.error?.code).toBe("42501");
  });

  // Removal is the owner's; a plain member's delete matches zero rows and does not error.
  // Last among the tests that involve `member`, because it ends with `member` removed.
  it("only the owner removes a member", async () => {
    await member.client
      .from("workspace_members")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("user_id", member.id);
    const still = await owner.client
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", member.id);
    expect(still.data).toHaveLength(1);

    await owner.client
      .from("workspace_members")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("user_id", member.id);
    const gone = await owner.client
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", member.id);
    expect(gone.data).toEqual([]);
  });
});
