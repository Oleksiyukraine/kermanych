// The Release Notes section's shared vocabulary and its api wire types. In core for the
// same reason management-actions.ts is: the browser builds the ask, the api validates and
// answers it, and two copies of the shape would drift into a 400 nobody can explain.
import type { Usage } from "./types";

// The build targets a release note can be written for. A DIFFERENT vocabulary from
// ./platform's session tag on purpose: that one labels what an agent is working on
// (backend/web/mobile — coarse, optional, never shown to a customer), while a release
// note is addressed to people who ask «що нового в iOS-застосунку?» — so its platforms
// are the shapes a product ships in, and mobile splits into the two stores it ships to.
//
// The values are the Postgres CHECK constraint on `workspace_release_notes.platform`
// (supabase/migrations/20260901120000_workspace_release_notes.sql) and the api's request
// validation; the labels are what every screen prints. One table, three consumers, the
// same rule as MANAGEMENT_SECTIONS: two copies would drift, and the drift would surface
// as a note the screen cannot label.
export const RELEASE_PLATFORMS = ["frontend", "backend", "ios", "android"] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

export function isReleasePlatform(v: unknown): v is ReleasePlatform {
  return typeof v === "string" && (RELEASE_PLATFORMS as readonly string[]).includes(v);
}

export const RELEASE_PLATFORM_LABELS: Record<ReleasePlatform, string> = {
  frontend: "Front-end",
  backend: "Back-end",
  ios: "iOS",
  android: "Android",
};

// One commit as the generator is shown it, parsed out of `git log` by the api. `body` is
// the commit's full message body — often the only place a commit says WHY, which is
// exactly what a non-technical reader needs the note to carry.
export type ReleaseCommit = {
  // Commit date, YYYY-MM-DD.
  date: string;
  author: string;
  subject: string;
  body: string;
};

// What the browser sends to POST /management/release-notes. The split mirrors the
// management chat's: the browser names the project by id and says what only the cloud
// knows (the workspace's name); the api resolves the id against ITS local registry for
// the repository path and the project's name. Paths never travel from a client.
export type ReleaseNotesAsk = {
  projectId: string;
  workspaceName: string;
  platform: ReleasePlatform;
  // The branch whose log is read. Picked by the operator; defaults in the UI to the
  // project's default branch, but any local branch of the bound repo is legal.
  branch: string;
  // Inclusive date range, YYYY-MM-DD both ends.
  rangeFrom: string;
  rangeTo: string;
};

// The generated document, NOT a stored row: the api has no cloud credentials, so the
// browser is the one that saves the note into `workspace_release_notes` under the
// operator's own JWT — the same division of labour the risk register uses.
export type ReleaseNotesReply = {
  // First `# ` heading of the markdown, extracted so the list screen has a title without
  // parsing documents.
  title: string;
  markdown: string;
  // How many commits the note was written from — the screen says it, because a note
  // generated from three commits reads very differently from one generated from ninety.
  commitCount: number;
  // Same plan-spend reporting as the management chat: this generation is debited to the
  // operator's own provider subscription, and the reply says what it cost.
  usage?: Usage;
  model?: string;
  ms: number;
};
