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
  BRANCH_PREFIXES,
  isTerminalRiskStatus,
  MANAGEMENT_ACTION_FENCE,
  MANAGEMENT_SECTIONS,
  managementSection,
  PLATFORMS,
  RISK_CATEGORY_VALUES,
  RISK_KIND_VALUES,
  RISK_RESPONSES_BY_KIND,
  RISK_SCORE_MAX,
  RISK_EXPORT_FORMATS,
  RISK_SCORE_MIN,
  RISK_STATUS_VALUES,
  type ManagementCapacity,
  type ManagementCapacityPerson,
  type ManagementCapacityWeek,
  type ManagementContext,
  type ManagementDocs,
  type ManagementDocFragment,
  type ManagementHome,
  type ManagementHomeTodoItem,
  type ManagementJiraBoard,
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
    "Ти працюєш з переліченими нижче розділами Менеджменту І з дошкою задач воркспейсу («Дошка»). Питання поза цим — не твоя робота: скажи це прямо.",
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
    // No count in this sentence, and that is a repair rather than a style choice: it used to
    // read «рівно чотири форми», the number was hand-kept beside a hand-written menu, and it
    // was wrong the moment a fifth kind existed. The next line already carries the whole
    // point — anything not listed is refused — without a number that can drift.
    "Усередині блоку — один JSON-обʼєкт або масив обʼєктів. Дозволені ТІЛЬКИ такі форми:",
    '  { "kind": "unsupported", "section": <назва розділу>, "request": <що просили зробити> }',
    '  { "kind": "risk.create", "risk": { … } }',
    '  { "kind": "risk.update", "code": "R-003", "patch": { … } }',
    // Listed HERE, in the exhaustive menu, and not only in riskProtocol() below — the same
    // repair the `attachments` line above documents, and this action is the case that proved
    // the rule twice. Asked to delete R-001, the assistant read this menu, correctly found
    // only create and update, and then told the operator to delete the card on the Risk
    // Registry screen — a button that did not exist anywhere in the app. A capability absent
    // from this list is not merely unavailable to the model; it is something the model will
    // invent a plausible home for.
    '  { "kind": "risk.delete", "code": "R-003" }',
    '  { "kind": "risk.export", "format": "pdf" | "xlsx", "codes": ["R-001", "…"] }',
    '  { "kind": "release.notes", "project": "…", "branch": "…", "rangeFrom": "РРРР-ММ-ДД", "rangeTo": "РРРР-ММ-ДД" }',
    '  { "kind": "ticket.create", "project": "…", "ticket": { … }, "assignee": "…", "prefix": "…", "platform": "…" }',
    // `attachments` is listed HERE and not only under «ДОДАТКОВІ ПОЛЯ» below, because the line
    // above declares this list exhaustive («Дозволені ТІЛЬКИ такі форми»). A field the model
    // can only find 170 lines later loses that argument: asked to put the operator's image on
    // the ticket, the assistant read this menu, concluded the action «не має поля для вкладень»
    // and told the operator to attach the file by hand in Jira — while the executor behind it
    // had been uploading named files all along.
    '  { "kind": "jira.ticket.create", "board": "…", "ticket": { … }, "issueType": "…", "priority": "…", "labels": ["…"], "assignee": "…", "parentKey": "…", "ref": "…", "parentRef": "…", "attachments": ["імʼя файлу"] }',
    // Listed HERE for the risk.delete lesson below: a verb absent from the exhaustive menu is
    // one the model tells the operator to go and perform by hand in Jira.
    '  { "kind": "jira.ticket.update", "key": "KRM-101", "patch": { "ticket": { … }, "title": "…", "issueType": "…", "priority": "…", "labels": ["…"], "assignee": "…", "unassign": true, "status": "…", "dueDate": "РРРР-ММ-ДД", "startDate": "РРРР-ММ-ДД", "originalEstimate": "3d 4h", "parentKey": "…", "attachments": ["імʼя файлу"] } }',
    '  { "kind": "ticket.questions", "forTicket": "…", "questions": ["…", "…"] }',
    // Listed HERE and not only in homeProtocol() below — the risk.delete lesson: the menu
    // declares itself exhaustive, and a verb it does not carry is one the model will refuse
    // or invent a screen for.
    '  { "kind": "todo.create", "items": [ { "text": "…", "kind": "check" | "number" } ] }',
    '  { "kind": "todo.update", "index": 1, "patch": { "text": "…", "kind": "check" | "number", "done": true | false } }',
    '  { "kind": "todo.delete", "index": 1 }',
    "Не вигадуй інші `kind` — вони відкидаються без виконання.",
    "",
    riskProtocol(),
    "",
    releaseProtocol(),
    "",
    ticketProtocol(),
    "",
    capacityProtocol(),
    "",
    homeProtocol(),
    "",
    docsProtocol(),
    "",
    "ПРАВИЛА:",
    `(а) якщо просять ЗМІНИТИ розділ з capability=read_write (${writable}) — віддай відповідний блок дії. Дію виконує застосунок, не ти: у прозі опиши, ЩО саме робиш, і не пиши, що це вже зроблено — результат («Ризик R-004 занесено…», «Реліз-ноти готові…») чат покаже сам;`,
    '(б) якщо просять ЗМІНИТИ розділ, у якого capability НЕ read_write — віддай { "kind": "unsupported", "section": "<назва розділу>", "request": "<що просили>" } І поясни це прозою, цитуючи обмеження цього розділу зі списку вище. Ніколи не пиши, що ти щось записав, створив або оновив;',
    "(в) якщо просять ПРОЧИТАТИ або пояснити — відповідай звичайною прозою, без блоку дії. Ти можеш читати репозиторії воркспейсу (див. контекст) своїми read/grep/glob;",
    "(в-1) СТВОРЕННЯ ТІКЕТА — окремий випадок: дошка задач не є розділом Менеджменту, тому тікет можна створити з будь-якого розділу, і на прохання «створи тікет» (або кілька тікетів) НІКОЛИ не відповідай unsupported. Так само ЗМІНА наявного тікета Jira — це jira.ticket.update, а не unsupported. Дій за протоколом ТІКЕТІВ нижче;",
    // Rule (в) says a READ is answered in prose, and an export reads like a read — without this
    // line the model summarises the register in the chat instead of producing the file.
    "(в-2) ЕКСПОРТ РЕЄСТРУ РИЗИКІВ у файл (PDF чи Excel) — теж блок дії, risk.export, хоча нічого не змінює, і працює з будь-якого розділу. Не переписуй реєстр у чат замість файлу. Дій за протоколом РЕЄСТРУ РИЗИКІВ нижче;",
    "(г) ніколи не викликай інтерактивний інструмент або запит, який чекає відповіді в інтерфейсі: за цим маршрутом немає жодного інтерфейсу, який міг би відповісти, і запит просто зависне. Будь-яке уточнення — прозою;",
    `(ґ) ${localeDirective(locale)} ВИНЯТОК — текст тікета: поля \`ticket\` завжди англійською, див. блок «МОВА ТІКЕТА» у протоколі ТІКЕТІВ.`,
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
    "",
    // The distinction the whole delete feature rests on, stated as a rule the model applies
    // rather than a fact it has to infer. Both halves are load-bearing: without the first the
    // model deletes materialised risks and destroys the lessons-learned set the register
    // exists to produce; without the second it refuses a legitimate «прибери тестовий рядок»
    // and sends the operator looking for a screen to do it on.
    "ЗАКРИТИ ЧИ ВИДАЛИТИ. Це різні дії, і плутати їх не можна:",
    `  ризик СТАВСЯ або відпав — це risk.update зі status ${RISK_STATUS_VALUES.filter(isTerminalRiskStatus).join(" / ")} і closureNote. Рядок лишається в реєстрі: він і є матеріал для lessons learned;`,
    "  рядка взагалі не мало бути в реєстрі (тестовий запис, дубль уже наявного ризику, помилковий воркспейс) — це risk.delete.",
    "risk.delete видаляє рядок НАЗАВЖДИ і разом з усією його історією подій; скасувати це неможливо. Тому: якщо з формулювання не очевидно, що рядок помилковий, спершу запитай прозою, що саме мають на увазі — закрити чи видалити, — і не давай блок дії до відповіді.",
    "Видаляти ризики може лише ВЛАСНИК воркспейсу. Якщо просить не власник, база відмовить — чат покаже цю відмову, а ти не обіцяй наперед, що видалиш.",
    "code бери СУВОРО зі списку реєстру в контексті — так само, як для risk.update. Інших полів risk.delete не має.",
    "",
    // Export writes nothing, so its rules are about the two choices the operator makes in the
    // dialog — the format and the rows — and about not narrating a file nobody has seen yet.
    "ЕКСПОРТ РЕЄСТРУ — це risk.export: застосунок збирає файл у браузері з реєстру, який бачить оператор, і пропонує його зберегти (те саме, що кнопка «Експорт» на екрані реєстру).",
    `  format — ${RISK_EXPORT_FORMATS.join(" | ")}: pdf — документ, щоб читати й пересилати; xlsx — таблиця Excel з усіма полями, щоб фільтрувати й рахувати. Якщо формат не названо — спитай прозою, який, і не давай блок дії до відповіді.`,
    "  codes — необовʼязковий список кодів СУВОРО зі списку реєстру в контексті. Без codes експортується весь реєстр.",
    "    Якщо просять частину реєстру описом («відкриті загрози», «все з експозицією від 12», «ризики постачальників») — відбери ці рядки з реєстру в контексті сам і передай їхні коди. Якщо під опис не підпадає жоден рядок — скажи це прозою, без блоку дії.",
    "  У прозі скажи, ЩО саме експортуєш (формат і які ризики); не переказуй вміст файлу і не пиши, що файл уже збережено — результат чат покаже сам.",
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

