# Chat Transcript Rendering & Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render assistant chat text as Markdown, surface model reasoning as a collapsed "Думаю" block (live placeholder + expandable history), and add a stepper to jump between the operator's own messages.

**Architecture:** UI-only presentation changes in `apps/ui` (KLogBlock renders Markdown + a reasoning disclosure; KPanel adds a live "Думаю…" row and a my-message nav stepper) plus a small additive backend change in `apps/api` (capture `thinking_delta` live and `{type:"thinking"}` history parts into the existing `assistant_thinking` transcript kind). No RPC, persistence, or worktree changes.

**Tech Stack:** Vue 3 (Quasar SPA), SCSS, TypeScript, NestJS, vitest, `markdown-it`.

## Global Constraints

- **Design tokens only.** Colors/fonts come from `packages/tokens` CSS vars: `--k-canvas #12110f`, `--k-bg #1b1a19`, `--k-surface #232120`, `--k-surface2 #2b2927`, `--k-line #3a3735`, `--k-line-strong #4a4644`, `--k-text #f3f2f2`, `--k-muted #8f8b88`, `--k-accent #ff563c`, `--k-diff #3fb950`; fonts `--k-font-ui` (Archivo), `--k-font-mono` (JetBrains Mono).
- **Green `--k-diff` is reserved for diff striping only.** Never use it for Markdown/code.
- **`--k-accent` is the single accent, used sparingly** (links, focus outline).
- **Radius 0 everywhere** (already enforced globally by `* { border-radius: 0 }`).
- **No syntax highlighting** of code blocks.
- **Markdown applies to `assistant_text` and expanded reasoning only.** `user_text`, `notice`, `tool_call`, `tool_result` are unchanged.
- **Node 22.x required** (native `better-sqlite3`); `pnpm@10.33.2`.
- **UI has no unit-test runner.** UI tasks are gated by `pnpm --filter @kermanych/ui typecheck` (`vue-tsc --noEmit`) plus a visual smoke in `KitGalleryPage` / browser. Only `apps/api` has vitest.
- **Chat replies to the operator are Ukrainian;** code, identifiers, and commit messages are English.

---

### Task 1: Markdown renderer utility + dependency

**Files:**
- Modify: `kermanych/apps/ui/package.json` (add `markdown-it` dep + `@types/markdown-it` devDep)
- Create: `kermanych/apps/ui/src/lib/markdown.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `renderMarkdown(src: string): string` and `renderMarkdownInline(src: string): string` from `../../lib/markdown` — return a safe HTML string (raw HTML in source is escaped; output is a controlled tag set safe for `v-html`).

- [ ] **Step 1: Add the dependency**

Edit `kermanych/apps/ui/package.json`. Add to `dependencies` (keep alphabetical-ish grouping with existing entries):

```json
"markdown-it": "^14.1.0",
```

Add to `devDependencies`:

```json
"@types/markdown-it": "^14.1.2",
```

- [ ] **Step 2: Install**

Run (repo root `kermanych/`):

```bash
pnpm install
```

Expected: lockfile updates; `markdown-it` + `@types/markdown-it` resolve.

- [ ] **Step 3: Create the shared renderer**

Create `kermanych/apps/ui/src/lib/markdown.ts`:

```ts
import MarkdownIt from 'markdown-it';

// One shared renderer for assistant prose and expanded reasoning.
// html:false escapes any raw HTML in the source, so the rendered output is a
// controlled tag set and is safe to inject via v-html. linkify autolinks bare
// URLs; breaks:true keeps single newlines as line breaks (chat reads better).
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

export function renderMarkdown(src: string): string {
  return md.render(src ?? '');
}

export function renderMarkdownInline(src: string): string {
  return md.renderInline(src ?? '');
}
```

- [ ] **Step 4: Typecheck**

Run:

```bash
pnpm --filter @kermanych/ui typecheck
```

Expected: PASS (no errors introduced by the new module).

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/ui/package.json kermanych/pnpm-lock.yaml kermanych/apps/ui/src/lib/markdown.ts
git commit -m "feat(ui): add markdown-it renderer utility"
```

