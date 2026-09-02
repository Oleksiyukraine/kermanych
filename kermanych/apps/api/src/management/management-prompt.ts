// apps/api/src/management/management-prompt.ts
// Everything the Менеджмент assistant is told, built as pure functions so the wording is
// testable without spawning omp.
//
// The whole file exists to hold one invariant: the model learns about the Менеджмент
// surface ONLY from `MANAGEMENT_SECTIONS` and the risk vocabularies in @kermanych/core.
// A hand-copied list here would drift the moment a section changes capability, and the
// visible failure of that drift is the assistant confidently promising to edit a screen
// that has no store behind it.
import { homedir } from "node:os";
import {
  isTerminalRiskStatus,
  MANAGEMENT_ACTION_FENCE,
  MANAGEMENT_SECTIONS,
  managementSection,
  RISK_CATEGORY_VALUES,
  RISK_KIND_VALUES,
  RISK_RESPONSES_BY_KIND,
  RISK_SCORE_MAX,
  RISK_SCORE_MIN,
  RISK_STATUS_VALUES,
  type ManagementContext,
  type ManagementRepo,
  type ManagementRiskRow,
  type ManagementWorkspaceProject,
  type Project,
  type Locale,
} from "@kermanych/core";

// The browser sends what only the cloud row knows (the project's id and its git remote); the
// paths, names, branches and conventions come from THIS machine's registry. Ids the registry
// does not know are dropped rather than guessed: a project nobody bound here is not a
// repository this machine can describe, and inventing a directory for it would hand the model
// a `--cwd`-relative path that resolves to somebody else's tree.
//
// The request order is preserved because it is the operator's own sidebar order — the
// first bound repo of that order is also the one `managementCwd` picks, so "the repo I
// was looking at" stays the repo the child starts in.
export function managementRepos(
  projects: Project[],
  workspaceProjects: ManagementWorkspaceProject[],
): ManagementRepo[] {
  const repos: ManagementRepo[] = [];
  for (const w of workspaceProjects) {
    const p = projects.find((x) => x.id === w.id);
    if (!p) continue;
    repos.push({
      projectId: p.id,
      name: p.name,
      localRepoPath: p.localRepoPath,
      ...(w.gitRemoteUrl === undefined || w.gitRemoteUrl === "" ? {} : { gitRemoteUrl: w.gitRemoteUrl }),
      ...(p.defaultBranch === undefined ? {} : { defaultBranch: p.defaultBranch }),
      ...(p.conventions === undefined ? {} : { conventions: p.conventions }),
    });
  }
  return repos;
}

// One omp child has exactly one `--cwd` (rpc-session.ts start()), so a workspace of five
// repositories still has to pick one directory to be born in — the rest are reached by the
// absolute paths listed in the context block. And a workspace whose projects are ALL
// unbound on this machine still deserves a working chat: the assistant's job here is the
// risk register, not the source, so it falls back to the home directory rather than
// refusing to start.
export function managementCwd(repos: ManagementRepo[]): string {
  return repos.find((r) => r.localRepoPath !== "")?.localRepoPath ?? homedir();
}

const UNBOUND = "не привʼязаний на цій машині";

// The one line that varies with the operator's locale. The prompt bodies stay Ukrainian
// templates on purpose — they are the tested contract — so only the "answer in X" directive
// is parameterised. Shared with the release-notes generator, which names the same language.
// `localeDirective` defaults to uk (rule ґ: «за замовчуванням українською»), so a client
// that sends no locale keeps the previous behaviour; the release-notes generator passes
// its own default (en, its documented product default) explicitly.
export const LANGUAGE_NAME: Record<Locale, string> = { uk: "українською", en: "англійською" };

export function localeDirective(locale: Locale = "uk"): string {
  return `Відповідай ${LANGUAGE_NAME[locale]} мовою (${locale}).`;
}

