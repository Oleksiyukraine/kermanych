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

// Upper bound on the commit block, in characters. A quarter's worth of a busy repo can be
// megabytes of commit bodies; past this the tail is dropped and the prompt says so, which
// beats a provider-side truncation the note would never mention. ~48k chars is roughly 12k
// tokens — small beside any modern context window, large enough for hundreds of commits.
export const MAX_COMMITS_CHARS = 48_000;

function commitLine(c: ReleaseCommit): string {
  // The body indented under its subject so the model reads them as one commit; hashes are
  // deliberately absent — the note must not quote them, so the prompt never shows them.
  const body = c.body.trim();
  return `- ${c.date} · ${c.author}: ${c.subject}${body ? `\n${body.replace(/^/gm, "    ")}` : ""}`;
}

// The commit block plus whether the cap cut it short. Whole commits only: a body sliced
// mid-sentence would be quoted into the note as if the sentence ended there.
export function commitsBlock(commits: ReleaseCommit[]): { block: string; included: number; truncated: boolean } {
  const lines: string[] = [];
  let size = 0;
  for (const c of commits) {
    const line = commitLine(c);
    if (size + line.length > MAX_COMMITS_CHARS && lines.length > 0) {
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

// No language input: every note is written in English, whatever the operator's UI locale,
// agent language or the commits' own language. A note is read by the whole team and by
// people outside it, and the workspace keeps one list of them.
export function buildReleaseNotesPrompt(input: {
  workspaceName: string;
  projectName: string;
  branch: string;
  rangeFrom: string;
  rangeTo: string;
  commits: ReleaseCommit[];
  // `topic` (default) groups changes by meaning; `person` writes one section per author.
  groupBy?: ReleaseGrouping;
}): string {
  // Per person, each author's commits are printed together and in section order, so the
  // model attributes from one contiguous run instead of re-sorting a mixed list. The roster
  // is counted over ALL commits, before the cap: a person whose commits fell past it is
  // still named, with a count, rather than silently missing from a report about people.
  const authors = input.groupBy === "person" ? commitsByAuthor(input.commits) : undefined;
  const { block, included, truncated } = commitsBlock(authors ? [...authors.values()].flat() : input.commits);
  const language = [
    // Stated as its own rule, ahead of the readability rule, because the commits printed
    // below are routinely Ukrainian and a model left alone mirrors the language it reads.
    `- МОВА ДОКУМЕНТА — АНГЛІЙСЬКА, завжди: заголовки, пункти, речення й заголовок першого рівня. Мова комітів, репозиторію чи цього завдання на неї не впливає — коміти іншою мовою перекладай англійською, не цитуй.`,
    `- Власні назви не перекладай: назву продукту, імена людей і підписи інтерфейсу пиши так, як вони існують, усередині англійського речення.`,
  ];
  const layout = authors
    ? [
        `- Розділи документ за людьми. Для кожної людини зі списку «Учасники» нижче — заголовок другого рівня, який є РІВНО її імʼям, як воно записане у списку (без нумерації, ролей і підписів), у тому самому порядку.`,
        `- Під іменем — що ця людина завершила за період: пункти простою мовою про те, що змінилося для користувача і чим це корисно. Споріднені коміти однієї людини обʼєднуй в один пункт.`,
        `- Пункт у розділі людини пишеться ЛИШЕ з її власних комітів: не приписуй їй чужої роботи й не перенось її роботу іншим.`,
        `- Якщо вся робота людини — дрібниці, яких користувач не помітить (рефакторинг, залежності, CI), напиши в її розділі одне речення про це, але людину не пропускай.`,
        `- Автоматичні облікові записи (боти, наприклад «dependabot[bot]») окремого розділу не отримують: їхню роботу згадай одним реченням наприкінці або пропусти.`,
        ...(truncated
          ? [
              `- Список комітів нижче обрізано за обсягом. Якщо комітів людини в ньому немає, напиши в її розділі одним реченням, скільки змін вона зробила, — не вигадуй, які саме.`,
            ]
          : []),
      ]
    : [
        `- Згрупуй зміни за смислом: «New», «Improvements», «Fixes» (заголовки другого рівня; порожні групи пропусти). Споріднені коміти об'єднуй в один пункт.`,
        `- Дрібниці, які користувач не помітить (рефакторинг, залежності, CI), збери одним реченням наприкінці або пропусти.`,
      ];
  return [
    `Ти пишеш реліз-ноти для продукту «${input.workspaceName}».`,
    ``,
    `Репозиторій: ${input.projectName}. Гілка: ${input.branch}. Період: ${input.rangeFrom} — ${input.rangeTo} включно.`,
    ``,
    `Вимоги до документа:`,
    ...language,
    // The requirement the user set for this feature: the reader is NOT an engineer, and
    // every rule below serves that one.
    `- Пиши простою мовою, зрозумілою людині без технічної освіти. Пояснюй, що змінилося ДЛЯ КОРИСТУВАЧА і чим це корисно — не як воно реалізоване.`,
    `- Жодних хешів комітів, назв файлів, назв гілок, імен функцій і технічного жаргону в тексті.`,
    ...layout,
    `- Якщо з коміта незрозуміло, що саме він змінює для користувача — відкрий код репозиторію (read/grep/glob) і розберися, перш ніж писати.`,
    `- Перший рядок — заголовок першого рівня \`#\`, що називає продукт і період.`,
    `- У відповіді — ЛИШЕ готовий markdown-документ. Без преамбули, без коментарів поза документом, без запитань.`,
    ``,
    ...(authors
      ? [`Учасники (імʼя — кількість комітів за період):`, ...[...authors].map(([name, own]) => `- ${name} — ${own.length}`), ``]
      : []),
    `Коміти за період${authors ? `, згруповані за автором` : ""} (${included}${truncated ? ` з ${input.commits.length} — список обрізано за обсягом, узагальни решту обережно` : ""}):`,
    ``,
    block,
  ].join("\n");
}
