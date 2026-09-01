// Хелпери: the operator's own command-instructions for one chat message. Pure data plus one
// parser, shared by the API (which expands a message on its way to the child) and the UI
// (which lists them in the composer's picker): no fs, no cloud, no omp process knowledge.
//
// A helper is NOT a skill. A skill is model-readable knowledge the model picks up when it
// judges it relevant, and it costs a line of every session's system prompt for as long as it
// exists. A helper is invoked by the operator, applies to exactly one message, and is
// advertised to nobody — which is why it lives in its own table here instead of as a flag on
// SkillDef, and why it never reaches `skills.customDirectories`.

/**
 * How a helper reaches the model.
 *
 * - `instruction` — `body` is prose prepended above the operator's request.
 * - `keyword` — `body` is one of omp's magic keywords and goes INLINE in front of the
 *   request, because omp only fires such a word when it stands alone in prose. These are the
 *   only helpers with a mechanical effect: `ultrathink` raises the turn's reasoning effort.
 */
export type HelperKind = "instruction" | "keyword";

export type HelperDef = {
  // The token the operator types, without the slash. Same grammar as a skill name — one
  // boundary, one source of truth — and asserted against it by the spec.
  name: string;
  // Picker title and its one-line explanation. Operator-facing, so Ukrainian, like every
  // other string in this product's UI.
  label: string;
  hint: string;
  kind: HelperKind;
  body: string;
};

/**
 * The shipped set. Baked into the app on purpose: a helper is a way of talking to the model,
 * not a property of a repository, so every user gets the same list with nothing to configure.
 * Adding one is a content change to this constant.
 *
 * Order is the order the picker shows: explanation, reasoning mode, adversarial, process.
 */
export const DEFAULT_HELPERS: readonly HelperDef[] = [
  {
    name: "el10",
    label: "Поясни просто",
    hint: "як для десятирічного, без жаргону",
    kind: "instruction",
    body: [
      "Поясни так, ніби мені 10 років: короткими реченнями, побутовими аналогіями, без жаргону.",
      "Якщо терміна не обійти — назви його один раз і відразу розшифруй.",
      "Не спрощуй до неправди: якщо аналогія десь ламається, скажи де саме.",
    ].join("\n"),
  },
  {
    name: "tldr",
    label: "Коротко",
    hint: "одне речення суті плюс три пункти",
    kind: "instruction",
    body: [
      "Дай спершу одне речення суті, потім рівно три пункти головного.",
      "Без преамбули, без вступів і без повторення мого питання.",
    ].join("\n"),
  },
  {
    name: "why",
    label: "Чому саме так",
    hint: "обґрунтуй останнє рішення й відкинуті варіанти",
    kind: "instruction",
    body: [
      "Обґрунтуй своє останнє рішення: які альтернативи ти розглядав, чому відкинув кожну,",
      "і що конкретно змінилося б, якби ми обрали найсильнішу з відкинутих.",
      "Якщо альтернатив не розглядав — скажи це прямо, а не вигадуй їх заднім числом.",
    ].join("\n"),
  },
  {
    name: "meta",
    label: "Про сам діалог",
    hint: "твої припущення й неоднозначності, а не задача",
    kind: "instruction",
    body: [
      "Говори про сам діалог, не про предметну задачу: що ти зрозумів із мого запиту,",
      "на яких припущеннях працюєш, де бачиш неоднозначність і чого тобі бракує, щоб не вгадувати.",
      "Задачу зараз не розв'язуй.",
    ].join("\n"),
  },
  {
    name: "deep",
    label: "Думай глибше",
    hint: "піднімає ліміт міркування omp для цього ходу",
    kind: "keyword",
    body: "ultrathink",
  },
  {
    name: "orchestrate",
    label: "Розпаралель",
    hint: "делегувати незалежні частини підагентам",
    kind: "keyword",
    body: "orchestrate",
  },
  {
    name: "redteam",
    label: "Змагальний розбір",
    hint: "шукай, чим зламати наш код і дизайн",
    kind: "instruction",
    body: [
      "Стань на бік атакувальника ПРОТИ цього коду й дизайну: де він ламається, які вхідні дані",
      "його ламають, які припущення про довіру він робить і хто може їх порушити.",
      "Шукай вразливості в тому, що ми написали — не грай роль зловмисника і не обходь власні",
      "обмеження. Кожну знахідку підкріпи конкретним місцем у коді.",
    ].join("\n"),
  },
  {
    name: "grill-me",
    label: "Допитай мене",
    hint: "жорсткі питання по моєму плану, по одному",
    kind: "instruction",
    body: [
      "Тепер питання задаєш ти. Знайди найслабше місце в МОЄМУ плані й допитай мене про нього:",
      "по одному питанню за раз, наступне — після моєї відповіді.",
      "Не пропонуй рішень, поки не переконаєшся, що я розумію, що саме роблю.",
    ].join("\n"),
  },
  {
    name: "steelman",
    label: "Найсильніший контраргумент",
    hint: "найкраща версія відкинутого варіанта",
    kind: "instruction",
    body: [
      "Побудуй найсильнішу можливу версію варіанта, який ми відкинули (або протилежного до мого).",
      "Не солом'яне опудало: аргументуй так, ніби ти його автор і хочеш перемогти.",
      "Наприкінці скажи, чи він таки сильніший — і якщо так, чому.",
    ].join("\n"),
  },
  {
    name: "premortem",
    label: "Post-mortem наперед",
    hint: "це вже зламалося в продакшені — як саме",
    kind: "instruction",
    body: [
      "Вважай, що це вже в продакшені й зламалося. Опиши, ЯК саме: причини відмови за спаданням",
      "імовірності, для кожної — сигнал, за яким ми дізнаємось першими, і найдешевша річ, яка б",
      "її зняла зараз.",
    ].join("\n"),
  },
  {
    name: "prove",
    label: "Доведи",
    hint: "запусти й покажи справжній вивід",
    kind: "instruction",
    body: [
      "Не описуй, а доведи: назви команду, тест або сценарій, вивід якого підтверджує, що це",
      "працює. Запусти й покажи справжній вивід.",
      "Якщо доказу немає — скажи «не перевірено» замість «готово».",
    ].join("\n"),
  },
  {
    name: "plan-only",
    label: "Тільки план",
    hint: "файлів не торкатися, чекати на «так»",
    kind: "instruction",
    body: [
      "Файлів не торкайся: ні правок, ні створення, ні команд, які щось змінюють.",
      "Дай план — що і в якому порядку, які файли зачепить, як перевіримо результат.",
      "Чекай на моє «так» перед будь-якою зміною.",
    ].join("\n"),
  },
  {
    name: "small",
    label: "Мінімальний дiфф",
    hint: "без рефакторингу поза задачею",
    kind: "instruction",
    body: [
      "Найменша зміна, яка розв'язує саме поставлену задачу. Ніякого рефакторингу поза нею,",
      "ніяких покращень «за компанію», нових абстракцій і перейменувань.",
      "Якщо бачиш поруч щось, що варто виправити — скажи, але не роби.",
    ].join("\n"),
  },
  {
    name: "ask",
    label: "Питай, не вгадуй",
    hint: "зупинись на неоднозначності",
    kind: "instruction",
    body: [
      "Якщо в задачі є неоднозначність, зупинись і спитай, а не обирай варіант сам.",
      "Одне питання за раз, із твоїм рекомендованим варіантом.",
      "Це стосується й неочевидних припущень: озвуч їх до того, як на них покладешся.",
    ].join("\n"),
  },
];

