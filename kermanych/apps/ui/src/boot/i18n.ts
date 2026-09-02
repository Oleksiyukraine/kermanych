import { boot } from 'quasar/wrappers';
import { createI18n } from 'vue-i18n';
import { uk } from '../i18n/uk';
import { en } from '../i18n/en';
import type { MessageSchema } from '../i18n/schema';
import { initLocale, readLocale } from '../lib/locale';
import type { Translator } from '../lib/i18n-coded';

export const i18n = createI18n<[MessageSchema], 'uk' | 'en', false>({
  legacy: false,
  locale: readLocale(),
  fallbackLocale: 'uk',
  messages: { uk, en },
});

// The `Translator` adapter for code outside a component (stores, the api client) that must
// localize a server `code`+`params` without `useI18n()`. Wraps the global composer's `t`/
// `te`; the positional `plural` is vue-i18n's plural choice (see lib/i18n-coded.ts).
export const globalTr: Translator = {
  t: (key, named, plural) => (plural === undefined ? i18n.global.t(key, named ?? {}) : i18n.global.t(key, named ?? {}, plural)),
  te: (key) => i18n.global.te(key),
};

export default boot(({ app }) => {
  app.use(i18n);
  // Keep localStorage and the active vue-i18n locale in step with the `locale`
  // ref (see lib/locale.ts). `immediate` also applies the stored locale on boot.
  initLocale(i18n);
});
