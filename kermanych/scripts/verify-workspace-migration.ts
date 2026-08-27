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
//   NODE_PATH=apps/api/node_modules ./apps/api/node_modules/.bin/tsx \
//     scripts/verify-workspace-migration.ts seed
//   mv /tmp/mig/20260827100000_workspaces.sql supabase/migrations/   # bring it back
//   supabase migration up                                           # NOT db reset:
//                                                                   # that would wipe the seed
//   NODE_PATH=apps/api/node_modules ./apps/api/node_modules/.bin/tsx \
//     scripts/verify-workspace-migration.ts check
//
// Both halves of that invocation are load-bearing, and they depend on each other:
//
//   * `apps/api/node_modules/.bin/tsx` — tsx is not a root dependency. It lives in
//     apps/api, and so does @supabase/supabase-js: neither is reachable from
//     kermanych/node_modules, where pnpm keeps them in a private hoist Node does not
//     search.
//   * `NODE_PATH=apps/api/node_modules` — Node resolves bare imports relative to the
//     FILE, not the cwd, so this file's own directory chain never finds supabase-js.
//     NODE_PATH is what supplies it, and NODE_PATH is honoured for CommonJS only —
//     which this file is, because kermanych/package.json is not `"type": "module"`
//     (see the dispatcher at the bottom). Making the file ESM would silence the
//     top-level-await workaround there AND break this resolution. Change neither
//     half alone.
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

// This script SEEDS DATA with the service key. The header tells you to run it right
// before `db push --linked`, i.e. exactly when a hosted URL and a secret key may be
// sitting in your shell — so refuse anything that is not loopback rather than trust
// the operator's shell history. Misfired at a hosted project, `seed` would mint two
// permanent auth.users rows, two projects and two tasks there, and nothing in this
// script deletes anything. No override flag: an escape hatch here has no legitimate
// use and would be reached for exactly once, in a hurry.
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(URL)) {
  console.error(`refusing to run against ${URL}: this script seeds data and is for a LOCAL stack only`);
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

  // The experiment is only worth running if bob's view is NARROWER than alice's: were
  // bob empty, `check` would print four `ok`s having proved nothing but that alice sees
  // everything and still does. That cannot happen today — invite_project_member throws
  // on an unknown email — but the guarantee comes from a migration this very cutover
  // replaces, so it is asserted rather than trusted.
  const [seen, all] = [visibility.bob!, visibility.alice!];
  for (const key of ["projects", "tasks"] as const) {
    const widened = seen[key].filter((n) => !all[key].includes(n));
    if (seen[key].length === 0 || widened.length > 0 || seen[key].length >= all[key].length) {
      throw new Error(
        `seed is not discriminating: bob.${key} [${seen[key].join(",")}] must be a non-empty ` +
          `strict subset of alice.${key} [${all[key].join(",")}]`,
      );
    }
  }
  // Named explicitly, because "strict subset" would also be satisfied by bob seeing beta
  // instead of alpha, and it is beta — the project bob was never invited to — whose
  // appearance after the migration is the exact failure this rehearsal hunts.
  if (seen.projects.includes("beta") || seen.tasks.includes("beta-task")) {
    throw new Error(`seed is wrong: bob must not see beta before the migration`);
  }
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

  // Probe the schema BEFORE comparing anything. Run against the pre-migration database
  // — the mis-staging that skips `supabase migration up` — every comparison matches
  // trivially, because nothing migrated, so nothing changed. That would print four `ok`
  // lines and only then trip over the missing column: a console that reads as success
  // followed by a traceback. A human eye is this artifact's only consumer, so refuse
  // first, and with exit 2 (staging error) rather than 1 (visibility changed).
  const anyone = await signIn(before.actors[0]!.email);
  const probe = await anyone.from("projects").select("workspace_id").limit(1);
  if (probe.error) {
    console.error(
      "projects.workspace_id does not exist: 20260827100000_workspaces.sql has not been " +
        "applied, so there is nothing to check — run `supabase migration up` first",
    );
    process.exit(2);
  }

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
  // Say what that line does NOT mean, because it reads as "authorization preserved".
  // This rehearsal compares SELECT visibility only — which rows each actor can read.
  // Write authorization deliberately widens: UPDATE on projects moves from owner-only
  // to any workspace member, because the spec's role matrix makes project config
  // member-editable. That change is intended and is not measured here.
  console.log("scope: SELECT visibility only. Write authorization widens by design —");
  console.log("       project config becomes editable by any workspace member.");
}

// Wrapped rather than top-level `await`: kermanych/package.json is not
// `"type": "module"`, so tsx transforms this file as CJS, where top-level await
// is a syntax error. A rejection here must still fail the run, hence the catch.
// Do not "fix" this by making the file ESM — the header's NODE_PATH depends on the
// CJS resolver, and the two would break together.
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
