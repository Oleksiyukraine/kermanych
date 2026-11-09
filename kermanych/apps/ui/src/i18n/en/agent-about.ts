// apps/ui/src/i18n/en/agent-about.ts
// «AI team → Agents → <agent>»: the «How it works» texts (docs/specs/2026-11-03-ai-team-agent-pages.md, decision 5).
import type { agentAbout as uk } from '../uk/agent-about';

export const agentAbout: typeof uk = {
  minion: {
    tagline: 'Picks up cards allowed to auto-run and works them on its own',
    when: 'There is no button: once a minute the Minion looks for your backlog cards marked “Allow auto-run” (not deep analysis, not design) and takes one when a slot is free. A trigger cannot run it.',
    steps:
      'Opens its own session in its own worktree; the ask tool is off, so it cannot ask the operator.\nChecks whether the card still applies.\nMakes the smallest change; if it would touch an API, schema, migration or dependency, it stops and asks for a decision.\nChecks the work against the acceptance criteria, runs the checks and commits without pushing or opening a PR.\nIt has 2 hours; then it is asked to wrap up, and 10 minutes later the turn is stopped.',
    inputs: {
      task: 'The card name, plus its description when it differs from the name.',
    },
    adds: 'A requirement to report a verdict at the end: ready, not needed or needs a decision. For cards from a Finding, a line about the finding type. Also the rules on commit co-authorship and keeping docs up to date.',
    ends: 'Ready: Kermanych opens the PR itself and the session moves to In review. Not needed: the card closes. Needs a decision or failed: the session waits for you with the reason. After two failures in a row the Minion pauses.',
  },
  promote: {
    tagline: 'Moves a chat discussion into work with full access',
    when: 'The “▶” button on the Chat page (“Start implementing what was discussed”). A trigger can also run it.',
    steps:
      'Creates a card for the work.\nStops the read-only chat.\nForks the same conversation into a new worktree on a new branch with the full toolset.\nSends the instruction to implement what was discussed.',
    inputs: {
      branch: 'The new branch created for the worktree.',
    },
    adds: 'The rules on commit co-authorship and keeping docs up to date.',
    ends: 'The session becomes an ordinary agent and appears on the Agents page. If the launch fails, the chat is restored as it was.',
  },
  designer: {
    tagline: 'Builds a screen prototype on the project’s UI kit',
    when: 'The “+ New design” button on the Design page: fill in topic, description, references (images and links) and base branch, then “Create”. A trigger cannot run it.',
    steps:
      'Reads the project’s UI kit and routing.\nStudies the references: looks at the images and opens the links in the browser.\nBuilds each screen on its own dev route with fixtures, covering every state.\nTakes screenshots at 390 and 1280 pixels after each change.\nKeeps the design README current and commits without pushing or opening a PR.\nWorks with you in conversation, turn by turn.',
    inputs: {
      designDir: 'The design folder: docs/design/date-name.',
      topic: 'The topic, which is the session name.',
      description: 'The card text, with the reference links at its end; empty when it equals the name. Reference images go with the first message.',
    },
    adds: 'The design-spec skill, always, plus the rules on commit co-authorship and keeping docs up to date.',
    ends: 'The session stays open for conversation. Next, on the Design page: “Save design”, “Create PR” or “Commit”, and “Finish”. For a design, the docs check looks only at the README in the design folder.',
  },
  'design-save': {
    tagline: 'Screenshots every design screen, syncs the README and commits',
    when: 'The “Save design” button on the Design page. A trigger cannot run it.',
    steps:
      'Sends a message to the same Designer in its session.\nIt reads the list of screens and states from the README.\nCaptures each at 390 and 1280 pixels into the screens folder and deletes stale screenshots.\nSyncs the README with the prototype, commits without pushing and lists the screenshots.',
    inputs: {
      designDir: 'This session’s design folder.',
      branch: 'The session branch.',
      message: 'The commit message: design: and the session name.',
    },
    adds: 'At the very end, a look back over the session for skill lessons (improve_skill), while «Improve skills» is not off.',
    ends: 'The turn ends as usual; the page waits for it up to 30 minutes.',
  },
  synergy: {
    tagline: 'Changes the running app with you, one request at a time, in seconds',
    when: 'The “+ New feature” or “+ Change a page” button on the Synergy page: a topic or a start path, base branch, model and effort, then “Start”. The agent waits for your first request. A trigger cannot run it.',
    steps:
      'Opens a session on a synergy/… branch in its own worktree and starts the preview, on the start path if one was given.\nRuns a fast model (Sonnet, low effort by default) with only read, edit, write, grep, glob, the session browser and the preview tools: no shell, no subagents.\nMakes the smallest frontend change per request in the real app code; data it lacks is stubbed and marked synergy-mock.\nEvery request carries the page you look at and the elements you pointed at with ◎.\nAfter each turn Kermanych commits a step; “Go back here” restores any step with a new commit.',
    adds: 'This instruction goes into the system prompt on every launch and resume. No skills, no triggers, no docs rule.',
    ends: 'The session stays open. “Implement” hands the prototype to a regular agent; “Discard” deletes the session, worktree and branch.',
  },
  'synergy-implement': {
    tagline: 'Builds a Synergy prototype properly: backend, tests, i18n, docs',
    when: 'The “Implement” button on the Synergy page, once there is at least one change. A trigger cannot run it.',
    steps:
      'Files a card for you with the chronology of your requests.\nStops the prototyping agent and starts a fresh one in the same worktree and branch, on the project’s default model, without the prototyping conversation.\nThe agent reads the branch diff and every synergy-mock, keeps what you agreed on and replaces the stubs with real code.\nIt writes tests and docs, runs the checks and commits.',
    inputs: {
      branch: 'The session branch, synergy/….',
      base: 'The base branch the prototype forked from.',
      brief: 'The start page and your requests in order, without the rolled-back steps; the card’s description too.',
    },
    adds: 'The rules on commit co-authorship and keeping docs up to date, as for any agent.',
    ends: 'The session leaves Synergy and works on the Agents page like any agent: PR and “Finish” as usual.',
  },
  review: {
    tagline: 'Checks a session’s changes with fresh eyes and gives a verdict',
    when: 'The “⚖ Reviewer” item in the session menu on the Agents page (⌘D), when the agent is idle and there are changes. A trigger can also run it.',
    steps:
      'Computes the branch changes against the base, including uncommitted ones.\nOpens a separate session with none of the doer’s memory, in the same worktree, with read-only tools.\nSends it the task, the branches and the changes.\nThe Reviewer reads the code and changes nothing.',
    inputs: {
      task: 'The task of the session under review.',
      base: 'The session’s base branch.',
      branch: 'The session branch.',
      diff: 'The branch changes against the base, including uncommitted ones.',
    },
    adds: '',
    ends: 'An APPROVE or NEEDS CHANGES answer with findings by priority, as text in the review session. The “⤴ Hand over” button passes the verdict to the doer and closes the review.',
  },
  tester: {
    tagline: 'Walks the card’s QA checklist in the live browser or on the device and gives each item a verdict',
    when: 'The “Run” button in the “Testing” step of the finish sheet, or “Run testing” on the session’s QA tab, while the agent is idle. Needs a session started from a card and a set-up preview; a web project also needs the desktop app, a Mobile project can be tested in the web build too. A back-end project cannot be tested. A trigger cannot run it.',
    steps:
      'Opens a separate “тестування: …” session in the same worktree, with read-only tools, the browser (the doer’s device in a Mobile project) and the doer’s preview.\nClears the old verdicts of the items it will check; when there is no checklist yet, composes one first and saves it to the card.\nStarts or opens the preview in a clean browser of its own and signs in with a test account. In a Mobile project it restarts the doer’s preview with the app’s data cleared, and the doer cannot drive the device meanwhile.\nWalks the items in order, as a user would, and records a verdict after each; takes a screenshot of every failure.\nChanges no code and commits nothing.',
    inputs: {
      loginPath: 'The sign-in page from this project’s tester settings; in a Mobile project, a deep link to the sign-in screen.',
      task: 'The task of the session under test.',
      accounts: 'The project’s test accounts on this machine: names, logins and notes — no passwords.',
      notes: 'The notes for the tester from the project settings.',
      items: 'The QA checklist items to check, with their ids — or the ask to compose a checklist first.',
    },
    adds: 'The reporting rules: a verdict per item through report_qa_result, a screenshot for every failure, passwords only through browser_type_credential (device_type_credential on a device), change nothing. The qa-tester skill when there is no checklist yet.',
    ends: '✓ / ✗ / ⏸ verdicts beside the items on the QA tab and on the card. “⤴ Hand over to the doer” sends the failed items to the doer and closes the session; “Discard” closes it without a message.',
  },
  'pull-request': {
    tagline: 'Commits, pushes the branch and opens a pull request',
    when: 'The “Create PR” button in the finish sheet or on the Design page, while the branch has no PR. Also started by a trigger, and by the Minion after a ready verdict.',
    steps:
      'Sends a message to the agent that did the work, in its own session.\nIt brings in the base branch with `git merge` (no rebase, no force-push) and resolves conflicts.\nCommits and pushes the branch, taking the token from the worktree .env.\nOpens the PR and replies with the link.',
    inputs: {
      branch: 'The session branch.',
      conventions: 'The project’s PR conventions, or if none: Conventional Commits and a body with Summary and Testing sections.',
      baseLine: 'Which branch the PR targets: the session’s base or the default branch.',
    },
    adds: 'The base-branch sync step; for the Minion, a [Minion] prefix in the PR title; for card sessions, a request to write a tester checklist. At the very end, a look back over the session for skill lessons (improve_skill), while «Improve skills» is not off.',
    ends: 'As soon as a PR link appears in the reply it is saved and the session moves to In review. The branch and worktree stay.',
  },
  commit: {
    tagline: 'Commits and pushes new changes to a branch that already has a PR',
    when: 'The “Commit” button in the finish sheet or on the Design page, once the branch has a PR. A trigger cannot run it.',
    steps:
      'Sends a message to the agent in its own session.\nIt brings in the base branch with `git merge` and resolves conflicts.\nCommits and pushes, taking the token from the worktree .env; it opens no new PR.\nIf there is nothing to commit, it says so.',
    inputs: {
      branch: 'The session branch.',
      conventions: 'The project’s commit conventions, or Conventional Commits if none.',
    },
    adds: 'The base-branch sync step. At the very end, a look back over the session for skill lessons (improve_skill), while «Improve skills» is not off.',
    ends: 'After the turn the session goes back to In review.',
  },
  'resolve-conflict': {
    tagline: 'Resolves merge conflicts, keeping both sides',
    when: 'The “Resolve automatically” button in the finish sheet, when there are conflicts. A trigger can also run it.',
    steps:
      'Sends a message to the session’s agent while the worktree is mid-merge.\nIt edits each conflicted file and removes the markers, keeping both sides.\nStages the files and completes the merge with a commit.',
    inputs: {
      files: 'The list of conflicted files, one per line.',
    },
    adds: '',
    ends: 'Progress shows in the normal session feed. Once the merge is done, the session returns to In review (if it has a PR) or Done.',
  },
  finish: {
    tagline: 'Closes the session: removes the worktree, keeps the branch for the PR',
    when: 'The “✓” button on the Agents page or “Finish” on the Design page opens the finish sheet; there, “Finish”. Disabled while there are conflicts or docs are missing. A trigger cannot run it.',
    steps:
      'No model is used; Kermanych does it all.\nCommits unsaved work as session work and the session name.\nStops the agent, the preview and any unfinished Minion run.\nRemoves the worktree; nothing is merged anywhere.',
    inputs: {},
    adds: '',
    ends: 'The card moves to Done. The branch stays for the PR, and “↻ Restore” brings the worktree back.',
  },
  summary: {
    tagline: 'Asks the session for a short summary: what is done and what is next',
    when: 'The “≡” button in the message box, when the agent is idle. A trigger cannot run it.',
    steps:
      'There is no instruction of its own and no separate agent.\nSends a fixed request into the same session: what is done, where things stand, what is next, change nothing.\nThat session’s own model answers.',
    inputs: {},
    adds: '',
    ends: 'The summary appears as the agent’s next reply in the feed.',
  },
};