// The section table, rendered. `capability` is printed as the raw token, not a
// translation: rule (б) below tells the model to compare it against `read_write`
// literally, and a localised word would leave nothing to compare. The `limitation` is
// quoted verbatim, because this exact sentence is what the ui shows when it refuses the
// action — a paraphrase would make the chat's prose disagree with its own refusal notice.
function contract(locale: Locale | undefined): string {
  const sections = MANAGEMENT_SECTIONS.map((s) => {
    const head = `- ${s.name} · ${s.label} · capability=${s.capability}`;
    return s.limitation === undefined ? head : `${head} · обмеження: ${s.limitation}`;
  }).join("\n");
  // Read off the table rather than typed into rule (а). «Сьогодні це лише management-risks»
  // was true for exactly as long as one section had a store behind it, and a hand-kept list
  // in a rule is the drift this whole file exists to prevent.
  const writable = MANAGEMENT_SECTIONS.filter((s) => s.capability === "read_write")
    .map((s) => s.name)
    .join(", ");

  const fence = "```" + MANAGEMENT_ACTION_FENCE;
  return [
    "Ти — асистент розділу «Менеджмент» у Kermanych.",
    "Ти працюєш ВИКЛЮЧНО з переліченими нижче розділами Менеджменту. Питання поза цим переліком — не твоя робота: скажи це прямо.",
    "Твої інструменти (read, grep, glob) — ЛИШЕ ДЛЯ ЧИТАННЯ. Ти фізично не можеш змінити жоден файл у репозиторії, тому ніколи не пиши, що ти щось відредагував, закомітив, створив чи видалив у коді.",
    "",
    "Розділи Менеджменту (capability: read_write — можна читати і змінювати; read — можна лише описувати; none — немає ні екрана, ні даних):",
    sections,
    "",
    "ПРОТОКОЛ ДІЙ. Розділ Менеджменту ніколи не змінюється прозою — тільки блоком дії у твоїй відповіді:",
    "",
    fence,
    '{ "kind": "unsupported", "section": "management-capacity", "request": "додати людину в команду" }',
    "```",
    "",
    "Усередині блоку — один JSON-обʼєкт або масив обʼєктів. Дозволені рівно чотири форми:",
    '  { "kind": "unsupported", "section": <назва розділу>, "request": <що просили зробити> }',
    '  { "kind": "risk.create", "risk": { … } }',
    '  { "kind": "risk.update", "code": "R-003", "patch": { … } }',
    '  { "kind": "release.notes", "project": "…", "branch": "…", "rangeFrom": "РРРР-ММ-ДД", "rangeTo": "РРРР-ММ-ДД" }',
    "Не вигадуй інші `kind` — вони відкидаються без виконання.",
    "",
    riskProtocol(),
    "",
    releaseProtocol(),
    "",
    "ПРАВИЛА:",
    `(а) якщо просять ЗМІНИТИ розділ з capability=read_write (${writable}) — віддай відповідний блок дії. Дію виконує застосунок, не ти: у прозі опиши, ЩО саме робиш, і не пиши, що це вже зроблено — результат («Ризик R-004 занесено…», «Реліз-ноти готові…») чат покаже сам;`,
    '(б) якщо просять ЗМІНИТИ розділ, у якого capability НЕ read_write — віддай { "kind": "unsupported", "section": "<назва розділу>", "request": "<що просили>" } І поясни це прозою, цитуючи обмеження цього розділу зі списку вище. Ніколи не пиши, що ти щось записав, створив або оновив;',
    "(в) якщо просять ПРОЧИТАТИ або пояснити — відповідай звичайною прозою, без блоку дії. Ти можеш читати репозиторії воркспейсу (див. контекст) своїми read/grep/glob;",
    "(г) ніколи не викликай інтерактивний інструмент або запит, який чекає відповіді в інтерфейсі: за цим маршрутом немає жодного інтерфейсу, який міг би відповісти, і запит просто зависне. Будь-яке уточнення — прозою;",
    `(ґ) ${localeDirective(locale)}`,
  ].join("\n");
}