// The ticket protocol — the longest block in this file, and deliberately so.
//
// The other two protocols describe a schema: get the vocabulary right and the row is right.
// A ticket has no schema that can be wrong in an interesting way (a title and a list of
// sentences), and everything that makes it worth filing is a QUALITY the operator asked for
// by name: it must read as though a senior project manager wrote it, it must speak business
// and not engineering, it must carry acceptance criteria somebody can check, and it must
// contain no open questions. `ManagementTicketFields` makes the shape unavoidable and
// `validateManagementAction` refuses the questions; the voice, the grounding and the choice
// of board have nowhere to live but here.
//
// Three rules in it are the ones that cost the most when they are missing:
//
//   * the DEFAULT board. There are two boards and only one of them always exists, so a
//     request that does not name Jira is a request for the native board. Left unstated, a
//     model that had just been reading about the Jira mirror files there;
//   * the READ-FIRST rule. The assistant has the workspace's repositories on disk and the
//     tools to read them, and a ticket grounded in what the product actually does is the
//     difference between «додати експорт» and a ticket the team can pick up. It is stated
//     together with its boundary — read the code, write about the business — because the
//     natural failure of a model that has just read code is to describe the code.
//   * the LANGUAGE. A card is read by whoever picks it up — including people who do not
//     speak the operator's language — so the ticket's own text is English, and the language
//     of the REQUEST says nothing about it. Left to rule (ґ) alone («answer in the user's
//     language»), a Ukrainian request produced a Ukrainian ticket: that is the default this
//     block exists to invert, and only an explicit «write it in X» moves it back. The split
//     from the chat's prose and from `ticket.questions` is stated inside the block, because
//     a model told «English» once starts answering the operator in English too.
function ticketProtocol(): string {
  return [
    "ТІКЕТИ (дошка задач). Дошка — це НЕ розділ Менеджменту: тікет можна створити з будь-якого розділу.",
    "",
    "ЯКА ДОШКА. Дошки бувають двох типів:",
    '  • власна дошка воркспейсу («Задачі») — дошка ЗА ЗАМОВЧУВАННЯМ. Дія: { "kind": "ticket.create", … }.',
    '  • дзеркала дошок Jira («Jira») — лише ті, що воркспейс підключив (див. «Дошки Jira» у контексті). Дія: { "kind": "jira.ticket.create", … }.',
    "  Jira вибирай ТІЛЬКИ тоді, коли користувач прямо назвав Jira (або тікет/ключ Jira). У всіх інших випадках —",
    "  ticket.create, навіть якщо ти щойно читав про Jira. Не питай «на власну чи Jira?»: замовчування вже є відповіддю.",
    "  Якщо Jira просять, а в контексті її немає (або немає особистого токена) — скажи це прозою і НЕ створюй тікет",
    "  на власній дошці замість неї: користувач назвав іншу дошку.",
    "  ЯКА САМЕ дошка Jira: воркспейс може мати кілька. Якщо підключена одна — вона і є відповіддю, поле board можна не",
    "  ставити. Якщо кілька — постав board з назвою дошки; коли користувач назвав ключ (напр. KRM-101) або проєкт,",
    "  вибери дошку з тим проєктом; якщо однозначно визначити не вдається — спитай прозою, на яку дошку, і не вгадуй.",
    "",
    "МОВА ТІКЕТА — АНГЛІЙСЬКА. Поля `ticket` (title, context, userFlow, acceptanceCriteria, outOfScope) пиши",
    "АНГЛІЙСЬКОЮ — завжди, на обох дошках, незалежно від мови розмови. Картку читає вся команда, і дошка в неї одна.",
    "Те, що користувач написав українською, НЕ означає прохання про український тікет: мова запиту й мова тікета не",
    "звʼязані. Інша мова в полях тікета — ТІЛЬКИ якщо користувач попросив її прямо («тікет українською»).",
    "Власні назви не перекладай: назви проєктів, гілок, екранів, підписи інтерфейсу, імена виконавців, ключі Jira й",
    "мітки цитуй так, як вони існують, усередині англійського речення (the «Історія» tab).",
    "Це правило лише про ПОЛЯ ТІКЕТА. Прозу відповіді й питання ticket.questions читає користувач — їх пиши його мовою.",
    "",
    "ЯК ПИСАТИ ТІКЕТ. Ти пишеш як досвідчений керівник проєкту, а не як розробник:",
    "  • мова — бізнесова: користувач, його потреба, наслідок для роботи команди або клієнта;",
    "  • НІЯКИХ технічних рішень і технічних порад. Не називай таблиць, полів БД, ендпоінтів, бібліотек, компонентів,",
    "    файлів, міграцій, архітектури; не пиши «як це реалізувати». ЩО і НАВІЩО — так; ЯК — ні, це вибір команди;",
    "  • ніякого коду і ніяких фрагментів коду в тексті тікета;",
    "  • жодних відкритих питань, «TBD», «уточнити», «якщо потрібно», «на розсуд розробника» і жодних заповнювачів",
    "    на кшталт <…> чи […]. Тікет — це рішення, а не чернетка.",
    "",
    "ПЕРЕД ТИМ ЯК ПИСАТИ — ПРОЧИТАЙ КОД. Репозиторії воркспейсу перелічені в контексті; читай їх своїми read/grep/glob,",
    "щоб тікет описував ЦЕЙ продукт: як екран чи процес працює зараз, які поняття вже є, як їх називає інтерфейс.",
    "Але в тікет іде тільки бізнесовий висновок з прочитаного: «зараз користувач не бачить історію змін» — так;",
    "«таблиця audit_log не має індексу» — ні.",
    "",
    "ПОЛЯ `ticket` (однакові для обох дошок):",
    "  title — один рядок, який видно на картці. Не переказ тікета.",
    "  context — обовʼязково: навіщо ця робота і кому вона потрібна. Бізнес, а не постановка задачі розробнику.",
    "  userFlow — необовʼязково: крок за кроком те, що робить користувач (масив рядків). Якщо сценарію немає — не вигадуй.",
    "  acceptanceCriteria — обовʼязково, мінімум один: перевіряльні твердження, за якими тікет закривають.",
    "    Кожен критерій — те, що людина може перевірити на екрані або в даних, без читання коду. Не питання.",
    "  outOfScope — необовʼязково: що цей тікет свідомо НЕ покриває, щоб межі були названі, а не вгадані.",
    "  Опис картки збирає застосунок з цих полів — заголовки й порядок його, тому не форматуй description сам.",
    "",
    "ХТО ВИКОНАВЕЦЬ. У кожної дошки СВІЙ список людей, і вони не збігаються — бери той, що для цієї дошки:",
    '  • ticket.create (власна дошка) — імʼя зі списку «Команда воркспейсу»: це користувачі застосунку.',
    '  • jira.ticket.create — імʼя зі списку «Виконавці Jira»: це акаунти Atlassian на цій дошці.',
    "    Те, що людини немає в команді воркспейсу, НЕ причина відмовити чи спитати: у Jira призначають того,",
    "    кого дозволяє Jira, а не того, у кого є доступ до нашого застосунку. Ці два списки не порівнюй.",
    "  Імʼя пиши РІВНО так, як воно стоїть у списку ДЛЯ ЦІЄЇ дошки (не uuid, не accountId і не e-mail).",
    "  Не назвали виконавця — не став його зовсім, непризначена картка це нормальний стан обох дошок.",
    "  Немає такого імені у списку для власної дошки — не вгадуй: спитай прозою.",
    "  Для Jira інакше: список «Виконавці Jira» обмежений за розміром, тому якщо користувач прямо назвав людину,",
    "    якої в ньому не видно, все одно постав це імʼя в assignee — застосунок перевірить його в живій Jira",
    "    і сам скаже, якщо Jira такого виконавця не знає. Відмовляти замість нього не потрібно.",
    "",
    "ДОДАТКОВІ ПОЛЯ ticket.create:",
    "  project — назва проєкту РІВНО так, як вона стоїть у списку репозиторіїв контексту (не id і не шлях).",
    "    Кілька проєктів і користувач не сказав, до якого належить робота — спитай, не вгадуй.",
    `  prefix — тип роботи: ${BRANCH_PREFIXES.join(" | ")} (необовʼязково).`,
    `  platform — ${PLATFORMS.join(" | ")} (необовʼязково).`,
    "  Модель, рівень роздумів, базову гілку й окреме робоче дерево не задавай — це параметри запуску агента,",
    "  тобто саме ті технічні рішення, яких у тікеті бути не повинно.",
    "  Вкладень у власної дошки НЕМАЄ: файл до картки «Задачі» прикріпити нікуди. Просили тікет із файлом на власній",
    "    дошці — створи тікет і скажи прозою, що файл лишився в розмові; вкладення є тільки в Jira. Не обіцяй",
    "    прикріпити його пізніше і не перенось тікет у Jira замість цього: дошку назвав користувач.",
    "",
    "ДОДАТКОВІ ПОЛЯ jira.ticket.create:",
    "  board — назва дошки Jira РІВНО так, як її названо у блоці «Дошки Jira». Обовʼязкове, коли підключено кілька",
    "    дошок; з однією можна пропустити. Проєкт Jira не задавай — він визначається обраною дошкою.",
    "  issueType, priority — НАЗВИ так, як їх показує Jira («Task», «Story», «Bug», «High»). Не назвали — не став:",
    "    Jira підставить свої типові значення. Назви, якої на обраній дошці немає, застосунок не знайде і скаже це.",
    "  labels — масив міток без пробілів (необовʼязково).",
    "  parentKey — ключ УЖЕ ІСНУЮЧОГО батьківського тікета: той, що назвав користувач («підзадача до KRM-101»), або той,",
    "    який ти знайшов у знімку дошки (блок «Дошки Jira» у контексті). Ключів не вигадуй: ключа, якого немає, Jira не приймає.",
    "  ref, parentRef — для батька, який створюється В ЦІЙ САМІЙ відповіді (див. «КІЛЬКА ТІКЕТІВ» нижче). parentKey і",
    "    parentRef разом не став.",
    '  attachments — масив ІМЕН файлів з блоку «ДОЛУЧЕНІ ФАЙЛИ» цього ходу, РІВНО так, як вони там названі.',
    "    Це ЄДИНИЙ і робочий спосіб прикріпити файл до тікета: користувач попросив «додай зображення/файл до тікета» —",
    "    постав ці імена в attachments ТОГО САМОГО блоку jira.ticket.create. Застосунок завантажить їх у Jira відразу",
    "    після створення тікета й сам напише про кожен файл окремим рядком.",
    "    НІКОЛИ не пиши, що поля для вкладень немає, що вкладення неможливі або що файл треба прикріпити вручну",
    "    на екрані Jira — це неправда, і користувач лишиться без вкладення, якого просив.",
    "    Зображення — такий самий файл, як документ: воно теж називається у цьому полі, а не описується прозою.",
    "    Вміст у дію не клади й імен не вигадуй: невідоме імʼя буде відхилено. Файли з ПОПЕРЕДНІХ повідомлень",
    "    розмови теж можна називати — блок «ДОЛУЧЕНІ ФАЙЛИ» перелічує всі файли розмови, а не тільки нові.",
    "    Файл як ДЖЕРЕЛО для тексту тікета — це не attachments: просто прочитай його і пиши тікет.",
    "",
    "КІЛЬКА ТІКЕТІВ. Одна відповідь може створити скільки завгодно тікетів — обмеження «один тікет за раз» НЕМАЄ.",
    "  Коли користувач просить кілька тікетів, серію, послідовність або «розбий це на тікети» — віддай ОКРЕМУ дію",
    "  створення на КОЖЕН тікет (кілька блоків або один блок з масивом) у тому порядку, в якому роботу слід робити.",
    "  Не зливай їх в один тікет і не обмежуйся першим. Кожен тікет самодостатній: свої title, context і",
    "  acceptanceCriteria — критерій «див. попередній тікет» неперевіряльний. Порядок, якщо він важливий, назви у context",
    "  («Follows “Export invoices to CSV”») і не нумеруй заголовки. Просили ОДИН тікет — не дроби його сам.",
    "  Епік із дочірніми тікетами в Jira однією відповіддю: батьківському постав \"ref\" (довільна мітка, напр. \"epic\"),",
    "  дочірнім — \"parentRef\" з тією самою міткою; батько ОБОВʼЯЗКОВО йде раніше за дітей. Ключ, який Jira дасть батькові,",
    "  підставить застосунок; дочірній тікет, чий батько не створився, теж не створюється. На власній дошці («Задачі»)",
    "  батьків немає — там серія це просто кілька ticket.create.",
    "  Відкрите питання хоч до одного тікета серії — постав його через ticket.questions і НЕ створюй цього ходу жодного",
    "  тікета серії: частково створена серія гірша, ніж жодної.",
    "",
    "ЗМІНИТИ НАЯВНИЙ ТІКЕТ JIRA — це jira.ticket.update:",
    '  { "kind": "jira.ticket.update", "key": "KRM-101", "patch": { … } }',
    "  key — ключ тікета: названий користувачем або знайдений у ЗНІМКУ ДОШКИ. Знімок — файл, шлях до якого стоїть біля",
    "    дошки в блоці «Дошки Jira»: там КОЖЕН тікет дошки — ключ, назва, тип, статус, пріоритет, виконавець, батько,",
    "    мітки, дати, оцінка й опис. Шукай у ньому grep-ом (за ключем або словами з назви) і читай read-ом. Описав",
    "    користувач тікет словами («тікет про експорт») — знайди його там; підходить кілька — спитай прозою, який;",
    "    не знайшов жодного — скажи це і нічого не змінюй. Ключів не вигадуй.",
    "  Перед зміною ПРОЧИТАЙ тікет у знімку: ти змінюєш те, що там є, а не те, що памʼятаєш.",
    "  patch містить ЛИШЕ те, що змінюється:",
    "    ticket — ПЕРЕПИСАТИ тікет цілком (назва + опис) за правилами «ЯК ПИСАТИ ТІКЕТ» і «МОВА ТІКЕТА». Опис замінюється",
    "      повністю, тож перенеси в нові поля все з поточного опису, що має лишитися, — інакше воно зникне.",
    "      Відкрите питання, яке ВЖЕ стоїть у тікеті («unclear», «TBD», питання в критеріях), зміні не заважає: тікет уже на",
    "      дошці, і застосунок таку зміну не відхиляє. Перенеси його як є або зніми, якщо користувач на нього відповів, —",
    "      але НЕ підміняй зміну блоком ticket.questions і не відмовляйся змінювати тікет через нього. Нових відкритих",
    "      питань від себе не додавай.",
    "    title — лише перейменувати, опис не чіпати. ticket і title разом не став.",
    "    issueType, priority, assignee — НАЗВИ, як для jira.ticket.create; unassign: true — зняти виконавця.",
    "    status — НАЗВА статусу, в який перевести («In Progress», «Done»); застосунок знайде перехід у Jira і скаже,",
    "      якщо з поточного статусу туди не можна.",
    "    labels — НОВИЙ повний список міток: щоб додати мітку, перелічи й наявні зі знімка; [] — прибрати всі.",
    "    dueDate, startDate — РРРР-ММ-ДД; \"\" — очистити дату. originalEstimate — тривалість Jira («3d 4h»); \"\" — очистити.",
    "    parentKey — новий батько (ключ наявного тікета). attachments — імена файлів розмови, як у jira.ticket.create.",
    "  Кілька тікетів змінюють — окремий jira.ticket.update на кожен. Змінювати можна тільки тікети Jira: для карток",
    "  власної дошки («Задачі») дії зміни немає — скажи прозою, що це робиться в самій картці на «Дошці».",
    "",
    "ЯКЩО ЧОГОСЬ НЕ ЗНАЄШ. Тікет з відкритим питанням не створюється. Коли для тікета бракує рішення, яке може",
    "ухвалити тільки користувач (межі роботи, поведінка в крайньому випадку, пріоритет, виконавець, проєкт) —",
    'віддай { "kind": "ticket.questions", "forTicket": "<робоча назва тікета>", "questions": ["…", "…"] } і НЕ давай',
    "того ж ходу блок створення. Питання — короткі, конкретні, кожне про одне рішення; застосунок сам покаже їх",
    "користувачеві й скаже, що тікет не створено. Не дублюй ці питання прозою — достатньо одного речення про те,",
    "що ти зрозумів. Наступного ходу, коли користувач відповість, створюй тікет. Якщо не відповів — тікета немає.",
    "Те, що можна вивести з коду або з контексту, питанням не є: прочитай і виріши сам. І виконавець, якого",
    "користувач НАЗВАВ, теж не питання — постав його за правилом «ХТО ВИКОНАВЕЦЬ» вище, а не питай про нього.",
    "",
    "Тікет створює і змінює застосунок, не ти: у прозі скажи, які тікети й на яку дошку ти подаєш або що саме в якому",
    "тікеті змінюєш, і не пиши, що це вже зроблено — рядки з номерами карток («Тікет KRM-214 створено…», «Тікет KRM-101",
    "оновлено…») чат покаже сам.",
  ].join("\n");
}