const HELPER_BY_NAME: Record<string, HelperDef | undefined> = Object.fromEntries(
  DEFAULT_HELPERS.map((h) => [h.name, h]),
);

// The token is the WHOLE word after the slash, bounded by whitespace or the end of the
// message. `\S+` rather than the name grammar on purpose: `/usr/bin/env` and `/el10/deep`
// capture a candidate that simply is not a helper, so they stop the scan instead of matching
// a prefix of one. Nothing but an exact known name is ever touched.
const HELPER_TOKEN_RE = /^\/(\S+)(?=\s|$)/;

/**
 * Expand the LEADING run of helper tokens in an operator's message.
 *
 * Leading run only, and stopping at the first token that is not a helper, is what makes this
 * safe to run on every message: a path (`/usr/bin/env`), a typo (`/xyz`) and a slash in prose
 * all leave the text byte-identical, exactly as an unknown slash command falls through in omp.
 *
 * The returned `text` is what the child is given; `used` is what the transcript reports, so a
 * helper is never invisible. `used` is empty ⇒ `text` is the original string, untouched.
 */
export function expandHelpers(text: string): { text: string; used: HelperDef[] } {
  const used: HelperDef[] = [];
  let rest = text;
  for (;;) {
    const head = rest.trimStart();
    const m = HELPER_TOKEN_RE.exec(head);
    if (!m) break;
    const hit = HELPER_BY_NAME[m[1]!];
    if (!hit) break;
    // The same helper twice would spend context twice and say nothing new.
    if (!used.some((h) => h.name === hit.name)) used.push(hit);
    rest = head.slice(m[0].length);
  }
  if (used.length === 0) return { text, used };

  // Instructions go above the request so they are read before what they apply to — the shape
  // an operator trigger's skill body already has. Keywords stay on the request's own line.
  const instructions = used.filter((h) => h.kind === "instruction").map((h) => h.body.trim());
  const keywords = used.filter((h) => h.kind === "keyword").map((h) => h.body);
  const inline = [...keywords, rest.trimStart()].filter((s) => s !== "").join(" ");
  return { text: [...instructions, inline].filter((s) => s !== "").join("\n\n"), used };
}

/**
 * What the transcript says about a message that carried helpers. The operator's row keeps the
 * slash they typed, so this line is the only record that the child was given more than that.
 */
export function helperNotice(used: readonly HelperDef[]): string {
  const names = used.map((h) => `«/${h.name}»`).join(", ");
  return used.length === 1 ? `хелпер ${names} додав настанову` : `хелпери ${names} додали настанову`;
}

/**
 * The draft a composer holds after the operator picks `name` from the picker.
 *
 * At the FRONT, never at the caret: `expandHelpers` reads a leading run and nothing else, so
 * a token dropped mid-sentence would look inserted and expand nowhere. Picking a helper the
 * draft already leads with is a no-op, so a double-click costs nothing.
 */
export function prependHelper(value: string, name: string): string {
  if (expandHelpers(value).used.some((h) => h.name === name)) return value;
  return `/${name} ${value}`;
}
