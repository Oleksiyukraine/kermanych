// The Release Notes section's shared vocabulary and its api wire types. In core for the
// same reason management-actions.ts is: the browser builds the ask, the api validates and
// answers it, and two copies of the shape would drift into a 400 nobody can explain.
//
// There is deliberately NO platform here: a note is generated for ONE project, and a
// project IS the shipping shape — its repository is the front-end, the back-end or an app,
// never two at once. Naming the project already answers «what does this note cover?», so a
// second picker could only contradict the first.
import type { Usage } from "./types";
import type { Locale } from "./i18n-codes";

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

// A calendar date the way the range speaks it — strict to the month and day bounds, not
// merely to the shape. `rangeFrom`/`rangeTo` reach `git log --since/--until` verbatim, and
// git parses junk like `2026-08-32` permissively into a period nobody picked, which then
// surfaces as a baffling «немає комітів» about dates that do not exist.
//
// Exported because three parties must agree on it and a third copy of the regex would
// drift: the action validator (management-actions.ts, so a model's bad date is refused as
// a sentence in the browser rather than as a 400 one round trip later) and the endpoint
// itself (apps/api/src/http/management.controller.ts).
const RELEASE_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isReleaseDate(v: string): boolean {
  return RELEASE_DATE_RE.test(v);
}

// What the browser sends to POST /management/release-notes. The split mirrors the
// management chat's: the browser names the project by id and says what only the cloud
// knows (the workspace's name); the api resolves the id against ITS local registry for
// the repository path and the project's name. Paths never travel from a client.
export type ReleaseNotesAsk = {
  projectId: string;
  workspaceName: string;
  // The branch whose log is read. Picked by the operator; defaults in the UI to the
  // project's default branch, but any local branch of the bound repo is legal.
  branch: string;
  // Inclusive date range, YYYY-MM-DD both ends.
  rangeFrom: string;
  rangeTo: string;
  // The operator's active UI locale, threaded into the generation prompt so the note is
  // written in it (release-notes-prompt.ts). Optional and defaulting to English — the
  // section's documented product default — when a caller omits it.
  locale?: Locale;
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
