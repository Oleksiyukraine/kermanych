// apps/api/src/management/release-notes-prompt.ts
// Everything the release-notes generator is told, as one pure function so the wording is
// testable without spawning omp — the same rule management-prompt.ts follows.
//
// The generator is a ONE-SHOT turn, not a conversation: there is no contract to send once
// and reuse, so the whole instruction rides on the single prompt. The commits are printed
// INTO the prompt rather than left for the model to dig out, because the child's tools are
// read-only (no bash, so no `git log`) — but the tools still matter: a commit subject that
// says nothing («fix», «wip») can be resolved by reading the code it touched.
import type { Locale, ReleaseCommit } from "@kermanych/core";
import { LANGUAGE_NAME } from "./management-prompt";

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

export function buildReleaseNotesPrompt(input: {
  workspaceName: string;
  projectName: string;
  branch: string;
  rangeFrom: string;
  rangeTo: string;
  commits: ReleaseCommit[];
  // The operator's active UI locale. The note is WRITTEN in it; the prompt body stays a
  // Ukrainian template and only the language word below varies. Defaults to English — this
  // section's documented product default — when a caller omits it.
  locale?: Locale;
}): string {
  const { block, included, truncated } = commitsBlock(input.commits);
  const language = LANGUAGE_NAME[input.locale ?? "en"];
  return [
    `Ти пишеш реліз-ноти для продукту «${input.workspaceName}».`,
    ``,
    `Репозиторій: ${input.projectName}. Гілка: ${input.branch}. Період: ${input.rangeFrom} — ${input.rangeTo} включно.`,
    ``,
    `Вимоги до документа:`,
    // The requirement the user set for this feature, stated first: the reader is NOT an
    // engineer, and every rule below serves that one. The note's LANGUAGE is the operator's
    // locale (default English — this section's product default); the group headings below
    // stay English example labels, which the model adapts to the chosen language.
    `- Пиши ${language}, простою мовою, зрозумілою людині без технічної освіти. Пояснюй, що змінилося ДЛЯ КОРИСТУВАЧА і чим це корисно — не як воно реалізоване.`,
    `- Жодних хешів комітів, назв файлів, назв гілок, імен функцій і технічного жаргону в тексті.`,
    `- Згрупуй зміни за смислом: «New», «Improvements», «Fixes» (заголовки другого рівня; порожні групи пропусти). Споріднені коміти об'єднуй в один пункт.`,
    `- Дрібниці, які користувач не помітить (рефакторинг, залежності, CI), збери одним реченням наприкінці або пропусти.`,
    `- Якщо з коміта незрозуміло, що саме він змінює для користувача — відкрий код репозиторію (read/grep/glob) і розберися, перш ніж писати.`,
    `- Перший рядок — заголовок першого рівня \`#\`, що називає продукт і період.`,
    `- У відповіді — ЛИШЕ готовий markdown-документ. Без преамбули, без коментарів поза документом, без запитань.`,
    ``,
    `Коміти за період (${included}${truncated ? ` з ${input.commits.length} — список обрізано за обсягом, узагальни решту обережно` : ""}):`,
    ``,
    block,
  ].join("\n");
}
