import { boot } from 'quasar/wrappers';
import { createI18n } from 'vue-i18n';
import { uk } from '../i18n/uk';
import { en } from '../i18n/en';
import type { MessageSchema } from '../i18n/schema';
import { initLocale, readLocale } from '../lib/locale';

export const i18n = createI18n<[MessageSchema], 'uk' | 'en', false>({
  legacy: false,
  locale: readLocale(),
  fallbackLocale: 'uk',
  messages: { uk, en },
});

export default boot(({ app }) => {
  app.use(i18n);
  // Keep localStorage and the active vue-i18n locale in step with the `locale`
  // ref (see lib/locale.ts). `immediate` also applies the stored locale on boot.
  initLocale(i18n);
});
