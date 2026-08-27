// One-time rehearsal for 20260827100000_workspaces.sql, run against a LOCAL stack
// before `supabase db push --linked`.
//
// Why a script and not a test: `supabase db reset` applies the migration to an
// EMPTY database, so the 1:1 backfill has nothing to prove there, and once the
// migration has run the pre-state is unreachable. So the check is staged by hand,
// from kermanych/, with the stack up and SUPABASE_TEST_* exported from
// `supabase status`:
//
//   mkdir -p /tmp/mig
//   mv supabase/migrations/20260827100000_workspaces.sql /tmp/mig/   # pre-cutover world
//   supabase db reset
//   ./apps/api/node_modules/.bin/tsx scripts/verify-workspace-migration.ts seed
//   mv /tmp/mig/20260827100000_workspaces.sql supabase/migrations/   # bring it back
//   supabase migration up                                           # NOT db reset:
//                                                                   # that would wipe the seed
//   ./apps/api/node_modules/.bin/tsx scripts/verify-workspace-migration.ts check
//
// tsx is not a root dependency; it comes from apps/api, hence the explicit bin path
// (`pnpm --filter @kermanych/api exec tsx ../../scripts/verify-workspace-migration.ts`
// works too).
//
// `seed` writes two users, two projects and crossed membership, then records who
// can see what into .kermanych-migration-rehearsal.json. `check` re-reads the same
// questions after the migration and diffs. Any difference is a migration bug.
import { readFileSync, writeFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const SNAPSHOT = ".kermanych-migration-rehearsal.json";
const PASSWORD = "kermanych-rehearsal-password";

if (!URL || !ANON || !SERVICE) {
  console.error("set SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY and SUPABASE_TEST_SERVICE_KEY");
  process.exit(2);
}

type Actor = { tag: string; id: string; email: string; client: SupabaseClient };
type Snapshot = { actors: { tag: string; email: string }[]; visibility: Record<string, { projects: string[]; tasks: string[] }> };

const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(URL!, ANON!, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

async function mint(tag: string): Promise<Actor> {
  const email = `${tag}-rehearsal@kermanych.test`;
  const created = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { user_name: `${tag}-rehearsal`, full_name: `${tag} Rehearsal` },
  });
  if (created.error) throw created.error;
  return { tag, id: created.data.user.id, email, client: await signIn(email) };
}

// The two questions the migration must not change the answer to. Names, not ids:
// the backfill creates new workspace rows but must not renumber projects.
async function visibilityOf(actor: Actor): Promise<{ projects: string[]; tasks: string[] }> {
  const projects = await actor.client.from("projects").select("name").order("name");
  if (projects.error) throw projects.error;
  const tasks = await actor.client.from("tasks").select("title").order("title");
  if (tasks.error) throw tasks.error;
  return {
    projects: (projects.data as { name: string }[]).map((r) => r.name),
    tasks: (tasks.data as { title: string }[]).map((r) => r.title),
  };
}

async function seed(): Promise<void> {
  const alice = await mint("alice");
  const bob = await mint("bob");

  // alice owns both projects; bob is invited to ONE of them. After the migration bob
  // must still see exactly that one — this is the case a careless merge would widen.
  const visibility: Snapshot["visibility"] = {};
  for (const [name, invitee] of [["alpha", bob], ["beta", null]] as const) {
    const project = await alice.client
      .from("projects")
      .insert({ name, owner_id: alice.id })
      .select("id")
      .single();
    if (project.error) throw project.error;
    const task = await alice.client
      .from("tasks")
      .insert({ project_id: project.data.id, title: `${name}-task`, created_by: alice.id });
    if (task.error) throw task.error;
    if (invitee) {
      const invited = await alice.client.rpc("invite_project_member", {
        p_project_id: project.data.id,
        p_email: invitee.email,
      });
      if (invited.error) throw invited.error;
    }
  }

  for (const actor of [alice, bob]) visibility[actor.tag] = await visibilityOf(actor);
  const snapshot: Snapshot = {
    actors: [alice, bob].map((a) => ({ tag: a.tag, email: a.email })),
    visibility,
  };
  writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2));
  console.log(`seeded; visibility recorded in ${SNAPSHOT}`);
  console.log(JSON.stringify(visibility, null, 2));
}

async function check(): Promise<void> {
  const before = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
  let failed = false;

  for (const { tag, email } of before.actors) {
    const client = await signIn(email);
    const after = await visibilityOf({ tag, id: "", email, client });
    const expected = before.visibility[tag];
    if (!expected) throw new Error(`no recorded visibility for ${tag}`);
    for (const key of ["projects", "tasks"] as const) {
      const a = after[key].join(",");
      const b = expected[key].join(",");
      if (a !== b) {
        failed = true;
        console.error(`FAIL ${tag}.${key}: before [${b}] -> after [${a}]`);
      } else {
        console.log(`ok   ${tag}.${key}: [${a}]`);
      }
    }
  }

  // Post-migration invariants the backfill claims.
  const anyone = await signIn(before.actors[0]!.email);
  const orphans = await anyone.from("projects").select("id").is("workspace_id", null);
  if (orphans.error) throw orphans.error;
  if ((orphans.data ?? []).length > 0) {
    failed = true;
    console.error(`FAIL: ${orphans.data!.length} project(s) with a null workspace_id`);
  } else {
    console.log("ok   every project has a workspace");
  }

  if (failed) {
    console.error("\nMIGRATION CHANGED VISIBILITY — do not push");
    process.exit(1);
  }
  console.log("\nvisibility preserved");
}

// Wrapped rather than top-level `await`: kermanych/package.json is not
// `"type": "module"`, so tsx transforms this file as CJS, where top-level await
// is a syntax error. A rejection here must still fail the run, hence the catch.
const mode = process.argv[2];
if (mode === "seed" || mode === "check") {
  (mode === "seed" ? seed() : check()).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
} else {
  console.error("usage: verify-workspace-migration.ts seed|check");
  process.exit(2);
}