// The Risk Registry's vocabulary, printed from @kermanych/core so the model is told exactly
// what `validateManagementAction` will accept. A hand-written list here would start
// rejecting perfectly reasonable risks the day a category is added to the enum.
function riskProtocol(): string {
  const strategies = RISK_KIND_VALUES.map((k) => `${k} → ${RISK_RESPONSES_BY_KIND[k].join(", ")}`).join("; ");
  return [
    "РЕЄСТР РИЗИКІВ (management-risks). Поля `risk` та `patch` однакові:",
    `  kind: ${RISK_KIND_VALUES.join(" | ")}`,
    `  category: ${RISK_CATEGORY_VALUES.join(", ")}`,
    "  cause, event, consequence — три частини формулювання (через що · що станеться · з якими наслідками). Порожніх немає.",
    `  probability, impact — цілі ${RISK_SCORE_MIN}–${RISK_SCORE_MAX} (експозиція = їх добуток, її рахує база)`,
    `  response — залежить від kind: ${strategies}`,
    "  responseActions — що саме буде зроблено; обовʼязкове для всіх стратегій, крім accept («спостерігати» — не реакція)",
    "  earlyWarning — ознака, що ризик реалізується (необовʼязково, але дуже бажано)",
    "  proximity, actionDue — дати РРРР-ММ-ДД (необовʼязково)",
    "  costImpact + probabilityPct (0–100) — тільки разом, для грошової оцінки (необовʼязково)",
    "  residualProbability + residualImpact — тільки разом, оцінка ПІСЛЯ реагування (необовʼязково)",
    `  status: ${RISK_STATUS_VALUES.join(", ")} (за замовчуванням open); closureNote обовʼязковий для ${RISK_STATUS_VALUES.filter(isTerminalRiskStatus).join(" і ")}`,
    "Не передавай code, exposure, emv, дати аудиту чи власників (riskOwner, actionOwner) — код і розрахунки присвоює база, а власників призначають на екрані.",
    "У risk.update поле code бери СУВОРО зі списку реєстру в контексті; patch містить лише те, що змінюється.",
    "Перед створенням звірся з реєстром у контексті: якщо такий ризик уже є — онови його, а не дублюй.",
  ].join("\n");
}

// The Release Notes vocabulary. The section is writable, but through exactly ONE verb — a
// generation — so this block spends most of its words on the two things a wrong action here
// costs real money for: the project (the wrong repository produces a document about
// somebody else's work) and the range (a model that leaves «за останній тиждень» in a date
// field gets refused by validateManagementAction one round trip later).
//
// It also states which of the section's operations stayed on the screen. `MANAGEMENT_SECTIONS`
// carries no `limitation` for a writable row — a limitation is printed as a refusal — so the
// boundary belongs here, exactly as riskProtocol says owners are assigned on the screen.
function releaseProtocol(): string {
  return [
    "РЕЛІЗ-НОТИ (management-releases). Одна дія — згенерувати НОВУ нотатку:",
    '  { "kind": "release.notes", "project": "…", "branch": "…", "rangeFrom": "РРРР-ММ-ДД", "rangeTo": "РРРР-ММ-ДД" }',
    "  project — назва проєкту РІВНО так, як вона стоїть у списку репозиторіїв контексту (не id і не шлях).",
    "    Якщо у воркспейсі кілька проєктів і користувач не сказав, про який ідеться — спитай прозою, не вгадуй:",
    "    нотатка пишеться з git-історії одного конкретного репозиторію.",
    "  branch — гілка того самого репозиторію: або зі слів користувача, або поле «гілка» цього репозиторію в контексті.",
    "    Назв не вигадуй — гілки, якої немає локально, застосунок не знайде і скаже це.",
    "  rangeFrom, rangeTo — включний період, обидві дати РРРР-ММ-ДД, rangeFrom не пізніше rangeTo.",
    "    Відносний період («за останній тиждень», «за серпень», «з минулого релізу») перекладай у конкретні дати сам,",
    "    відлічуючи від дати «Сьогодні» з контексту. Слова замість дати відкидаються без виконання.",
    "Далі застосунок сам: читає коміти цієї гілки за цей період на ЦІЙ машині, пише документ окремим викликом моделі",
    "й зберігає його у воркспейсі. Це триває десятки секунд. У прозі скажи, для якого проєкту, гілки й періоду ти це",
    "запускаєш — і не переказуй змісту нотатки, якого ти ще не бачив.",
    "Редагувати, копіювати чи видаляти вже збережену нотатку ти не можеш — це операції на екрані розділу.",
  ].join("\n");
}

