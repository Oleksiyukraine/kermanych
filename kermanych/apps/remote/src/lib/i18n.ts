// The phone's texts (spec → «Phone language follows the phone's browser: Ukrainian for `uk`,
// English otherwise»). Two flat dictionaries and a `{name}` interpolation — the phone needs no
// plural rules beyond the relative times below, so vue-i18n would be dead weight in its bundle.
//
// `uk` defines the keys; `en` is typed against them, and test/i18n.spec.ts checks at runtime that
// neither has a key the other lacks.

import type { SessionStatus } from "@kermanych/core";

export type Lang = "uk" | "en";

const uk = {
  // Pairing (spec → Pairing and devices)
  "pair.title": "Підключіть телефон",
  "pair.where":
    "На комп'ютері відкрийте Kermanych → Налаштування → Застосунок → «Пульт» і натисніть «Підключити телефон». Під QR-кодом — 6 цифр.",
  "pair.codeLabel": "Код із комп'ютера",
  "pair.submit": "Підключити",
  "pair.pairing": "Підключаю телефон…",
  "pair.forgotten": "Цей телефон відключено на комп'ютері або його ключ застарів. Підключіть його ще раз.",
  "pair.iosTitle": "Встановіть Пульт на початковий екран",
  "pair.iosWhy":
    "На iPhone застосунок з початкового екрана має власне сховище, окреме від Safari, і лише він отримує сповіщення. Тому підключіть телефон уже з нього:",
  "pair.iosStep1": "Натисніть «Поділитися» внизу Safari.",
  "pair.iosStep2": "Оберіть «На початковий екран» і підтвердьте.",
  "pair.iosStep3": "Відкрийте Пульт з іконки на початковому екрані.",
  "pair.iosStep4": "Введіть 6 цифр, які показує комп'ютер під QR-кодом.",
  "pair.iosHere": "Користуватися тут, у Safari (без сповіщень)",
  "pair.toList": "До списку агентів",
  // Connection banners
  "banner.offline": "Комп'ютер недоступний",
  "banner.offlineHint": "Можливо, він заснув або вимкнений, чи на телефоні вимкнено Tailscale. Пробую під'єднатися знову…",
  "banner.retry": "Спробувати ще",
  "banner.signedOut": "На комп'ютері не виконано вхід у Kermanych",
  "banner.signedOutHint": "Увійдіть у Kermanych на комп'ютері — телефон під'єднається сам.",
  "banner.foreignLogin": "Інший обліковий запис Tailscale",
  "banner.foreignLoginHint":
    "Телефон має бути в Tailscale під тим самим обліковим записом, що й комп'ютер. Перевірте вхід у застосунку Tailscale на телефоні.",
  // Errors by RemoteError code
  "error.unauthorized": "Телефон більше не підключено. Підключіть його ще раз.",
  "error.signed_out": "На комп'ютері не виконано вхід у Kermanych.",
  "error.foreign_login": "Телефон має бути в Tailscale під тим самим обліковим записом, що й комп'ютер.",
  "error.pairing": "Код неправильний або застарів — натисніть «Підключити телефон» на комп'ютері ще раз.",
  "error.not_found": "Сесію не знайдено — можливо, її вже видалено.",
  "error.native_busy": "Агент зараз зайнятий — надішліть, коли він закінчить.",
  "error.network": "Комп'ютер недоступний. Перевірте Tailscale на телефоні.",
  "error.failed": "Не вдалося виконати дію.",
  // List
  "list.title": "Агенти",
  "list.empty": "Немає агентів",
  "list.emptyHint": "Тут з'являться сесії, які працюють на комп'ютері.",
  "list.attention": "потребує уваги",
  "list.otherProject": "Без проєкту",
  // Statuses (the sidebar's words, apps/ui i18n → statusWord)
  "status.backlog": "у беклозі",
  "status.queued": "у черзі",
  "status.thinking": "думає",
  "status.tool": "виконує",
  "status.waiting_input": "потрібна відповідь",
  "status.done": "готово",
  "status.in_review": "на ревʼю",
  "status.error": "помилка",
  "status.stopped": "зупинено",
  "status.merged": "завершено",
  "status.conflict": "конфлікт",
  // Relative time
  "time.now": "щойно",
  "time.min": "{n} хв тому",
  "time.hour": "{n} год тому",
  "time.day": "{n} дн тому",
  // Session
  "session.back": "Назад",
  "session.stop": "Зупинити",
  "session.stopConfirm": "Зупинити агента?",
  "session.stopConfirmHint": "Поточна робота перерветься. Продовжити можна новим повідомленням.",
  "session.stopYes": "Зупинити",
  "session.stopNo": "Скасувати",
  "session.removed": "Цієї сесії більше немає в списку — її завершено, архівовано або видалено.",
  "session.emptyLog": "Розмова ще порожня.",
  "session.thinking": "думав…",
  "session.thinkingHide": "сховати",
  "session.jumpEnd": "До кінця",
  "session.photoAlt": "Фото",
  "session.native": "у терміналі",
  // Question (decision 3)
  "question.title": "Агент питає",
  "question.yes": "Так",
  "question.no": "Ні",
  "question.answer": "Відповісти",
  "question.cancel": "Скасувати",
  "question.placeholder": "Ваша відповідь",
  "question.native": "Цей агент працює в терміналі — відповісти можна лише на комп'ютері.",
  // Composer
  "composer.placeholder": "Повідомлення агенту",
  "composer.send": "Надіслати",
  "composer.photo": "Додати фото",
  "composer.removePhoto": "Прибрати фото",
  "composer.photoLimit": "Не більше {n} фото в одному повідомленні.",
  "composer.photoFailed": "Не вдалося прочитати фото.",
  // Push (decision 4)
  "push.title": "Сповіщення",
  "push.hint": "Коли агент чекає на відповідь або зупинився з помилкою, а вас немає за комп'ютером.",
  "push.enable": "Увімкнути сповіщення",
  "push.disable": "Вимкнути сповіщення",
  "push.on": "Сповіщення увімкнено.",
  "push.denied": "Сповіщення заборонені в налаштуваннях телефона для цього застосунку.",
  "push.iosInstall": "На iPhone сповіщення приходять лише в застосунок з початкового екрана: «Поділитися» → «На початковий екран».",
  "push.unsupported": "Цей браузер не підтримує сповіщення.",
  "push.notGranted": "Дозвіл на сповіщення не надано.",
  "device.this": "Цей телефон",
} as const;

