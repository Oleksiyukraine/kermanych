// packages/core/src/release-notes-prompt.ts
// Everything the release-notes generator is told, as one pure function so the wording is
// testable without spawning a model — the same rule management-prompt.ts follows.
//
// The generator is a ONE-SHOT turn, not a conversation: there is no contract to send once
// and reuse, so the whole instruction rides on the single prompt. The commits are printed
// INTO the prompt rather than left for the model to dig out, because the child's tools are
// read-only (no bash, so no `git log`) — but the tools still matter: a commit subject that
// says nothing («fix», «wip») can be resolved by reading the code it touched.
//
// Two generators read it: the local api (code in a checkout on this machine, omp's
// read/grep/glob) and the cloud routine runner (code on GitHub, its own list_files/read_file/
// search_code tools).
//
// NO IMPORTS, on purpose — the slack-answer.ts rule: the routines-runner Edge Function imports
// this file by relative path from Deno, which resolves neither extensionless specifiers nor
// workspace packages. The two types below are structural copies of ./release-notes; a drift
// there stops the api compiling where it hands those types in.
type ReleaseCommit = { date: string; author: string; subject: string; body: string };
type ReleaseGrouping = "topic" | "person";

// Upper bound on the commit blocks, in characters. A quarter's worth of a busy repo can be
// megabytes of commit bodies; past this the tail is dropped and the prompt says so, which
// beats a provider-side truncation the note would never mention. ~48k chars is roughly 12k
// tokens — small beside any modern context window, large enough for hundreds of commits.
// A note over several projects splits it evenly, so one busy repository cannot push another
// one's commits out of the prompt.
export const MAX_COMMITS_CHARS = 48_000;

// The document's title, read from its first `# ` heading — the prompt requires one, but a
// model that ignored the rule must not sink the whole generation, so the fallback restates
// what the note is about in the list's own terms.
export function titleOf(markdown: string, fallback: string): string {
  const m = /^#[^\S\n]+(.+)$/m.exec(markdown);
  return m?.[1]?.trim() || fallback;
}

function commitLine(c: ReleaseCommit): string {
  // The body indented under its subject so the model reads them as one commit; hashes are
  // deliberately absent — the note must not quote them, so the prompt never shows them.
  const body = c.body.trim();
  return `- ${c.date} · ${c.author}: ${c.subject}${body ? `\n${body.replace(/^/gm, "    ")}` : ""}`;
}