---

### Task 2: Render assistant text as Markdown

**Files:**
- Modify: `kermanych/apps/ui/src/components/kit/KLogBlock.vue` (template `assistant_text` branch `:34-41`; script `body` computed `:103-111`; styles `:114-246`)

**Interfaces:**
- Consumes: `renderMarkdown` (Task 1).
- Produces: `.k-log__markdown` prose CSS class (reused by Task 3).

- [ ] **Step 1: Import the renderer and add a computed**

In `<script setup>` of `KLogBlock.vue`, add the import after the existing imports (line 68–69 area):

```ts
import { renderMarkdown } from '../../lib/markdown';
```

Add a computed (near the other computeds, after `body`):

```ts
// assistant_text renders as Markdown (headings, lists, code, links). Output is a
// controlled tag set (html:false), safe for v-html.
const renderedText = computed(() =>
  props.entry.kind === 'assistant_text' ? renderMarkdown(props.entry.text) : '',
);
```

- [ ] **Step 2: Drop `assistant_text` from the line-splitter `body`**

Replace the `body` computed (currently lines 103–111) so it only serves tool output:

```ts
// Diff striping (green strip + accent tint) is reserved for real diff/tool
// output. Assistant prose is Markdown-rendered separately (see renderedText).
const body = computed<Line[]>(() => {
  if (props.entry.kind === 'tool_call' || props.entry.kind === 'tool_result') {
    return toLines(props.entry.summary, true).slice(1);
  }
  return [];
});
```

- [ ] **Step 3: Replace the `assistant_text` template branch**

Replace the `assistant_text` block (currently template lines 33–41):

```html
    <!-- assistant_text — Markdown-rendered prose, UI font -->
    <div
      v-else-if="entry.kind === 'assistant_text'"
      class="k-log__markdown"
      v-html="renderedText"
    />
```

- [ ] **Step 4: Add Markdown prose styles**

In the `<style scoped>` block, remove the now-unused `.k-log__text` and `.k-log__text + .k-log__text` rules (currently lines 172–184), and add:

```scss
// assistant prose — Markdown rendered, UI font, primary text. Code is mono on a
// surface fill (no syntax colors); links use the single accent; green stays for diffs.
.k-log__markdown {
  font-family: var(--k-font-ui);
  font-size: 14px;
  line-height: 1.65;
  color: var(--k-text);
  word-break: break-word;
}
.k-log__markdown > :first-child { margin-top: 0; }
.k-log__markdown > :last-child { margin-bottom: 0; }
.k-log__markdown p { margin: 0 0 8px; }
.k-log__markdown h1,
.k-log__markdown h2,
.k-log__markdown h3,
.k-log__markdown h4,
.k-log__markdown h5,
.k-log__markdown h6 { margin: 14px 0 6px; font-weight: 700; line-height: 1.3; }
.k-log__markdown h1 { font-size: 19px; }
.k-log__markdown h2 { font-size: 17px; }
.k-log__markdown h3 { font-size: 15px; }
.k-log__markdown h4,
.k-log__markdown h5,
.k-log__markdown h6 { font-size: 14px; }
.k-log__markdown ul,
.k-log__markdown ol { margin: 0 0 8px; padding-left: 20px; }
.k-log__markdown li { margin: 2px 0; }
.k-log__markdown li > ul,
.k-log__markdown li > ol { margin: 2px 0; }
.k-log__markdown a { color: var(--k-accent); text-decoration: underline; }
.k-log__markdown strong { font-weight: 700; }
.k-log__markdown blockquote {
  margin: 8px 0;
  padding: 2px 12px;
  color: var(--k-muted);
  border-left: 2px solid var(--k-line-strong);
}
.k-log__markdown code {
  font-family: var(--k-font-mono);
  font-size: 12.5px;
  background: var(--k-surface2);
  padding: 1px 5px;
}
.k-log__markdown pre {
  margin: 8px 0;
  padding: 10px 12px;
  background: var(--k-surface2);
  overflow-x: auto;
}
.k-log__markdown pre code { background: none; padding: 0; line-height: 1.5; }
.k-log__markdown hr { border: none; border-top: 1px solid var(--k-line); margin: 12px 0; }
.k-log__markdown table { border-collapse: collapse; margin: 8px 0; font-size: 13px; }
.k-log__markdown th,
.k-log__markdown td { border: 1px solid var(--k-line-strong); padding: 4px 8px; text-align: left; }
.k-log__markdown th { background: var(--k-surface2); font-weight: 700; }
.k-log__markdown img { max-width: 100%; }
```

