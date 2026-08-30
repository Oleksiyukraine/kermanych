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
  MANAGEMENT_ACTION_FENCE,
  MANAGEMENT_SECTIONS,
  managementSection,
  type ManagementContext,
  type ManagementRepo,
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
    '{ "kind": "unsupported", "section": "management-releases", "request": "додати нотатку релізу 2.1" }',
    "```",
    "",
    "Усередині блоку — один JSON-обʼєкт або масив обʼєктів. Наразі дозволена рівно одна форма:",
    '  { "kind": "unsupported", "section": <назва розділу>, "request": <що просили зробити> }',
    "Жодного розділу з capability=read_write зараз немає, тому жодної дії, що щось записує, теж немає. Не вигадуй інші `kind` — вони відкидаються без виконання.",
    "",
    "ПРАВИЛА:",
    '(а) якщо просять ЗМІНИТИ будь-який розділ Менеджменту — віддай { "kind": "unsupported", "section": "<назва розділу>", "request": "<що просили>" } І поясни це прозою, цитуючи обмеження цього розділу зі списку вище. Ніколи не пиши, що ти щось записав, створив або оновив;',
    "(б) якщо просять ПРОЧИТАТИ або пояснити — відповідай звичайною прозою, без блоку дії. Ти можеш читати репозиторії воркспейсу (див. контекст) своїми read/grep/glob;",
    "(в) ніколи не викликай інтерактивний інструмент або запит, який чекає відповіді в інтерфейсі: за цим маршрутом немає жодного інтерфейсу, який міг би відповісти, і запит просто зависне. Будь-яке уточнення — прозою;",
    "(г) відповідай мовою користувача, за замовчуванням українською.",
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

function contextBlock(repos: ManagementRepo[], c: ManagementContext): string {
  const s = managementSection(c.section);
  // An unresolved section name is still printed: the model must be able to say WHICH
  // screen it was asked about even when the ui sent a name this build does not know.
  const section = s ? `${s.name} (${s.label}, capability=${s.capability})` : c.section;
  return [
    "── КОНТЕКСТ ──",
    `Воркспейс: ${c.workspaceName}`,
    `Проєкт: ${c.projectName}`,
    `Активний розділ: ${section}`,
    "Репозиторії воркспейсу (шлях абсолютний — читай їх саме за ним):",
    repos.length ? repos.map(repoLine).join("\n") : "- жодного привʼязаного репозиторію",
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
  text: string;
}): string {
  const parts = input.first ? [contract(), ""] : [];
  parts.push(contextBlock(input.repos, input.context), "", "── ПОВІДОМЛЕННЯ КОРИСТУВАЧА ──", input.text);
  return parts.join("\n");
}
