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
  RISK_SCORE_MIN,
  RISK_STATUS_VALUES,
  type ManagementContext,
  type ManagementJiraBoard,
  type ManagementRepo,
  type ManagementRiskRow,
  type ManagementWorkspaceProject,
  type Project,
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

// The section table, rendered. `capability` is printed as the raw token, not a
// translation: rule (б) below tells the model to compare it against `read_write`
// literally, and a localised word would leave nothing to compare. The `limitation` is
// quoted verbatim, because this exact sentence is what the ui shows when it refuses the
// action — a paraphrase would make the chat's prose disagree with its own refusal notice.
function contract(): string {
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
    '  { "kind": "release.notes", "project": "…", "branch": "…", "rangeFrom": "РРРР-ММ-ДД", "rangeTo": "РРРР-ММ-ДД" }',
    '  { "kind": "ticket.create", "project": "…", "ticket": { … }, "assignee": "…", "prefix": "…", "platform": "…" }',
    '  { "kind": "jira.ticket.create", "ticket": { … }, "issueType": "…", "priority": "…", "labels": ["…"], "assignee": "…", "parentKey": "…" }',
    '  { "kind": "ticket.questions", "forTicket": "…", "questions": ["…", "…"] }',
    "Не вигадуй інші `kind` — вони відкидаються без виконання.",
    "",
    riskProtocol(),
    "",
    releaseProtocol(),
    "",
    ticketProtocol(),
    "",
    "ПРАВИЛА:",
    `(а) якщо просять ЗМІНИТИ розділ з capability=read_write (${writable}) — віддай відповідний блок дії. Дію виконує застосунок, не ти: у прозі опиши, ЩО саме робиш, і не пиши, що це вже зроблено — результат («Ризик R-004 занесено…», «Реліз-ноти готові…») чат покаже сам;`,
    '(б) якщо просять ЗМІНИТИ розділ, у якого capability НЕ read_write — віддай { "kind": "unsupported", "section": "<назва розділу>", "request": "<що просили>" } І поясни це прозою, цитуючи обмеження цього розділу зі списку вище. Ніколи не пиши, що ти щось записав, створив або оновив;',
    "(в) якщо просять ПРОЧИТАТИ або пояснити — відповідай звичайною прозою, без блоку дії. Ти можеш читати репозиторії воркспейсу (див. контекст) своїми read/grep/glob;",
    "(в-1) СТВОРЕННЯ ТІКЕТА — окремий випадок: дошка задач не є розділом Менеджменту, тому тікет можна створити з будь-якого розділу, і на прохання «створи тікет» НІКОЛИ не відповідай unsupported. Дій за протоколом ТІКЕТІВ нижче;",
    "(г) ніколи не викликай інтерактивний інструмент або запит, який чекає відповіді в інтерфейсі: за цим маршрутом немає жодного інтерфейсу, який міг би відповісти, і запит просто зависне. Будь-яке уточнення — прозою;",
    "(ґ) відповідай мовою користувача, за замовчуванням українською. ВИНЯТОК — текст тікета: поля `ticket` завжди англійською, див. блок «МОВА ТІКЕТА» у протоколі ТІКЕТІВ.",
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
    "ЯКА ДОШКА. Дошок дві:",
    '  • власна дошка воркспейсу («Задачі») — дошка ЗА ЗАМОВЧУВАННЯМ. Дія: { "kind": "ticket.create", … }.',
    '  • дзеркало дошки Jira («Jira») — лише якщо воркспейс її підключив (див. «Дошка Jira» у контексті). Дія: { "kind": "jira.ticket.create", … }.',
    "  Jira вибирай ТІЛЬКИ тоді, коли користувач прямо назвав Jira (або тікет/ключ Jira). У всіх інших випадках —",
    "  ticket.create, навіть якщо ти щойно читав про Jira. Не питай «на яку дошку?»: замовчування вже є відповіддю.",
    "  Якщо Jira просять, а в контексті її немає (або немає особистого токена) — скажи це прозою і НЕ створюй тікет",
    "  на власній дошці замість неї: користувач назвав іншу дошку.",
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
    "",
    "ДОДАТКОВІ ПОЛЯ jira.ticket.create:",
    "  issueType, priority — НАЗВИ так, як їх показує Jira («Task», «Story», «Bug», «High»). Не назвали — не став:",
    "    Jira підставить свої типові значення. Назви, якої на цій дошці немає, застосунок не знайде і скаже це.",
    "  labels — масив міток без пробілів (необовʼязково).",
    "  parentKey — ключ батьківського тікета, ТІЛЬКИ якщо користувач назвав його сам (наприклад «підзадача до KRM-101»).",
    "    Списку тікетів Jira у тебе немає, тому ключів не вигадуй: ключа, якого немає, Jira не приймає.",
    "  Проєкт Jira не вказуй — він визначений підключенням воркспейсу.",
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
    "Тікет створює застосунок, не ти: у прозі скажи, який тікет і на яку дошку ти подаєш, і не пиши, що він уже",
    "створений — рядок з номером картки («Тікет KRM-214 створено…») чат покаже сам.",
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
// Printed only for a WRITABLE board: with no token there is no ticket to assign, and the
// browser has no list to send either.
function jiraLines(jira: ManagementJiraBoard | undefined): string {
  if (jira === undefined)
    return "Дошка Jira: не підключена — тікети створюються тільки на власній дошці воркспейсу";
  const head =
    `Дошка Jira: ${jira.boardName} · проєкт ${jira.projectKey} · ` +
    (jira.canWrite
      ? "можна створювати тікети"
      : "БЕЗ особистого токена Jira на цій машині — створити тікет неможливо, скажи це прозою");
  if (!jira.canWrite) return head;
  return [
    head,
    `Виконавці Jira (${jira.assignees.length}) — цим списком, а НЕ командою воркспейсу, називається assignee у jira.ticket.create:`,
    // An empty list is a failed read, never «nobody is assignable», so the sentence says what
    // to do about it instead of leaving the model to infer a refusal from a network error.
    jira.assignees.length
      ? jira.assignees.map((n) => `- ${n}`).join("\n")
      : "- список цього ходу недоступний: якщо користувач назвав виконавця — постав його імʼя як є, застосунок перевірить його в Jira",
  ].join("\n");
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
    // The roster — the NATIVE board's assignees, because `tasks.assignee_id` is a uuid the
    // model must never invent. Printed with the role, which is the other thing a manager
    // assigns by. Re-sent every turn for the register's reason: membership changes.
    `Команда воркспейсу (${c.members.length}) — імʼя · роль (виконавця тікета на ВЛАСНІЙ дошці називай саме цим імʼям):`,
    c.members.length ? c.members.map((m) => `- ${m.name} · ${m.role}`).join("\n") : "- список недоступний",
    jiraLines(c.jira),
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
}): string {
  const parts = input.first ? [contract(), ""] : [];
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
