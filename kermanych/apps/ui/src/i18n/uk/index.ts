// uk is the source of truth and the message SCHEMA (see ../schema.ts). Domains
// are split into files so each is reviewable on its own; add keys here as
// domains migrate. This is a plain object, not `as const`: the KEY structure is
// the contract every locale must satisfy, while leaf VALUES widen to `string`
// so `en` can carry its own translations rather than being pinned to uk's text.
export const uk = {
  common: {},
  agents: {},
  board: {},
  settings: {
    appGeneral: {
      language: 'Мова',
    },
  },
  management: {},
  risk: {},
  kit: {},
  chat: {},
  errors: {},
  notices: {},
};
