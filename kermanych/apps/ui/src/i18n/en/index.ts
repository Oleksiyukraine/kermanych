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
  errors: {},
  notices: {},
};