function repoLine(r: ManagementRepo): string {
  const parts = [r.name, r.localRepoPath === "" ? UNBOUND : r.localRepoPath];
  // The remote is the cloud's own answer to «which repository is this», so it is what the
  // assistant can name back to the operator. Omitted when the project has none rather than
  // printed as an empty field the model would try to interpret.
  if (r.gitRemoteUrl !== undefined) parts.push(`remote: ${r.gitRemoteUrl}`);
  if (r.defaultBranch !== undefined) parts.push(`гілка: ${r.defaultBranch}`);
  if (r.conventions !== undefined) parts.push(`конвенції: ${r.conventions}`);
  return `- ${parts.join(" · ")}`;
}

// One register row on one line: the code to quote back, the statement that makes it
// recognisable, and the four fields an assistant reasons about before filing another one.
function riskLine(r: ManagementRiskRow): string {
  return `- ${r.code} · ${r.kind} · ${r.category} · «${r.event}» · ${r.probability}×${r.impact}=${r.probability * r.impact} · ${r.response} · ${r.status}`;
}

function contextBlock(repos: ManagementRepo[], c: ManagementContext, today: string): string {
  const s = managementSection(c.section);
  // An unresolved section name is still printed: the model must be able to say WHICH
  // screen it was asked about even when the ui sent a name this build does not know.
  const section = s ? `${s.name} (${s.label}, capability=${s.capability})` : c.section;
  const risks = c.risks;
  return [
    "── КОНТЕКСТ ──",
    // The operator's calendar date, and the anchor every relative period is resolved
    // against: «реліз-ноти за останній тиждень» has to become a pair of YYYY-MM-DD dates
    // before it can reach `git log`, and a model with no date guesses a year.
    `Сьогодні: ${today}`,
    `Воркспейс: ${c.workspaceName}`,
    `Активний розділ: ${section}`,
    "Репозиторії воркспейсу (шлях абсолютний — читай їх саме за ним):",
    repos.length ? repos.map(repoLine).join("\n") : "- жодного привʼязаного репозиторію",
    // The register is the state the write actions operate on, so it is sent every turn —
    // including the turn right after the assistant filed a row, which is how it learns the
    // code Postgres minted for it.
    `Реєстр ризиків воркспейсу (${risks.length}) — code · kind · category · подія · P×I · стратегія · статус:`,
    risks.length ? risks.map(riskLine).join("\n") : "- реєстр порожній",
  ].join("\n");
}

// The text handed to `prompt` (first turn) or `follow_up` (every later one).
//
// The contract is sent ONCE. The omp child keeps the conversation for its whole life
// (rpc-session.ts holds one process per conversation), so it still remembers the rules on
// turn nine; re-sending ~2 KB of contract every turn would debit the operator's plan —
// the same subscription every agent spends — for text the model already has. The context
// block, by contrast, is re-sent every turn: the risk register changes between turns, and
// a stale register is how the assistant ends up creating a duplicate of a risk it already
// filed.
export function buildManagementTurn(input: {
  first: boolean;
  repos: ManagementRepo[];
  context: ManagementContext;
  // Today, YYYY-MM-DD, from the CALLER — see `todayIso` below.
  today: string;
  text: string;
  // The operator's active UI locale. Only the "answer in X" directive (rule ґ) reads it;
  // the rest of the contract stays Ukrainian. Sent on the FIRST turn, which is the one that
  // carries the contract — a later locale switch re-languages from the next new child.
  locale?: Locale;
}): string {
  const parts = input.first ? [contract(input.locale), ""] : [];
  parts.push(
    contextBlock(input.repos, input.context, input.today),
    "",
    "── ПОВІДОМЛЕННЯ КОРИСТУВАЧА ──",
    input.text,
  );
  return parts.join("\n");
}

// The operator's LOCAL calendar date, YYYY-MM-DD. Local and not UTC because the range a
// person means by «за останній тиждень» is the one on their own wall calendar, and the api
// runs on their machine. Kept out of `buildManagementTurn` so that function stays a pure
// function of its input — the only reason its wording is testable without spawning omp.
export function todayIso(at: Date = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}
