import type { MessageSchema } from '../schema';
export const en: MessageSchema = {
  common: {},
  agents: {
    role: {
      review: 'Reviewer',
      promote: 'Promoter',
      'pull-request': 'Pull Request',
      'resolve-conflict': 'Conflict Resolver',
      finish: 'Finish',
      summary: 'Summary',
    },
  },
  board: {},
  settings: {
    appGeneral: {
      language: 'Language',
    },
  },
  management: {},
  risk: {},
  kit: {},
  chat: {
    toolStat: {
      dir: 'directory',
      files: '{count} files',
      matches: '{matches} matches / {files} f',
      truncated: ' ·truncated',
    },
    unit: {
      lines: 'ln',
      matches: 'matches',
      files: 'files',
    },
  },
  errors: {
    conversation_id_missing: 'No conversation specified',
    message_empty: 'The message is empty',
    workspace_missing: 'No workspace specified',
    section_context_missing: 'No section context provided',
    project_missing: 'No project specified',
    branch_missing: 'No branch specified',
    period_format_invalid: 'The period must be a pair of YYYY-MM-DD dates',
    period_start_after_end: 'The period start is later than its end',
    omp_launch_timeout: 'omp did not start within {seconds}s — check that the omp command is on your PATH',
    omp_exited_during_reply: 'omp exited during the reply: {reason}',
    assistant_no_reply_timeout: 'the assistant did not reply within {seconds}s — the conversation was restarted, try again',
    project_not_in_registry: 'Project not found in the local registry',
    project_not_bound: 'Project is not bound on this machine — generation reads the local repository’s git history',
    branch_not_in_repo: 'Branch “{branch}” is not present in the local repository',
    no_commits_in_range: 'Branch “{branch}” has no commits in {from} — {to}; there is nothing to write release notes from',
    omp_exited_during_generation: 'omp exited during generation: {reason}',
    generation_timeout: 'Generation did not finish within {seconds}s — try a narrower period or a smaller branch',
    model_no_text: 'The model returned no text — try again',
  },
  notices: {
    interactive_request_cancelled:
      'the assistant tried to ask via an interactive dialog ({method}) — the request was cancelled because there is nowhere to answer it in this chat',
    frames_lost: 'lost {count} frame(s) from omp — part of the reply may not have arrived',
    helper_added_instruction: 'helper {names} added an instruction | helpers {names} added instructions',
    skill_added_by_trigger: 'trigger “{trigger}” added skill “{skill}”',
    trigger_launches_agent: 'trigger “{trigger}” launches “{agent}”',
    trigger_skill_missing: 'trigger “{trigger}”: skill “{skill}” not found',
    trigger_agent_launch_failed: 'trigger “{trigger}” failed to launch its agent: {reason}',
    session_dormant_merged: 'Session merged into the project. Press “↻ Restore” at the top to bring up the worktree and continue.',
    session_dormant_inactive: 'Session inactive. Send a message to restore it and pull in its history.',
  },
};