- [ ] **Step 5: Visual smoke sample**

In `kermanych/apps/ui/src/pages/KitGalleryPage.vue`, replace the plain `assistant_text` sample inside `logSamples` (currently line 214) with a Markdown-rich one so the gallery exercises the renderer:

```ts
  { kind: 'assistant_text', text: '## Знайшов два місця\n\nСесія зберігається у **двох** місцях — треба звести:\n\n- `session.ts` — запис у файл\n- `store.ts` — дубль у памʼяті\n\n```ts\nconst s = load();\n```' },
```

- [ ] **Step 6: Typecheck + browser smoke**

Run:

```bash
pnpm --filter @kermanych/ui typecheck
```

Expected: PASS.

Then `pnpm dev:ui`, open the Kit gallery route, and confirm the assistant sample renders a heading, bold, a bullet list, and a mono code block on a surface fill (no syntax colors, links in accent).

- [ ] **Step 7: Commit**

```bash
git add kermanych/apps/ui/src/components/kit/KLogBlock.vue kermanych/apps/ui/src/pages/KitGalleryPage.vue
git commit -m "feat(ui): render assistant text as markdown"
```

---

### Task 3: Collapsible "Думаю" reasoning block

**Files:**
- Modify: `kermanych/apps/ui/src/components/kit/KLogBlock.vue` (template `assistant_thinking` branch `:57-60`; script imports; styles)

**Interfaces:**
- Consumes: `renderMarkdown` (Task 1), `.k-log__markdown` (Task 2).
- Produces: a collapsed disclosure for `assistant_thinking` entries; default collapsed.

- [ ] **Step 1: Add `ref` + expanded state + rendered computed**

Update the Vue import to include `ref` (currently `import { computed } from 'vue';`):

```ts
import { computed, ref } from 'vue';
```

Add near the other component state:

```ts
// Reasoning is collapsed by default; expand to read the full chain.
const open = ref(false);
const renderedThinking = computed(() =>
  props.entry.kind === 'assistant_thinking' ? renderMarkdown(props.entry.text) : '',
);
```

- [ ] **Step 2: Replace the `assistant_thinking` template branch**

Replace the block (currently template lines 57–60):

```html
    <!-- assistant_thinking — collapsed reasoning; expand to read the full chain -->
    <div v-else-if="entry.kind === 'assistant_thinking'" class="k-log__reason">
      <button
        type="button"
        class="k-log__reason-toggle"
        :aria-expanded="open"
        @click="open = !open"
      >
        <span class="k-log__reason-caret" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
        Думаю
      </button>
      <div v-if="open" class="k-log__reason-body k-log__markdown" v-html="renderedThinking" />
    </div>
```

- [ ] **Step 3: Replace `.k-log__thinking` styles with disclosure styles**

In `<style scoped>`, remove the `.k-log__thinking` rule (currently lines 186–193) and add:

