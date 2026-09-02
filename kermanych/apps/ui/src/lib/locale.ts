import { ref, watch, type Ref } from 'vue';

// The UI language. Like the theme (see lib/theme.ts) it is a device-local
// preference, not an account setting: the operator picks the language of the
// screen in front of them, and it is remembered in localStorage — never in
// Supabase. `uk` is the source of truth and the fallback, so an unknown or
// missing stored value resolves to it.

export type Locale = 'uk' | 'en';
const KEY = 'kermanych.locale';
const LOCALES: readonly Locale[] = ['uk', 'en'];

export function readLocale(): Locale {
  const v = localStorage.getItem(KEY);
  return (LOCALES as readonly string[]).includes(v ?? '') ? (v as Locale) : 'uk';
}
export function writeLocale(l: Locale): void {
  localStorage.setItem(KEY, l);
}

/** Current locale. Assigning to it persists and applies (see `initLocale`). */
export const locale: Ref<Locale> = ref(readLocale());

// initLocale needs exactly one capability from the vue-i18n instance: a global,
// writable locale it can push the current `locale` ref into. Typing that lone
// capability structurally keeps this module free of vue-i18n's resource
// generics — the concrete `createI18n` instance parameterises `Composer` with
// its full message schema, which no hand-written `I18n<…>` annotation here
// could restate without drifting out of sync.
type LocaleAwareI18n = { global: { locale: { value: string } } };

export function initLocale(i18n: LocaleAwareI18n): void {
  watch(
    locale,
    (l) => {
      writeLocale(l);
      i18n.global.locale.value = l;
    },
    { immediate: true },
  );
}
