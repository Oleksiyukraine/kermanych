import type { MessageSchema } from '../schema';
export const en: MessageSchema = {
  common: {},
  agents: {},
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