// Team Capacity is the one section the assistant READS but never writes, and the protocol
// spends its words on what the numbers mean: a manager who hears «45 of 40 hours» has to
// know whether that is time logged or time still estimated, and a model left to guess says
// «planned» about a week that already happened.
function capacityProtocol(): string {
  return [
    "НАВАНТАЖЕННЯ КОМАНДИ (management-capacity). Розділ лише читається: єдина дія для нього — unsupported.",
    "Питання «яка потужність / яке навантаження команди або людини» — відповідай ПРОЗОЮ і ТІЛЬКИ з блоку",
    "«Навантаження команди Jira» у контексті:",
    "  • дай розбивку по людях і по тижнях: навантаження проти потужності, у годинах і у відсотках;",
    "    назви, хто перевантажений (понад 100%) і хто недовантажений (менше 80%);",
    "  • минулі тижні — це ЗАЛОГОВАНИЙ час (факт); поточний і майбутні — ОЦІНКИ, що лишилися по відкритих тікетах,",
    "    розкладені рівномірно між датою початку (або сьогодні) і дедлайном;",
    "  • тікети без дедлайну в тижні не входять — назви їх кількість окремо: це робота, якої графік не показує;",
    "    прострочені лягають цілком на сьогодні;",
    "  • «потужність проєкту» — це ця дошка Jira; «людина» — виконавець Jira з цього блоку. Не вигадуй людей і",
    "    чисел, яких у блоці немає; «(не призначено)» — робота без виконавця, потужності в неї нема;",
    "  • період поза вікном блоку — скажи це прямо і відправ на екран Team Capacity, де є вибір дат.",
    "    Блоку немає — воркспейс без дошки Jira, оцінок узяти нізвідки.",
  ].join("\n");
}