// The commit block plus whether the cap cut it short. Whole commits only: a body sliced
// mid-sentence would be quoted into the note as if the sentence ended there.
export function commitsBlock(
  commits: ReleaseCommit[],
  cap: number = MAX_COMMITS_CHARS,
): { block: string; included: number; truncated: boolean } {
  const lines: string[] = [];
  let size = 0;
  for (const c of commits) {
    const line = commitLine(c);
    if (size + line.length > cap && lines.length > 0) {
      return { block: lines.join("\n"), included: lines.length, truncated: true };
    }
    lines.push(line);
    size += line.length;
  }
  return { block: lines.join("\n"), included: lines.length, truncated: false };
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
// that was read, where its code lives (a folder on this machine, or an `owner/repo` on GitHub
// for the cloud runner — so the read-only tools can open the code behind a vague commit) and
// the commits of the period.
export type ReleasePromptSource = {
  projectName: string;
  branch: string;
  repoPath: string;
  commits: ReleaseCommit[];
};

// How the generator reaches the code: `local` is a checkout and omp's tools, `github` is the
// cloud runner's GitHub-backed tools.
export type ReleaseCodeAccess = "local" | "github";

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
  // Absent means `local`, the generator every caller had before the cloud runner.
  codeAccess?: ReleaseCodeAccess;
}): string {
  const github = input.codeAccess === "github";
  const codeHome = github ? "репозиторії GitHub" : "теці";
  const tools = github ? "list_files/read_file/search_code" : "read/grep/glob";
  const multi = input.sources.length > 1;
  const cap = Math.floor(MAX_COMMITS_CHARS / Math.max(1, input.sources.length));
  const byPerson = input.groupBy === "person";
  // Per person, each author's commits are printed together and in section order, so the
  // model attributes from one contiguous run instead of re-sorting a mixed list. The roster
  // is counted over ALL commits, before the cap: a person whose commits fell past it is
  // still named, with a count, rather than silently missing from a report about people.
  const parts = input.sources.map((s) => {
    const authors = byPerson ? commitsByAuthor(s.commits) : undefined;
    return { source: s, authors, ...commitsBlock(authors ? [...authors.values()].flat() : s.commits, cap) };
  });
  const truncated = parts.some((p) => p.truncated);
  // The heading level the layout's groups use: the top level of the document for one
  // project, one level under the project's own heading for several.
  const level = multi ? "третього" : "другого";

  const language = [
    // Stated as its own rule, ahead of the readability rule, because the commits printed
    // below are routinely Ukrainian and a model left alone mirrors the language it reads.
    `- МОВА ДОКУМЕНТА — АНГЛІЙСЬКА, завжди: заголовки, пункти, речення й заголовок першого рівня. Мова комітів, репозиторію чи цього завдання на неї не впливає — коміти іншою мовою перекладай англійською, не цитуй.`,
    `- Власні назви не перекладай: назву продукту, імена людей і підписи інтерфейсу пиши так, як вони існують, усередині англійського речення.`,
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
        `- Під іменем — що ця людина завершила за період: пункти простою мовою про те, що змінилося для користувача і чим це корисно. Споріднені коміти однієї людини обʼєднуй в один пункт.`,
        `- Пункт у розділі людини пишеться ЛИШЕ з її власних комітів: не приписуй їй чужої роботи й не перенось її роботу іншим.`,
        `- Якщо вся робота людини — дрібниці, яких користувач не помітить (рефакторинг, залежності, CI), напиши в її розділі одне речення про це, але людину не пропускай.`,
        `- Автоматичні облікові записи (боти, наприклад «dependabot[bot]») окремого розділу не отримують: їхню роботу згадай одним реченням наприкінці${multi ? " розділу проєкту" : ""} або пропусти.`,
        ...(truncated
          ? [
              `- Список комітів нижче обрізано за обсягом. Якщо комітів людини в ньому немає, напиши в її розділі одним реченням, скільки змін вона зробила, — не вигадуй, які саме.`,
            ]
          : []),
      ]
    : [
        multi
          ? `- Усередині розділу кожного проєкту згрупуй його зміни за смислом: «New», «Improvements», «Fixes» (заголовки ${level} рівня; порожні групи пропусти). Споріднені коміти об'єднуй в один пункт.`
          : `- Згрупуй зміни за смислом: «New», «Improvements», «Fixes» (заголовки ${level} рівня; порожні групи пропусти). Споріднені коміти об'єднуй в один пункт.`,
        `- Дрібниці, які користувач не помітить (рефакторинг, залежності, CI), збери одним реченням наприкінці${multi ? " розділу проєкту" : ""} або пропусти.`,
      ];

  const header = multi
    ? [
        `Період: ${input.rangeFrom} — ${input.rangeTo} включно, однаковий для всіх проєктів.`,
        ``,
        `Проєкти (кожен — окремий репозиторій зі своєю гілкою):`,
        ...input.sources.map((s, i) => `${i + 1}. ${s.projectName} — гілка ${s.branch}, код у ${codeHome} ${s.repoPath}`),
      ]
    : [
        `Репозиторій: ${input.sources[0]?.projectName ?? ""}. Гілка: ${input.sources[0]?.branch ?? ""}. Період: ${input.rangeFrom} — ${input.rangeTo} включно.`,
      ];

  const commitSections = parts.flatMap(({ source, authors, block, included }) => {
    const all = source.commits.length;
    const count = `${included}${included < all ? ` з ${all} — список обрізано за обсягом, узагальни решту обережно` : ""}`;
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
    multi
      ? `- Якщо з коміта незрозуміло, що саме він змінює для користувача — відкрий код репозиторію саме цього проєкту (його ${github ? "репозиторій" : "тека"} — у списку «Проєкти»; ${tools}) і розберися, перш ніж писати.`
      : `- Якщо з коміта незрозуміло, що саме він змінює для користувача — відкрий код репозиторію (${tools}) і розберися, перш ніж писати.`,
    `- Перший рядок — заголовок першого рівня \`#\`, що називає продукт і період.`,
    `- У відповіді — ЛИШЕ готовий markdown-документ. Без преамбули, без коментарів поза документом, без запитань.`,
    ``,
    ...commitSections,
  ]
    .join("\n")
    .trimEnd();
}
