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
import { deleteAgentSkill, listAgentSkills, setAgentSkill } from "../src/agent-skills";
import { createProject, listProjects, patchProject } from "../src/projects";
import { deleteProjectSkill, listProjectSkills, upsertProjectSkill } from "../src/skills";
import { deleteTrigger, listTriggers, upsertTrigger } from "../src/triggers";
import { listMembers } from "../src/workspaces";
import {
  deleteJiraIntegration,
  ensureJiraSyncState,
  getJiraIntegration,
  listJiraColumns,
  listJiraIssues,
  replaceJiraColumns,
  takeJiraSyncLease,
  upsertJiraIntegration,
  upsertJiraIssues,
} from "../src/jira";
import { createTask, getTask } from "../src/tasks";

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
    //
    // Upper-cased on purpose, and the only upper-cased address in the file: auth stores
    // it lower-cased, so `lower(u.email) = norm` inside the rpc is what makes a teammate
    // typing a colleague's address from memory resolve. Being the FIRST invite, this is
    // also the one call site that reaches the rpc's `returning * into membership` branch
    // — every later one finds the row already there and exercises the `do nothing`
    // re-select fallback instead — so the returned row is checked here, not just the
    // error.
    const seatedMember = await owner.client.rpc("invite_workspace_member", {
      p_workspace_id: workspaceId,
      p_email: member.email.toUpperCase(),
    });
    if (seatedMember.error) throw seatedMember.error;
    const seatedRow = seatedMember.data as { user_id: string; role: string } | null;
    if (seatedRow?.user_id !== member.id || seatedRow.role !== "developer") {
      throw new Error(
        `invite_workspace_member seated ${JSON.stringify(seatedRow)}, expected ${member.id} as 'developer'`,
      );
    }

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

    // Keyed both ways deliberately: `project_id` proves the whole card wall is invisible,
    // and `id` proves that knowing a task's id is not a way around that.
    const byProject = await outsider.client.from("tasks").select("id").eq("project_id", projectId);
    expect(byProject.error).toBeNull();
    expect(byProject.data).toEqual([]);

    const byId = await outsider.client.from("tasks").select("id").eq("id", taskId);
    expect(byId.error).toBeNull();
    expect(byId.data).toEqual([]);
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
  //
  // What Task 2 changed here: the hatch resolves the owner through
  // projects.workspace_id -> workspaces.owner_id instead of projects.owner_id, because a
  // project no longer has an owner of its own. `owner` holds the workspace.
  it("the workspace owner can force a stuck active task to stopped", async () => {
    const forced = await owner.client.from("tasks").update({ status: "stopped" }).eq("id", taskId);
    expect(forced.error).toBeNull();

    const { data } = await owner.client.from("tasks").select("status").eq("id", taskId).single();
    expect(data?.status).toBe("stopped");
  });

  // 'stopped' and nothing else: the escape hatch must not become a way for an owner to
  // drive someone else's task around the board.
  it("the workspace owner cannot force any status other than stopped", async () => {
    const restarted = await owner.client
      .from("tasks")
      .update({ status: "thinking" })
      .eq("id", taskId);
    expect(restarted.error?.message).toContain("only the assignee can change status");

    const finished = await owner.client.from("tasks").update({ status: "done" }).eq("id", taskId);
    expect(finished.error?.message).toContain("only the assignee can change status");
  });

  // The hatch is the workspace OWNER's, not any member's. Roles are inverted here on
  // purpose: `owner` is the assignee, so they may legitimately start the task, which
  // leaves `member` as a workspace member who is neither assignee nor owner — the exact
  // actor tasks_guard must refuse.
  it("a plain workspace member cannot force-stop someone else's active task", async () => {
    const theirs = await owner.client
      .from("tasks")
      .insert({ project_id: projectId, title: "owned by owner", created_by: owner.id, assignee_id: owner.id })
      .select("id")
      .single();
    if (theirs.error) throw theirs.error;

    const started = await owner.client.from("tasks").update({ status: "thinking" }).eq("id", theirs.data.id);
    expect(started.error).toBeNull();

    const memberTry = await member.client
      .from("tasks")
      .update({ status: "stopped" })
      .eq("id", theirs.data.id);
    expect(memberTry.error?.message).toMatch(/only the assignee can change status/);

    // Leave nothing active behind: the assignee stops their own task.
    const cleared = await owner.client.from("tasks").update({ status: "stopped" }).eq("id", theirs.data.id);
    expect(cleared.error).toBeNull();
  });

  it("a finished task can be deleted", async () => {
    const finished = await member.client.from("tasks").update({ status: "done" }).eq("id", taskId);
    expect(finished.error).toBeNull();

    const { error } = await owner.client.from("tasks").delete().eq("id", taskId);
    expect(error).toBeNull();
  });

  // ── Assignment (20260830090000_tasks_assignment.sql) ────────────────────────
  // Insert a fresh card per case: the fixture `taskId` carries state from the cases above.
  async function freshTask(assigneeId: string | null): Promise<string> {
    const inserted = await owner.client
      .from("tasks")
      .insert({
        project_id: projectId,
        title: "assignment case",
        created_by: owner.id,
        ...(assigneeId ? { assignee_id: assigneeId } : {}),
      })
      .select("id")
      .single();
    if (inserted.error) throw inserted.error;
    return inserted.data.id as string;
  }

  it("refuses to take a backlog card that is already assigned to someone else", async () => {
    const id = await freshTask(owner.id);

    const stolen = await member.client.from("tasks").update({ assignee_id: member.id }).eq("id", id);

    expect(stolen.error?.message).toMatch(/task assigned to someone else/);
    const after = await owner.client.from("tasks").select("assignee_id").eq("id", id).single();
    expect(after.data!.assignee_id).toBe(owner.id);
  });

  it("still lets any member claim an unassigned card", async () => {
    const id = await freshTask(null);

    const claimed = await member.client
      .from("tasks")
      .update({ assignee_id: member.id })
      .eq("id", id)
      .is("assignee_id", null)
      .select("assignee_id")
      .maybeSingle();

    expect(claimed.error).toBeNull();
    expect(claimed.data!.assignee_id).toBe(member.id);
  });

  it("lets the assignee release or hand over their own card", async () => {
    const id = await freshTask(member.id);

    const released = await member.client.from("tasks").update({ assignee_id: null }).eq("id", id);
    expect(released.error).toBeNull();

    const handedOver = await member.client.from("tasks").update({ assignee_id: owner.id }).eq("id", id);
    expect(handedOver.error).toBeNull();
  });

  // The escape hatch: rule 1 already lets the workspace owner force 'stopped' when an
  // assignee is gone for good; reassigning a settled card is the same situation.
  it("lets the workspace owner reassign a non-active card", async () => {
    const id = await freshTask(member.id);

    const moved = await owner.client
      .from("tasks")
      .update({ assignee_id: owner.id })
      .eq("id", id)
      .select("assignee_id")
      .single();

    expect(moved.error).toBeNull();
    expect(moved.data!.assignee_id).toBe(owner.id);
  });

  it("refuses an assignee who is not a member of the task's workspace", async () => {
    const onInsert = await owner.client
      .from("tasks")
      .insert({
        project_id: projectId,
        title: "outsider assignee",
        created_by: owner.id,
        assignee_id: outsider.id,
      })
      .select("id")
      .maybeSingle();
    expect(onInsert.error?.message).toMatch(/assignee is not a workspace member/);

    const id = await freshTask(null);
    const onUpdate = await owner.client.from("tasks").update({ assignee_id: outsider.id }).eq("id", id);
    expect(onUpdate.error?.message).toMatch(/assignee is not a workspace member/);
  });

  // Requirement 8's storage half: the column the launcher's «Ізолювати у worktree» maps to.
  it("defaults worktree to true and accepts false", async () => {
    const id = await freshTask(null);
    const def = await owner.client.from("tasks").select("worktree").eq("id", id).single();
    expect(def.data!.worktree).toBe(true);

    const inPlace = await owner.client
      .from("tasks")
      .update({ worktree: false })
      .eq("id", id)
      .select("worktree")
      .single();
    expect(inPlace.error).toBeNull();
    expect(inPlace.data!.worktree).toBe(false);
  });

  // ── project_skills ──────────────────────────────────────────────────────────
  // Project-level cloud config, so the policy matrix is the projects one: members read,
  // the owner writes. `member` was invited above, `outsider` never was.
  it("the project owner can insert a skill, and the trigger stamps updated_by", async () => {
    const skill = await upsertProjectSkill(owner.client, {
      projectId,
      name: "opening-a-pr",
      description: "  how this team opens a pull request  ",
      body: "Squash, then request a review.",
    });

    expect(skill).toMatchObject({
      projectId,
      name: "opening-a-pr",
      // upsertProjectSkill trims: the editor's trailing whitespace must not become part of
      // the description omp reads.
      description: "how this team opens a pull request",
      body: "Squash, then request a review.",
      enabled: true,
    });
    // project_skills_touch() owns both audit columns, so the writer cannot be forged and an
    // edit cannot be backdated.
    expect(skill.updatedBy).toBe(owner.id);
    expect(Date.parse(skill.updatedAt)).not.toBeNaN();
  });

  it("a member reads the project's skills", async () => {
    const skills = await listProjectSkills(member.client, [projectId]);
    expect(skills.map((s) => s.name)).toEqual(["opening-a-pr"]);
    expect(skills[0]?.body).toBe("Squash, then request a review.");
  });

  // Read-only for members: the library configures every session the whole team launches, so
  // only the owner edits it.
  it("a member cannot write a skill", async () => {
    await expect(
      upsertProjectSkill(member.client, {
        projectId,
        name: "member-written",
        description: "should never land",
        body: "nope",
      }),
    ).rejects.toThrow(/row-level security/);

    const stillOne = await listProjectSkills(owner.client, [projectId]);
    expect(stillOne.map((s) => s.name)).toEqual(["opening-a-pr"]);
  });

  it("a non-member sees zero skills", async () => {
    expect(await listProjectSkills(outsider.client, [projectId])).toEqual([]);
  });

  // Postgres does not raise on a DELETE the USING clause filters out — it matches zero rows
  // and reports success. deleteProjectSkill turns that empty result into a throw, so the
  // refusal reaches the editor instead of looking like a dropped row.
  it("a member's delete is refused and surfaces as a throw", async () => {
    await expect(deleteProjectSkill(member.client, projectId, "opening-a-pr")).rejects.toThrow(
      /was not deleted/,
    );

    const survived = await listProjectSkills(owner.client, [projectId]);
    expect(survived.map((s) => s.name)).toEqual(["opening-a-pr"]);
  });

  it("the owner's delete removes the skill", async () => {
    await expect(deleteProjectSkill(owner.client, projectId, "opening-a-pr")).resolves.toBeUndefined();
    expect(await listProjectSkills(owner.client, [projectId])).toEqual([]);
  });

  // ── project_agent_skills / project_triggers ─────────────────────────────────
  // Same policy matrix as project_skills — members read, the workspace owner writes — so
  // these cases exist to prove the NEW tables carry it, not to re-prove the shape. Placed
  // before the workspace-membership tests below because the last of those ends with
  // `member` removed from the workspace, which would make every read here vacuous.
  it("the workspace owner can assign a skill to an agent and create a trigger", async () => {
    const assignment = await setAgentSkill(owner.client, {
      projectId,
      agentId: "review",
      skillName: "how-we-review",
      position: 2,
    });
    expect(assignment).toEqual({
      projectId,
      agentId: "review",
      skillName: "how-we-review",
      position: 2,
    });

    const trigger = await upsertTrigger(owner.client, {
      projectId,
      id: "env-guard",
      label: "  Нова env-змінна  ",
      source: "thinking",
      pattern: "нову env|new env var",
      action: "skill",
      target: "how-we-add-env",
      mode: "remind",
      repeat: "once",
    });
    // upsertTrigger trims the label and defaults `enabled`; an omitted glob list is stored
    // as NULL and read back as [], which is the normalisation the whole UI relies on.
    expect(trigger.label).toBe("Нова env-змінна");
    expect(trigger.enabled).toBe(true);
    expect(trigger.pathGlobs).toEqual([]);
  });

  // ai_team_touch() owns both audit columns on both tables, so a writer cannot be forged
  // and an edit cannot be backdated. Neither column is in the typed surface, so the check
  // reads them straight off the tables.
  it("ai_team_touch stamps updated_by and updated_at on both tables", async () => {
    const assignment = await owner.client
      .from("project_agent_skills")
      .select("updated_at, updated_by")
      .eq("project_id", projectId)
      .eq("agent_id", "review")
      .eq("skill_name", "how-we-review")
      .single();
    expect(assignment.error).toBeNull();
    expect(assignment.data?.updated_by).toBe(owner.id);
    expect(Date.parse(assignment.data?.updated_at as string)).not.toBeNaN();

    const trigger = await owner.client
      .from("project_triggers")
      .select("updated_at, updated_by")
      .eq("project_id", projectId)
      .eq("id", "env-guard")
      .single();
    expect(trigger.error).toBeNull();
    expect(trigger.data?.updated_by).toBe(owner.id);
    expect(Date.parse(trigger.data?.updated_at as string)).not.toBeNaN();
  });

  it("a member reads the project's agent assignments and triggers", async () => {
    const assignments = await listAgentSkills(member.client, [projectId]);
    expect(assignments.map((a) => `${a.agentId}/${a.skillName}`)).toEqual(["review/how-we-review"]);

    const triggers = await listTriggers(member.client, [projectId]);
    expect(triggers.map((t) => t.id)).toEqual(["env-guard"]);
    expect(triggers[0]?.source).toBe("thinking");
  });

  // The configuration a session launches with is the workspace owner's call: a member reads
  // it and runs under it, but cannot change who does what.
  it("a member cannot write or delete an assignment or a trigger", async () => {
    await expect(
      setAgentSkill(member.client, { projectId, agentId: "plan", skillName: "member-written" }),
    ).rejects.toThrow(/row-level security|violates/);

    await expect(
      upsertTrigger(member.client, {
        projectId,
        id: "member-written",
        label: "should never land",
        source: "operator",
        pattern: "anything",
        action: "skill",
        target: "how-we-add-env",
        mode: "remind",
        repeat: "once",
      }),
    ).rejects.toThrow(/row-level security|violates/);

    // A refused DELETE matches zero rows and reports success; both modules turn that empty
    // result into a throw, which is the only thing that makes the refusal visible.
    await expect(deleteAgentSkill(member.client, projectId, "review", "how-we-review")).rejects.toThrow(
      /was not unassigned/,
    );
    await expect(deleteTrigger(member.client, projectId, "env-guard")).rejects.toThrow(/was not deleted/);

    const assignments = await listAgentSkills(owner.client, [projectId]);
    expect(assignments.map((a) => a.skillName)).toEqual(["how-we-review"]);
    const triggers = await listTriggers(owner.client, [projectId]);
    expect(triggers.map((t) => t.id)).toEqual(["env-guard"]);
  });

  it("a non-member sees zero assignments and zero triggers", async () => {
    expect(await listAgentSkills(outsider.client, [projectId])).toEqual([]);
    expect(await listTriggers(outsider.client, [projectId])).toEqual([]);
  });

  // A child omp process cannot call back into Kermanych, so a trigger that RUNS AN AGENT is
  // only meaningful when Kermanych itself matched it — that is, `source: 'operator'`. The
  // editor blocks the combination too; this constraint is what makes it true for psql and
  // for a direct PostgREST call.
  it("an agent-action trigger from a non-operator source is refused by the check constraint", async () => {
    await expect(
      upsertTrigger(owner.client, {
        projectId,
        id: "bad-agent",
        label: "агент із думок",
        source: "thinking",
        pattern: "щось",
        action: "agent",
        target: "review",
        mode: "remind",
        repeat: "once",
      }),
    ).rejects.toThrow(/project_triggers_agent_action_is_operator/);

    const operatorSourced = await upsertTrigger(owner.client, {
      projectId,
      id: "good-agent",
      label: "агент від оператора",
      source: "operator",
      pattern: "перевір",
      action: "agent",
      target: "review",
      mode: "interrupt",
      repeat: "after-gap",
      pathGlobs: ["apps/api/**"],
    });
    expect(operatorSourced.action).toBe("agent");
    expect(operatorSourced.pathGlobs).toEqual(["apps/api/**"]);

    await expect(deleteTrigger(owner.client, projectId, "good-agent")).resolves.toBeUndefined();
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
      .insert({ workspace_id: workspaceId, user_id: member.id, role: "developer" });
    expect(ownerTry.error?.code).toBe("42501");

    const outsiderTry = await outsider.client
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: outsider.id, role: "developer" });
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

  // set_workspace_member_role is the ONLY writer of workspace_members.role: the table
  // has no UPDATE grant (20260901100000_workspace_member_roles.sql), so this rpc's
  // owner check IS the authorization surface.
  it("the owner sets a member's role, and it round-trips through the roster", async () => {
    const toManager = await owner.client.rpc("set_workspace_member_role", {
      p_workspace_id: workspaceId,
      p_user_id: member.id,
      p_role: "manager",
    });
    expect(toManager.error).toBeNull();
    expect((toManager.data as { role: string } | null)?.role).toBe("manager");

    const seen = await owner.client
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", member.id)
      .single();
    expect(seen.data?.role).toBe("manager");

    // Restore the fixture's default so later tests see `member` as they expect.
    const back = await owner.client.rpc("set_workspace_member_role", {
      p_workspace_id: workspaceId,
      p_user_id: member.id,
      p_role: "developer",
    });
    expect(back.error).toBeNull();
  });

  it("a plain member cannot change roles", async () => {
    const denied = await member.client.rpc("set_workspace_member_role", {
      p_workspace_id: workspaceId,
      p_user_id: member.id,
      p_role: "manager",
    });
    expect(denied.error?.message).toMatch(/only the workspace owner can change roles/);
  });

  it("the owner's own seat cannot be re-roled", async () => {
    const denied = await owner.client.rpc("set_workspace_member_role", {
      p_workspace_id: workspaceId,
      p_user_id: owner.id,
      p_role: "manager",
    });
    expect(denied.error?.message).toMatch(/owner keeps the owner role/);
  });

  it("owner cannot be handed out as a role", async () => {
    const denied = await owner.client.rpc("set_workspace_member_role", {
      p_workspace_id: workspaceId,
      p_user_id: member.id,
      p_role: "owner",
    });
    expect(denied.error?.message).toMatch(/role must be manager or developer/);
  });

  it("workspaces_insert_own refuses a forged owner_id", async () => {
    const forged = await member.client
      .from("workspaces")
      .insert({ name: "forged", owner_id: owner.id })
      .select("id")
      .single();
    expect(forged.error?.code).toBe("42501");
  });

  // Several things assume the owner is always a member, so the owner's seat is the one
  // row their own delete policy must refuse. There is no way back if it goes: no INSERT
  // grant, and the invite rpc would re-seat them as 'developer'. The other half of the
  // policy — that the owner CAN unseat someone else — is the test immediately below.
  it("the owner cannot delete their own seat", async () => {
    await owner.client
      .from("workspace_members")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("user_id", owner.id);
    const still = await owner.client
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", owner.id)
      .single();
    expect(still.error).toBeNull();
    expect(still.data?.role).toBe("owner");
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

  // The one place the TypeScript column contract meets the real database. Everything
  // else in packages/cloud is unit-tested against a hand-rolled fake, so a typo in
  // PROJECT_COLUMNS, MEMBER_COLUMNS or a mapper would otherwise ship green — there is no
  // generated Database type to catch it.
  it("the typed project and member surfaces round-trip against the real schema", async () => {
    const created = await createProject(owner.client, { name: "typed-surface", workspaceId });
    expect(created.workspaceId).toBe(workspaceId);
    expect(created).not.toHaveProperty("ownerId");
    expect(created.carryFiles).toEqual([".env"]);

    const listed = (await listProjects(owner.client)).find((p) => p.id === created.id);
    expect(listed?.workspaceId).toBe(workspaceId);

    const moved = await patchProject(owner.client, created.id, { name: "typed-surface-2" });
    expect(moved.name).toBe("typed-surface-2");

    // Exercises MEMBER_COLUMNS and its profiles(...) embed, which no other test issues.
    const roster = await listMembers(owner.client, workspaceId);
    expect(roster.every((m) => m.workspaceId === workspaceId)).toBe(true);

    // `profile` is the ONLY field that comes from the profiles(...) embed in
    // MEMBER_COLUMNS. Without this assertion a dropped or misspelled embed leaves it
    // undefined and every other assertion here still passes — which is the exact gap
    // this test exists to close. makeUser mints user_metadata.user_name as
    // `owner-<stamp>` and handle_new_user() copies it into profiles.github_username, so
    // the value is guaranteed non-empty.
    const ownerSeat = roster.find((m) => m.userId === owner.id);
    expect(ownerSeat?.role).toBe("owner");
    expect(ownerSeat?.profile?.githubUsername).toMatch(/^owner-/);
  });

  // ── the Jira mirror ─────────────────────────────────────────────────────────
  // Its own workspace: the fixture one has shed `member` by the time this block runs
  // (the removal test above), and the mirror's whole policy story is «owner manages the
  // integration row, any member writes the mirror» — both roles must exist to test it.
  describe("jira mirror", () => {
    let jiraWs: string;
    let integrationId: string;

    beforeAll(async () => {
      const ws = await owner.client
        .from("workspaces")
        .insert({ name: "rls-jira-ws", owner_id: owner.id })
        .select()
        .single();
      if (ws.error) throw ws.error;
      jiraWs = ws.data.id as string;
      const seated = await owner.client.rpc("invite_workspace_member", {
        p_workspace_id: jiraWs,
        p_email: member.email,
      });
      if (seated.error) throw seated.error;
    }, 30_000);

    it("a member cannot connect the integration; the owner can", async () => {
      const refused = await member.client.from("workspace_jira_integrations").insert({
        workspace_id: jiraWs,
        site_url: "https://x.atlassian.net",
        jira_project_key: "KAN",
        board_id: 1,
        board_name: "KAN board",
      });
      // Either spelling of an RLS refusal (42501 or a policy message) — the row must not land.
      expect(refused.error).not.toBeNull();

      const connected = await upsertJiraIntegration(owner.client, {
        workspaceId: jiraWs,
        siteUrl: "https://x.atlassian.net",
        projectKey: "KAN",
        boardId: 1,
        boardName: "KAN board",
      });
      integrationId = connected.id;
      expect(connected.workspaceId).toBe(jiraWs);
      // The touch trigger owns provenance: connected_by is the caller, never a claim.
      expect(connected.connectedBy).toBe(owner.id);
    });

    it("a member reads the integration; an outsider sees nothing", async () => {
      expect((await getJiraIntegration(member.client, jiraWs))?.id).toBe(integrationId);
      expect(await getJiraIntegration(outsider.client, jiraWs)).toBeUndefined();
    });

    it("any member writes the mirror; an outsider cannot read it", async () => {
      await replaceJiraColumns(member.client, integrationId, jiraWs, [
        { position: 0, name: "To Do", statusIds: ["1"] },
      ]);
      await upsertJiraIssues(member.client, [
        {
          integrationId,
          workspaceId: jiraWs,
          issueId: "10001",
          key: "KAN-1",
          summary: "mirrored",
          descriptionHtml: "",
          typeName: "Task",
          typeIcon: "",
          priorityName: "",
          priorityIcon: "",
          labels: ["a"],
          originalEstimate: "",
          timeSpent: "",
          remainingEstimate: "",
          startDate: "",
          dueDate: "2026-09-30",
          statusId: "1",
          statusName: "To Do",
          statusCategory: "new",
          jiraUpdatedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);

      const mine = await listJiraIssues(member.client, integrationId);
      expect(mine.map((i) => i.key)).toEqual(["KAN-1"]);
      // toJiraIssueRow never carries the binding — the columns must still be null.
      expect(mine[0]).not.toHaveProperty("taskId");

      expect(await listJiraIssues(outsider.client, integrationId)).toEqual([]);
      expect(await listJiraColumns(outsider.client, integrationId)).toEqual([]);
    });

    it("the sync lease admits one taker per staleness window", async () => {
      await ensureJiraSyncState(member.client, integrationId, jiraWs);
      expect(await takeJiraSyncLease(member.client, integrationId, 25_000)).toBe(true);
      // Fresh stamp: the immediate second take loses without an error.
      expect(await takeJiraSyncLease(owner.client, integrationId, 25_000)).toBe(false);
      // A zero window makes the stamp instantly stale again.
      expect(await takeJiraSyncLease(owner.client, integrationId, 0)).toBe(true);
    });

    it("tasks.jira_key round-trips through the typed surface", async () => {
      const project = await owner.client
        .from("projects")
        .insert({ name: "rls-jira-project", workspace_id: jiraWs })
        .select()
        .single();
      if (project.error) throw project.error;
      const shadow = await createTask(owner.client, {
        projectId: project.data.id as string,
        title: "KAN-1 — mirrored",
        createdBy: owner.id,
        jiraKey: "KAN-1",
      });
      expect(shadow.jiraKey).toBe("KAN-1");
      expect((await getTask(owner.client, shadow.id))?.jiraKey).toBe("KAN-1");
    });

    it("disconnecting cascades the whole mirror away", async () => {
      // Member cannot disconnect…
      await deleteJiraIntegration(member.client, jiraWs);
      expect((await getJiraIntegration(member.client, jiraWs))?.id).toBe(integrationId);
      // …the owner can, and the cascade sweeps columns and issues with the row.
      await deleteJiraIntegration(owner.client, jiraWs);
      expect(await getJiraIntegration(owner.client, jiraWs)).toBeUndefined();
      expect(await listJiraIssues(owner.client, integrationId)).toEqual([]);
    });
  });
});
