// apps/ui/src/lib/i18n-coded.ts
// The one place the UI turns a server-produced `code`+`params` into localized prose. The
// server always sends its Ukrainian `text`/`message` too, so a code this build has no
// translation for degrades to that fallback rather than to a bare identifier — the whole
// point of the `@kermanych/core` i18n-codes contract.
import type { Notice, NoticeParams } from '@kermanych/core';

// The two capabilities we need off a vue-i18n composer, named structurally so this module
// works with both `useI18n()` (in a component) and the global `i18n.global` (in a store or
// the api client). `t`'s third positional argument is vue-i18n's plural choice.
export type Translator = {
  t: (key: string, named?: Record<string, unknown>, plural?: number) => string;
  te: (key: string) => boolean;
};

// A notice's localized line. A `trigger_launches_agent` notice carries the raw agent id in
// `params.agent`; the label lives in the UI's own catalog (`agents.role.<id>`), so it is
// resolved here before the message interpolates it. `params.count`, when present, drives the
// message's plural form.
export function localizeNotice(tr: Translator, notice: Notice): string {
  const key = `notices.${notice.code}`;
  if (!notice.code || !tr.te(key)) return notice.text;
  const params: NoticeParams = { ...notice.params };
  if (typeof params.agent === 'string') {
    const roleKey = `agents.role.${params.agent}`;
    if (tr.te(roleKey)) params.agent = tr.t(roleKey);
  }
  return typeof params.count === 'number' ? tr.t(key, params, params.count) : tr.t(key, params);
}

// An HTTP error's localized message, falling back to the server's Ukrainian sentence when
// the build does not know the code.
export function localizeError(tr: Translator, code: string | undefined, params: NoticeParams | undefined, fallback: string): string {
  const key = `errors.${code}`;
  if (!code || !tr.te(key)) return fallback;
  return tr.t(key, { ...params });
}
