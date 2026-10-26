// apps/api/src/management/release-notes-prompt.ts
// Everything the release-notes generator is told, as one pure function so the wording is
// testable without spawning omp — the same rule management-prompt.ts follows.
//
// The generator is a ONE-SHOT turn, not a conversation: there is no contract to send once
// and reuse, so the whole instruction rides on the single prompt. The commits are printed
// INTO the prompt rather than left for the model to dig out, because the child's tools are
// read-only (no bash, so no `git log`) — but the tools still matter: a commit subject that
// says nothing («fix», «wip») can be resolved by reading the code it touched.
import type { ReleaseCommit, ReleaseGrouping } from "@kermanych/core";

// Budget of the commit blocks, in characters. A quarter's worth of a busy repo can be
// megabytes of commit bodies, so past this budget the BODIES give way — never a commit:
// every subject is always printed, because the note must name every change and a commit
// the model never saw can only be written up as «and 45 other changes». ~48k chars is
// roughly 12k tokens. A note over several projects splits it evenly, so one busy
// repository cannot push another one's bodies out of the prompt.
export const MAX_COMMITS_CHARS = 48_000;

// Hard ceiling on the subject lines alone, over the whole note. Subjects are never dropped,
// so this is what bounds the prompt: past it (roughly 1,500+ commits) the generation is
// refused before any model turn — a note that names every change of such a period would
// not fit one reply, and a note that silently leaves changes out is what this replaces.
export const MAX_SUBJECT_CHARS = 160_000;

// One commit's subject line. Shared by the block and by subjectsSize, so the ceiling the
// service checks measures exactly what the prompt prints. Hashes are deliberately absent —
// the note must not quote them, so the prompt never shows them.
function subjectLine(c: ReleaseCommit): string {
  return `- ${c.date} · ${c.author}: ${c.subject}`;
}

// What the subject lines of these commits cost — the measure MAX_SUBJECT_CHARS bounds.
export function subjectsSize(commits: ReleaseCommit[]): number {
  return commits.reduce((n, c) => n + subjectLine(c).length, 0);
}

// The commit block, in the order given, and how many bodies did not fit. Every commit's
// subject is always in it. When subjects and bodies together exceed the cap, the bodies
// are kept shortest first while they fit, so as many commits as possible keep theirs, and
// the longest go. Whole bodies only: a body sliced mid-sentence would be quoted into the
// note as if the sentence ended there.
export function commitsBlock(
  commits: ReleaseCommit[],
  cap: number = MAX_COMMITS_CHARS,
): { block: string; bodiesDropped: number } {
  const subjects = commits.map(subjectLine);
  // Each body indented under its subject so the model reads them as one commit.
  const bodies = commits.map((c) => {
    const body = c.body.trim();
    return body ? `\n${body.replace(/^/gm, "    ")}` : "";
  });
  const subjectsTotal = subjects.reduce((n, s) => n + s.length, 0);
  const bodiesTotal = bodies.reduce((n, b) => n + b.length, 0);
  if (subjectsTotal + bodiesTotal <= cap) return { block: subjects.map((s, i) => s + bodies[i]).join("\n"), bodiesDropped: 0 };

  let room = cap - subjectsTotal;
  const kept = new Set<number>();
  const byLength = commits
    .map((_, i) => i)
    .filter((i) => bodies[i]!.length > 0)
    .sort((a, b) => bodies[a]!.length - bodies[b]!.length || a - b);
  for (const i of byLength) {
    if (bodies[i]!.length > room) break;
    kept.add(i);
    room -= bodies[i]!.length;
  }
  return {
    block: subjects.map((s, i) => (kept.has(i) ? s + bodies[i] : s)).join("\n"),
    bodiesDropped: byLength.length - kept.size,
  };
}

// The period's commits per author, in the order the per-person note writes its sections:
// most commits first, ties by name so the same history always yields the same order. Each
// author's commits keep git's newest-first order. Keyed by the author name exactly as git
// printed it (`%aN`, so a repository's .mailmap already folds one person's aliases).
export function commitsByAuthor(commits: ReleaseCommit[]): Map<string, ReleaseCommit[]> {
  const groups = new Map<string, ReleaseCommit[]>();
  for (const c of commits) {
    const group = groups.get(c.author);
    if (group) group.push(c);
    else groups.set(c.author, [c]);
  }
  return new Map([...groups].sort(([a, ga], [b, gb]) => gb.length - ga.length || a.localeCompare(b)));
}

// One project as the generator is shown it: the name its section is headed with, the branch
// that was read, where its code lives on this machine (so the read-only tools can open the
// code behind a vague commit) and the commits of the period.
export type ReleasePromptSource = {
  projectName: string;
  branch: string;
  repoPath: string;
  commits: ReleaseCommit[];
};