```scss
// assistant reasoning — a muted, collapsed disclosure ("Думаю"); expanded body
// reuses the Markdown prose styles, dimmed.
.k-log__reason { font-family: var(--k-font-ui); }
.k-log__reason-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  background: transparent;
  border: none;
  font-family: var(--k-font-ui);
  font-size: 13px;
  font-style: italic;
  color: var(--k-muted);
  cursor: pointer;
}
.k-log__reason-toggle:hover { color: var(--k-text); }
.k-log__reason-toggle:focus-visible { outline: 1px solid var(--k-accent); outline-offset: 2px; }
.k-log__reason-caret { font-size: 10px; font-style: normal; }
.k-log__reason-body {
  margin-top: 6px;
  padding-left: 14px;
  border-left: 1px solid var(--k-line);
  color: var(--k-muted);
}
```

- [ ] **Step 4: Typecheck + browser smoke**

Run:

```bash
pnpm --filter @kermanych/ui typecheck
```

Expected: PASS.

Then in the Kit gallery (the `logSamples` block already contains an `assistant_thinking` entry), confirm it renders a muted `▸ Думаю` toggle, collapsed by default, and expands to show the reasoning text (Markdown, dimmed) with the caret flipping to `▾`.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/ui/src/components/kit/KLogBlock.vue
git commit -m "feat(ui): collapsible reasoning disclosure"
```

---

### Task 4: Backend — surface reasoning (resume + live)

**Files:**
- Create: `kermanych/apps/api/src/supervisor/messages-to-transcript.ts`
- Create (test): `kermanych/apps/api/test/messages-to-transcript.spec.ts`
- Modify: `kermanych/apps/api/src/supervisor/supervisor.service.ts` (remove inline `OmpPart`/`OmpMessage` `:34-43` and the private `messagesToTranscript` `:346-368`; `Live` type `:24-31`; `wireLive` `:290`; `onRpcEvent` `:145-152`; caller `:326`)

**Interfaces:**
- Consumes: `TranscriptEntry` from `@kermanych/core`.
- Produces: `messagesToTranscript(messages: unknown[]): TranscriptEntry[]` and exported `OmpMessage` / `OmpPart` from `./messages-to-transcript`. Emits `{ kind: "assistant_thinking", text }` on both the live path (`thinking_delta` → flushed at `message_end`, before `assistant_text`) and the resume path (`{ type: "thinking", thinking }` history part).

- [ ] **Step 1: Write the failing test**

Create `kermanych/apps/api/test/messages-to-transcript.spec.ts`:

```ts
import { expect, test } from "vitest";
import { messagesToTranscript } from "../src/supervisor/messages-to-transcript";

test("maps assistant reasoning before text, preserving in-message order", () => {
  const out = messagesToTranscript([
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "weigh options" },
        { type: "text", text: "Here is the answer." },
      ],
    },
  ]);
  expect(out).toEqual([
    { kind: "assistant_thinking", text: "weigh options" },
    { kind: "assistant_text", text: "Here is the answer." },
  ]);
});

test("skips empty/whitespace reasoning parts", () => {
  const out = messagesToTranscript([
    { role: "assistant", content: [{ type: "thinking", thinking: "  " }, { type: "text", text: "x" }] },
  ]);
  expect(out).toEqual([{ kind: "assistant_text", text: "x" }]);
});