// The Home overview: readable as a whole, writable through THREE verbs — the Action List's
// create / update / delete. The read half spends its words on what an «insight» is allowed to
// be built from: the digest block plus the register and capacity blocks the tiles mirror —
// never numbers the context does not hold. The write half addresses a row by the `#N` the
// digest prints beside it, and names what stays screen work (moving and resizing the tiles,
// the layout): an operation absent from the menu is one the model will invent a home for, so
// the boundary is stated, not implied.
function homeProtocol(): string {
  return [
    "ОГЛЯД HOME (management-home). Плитка «Список дій» (Action List) — особистий список справ оператора; ти читаєш його зі знімка «Огляд Home» і пишеш ТРЬОМА дієсловами:",
    '  { "kind": "todo.create", "items": [ { "text": "…", "kind": "check" | "number" } ] } — додати пункти в кінець списку.',
    '  { "kind": "todo.update", "index": N, "patch": { … } } — змінити пункт №N.',
    '  { "kind": "todo.delete", "index": N } — прибрати пункт №N.',
    "  text — один пункт ПРОСТИМ ТЕКСТОМ, як його читатиме оператор; без розмітки й тегів.",
    "  kind — check (пункт із чекбоксом; за замовчуванням) або number (пункт нумерованого списку).",
    "  index — номер пункта #N зі знімка «Огляд Home»: цей номер плитка друкує біля кожного рядка. patch у todo.update ставить ЛИШЕ те, що змінюється — text, kind і/або done (виконано; лише для check).",
    "  Кілька пунктів у create — кілька елементів items ОДНОГО блоку. Кілька змін чи видалень — окремий блок на кожен пункт; видаляй від БІЛЬШОГО index до меншого, бо видалення зсуває номери пунктів під ним.",
    "  Список особистий і живе лише в браузері оператора — він не синхронізується між машинами; змінив — скажи це, коли доречно, і не обіцяй, що список побачить хтось інший.",
    "Пересунути або розтягнути плитки, змінити розкладку — це робиться на самій плитці мишею; такі прохання — unsupported із поясненням прозою.",
    "Питання «що на головній / огляд воркспейсу / проаналізуй дашборд» — відповідай ПРОЗОЮ з блоку «Огляд Home»",
    "у контексті разом з рештою контексту:",
    "  • плитки дзеркалять розділи: capacity — блок «Навантаження команди Jira», risks — реєстр ризиків,",
    "    tasks — «Задачі на сьогодні», releases — «Реліз-ноти», todo — особистий список справ оператора (Action List);",
    "  • давай ВИСНОВКИ, а не переказ: перевантаження й прострочене, ризики з найбільшою експозицією,",
    "    невиконані пункти списку дій, робота без виконавця — і що з цього варто зробити першим;",
    "  • не вигадуй плиток і чисел, яких у блоці немає; блоку «Огляд Home» немає взагалі — скажи, що знімок",
    "    дашборда цього ходу недоступний, і відповідай з решти контексту.",
  ].join("\n");
}

