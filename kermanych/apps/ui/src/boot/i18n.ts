import { boot } from 'quasar/wrappers';
import { createI18n, type PluralizationRule } from 'vue-i18n';
import { uk } from '../i18n/uk';
import { en } from '../i18n/en';
import type { MessageSchema } from '../i18n/schema';
import { initLocale, readLocale } from '../lib/locale';
import type { Translator } from '../lib/i18n-coded';

// Ukrainian three-form messages are `one | few | many`: 1, 21, 31… take the first form;
// 2–4, 22–24… (not 12–14) the second; 0, 5–20, 25–30… the third. vue-i18n's built-in rule
// reads three forms as `zero | one | other`, so without this n=1 picked «пункти». Messages
// with any other number of forms keep the built-in rule, which vue-i18n always passes to a
// custom rule as `orgRule`.
const ukPluralRule: PluralizationRule = (choice, choicesLength, orgRule) => {
  if (choicesLength !== 3) return orgRule!(choice, choicesLength);
  const n = Math.abs(choice);
  const lastTwo = n % 100;
  const last = n % 10;
  if (last === 1 && lastTwo !== 11) return 0;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return 1;
  return 2;
};

export const i18n = createI18n<[MessageSchema], 'uk' | 'en', false>({
  legacy: false,
  locale: readLocale(),
  fallbackLocale: 'uk',
  messages: { uk, en },
  pluralRules: { uk: ukPluralRule },
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