test("maps user text, tool calls, and tool results", () => {
  const out = messagesToTranscript([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "toolCall", name: "Read", arguments: { path: "a.ts" } }] },
    { role: "toolResult", toolName: "Read", isError: false, content: [{ type: "text", text: "ok" }] },
  ]);
  expect(out).toEqual([
    { kind: "user_text", text: "hi", images: undefined },
    { kind: "tool_call", tool: "Read", summary: "a.ts" },
    { kind: "tool_result", tool: "Read", ok: true, summary: "ok" },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @kermanych/api test -- messages-to-transcript
```

Expected: FAIL — cannot resolve `../src/supervisor/messages-to-transcript`.

- [ ] **Step 3: Create the extracted module**

Create `kermanych/apps/api/src/supervisor/messages-to-transcript.ts`:

```ts
import type { TranscriptEntry } from "@kermanych/core";

// Shape of omp's converted history messages (get_messages / get_messages_page) we map from.
export type OmpPart = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: { command?: string; path?: string };
  intent?: string;
  data?: string;
  mimeType?: string;
};
export type OmpMessage = { role?: string; content?: OmpPart[]; toolName?: string; isError?: boolean };

// Map omp's converted message history into transcript entries, mirroring the live
// event reduction: user text/images, assistant reasoning then text, tool calls, and
// tool results. Reasoning parts ({ type:"thinking" }) map to assistant_thinking and
// render as a collapsed block in the UI.
export function messagesToTranscript(messages: unknown[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const raw of messages) {
    const m = raw as OmpMessage;
    const parts = m.content ?? [];
    if (m.role === "user") {
      const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
      const images = parts
        .filter((p) => p.type === "image" && p.data)
        .map((p) => `data:${p.mimeType ?? "image/png"};base64,${p.data}`);
      if (text.trim() || images.length) out.push({ kind: "user_text", text, images: images.length ? images : undefined });
    } else if (m.role === "assistant") {
      for (const p of parts) {
        if (p.type === "thinking" && p.thinking?.trim()) out.push({ kind: "assistant_thinking", text: p.thinking });
        else if (p.type === "text" && p.text?.trim()) out.push({ kind: "assistant_text", text: p.text });
        else if (p.type === "toolCall") out.push({ kind: "tool_call", tool: p.name ?? "?", summary: p.arguments?.command ?? p.arguments?.path ?? p.intent });
      }
    } else if (m.role === "toolResult") {
      const summary = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
      out.push({ kind: "tool_result", tool: m.toolName ?? "?", ok: !m.isError, summary });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @kermanych/api test -- messages-to-transcript
```

Expected: PASS (3 tests).

- [ ] **Step 5: Wire the extracted module into the supervisor**

In `kermanych/apps/api/src/supervisor/supervisor.service.ts`:

1. Delete the inline `OmpPart` and `OmpMessage` type declarations (currently lines 34–43).
2. Delete the private `messagesToTranscript` method and its leading comment (currently lines 343–368).
3. Add an import near the top imports (after the `RpcSession` import, line 6):

```ts
import { messagesToTranscript } from "./messages-to-transcript";
```

4. Update the sole caller (currently line 326) from `this.messagesToTranscript(...)` to:

```ts
        live.transcript = messagesToTranscript(await rpc.getAllMessages());
```

- [ ] **Step 6: Add the live reasoning buffer**

In the same file:

1. Extend the `Live` type (currently lines 24–31) — add `thinkBuf`:

```ts
type Live = {
  rpc: RpcSession;
  state: StatusState;
  transcript: TranscriptEntry[];
  live: Partial<Session>;
  textBuf: string;
  thinkBuf: string;
  poll?: NodeJS.Timeout;
};
```

2. Initialize it in `wireLive` (currently line 290):

```ts
    const live: Live = { rpc, state: INITIAL_STATUS, transcript: [], live: { status }, textBuf: "", thinkBuf: "" };
```

3. Buffer `thinking_delta` and flush it in `onRpcEvent` (currently lines 145–152):

```ts
    if (e.type === "message_update") {
      const ame = (e as Extract<RpcEvent, { type: "message_update" }>).assistantMessageEvent;
      if (ame?.type === "text_delta") l.textBuf += ame.delta ?? "";
      else if (ame?.type === "thinking_delta") l.thinkBuf += ame.delta ?? "";
    }
    if (e.type === "message_end") {
      if (l.thinkBuf.trim()) this.appendEntry(id, { kind: "assistant_thinking", text: l.thinkBuf });
      if (l.textBuf.trim()) this.appendEntry(id, { kind: "assistant_text", text: l.textBuf });
      l.textBuf = "";
      l.thinkBuf = "";
    }
```

- [ ] **Step 7: Run the full api suite + typecheck**

Run:

```bash
pnpm --filter @kermanych/api test
pnpm --filter @kermanych/api exec tsc --noEmit -p tsconfig.json
```

Expected: all existing specs + the new spec PASS; no type errors (supervisor no longer references the removed inline types).

- [ ] **Step 8: Commit**

```bash
git add kermanych/apps/api/src/supervisor/messages-to-transcript.ts kermanych/apps/api/test/messages-to-transcript.spec.ts kermanych/apps/api/src/supervisor/supervisor.service.ts
git commit -m "feat(api): surface model reasoning on live + resume paths"
```

---

### Task 5: KPanel live "Думаю…" placeholder

**Files:**
- Modify: `kermanych/apps/ui/src/components/kit/KPanel.vue` (template log region — insert before the log's closing `</div>` at `:102`; styles)

**Interfaces:**
- Consumes: `session.status` (already a prop).
- Produces: a transient status-driven placeholder row; no persistent transcript entry.

- [ ] **Step 1: Add the placeholder row**

In `KPanel.vue`, inside `.k-panel__log`, immediately after the error banner block and before the log's closing `</div>` (currently line 101 → insert before line 102):

```html
      <!-- live reasoning placeholder — a tidy "Думаю…" while the agent thinks -->
      <div v-if="session.status === 'thinking'" class="k-panel__thinking" aria-live="polite">Думаю…</div>
```

- [ ] **Step 2: Add styles**

In `KPanel.vue` `<style scoped>`, after the `.k-panel__log` rule (currently lines 378–382), add:

```scss
// live reasoning placeholder — muted, gently pulsing; replaced by the collapsed
// reasoning block + answer at message_end.
.k-panel__thinking {
  margin-top: 14px;
  font-family: var(--k-font-ui);
  font-size: 13px;
  font-style: italic;
  color: var(--k-muted);
  animation: k-panel-think-pulse 1.4s ease-in-out infinite;
}
@keyframes k-panel-think-pulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}
```

- [ ] **Step 3: Typecheck + browser smoke**

Run:

```bash
pnpm --filter @kermanych/ui typecheck
```

Expected: PASS.

Browser smoke: with a running session (status `thinking`), the log shows a pulsing `Думаю…` at the bottom that disappears once the message lands (replaced by the collapsed reasoning block + answer). For an offline check, temporarily render a `KPanel` with a `session` whose `status: 'thinking'` in `KitGalleryPage` and confirm the row appears.

- [ ] **Step 4: Commit**

```bash
git add kermanych/apps/ui/src/components/kit/KPanel.vue
git commit -m "feat(ui): live 'Думаю…' thinking placeholder"
```

---

### Task 6: KPanel — navigate the operator's own messages

**Files:**
- Modify: `kermanych/apps/ui/src/components/kit/KPanel.vue` (root `<section>` `:2`; insert stepper after header `:34`; script; styles)
- Modify: `kermanych/apps/ui/src/css/app.scss` (global flash keyframe)

**Interfaces:**
- Consumes: `.k-log--user_text` DOM class (already emitted by `KLogBlock` from `entry.kind`); `logEl` (already in `KPanel`).
- Produces: a floating ▲/▼ stepper with an `N/M` counter and `Alt+↑ / Alt+↓` shortcuts; briefly flashes the target message via the global `.k-log--flash` class.

- [ ] **Step 1: Add the global flash style**

Append to `kermanych/apps/ui/src/css/app.scss`:

```scss
// Brief highlight when jumping to a message (my-message navigation). Global
// because the target element belongs to the KLogBlock child; a left accent strip
// + fading accent tint, then gone.
.k-log--flash {
  animation: k-log-flash 1.1s ease-out;
}
@keyframes k-log-flash {
  0% { background: color-mix(in srgb, var(--k-accent) 18%, transparent); box-shadow: inset 2px 0 0 0 var(--k-accent); }
  100% { background: transparent; box-shadow: inset 2px 0 0 0 transparent; }
}
```

- [ ] **Step 2: Add the root ref + stepper markup**

In `KPanel.vue`, add `ref="rootEl"` to the root section (currently line 2):

```html
  <section ref="rootEl" class="k-panel" :class="{ 'k-panel--active': isActive }">
```

Insert the stepper as a direct child of `.k-panel`, between the header's closing `</header>` (line 34) and the `<!-- floor 2 -->` comment (line 36):

```html
    <!-- my-message navigation — jump between the operator's own messages -->
    <div v-if="userMsgCount > 1" class="k-panel__nav" role="group" aria-label="Навігація по моїх повідомленнях">
      <button type="button" class="k-panel__nav-btn" title="Попереднє моє повідомлення (Alt+↑)" @click="jumpUser(-1)">▲</button>
      <span class="k-panel__nav-count mono">{{ userNavLabel }}</span>
      <button type="button" class="k-panel__nav-btn" title="Наступне моє повідомлення (Alt+↓)" @click="jumpUser(1)">▼</button>
    </div>
```

- [ ] **Step 3: Add the navigation script**

In `<script setup>` of `KPanel.vue`, add state + logic (near the log/scroll section, after `onLogScroll`). Reuse the existing `logEl` ref and `stick` flag:

```ts
// My-message navigation: step between the operator's own (.k-log--user_text)
// blocks. Count is kept in sync with the log via the existing MutationObserver.
const rootEl = ref<HTMLElement | null>(null);
const userMsgCount = ref(0);
const userIndex = ref(-1); // last message we jumped to; -1 = derive from scroll

function userEls(): HTMLElement[] {
  const el = logEl.value;
  return el ? Array.from(el.querySelectorAll<HTMLElement>('.k-log--user_text')) : [];
}
function refreshUserCount(): void {
  userMsgCount.value = userEls().length;
}
const userNavLabel = computed(() =>
  userIndex.value >= 0 ? `${userIndex.value + 1}/${userMsgCount.value}` : `–/${userMsgCount.value}`,
);
// Index of the last user message whose top is at/above the log viewport top.
function currentUserIdx(els: HTMLElement[]): number {
  const log = logEl.value;
  if (!log) return 0;
  const logTop = log.getBoundingClientRect().top;
  let idx = 0;
  for (let i = 0; i < els.length; i++) {
    if (els[i].getBoundingClientRect().top - logTop <= 4) idx = i;
    else break;
  }
  return idx;
}
function jumpUser(dir: 1 | -1): void {
  const els = userEls();
  if (!els.length) return;
  const base = userIndex.value >= 0 && userIndex.value < els.length ? userIndex.value : currentUserIdx(els);
  const idx = Math.min(els.length - 1, Math.max(0, base + dir));
  userIndex.value = idx;
  const target = els[idx];
  stick = false; // stop auto-follow while the operator browses history
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.classList.remove('k-log--flash');
  void target.offsetWidth; // reflow so the animation restarts on re-jump
  target.classList.add('k-log--flash');
}
function onNavKeydown(e: KeyboardEvent): void {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  if (!rootEl.value?.contains(e.target as Node)) return; // only when this panel is focused
  e.preventDefault();
  jumpUser(e.key === 'ArrowUp' ? -1 : 1);
}
```

- [ ] **Step 4: Hook count refresh + keybindings into existing lifecycle**

Extend the existing `onMounted` (currently lines 211–219) so the MutationObserver also refreshes the count and the keydown listener is registered:

```ts
onMounted(() => {
  const el = logEl.value;
  if (!el) return;
  scrollToBottom();
  refreshUserCount();
  logObserver = new MutationObserver(() => {
    refreshUserCount();
    if (stick) requestAnimationFrame(scrollToBottom);
  });
  logObserver.observe(el, { childList: true, subtree: true });
  window.addEventListener('keydown', onNavKeydown);
});
```

Extend the existing `onBeforeUnmount` (currently line 220):

```ts
onBeforeUnmount(() => {
  logObserver?.disconnect();
  window.removeEventListener('keydown', onNavKeydown);
});
```

Reset the pointer on session switch — extend the existing `watch(() => props.session.id, ...)` (currently lines 222–228):

```ts
watch(
  () => props.session.id,
  () => {
    stick = true;
    userIndex.value = -1;
    void nextTick(() => {
      scrollToBottom();
      refreshUserCount();
    });
  },
);
```

- [ ] **Step 5: Add stepper styles**

In `KPanel.vue` `<style scoped>`, make the panel a positioning context and add the stepper. Update the `.k-panel` rule (currently lines 288–294) to add `position: relative;`:

```scss
.k-panel {
  display: flex;
  flex-direction: column;
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  min-height: 320px;
  position: relative;
}
```

Then add:

```scss
// my-message nav — floating stepper pinned to the log's top-right, over the log
// (outside the scroll container so it stays put while the log scrolls).
.k-panel__nav {
  position: absolute;
  top: 42px; // header (34px) + 8px
  right: 14px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 3px;
  background: color-mix(in srgb, var(--k-surface2) 88%, transparent);
  border: 1px solid var(--k-line-strong);
}
.k-panel__nav-btn {
  width: 22px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--k-muted);
  font-size: 11px;
  cursor: pointer;
  transition: color 0.12s;
}
.k-panel__nav-btn:hover { color: var(--k-text); }
.k-panel__nav-btn:focus-visible { outline: 1px solid var(--k-accent); outline-offset: -1px; }
.k-panel__nav-count {
  font-size: 10px;
  color: var(--k-muted);
  user-select: none;
}
```

- [ ] **Step 6: Typecheck + browser smoke**

Run:

```bash
pnpm --filter @kermanych/ui typecheck
```

Expected: PASS.

Browser smoke: in a session with ≥2 of your own messages, the stepper appears top-right of the log; ▲/▼ (and `Alt+↑`/`Alt+↓` while focused in the panel) scroll to the previous/next of your messages, the counter tracks `N/M`, and the target flashes briefly. With <2 of your messages the stepper is hidden.

- [ ] **Step 7: Commit**

```bash
git add kermanych/apps/ui/src/components/kit/KPanel.vue kermanych/apps/ui/src/css/app.scss
git commit -m "feat(ui): navigate operator messages with a stepper + Alt+arrows"
```

---

## Self-Review

**1. Spec coverage:**
- §4.1 Markdown rendering → Task 1 (util) + Task 2 (assistant_text + prose styles). ✓
- §4.1 no syntax highlighting / user_text & notice & tool_* unchanged → Task 2 scope + Global Constraints. ✓
- §4.2 backend live `thinking_delta` + resume `{type:"thinking"}` + `OmpPart.thinking` + remove "omitted" comment → Task 4. ✓
- §4.2 collapsed disclosure, default collapsed, Markdown expanded body → Task 3. ✓
- §4.2 live "Думаю…" placeholder → Task 5. ✓
- §4.3 floating ▲/▼ stepper + counter + smooth scroll + highlight + `Alt+↑/↓`, hidden < 2 msgs, local to KPanel via `.k-log--user_text` → Task 6. ✓
- §6 verification: `messagesToTranscript` unit test → Task 4 Step 1; smoke steps in Tasks 2/3/5/6. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N"; every code step has concrete content. ✓

**3. Type consistency:**
- `renderMarkdown(src: string): string` — defined Task 1, consumed Tasks 2 & 3. ✓
- `.k-log__markdown` — produced Task 2, reused Task 3. ✓
- `messagesToTranscript(messages: unknown[]): TranscriptEntry[]` — produced Task 4, name matches the replaced caller. ✓
- `TranscriptEntry.assistant_thinking` uses field `text` (existing core type); backend maps history field `thinking` → entry `text`; UI reads `entry.text`. Consistent across Tasks 3 & 4. ✓
- `Live.thinkBuf: string` — declared, initialized in `wireLive`, used in `onRpcEvent`. ✓
- `.k-log--flash` — global (Task 6 app.scss), applied to the KLogBlock child element by KPanel. ✓