// One attached file of the conversation, as the message states it. Documents carry the
// absolute path the api wrote them to (the read tool's subject); images carry no path —
// they ride their own message through omp's image slots and the line only names them.
//
// `earlier` marks a file that came with an EARLIER message: the block lists the whole
// conversation (see ManagementChatService's ledger), and the model must still be able to
// tell what arrived with the words it is answering now.
export type ManagementTurnFile = { name: string; path?: string; earlier?: boolean };

// The block that tells the model which files the operator has attached to this conversation
// and how to reach them. Names are quoted exactly because they are also the vocabulary of
// `jira.ticket.create.attachments` — a paraphrased name there would be refused.
//
// The second line is not decoration. This block is the text CLOSEST to the decision «the
// operator asked me to put this image on the ticket», and while it said only «зображення,
// додане до цього повідомлення» the assistant filed the ticket and explained in prose that
// attachments were impossible — the capability was stated once, in the first turn's
// contract, hundreds of lines away. The rule is repeated where the file is named.
function attachmentsBlock(files: ManagementTurnFile[]): string {
  return [
    "── ДОЛУЧЕНІ ФАЙЛИ ──",
    "Ці імена — вокабуляр поля `attachments` у jira.ticket.create: просили прикріпити файл до тікета Jira —",
    "постав імʼя звідси в те поле (і зображення теж), а не пиши, що вкладення неможливі.",
    ...files.map((f) => {
      const where = f.earlier ? "з попереднього повідомлення цієї розмови" : "додане до цього повідомлення";
      return f.path === undefined
        ? `- «${f.name}» — зображення, ${where}`
        : `- «${f.name}» — ${f.path} (відкрий інструментом read, якщо файл потрібен для відповіді)`;
    }),
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

// The Jira board's two or three lines. The FIRST is the only thing that tells the model the
// second board exists at all: absent means the workspace has no Jira mirror, so
// `jira.ticket.create` has nowhere to land — and the line says which of the two failures it
// is, because they are not the same conversation: «нема інтеграції» is the owner's job in
// Integrations, «нема токена» is this operator's.
//
// The rest is Jira's OWN assignable list, and it is a separate block from the roster on
// purpose. The two are different sets of people — a Jira seat is not a Kermanych account —
// and folding them into one list is precisely how a perfectly ordinary Jira assignee
// («створи тікет у Jira на Марину») became «немає в команді воркспейсу, тікет не створено».
// The roster is the native board's answer; this is Jira's.
//
// The writable board's assignees are printed only for a WRITABLE board: with no token there is
// no ticket to assign, and the browser has no list to send either.
//
// The last line names the board's SNAPSHOT file — every ticket on it, written beside the
// conversation's attachments this turn (`jiraBoardSnapshot` below). It is how the assistant
// finds a key the operator described and reads an issue before `jira.ticket.update` touches
// it, and it is a PATH rather than the tickets themselves because a board of hundreds of
// issues re-printed into every turn would spend the operator's plan re-reading them. Printed
// for a read-only board too: reading the mirror needs no token.
function jiraBoardLines(b: ManagementJiraBoard, file: string | undefined): string {
  const head =
    `- «${b.boardName}» · проєкт ${b.projectKey} · ` +
    (b.canWrite
      ? "можна створювати й змінювати тікети"
      : "БЕЗ особистого токена Jira на цій машині — тікет тут створити чи змінити неможливо, скажи це прозою");
  const lines = [head];
  // An empty list is a failed read, never «nobody is assignable», so the sentence says what
  // to do about it instead of leaving the model to infer a refusal from a network error.
  if (b.canWrite)
    lines.push(
      b.assignees.length
        ? `  Виконавці Jira: ${b.assignees.join(", ")}`
        : "  список виконавців цього ходу недоступний: якщо користувач назвав виконавця — постав його імʼя як є, застосунок перевірить його в Jira",
    );
  lines.push(
    file !== undefined && b.issues !== undefined
      ? `  Тікети дошки (${b.issues.length}) — знімок: ${file} (шукай ключ чи слова назви grep-ом, читай тікет read-ом)`
      : "  знімок тікетів цього ходу недоступний: ключ тікета бери лише зі слів користувача й не вигадуй",
  );
  return lines.join("\n");
}

function jiraLines(boards: ManagementJiraBoard[] | undefined, files: (string | undefined)[] = []): string {
  if (!boards || boards.length === 0)
    return "Дошки Jira: не підключені — тікети створюються тільки на власній дошці воркспейсу";
  const head =
    boards.length === 1
      ? "Дошка Jira (підключена одна) — assignee в jira.ticket.create/update бери зі списку виконавців ЦІЄЇ дошки:"
      : `Дошки Jira (${boards.length}) — у jira.ticket.create назви поле "board" РІВНО так, як дошку названо тут, і бери виконавця зі списку ТІЄЇ дошки; jira.ticket.update знаходить дошку за ключем тікета:`;
  return [head, ...boards.map((b, i) => jiraBoardLines(b, files[i]))].join("\n");
}

// The mirror's rendered description HTML as plain text the model can read and carry into a
// rewrite. Block boundaries become line breaks and list items keep a dash — flattening to
// textContent would glue «Context» and its first sentence into one word. No DOM on this side,
// and none is needed: this is Jira's own renderer output, not arbitrary markup.
const HTML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function htmlText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|tr|pre|blockquote|ul|ol|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== "#") return HTML_ENTITIES[e.toLowerCase()] ?? m;
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A ticket body past this is a document; its head is what an edit has to preserve, and the
// cut is announced so the model never mistakes it for the whole.
const SNAPSHOT_DESCRIPTION_MAX = 4000;

// One board's snapshot file. Every issue opens with a `### KEY · summary` line, so a grep for
// a key or for words of a title lands on the header, and the lines under it are the fields an
// update names — in the vocabulary it names them in.
export function jiraBoardSnapshot(b: ManagementJiraBoard, today: string): string {
  const issues = b.issues ?? [];
  const out = [
    `Знімок дошки Jira «${b.boardName}» · проєкт ${b.projectKey} · тікетів: ${issues.length} · станом на ${today}`,
    "Кожен тікет починається рядком «### КЛЮЧ · назва»; під ним — поля й опис.",
  ];
  for (const i of issues) {
    const facts = [
      `тип: ${i.type || "—"}`,
      `статус: ${i.status || "—"}`,
      `пріоритет: ${i.priority || "—"}`,
      `виконавець: ${i.assignee || "не призначено"}`,
      ...(i.parentKey ? [`батько: ${i.parentKey}`] : []),
      ...(i.labels.length ? [`мітки: ${i.labels.join(", ")}`] : []),
      ...(i.startDate ? [`старт: ${i.startDate}`] : []),
      ...(i.dueDate ? [`дедлайн: ${i.dueDate}`] : []),
      ...(i.originalEstimate ? [`оцінка: ${i.originalEstimate}`] : []),
    ];
    const text = htmlText(i.description);
    const body =
      text.length > SNAPSHOT_DESCRIPTION_MAX ? `${text.slice(0, SNAPSHOT_DESCRIPTION_MAX)}\n… (опис обрізано)` : text;
    out.push("", `### ${i.key} · ${i.summary}`, facts.join(" · "));
    out.push(body ? `опис:\n${body.replace(/^(?=.)/gm, "  ")}` : "опис: (порожній)");
  }
  return `${out.join("\n")}\n`;
}

function hoursText(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function capacityWeek(w: ManagementCapacityWeek): string {
  return `${w.week}: ${hoursText(Math.round((w.loggedH + w.plannedH) * 10) / 10)}/${hoursText(w.capacityH)} год (лог ${hoursText(w.loggedH)} · план ${hoursText(w.plannedH)})`;
}

function capacityPerson(p: ManagementCapacityPerson): string {
  return `- ${p.name || "(не призначено)"} · відкритих ${p.openIssues} · без дати ${p.unscheduled} · прострочено ${p.overdue} · ${p.weeks.map(capacityWeek).join(" · ")}`;
}

// The Team Capacity digest, one line per person. Absent means the workspace has no Jira
// board, and the line says so: the alternative is a model that invents a team's hours.
function capacityLines(c: ManagementCapacity | undefined): string {
  if (c === undefined)
    return "Навантаження команди (Team Capacity): недоступне — у воркспейсу немає дошки Jira, а оцінки є тільки там";
  return [
    `Навантаження команди Jira (Team Capacity), ${c.from} … ${c.to}, тижні від понеділка, потужність ${c.hoursPerDay} год/робочий день на людину; тиждень читається як «понеділок: навантаження/потужність год (лог · план)»:`,
    `- КОМАНДА РАЗОМ · без дати ${c.unscheduled} · прострочено ${c.overdue} · ${c.team.map(capacityWeek).join(" · ")}`,
    ...c.persons.map(capacityPerson),
  ].join("\n");
}

// One Action List row, prefixed with its 1-based position (`#N`) — the handle todo.update and
// todo.delete address it by. Checklist rows print as checkboxes; a numbered run counts itself
// and, like the tile, restarts after a checklist row — the two must read the same.
function homeTodoLines(items: ManagementHomeTodoItem[]): string {
  const out: string[] = [];
  let n = 0;
  items.forEach((it, i) => {
    const pos = i + 1;
    if (it.kind === "number") {
      n += 1;
      out.push(`- #${pos} ${n}. ${it.text}`);
    } else {
      n = 0;
      out.push(`- #${pos} [${it.done ? "x" : " "}] ${it.text}`);
    }
  });
  return out.join("\n");
}

// The Home overview digest, tile by tile. Absent means the client predates it, and the line
// says so — the assistant must never invent what the operator's dashboard shows. The
// capacity and risks tiles are not repeated here: their data is the capacity block and the
// register above, and the homeProtocol states that mapping.
function homeLines(h: ManagementHome | undefined): string {
  if (h === undefined)
    return "Огляд Home (management-home): знімок дашборда цього ходу недоступний — описуй головну з решти контексту і скажи це прямо";
  const tiles = h.tiles.length
    ? h.tiles.map((t) => `${t.id} ${t.w}×${t.h}`).join(", ")
    : "розкладка порожня";
  const groups = h.tasksToday.map((g) => {
    const tasks = g.tasks
      .map((t) => `${t.key} «${t.summary}»${t.overdue ? " (прострочено)" : ""}`)
      .join("; ");
    return `- ${g.name || "(не призначено)"}: ${tasks}`;
  });
  return [
    `Огляд Home (дашборд management-home) — плитки в порядку читання оператора, id · ширина×висота на сітці з 4 колонок: ${tiles}.`,
    `Плитка «Список дій» (Action List) — особистий список оператора (${h.todo.length}); #N — номер пункта для todo.update/todo.delete, [x] — виконано:`,
    h.todo.length ? homeTodoLines(h.todo) : "- список порожній",
    `Плитка «Задачі на сьогодні» (${h.tasksToday.length} ос.):`,
    groups.length ? groups.join("\n") : "- сьогодні ні на кому не «лежить» запланована робота (або дошки Jira немає)",
    `Плитка «Реліз-ноти» — останні збережені (${h.releases.length}):`,
    h.releases.length
      ? h.releases.map((r) => `- ${r.title} · ${r.projectName} · ${r.createdAt.slice(0, 10)}`).join("\n")
      : "- реліз-нот ще немає",
  ].join("\n");
}

// The contract half of documentation RAG. Retrieval already happened BEFORE this turn (a
// browser-side Edge Function call embedded the question and searched), so the fragments are
// in the context block and the model's whole job is to answer from them — the agent loop
// that used to grep the repo is exactly what this feature removes. So this protocol OVERRIDES
// rule (в): for a documentation question, read/grep/glob are forbidden.
function docsProtocol(): string {
  return [
    "ДОКУМЕНТАЦІЯ ПРОЄКТУ (management-docs). Коли в контексті є блок «Документація проєкту», відповідай на питання про документацію ВИКЛЮЧНО з наведених фрагментів:",
    "  • НЕ використовуй read/grep/glob для документації — фрагменти вже дібрані заздалегідь; шукати файли самому означає повернути повільну непередбачувану відповідь, яку ця функція саме усуває (це виняток із правила (в));",
    "  • цитуй КОЖЕН використаний фрагмент markdown-посиланням рівно у форматі [шлях › заголовок](kdoc:folder|path|рядок) — беручи folder, path і початковий рядок із рядка «→ kdoc:…» під фрагментом; застосунок перетворює його на посилання, що відкриває файл у превʼю на потрібному рядку;",
    "  • якщо у фрагментах немає відповіді — так і скажи прямо, не додумуй з памʼяті і не вигадуй шляхів;",
    "  • status=\"not-indexed\": проєкт ще не проіндексовано — скажи це прямо і попроси натиснути «Переіндексувати» на вкладці; НЕ грепай репозиторій;",
    "  • status=\"fulltext\": повнотекстовий резерв (сервіс ембедингів недоступний) — відповідай із фрагментів, але попередь, що пошук цього разу був неповний.",
  ].join("\n");
}

// One retrieved fragment: its location line (which carries the kdoc citation token) followed
// by its indented content, so the model can both cite it and quote from it.
function fragmentLines(f: ManagementDocFragment): string {
  const head = `- ${f.folder}/${f.path} › ${f.headingPath || "(без заголовка)"} (рядки ${f.startLine}–${f.endLine}) → kdoc:${f.folder}|${f.path}|${f.startLine}`;
  const body = f.content.split("\n").map((l) => `    ${l}`);
  return [head, ...body].join("\n");
}

// The documentation retrieval block for the turn. Three shapes by status: an indexed project
// with fragments to answer from, the full-text fallback (Voyage down), and a project with no
// index at all — the last of which the model must report plainly rather than grep around.
function docsLines(d: ManagementDocs): string {
  if (d.status === "not-indexed") {
    return `Документація проєкту «${d.projectName}» (management-docs): проєкт НЕ проіндексовано — скажи, що індексу ще немає, і не грепай репозиторій.`;
  }
  const head =
    d.status === "fulltext"
      ? `Документація проєкту «${d.projectName}» — знайдені фрагменти (повнотекстовий резерв, сервіс ембедингів недоступний):`
      : `Документація проєкту «${d.projectName}» — знайдені фрагменти:`;
  if (d.fragments.length === 0) return `${head}\n- (за запитом нічого не знайдено)`;
  return [head, ...d.fragments.map(fragmentLines)].join("\n");
}

function contextBlock(repos: ManagementRepo[], c: ManagementContext, today: string, jiraFiles?: (string | undefined)[]): string {
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
    // The roster — the NATIVE board's assignees, because `tasks.assignee_id` is a uuid the
    // model must never invent. Printed with the role, which is the other thing a manager
    // assigns by. Re-sent every turn for the register's reason: membership changes.
    `Команда воркспейсу (${c.members.length}) — імʼя · роль (виконавця тікета на ВЛАСНІЙ дошці називай саме цим імʼям):`,
    c.members.length ? c.members.map((m) => `- ${m.name} · ${m.role}`).join("\n") : "- список недоступний",
    jiraLines(c.jira, jiraFiles),
    capacityLines(c.capacity),
    homeLines(c.home),
    // Documentation fragments, present only in the Проєктна документація section once a
    // project is selected. Omitted entirely elsewhere so no other section pays for the block.
    ...(c.docs ? [docsLines(c.docs)] : []),
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
  // Every file of the CONVERSATION, newest message first (see ManagementTurnFile and the
  // ledger in ManagementChatService). Per-turn like the context block, not part of the
  // contract: a ticket is routinely filed a turn or two after the file arrived — through a
  // `ticket.questions` round trip — and a block that listed only this message's files left
  // that turn with no names to put in `attachments` at all.
  attachments?: ManagementTurnFile[];
  // Where this turn's board snapshots were written, aligned with `context.jira` by position
  // (`undefined` for a board whose tickets could not be read). Per-turn like the context
  // block: the board changes between turns, not least through this chat's own writes.
  jiraFiles?: (string | undefined)[];
}): string {
  const parts = input.first ? [contract(input.locale), ""] : [];
  parts.push(contextBlock(input.repos, input.context, input.today, input.jiraFiles), "");
  if (input.attachments?.length) parts.push(attachmentsBlock(input.attachments), "");
  parts.push("── ПОВІДОМЛЕННЯ КОРИСТУВАЧА ──", input.text);
  return parts.join("\n");
}

// The operator's LOCAL calendar date, YYYY-MM-DD. Local and not UTC because the range a
// person means by «за останній тиждень» is the one on their own wall calendar, and the api
// runs on their machine. Kept out of `buildManagementTurn` so that function stays a pure
// function of its input — the only reason its wording is testable without spawning omp.
export function todayIso(at: Date = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}