// No language input: every note is written in English, whatever the operator's UI locale,
// agent language or the commits' own language. A note is read by the whole team and by
// people outside it, and the workspace keeps one list of them.
//
// One source is the single-project note, exactly as it always was. Two or more get one
// second-level section per project, in the order given, and the layout below (by meaning or
// by person) moves one level down, inside each project.
export function buildReleaseNotesPrompt(input: {
  workspaceName: string;
  sources: ReleasePromptSource[];
  rangeFrom: string;
  rangeTo: string;
  // `topic` (default) groups changes by meaning; `person` writes one section per author.
  groupBy?: ReleaseGrouping;
  // `person` only: the people the operator picked when the report is about some of the team.
  // The sources' commits are already only theirs (release-notes.service.ts filters them);
  // this tells the model the document is not the whole team's, so it is not titled as such.
  authors?: readonly string[];
}): string {
  const multi = input.sources.length > 1;
  const cap = Math.floor(MAX_COMMITS_CHARS / Math.max(1, input.sources.length));
  const byPerson = input.groupBy === "person";
  // Per person, each author's commits are printed together and in section order, so the
  // model attributes from one contiguous run instead of re-sorting a mixed list. Every
  // commit is printed (only bodies give way to the budget), so every person on the roster
  // has their own commits to write their section from.
  const parts = input.sources.map((s) => {
    const authors = byPerson ? commitsByAuthor(s.commits) : undefined;
    return { source: s, authors, ...commitsBlock(authors ? [...authors.values()].flat() : s.commits, cap) };
  });
  // The heading level the layout's groups use: the top level of the document for one
  // project, one level under the project's own heading for several.
  const level = multi ? "третього" : "другого";

  const language = [
    // Stated as its own rule, ahead of the readability rule, because the commits printed
    // below are routinely Ukrainian and a model left alone mirrors the language it reads.
    `- МОВА ДОКУМЕНТА — АНГЛІЙСЬКА, завжди: заголовки, пункти, речення й заголовок першого рівня. Мова комітів, репозиторію чи цього завдання на неї не впливає — коміти іншою мовою перекладай англійською, не цитуй.`,
    `- Власні назви не перекладай: назву продукту, імена людей і підписи інтерфейсу пиши так, як вони існують, усередині англійського речення.`,
  ];
  // The rule this layout exists for: a long period must still name every change. A model
  // left alone compresses a long tail into «and 45 other changes», which tells the reader
  // nothing — so the tail is written compactly instead of counted.
  const completeness = [
    `- ПОВНОТА: кожен коміт зі списку нижче має бути відображений у документі — у власному пункті або в одному пункті разом зі спорідненими комітами. Жоден коміт не пропускай і не відкидай як неважливий.`,
    `- Ніколи не заміняй зміни їхньою кількістю: жодних «and 45 other changes», «plus several smaller fixes», «various improvements» чи «N commits». Кожна зміна названа словами — що саме змінилося. Кількість комітів у документі не пиши взагалі.`,
    `- Документ має бути компактним, але повним: один пункт — один рядок без вступних фраз; споріднені коміти (одна функція, один екран, серія правок одного місця) обʼєднуй в один пункт, який перелічує, що саме змінилося. Помітні для користувача зміни описуй реченням про користь, дрібні — коротким пунктом у кілька слів.`,
  ];
  // The split the operator asked for when they picked several projects: the reader sees
  // what changed in the back-end apart from what changed in the front-end.
  const projects = multi
    ? [
        `- Розділи документ за проєктами. Для кожного проєкту зі списку «Проєкти» вище — заголовок другого рівня, який є РІВНО назвою проєкту, як вона записана у списку (без лапок, нумерації й гілки), у тому самому порядку. Жодного проєкту не пропускай.`,
        `- Під назвою проєкту — лише зміни цього проєкту, написані з його власних комітів: не перенось зміни одного проєкту в розділ іншого й не обʼєднуй проєкти в один розділ.`,
      ]
    : [];
  const layout = byPerson
    ? [
        multi
          ? `- Усередині розділу кожного проєкту — заголовок ${level} рівня для кожної людини зі списку «Учасники» цього проєкту нижче, який є РІВНО її імʼям, як воно записане у списку (без нумерації, ролей і підписів), у тому самому порядку. Людина, що працювала в кількох проєктах, має розділ у кожному з них — з роботою саме в цьому проєкті.`
          : `- Розділи документ за людьми. Для кожної людини зі списку «Учасники» нижче — заголовок ${level} рівня, який є РІВНО її імʼям, як воно записане у списку (без нумерації, ролей і підписів), у тому самому порядку.`,
        `- Під іменем — усе, що ця людина зробила за період: спершу помітні для користувача зміни — пункти простою мовою про те, що змінилося і чим це корисно. Споріднені коміти однієї людини обʼєднуй в один пункт.`,
        `- Решту роботи людини — дрібні правки й роботу, якої користувач не помітить (рефакторинг, залежності, CI, тести), — не пропускай: після основних пунктів додай рядок «**Smaller changes**» і під ним короткі пункти по кілька слів, кожен з яких називає, що саме зроблено. Якщо вся робота людини така, її розділ складається лише з цього списку.`,
        `- Пункт у розділі людини пишеться ЛИШЕ з її власних комітів: не приписуй їй чужої роботи й не перенось її роботу іншим.`,
        `- Автоматичні облікові записи (боти, наприклад «dependabot[bot]») окремого розділу не отримують: наприкінці${multi ? " розділу проєкту" : ""} одним реченням назви, що саме вони оновили.`,
      ]
    : [
        multi
          ? `- Усередині розділу кожного проєкту згрупуй його зміни за смислом: «New», «Improvements», «Fixes», «Maintenance» (заголовки ${level} рівня, у цьому порядку; порожні групи пропусти).`
          : `- Згрупуй зміни за смислом: «New», «Improvements», «Fixes», «Maintenance» (заголовки ${level} рівня, у цьому порядку; порожні групи пропусти).`,
        `- У кожній групі спершу найпомітніші зміни, далі дрібніші.`,
        `- «Maintenance» — робота, якої користувач не помітить (рефакторинг, залежності, CI, тести): короткими пунктами простою мовою, кожен називає, що саме зроблено (наприклад, «Updated the libraries behind charts and date pickers»). Її не пропускай.`,
      ];
  // Said only for a report about some of the team: without it a model reading «release notes
  // for the product» titles a two-person report as the product's whole release.
  const scope =
    byPerson && input.authors
      ? [
          `- Це звіт не про всю команду, а лише про роботу обраних людей: ${input.authors.join(", ")}. Нижче — лише їхні коміти. У заголовку першого рівня назви цих людей (або «selected contributors», якщо їх більше трьох) і не подавай документ як повний підсумок змін продукту.`,
        ]
      : [];

  const header = multi
    ? [
        `Період: ${input.rangeFrom} — ${input.rangeTo} включно, однаковий для всіх проєктів.`,
        ``,
        `Проєкти (кожен — окремий репозиторій зі своєю гілкою):`,
        ...input.sources.map((s, i) => `${i + 1}. ${s.projectName} — гілка ${s.branch}, код у теці ${s.repoPath}`),
      ]
    : [
        `Репозиторій: ${input.sources[0]?.projectName ?? ""}. Гілка: ${input.sources[0]?.branch ?? ""}. Період: ${input.rangeFrom} — ${input.rangeTo} включно.`,
      ];

  const commitSections = parts.flatMap(({ source, authors, block, bodiesDropped }) => {
    const count = `${source.commits.length}${bodiesDropped > 0 ? `; через обсяг у ${bodiesDropped} з них опис пропущено — лишився тільки заголовок коміта, але сам коміт у документі має бути` : ""}`;
    return [
      ...(multi ? [`=== Проєкт ${source.projectName} (гілка ${source.branch}) ===`, ``] : []),
      ...(authors
        ? [`Учасники (імʼя — кількість комітів за період):`, ...[...authors].map(([name, own]) => `- ${name} — ${own.length}`), ``]
        : []),
      `Коміти за період${authors ? `, згруповані за автором` : ""} (${count}):`,
      ``,
      block,
      ``,
    ];
  });

  return [
    `Ти пишеш реліз-ноти для продукту «${input.workspaceName}».`,
    ``,
    ...header,
    ``,
    `Вимоги до документа:`,
    ...language,
    // The requirement the user set for this feature: the reader is NOT an engineer, and
    // every rule below serves that one.
    `- Пиши простою мовою, зрозумілою людині без технічної освіти. Пояснюй, що змінилося ДЛЯ КОРИСТУВАЧА і чим це корисно — не як воно реалізоване.`,
    `- Жодних хешів комітів, назв файлів, назв гілок, імен функцій і технічного жаргону в тексті.`,
    ...projects,
    ...layout,
    ...scope,
    ...completeness,
    multi
      ? `- Якщо з коміта незрозуміло, що саме він змінює для користувача — відкрий код репозиторію саме цього проєкту (його тека — у списку «Проєкти»; read/grep/glob) і розберися, перш ніж писати. Код відкривай лише заради помітних змін: дрібницю пиши з заголовка коміта.`
      : `- Якщо з коміта незрозуміло, що саме він змінює для користувача — відкрий код репозиторію (read/grep/glob) і розберися, перш ніж писати. Код відкривай лише заради помітних змін: дрібницю пиши з заголовка коміта.`,
    `- Перший рядок — заголовок першого рівня \`#\`, що називає продукт і період.`,
    `- У відповіді — ЛИШЕ готовий markdown-документ. Без преамбули, без коментарів поза документом, без запитань.`,
    ``,
    ...commitSections,
  ]
    .join("\n")
    .trimEnd();
}
