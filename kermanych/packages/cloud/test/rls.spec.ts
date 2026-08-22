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
// Sign-in is allowlisted (`public.allowed_github_users`), so every handle this
// suite invents has to be seeded first. The allowlist deliberately grants
// NOTHING to anon or authenticated — not even to service_role for DML — so it is
// reachable only as `postgres`, i.e. through psql on the local DSN.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const DB_URL =
  process.env.SUPABASE_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function sql(statement: string): void {
  execFileSync("psql", [DB_URL, "-v", "ON_ERROR_STOP=1", "-q", "-c", statement], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

// Handles seeded by this run, so afterAll removes exactly those and nothing else.
const seeded: string[] = [];

function allow(handle: string): void {
  sql(
    `insert into public.allowed_github_users (github_username, note)
     values ('${handle}', 'rls-suite') on conflict do nothing`,
  );
  seeded.push(handle);
}

type TestUser = { id: string; client: SupabaseClient };

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
    allow(handle);
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
    return { id: created.data.user.id, client };
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

  // Id-scoped: only the handles this run seeded. Removing them does NOT affect the
  // users already created — the allowlist is checked at signup, once.
  afterAll(() => {
    for (const handle of seeded) {
      sql(`delete from public.allowed_github_users where github_username = '${handle}'`);
    }
  });

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

  // The team gate. The repo is public, so this is the difference between "our
  // team can sign in" and "every GitHub account on earth can". handle_new_user()
  // raises, which aborts the auth.users insert itself: no user, no profile.
  it("a GitHub handle that is not on the allowlist cannot become a user", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handle = `intruder-${stamp}`;
    const created = await admin.auth.admin.createUser({
      email: `${handle}@kermanych.test`,
      password: "kermanych-test-password",
      email_confirm: true,
      user_metadata: { user_name: handle, full_name: "Intruder" },
    });
    expect(created.error).not.toBeNull();
    expect(created.data.user).toBeNull();

    // And nothing was left behind: no profile row carries that handle.
    const { data } = await owner.client
      .from("profiles")
      .select("id")
      .eq("github_username", handle);
    expect(data).toEqual([]);
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

  it("a non-owner cannot add a project member", async () => {
    const { error } = await outsider.client
      .from("project_members")
      .insert({ project_id: projectId, user_id: outsider.id, role: "member" });
    expect(error?.code).toBe("42501");
  });

  it("the owner can add a member, who then sees the project's tasks", async () => {
    const added = await owner.client
      .from("project_members")
      .insert({ project_id: projectId, user_id: member.id, role: "member" });
    expect(added.error).toBeNull();

    const tasks = await member.client.from("tasks").select("id").eq("project_id", projectId);
    expect(tasks.error).toBeNull();
    expect(tasks.data?.map((t) => t.id)).toEqual([taskId]);
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