export type TextKey = keyof typeof uk;

const en: Record<TextKey, string> = {
  "pair.title": "Connect your phone",
  "pair.where":
    "On the computer open Kermanych → Settings → App → «Remote» and press «Connect a phone». The 6 digits are under the QR code.",
  "pair.codeLabel": "Code from the computer",
  "pair.submit": "Connect",
  "pair.pairing": "Connecting the phone…",
  "pair.forgotten": "This phone was disconnected on the computer or its key expired. Connect it again.",
  "pair.iosTitle": "Add Remote to the Home Screen",
  "pair.iosWhy":
    "On iPhone an app opened from the Home Screen keeps its own storage, apart from Safari, and only it receives notifications. So connect the phone from there:",
  "pair.iosStep1": "Tap «Share» at the bottom of Safari.",
  "pair.iosStep2": "Choose «Add to Home Screen» and confirm.",
  "pair.iosStep3": "Open Remote from its Home Screen icon.",
  "pair.iosStep4": "Enter the 6 digits the computer shows under the QR code.",
  "pair.iosHere": "Use it here in Safari (no notifications)",
  "pair.toList": "Back to the agents",
  "banner.offline": "The computer is unreachable",
  "banner.offlineHint": "It may be asleep or off, or Tailscale is off on this phone. Reconnecting…",
  "banner.retry": "Retry",
  "banner.signedOut": "Nobody is signed in to Kermanych on the computer",
  "banner.signedOutHint": "Sign in to Kermanych on the computer — the phone reconnects by itself.",
  "banner.foreignLogin": "Another Tailscale account",
  "banner.foreignLoginHint":
    "The phone must be signed in to Tailscale with the same account as the computer. Check the account in the Tailscale app on the phone.",
  "error.unauthorized": "This phone is no longer connected. Connect it again.",
  "error.signed_out": "Nobody is signed in to Kermanych on the computer.",
  "error.foreign_login": "The phone must be signed in to Tailscale with the same account as the computer.",
  "error.pairing": "The code is wrong or expired — press «Connect a phone» on the computer again.",
  "error.not_found": "Session not found — it may have been deleted.",
  "error.native_busy": "The agent is busy right now — send it when it finishes.",
  "error.network": "The computer is unreachable. Check Tailscale on the phone.",
  "error.failed": "The action failed.",
  "list.title": "Agents",
  "list.empty": "No agents",
  "list.emptyHint": "Sessions running on the computer will show up here.",
  "list.attention": "needs you",
  "list.otherProject": "No project",
  "status.backlog": "backlog",
  "status.queued": "queued",
  "status.thinking": "thinking",
  "status.tool": "running",
  "status.waiting_input": "response needed",
  "status.done": "done",
  "status.in_review": "in review",
  "status.error": "error",
  "status.stopped": "stopped",
  "status.merged": "finished",
  "status.conflict": "conflict",
  "time.now": "just now",
  "time.min": "{n} min ago",
  "time.hour": "{n} h ago",
  "time.day": "{n} d ago",
  "session.back": "Back",
  "session.stop": "Stop",
  "session.stopConfirm": "Stop the agent?",
  "session.stopConfirmHint": "The current work is interrupted. A new message continues it.",
  "session.stopYes": "Stop",
  "session.stopNo": "Cancel",
  "session.removed": "This session is no longer listed — it was finished, archived or deleted.",
  "session.emptyLog": "The conversation is empty so far.",
  "session.thinking": "thought…",
  "session.thinkingHide": "hide",
  "session.jumpEnd": "To the end",
  "session.photoAlt": "Photo",
  "session.native": "in a terminal",
  "question.title": "The agent asks",
  "question.yes": "Yes",
  "question.no": "No",
  "question.answer": "Answer",
  "question.cancel": "Cancel",
  "question.placeholder": "Your answer",
  "question.native": "This agent runs in a terminal — it can be answered only on the computer.",
  "composer.placeholder": "Message to the agent",
  "composer.send": "Send",
  "composer.photo": "Add a photo",
  "composer.removePhoto": "Remove the photo",
  "composer.photoLimit": "At most {n} photos in one message.",
  "composer.photoFailed": "Could not read the photo.",
  "push.title": "Notifications",
  "push.hint": "When an agent waits for your answer or stops with an error while you are away from the computer.",
  "push.enable": "Turn on notifications",
  "push.disable": "Turn off notifications",
  "push.on": "Notifications are on.",
  "push.denied": "Notifications are blocked for this app in the phone's settings.",
  "push.iosInstall": "On iPhone notifications arrive only in the Home Screen app: «Share» → «Add to Home Screen».",
  "push.unsupported": "This browser does not support notifications.",
  "push.notGranted": "Notification permission was not granted.",
  "device.this": "This phone",
};

export const DICTIONARIES: Record<Lang, Record<TextKey, string>> = { uk, en };

/** `uk` for a Ukrainian browser, English for everything else (spec → settled without a question). */
export function langOf(language: string | undefined): Lang {
  return (language ?? "").toLowerCase().startsWith("uk") ? "uk" : "en";
}

export const lang: Lang = langOf(typeof navigator === "undefined" ? undefined : navigator.language);

export function t(key: TextKey, params?: Record<string, string | number>, l: Lang = lang): string {
  const text = DICTIONARIES[l][key];
  return params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : text;
}

export function statusText(status: SessionStatus, l: Lang = lang): string {
  return t(`status.${status}` as TextKey, undefined, l);
}

/** «5 хв тому» from two instants; `now` comes from the caller so the helper stays pure. */
export function relativeTime(iso: string, now: number, l: Lang = lang): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return t("time.now", undefined, l);
  const m = Math.floor(s / 60);
  if (m < 60) return t("time.min", { n: m }, l);
  const h = Math.floor(m / 60);
  if (h < 24) return t("time.hour", { n: h }, l);
  return t("time.day", { n: Math.floor(h / 24) }, l);
}
