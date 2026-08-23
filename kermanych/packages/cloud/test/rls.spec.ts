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

    const project = await owner.client
      .from("projects")
      .insert({ name: "rls-suite", owner_id: owner.id })
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

  it("handle_new_project inserts the creator as owner-member", async () => {
    const { data, error } = await owner.client
      .from("project_members")
      .select("user_id, role")
      .eq("project_id", projectId);
    expect(error).toBeNull();
    expect(data).toEqual([{ user_id: owner.id, role: "owner" }]);
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

  // `project_members` has NO insert policy since 20260823130000: the invite rpc is the only
  // path in. Not even the owner may hand-write a row, so nobody can forge `role='owner'` or
  // a `user_id` that never agreed to anything.
  it("nobody can insert a project member directly, not even the owner", async () => {
    const outsiderTry = await outsider.client
      .from("project_members")
      .insert({ project_id: projectId, user_id: outsider.id, role: "member" });
    expect(outsiderTry.error?.code).toBe("42501");

    const ownerTry = await owner.client
      .from("project_members")
      .insert({ project_id: projectId, user_id: member.id, role: "member" });
    expect(ownerTry.error?.code).toBe("42501");
  });

  it("a non-member cannot invite anyone", async () => {
    const { error } = await outsider.client.rpc("invite_project_member", {
      p_project_id: projectId,
      p_email: outsider.email,
    });
    expect(error?.message).toContain("only a project member can invite");
  });

  it("an email with no Kermanych account is refused", async () => {
    const { error } = await owner.client.rpc("invite_project_member", {
      p_project_id: projectId,
      p_email: "ghost@kermanych.test",
    });
    expect(error?.message).toContain("no Kermanych account");
  });

  it("an invite by email adds the member, who then sees the project's tasks", async () => {
    // Upper-cased on purpose: auth stores the address lower-cased, and a teammate typing it
    // from memory must still resolve.
    const invited = await owner.client.rpc("invite_project_member", {
      p_project_id: projectId,
      p_email: member.email.toUpperCase(),
    });
    expect(invited.error).toBeNull();
    expect(invited.data).toMatchObject({ project_id: projectId, user_id: member.id, role: "member" });

    const tasks = await member.client.from("tasks").select("id").eq("project_id", projectId);
    expect(tasks.error).toBeNull();
    expect(tasks.data?.map((t) => t.id)).toEqual([taskId]);
  });

  // The requirement in one test: whoever is already on the project may bring someone in.
  // `member` was invited by the owner above and holds no ownership of anything.
  it("a plain member can invite another member", async () => {
    const newcomer = await makeUser("invited-by-member");
    const { error } = await member.client.rpc("invite_project_member", {
      p_project_id: projectId,
      p_email: newcomer.email,
    });
    expect(error).toBeNull();

    const projects = await newcomer.client.from("projects").select("id").eq("id", projectId);
    expect(projects.error).toBeNull();
    expect(projects.data?.map((p) => p.id)).toEqual([projectId]);
  });

  it("re-inviting an existing member returns the same row instead of failing", async () => {
    const again = await owner.client.rpc("invite_project_member", {
      p_project_id: projectId,
      p_email: member.email,
    });
    expect(again.error).toBeNull();
    expect(again.data).toMatchObject({ user_id: member.id, role: "member" });

    const rows = await owner.client
      .from("project_members")
      .select("user_id")
      .eq("project_id", projectId)
      .eq("user_id", member.id);
    expect(rows.data).toHaveLength(1);
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
});
