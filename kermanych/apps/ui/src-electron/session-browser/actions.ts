// The agent's tools on one session view (docs/specs/2026-10-05-embedded-browser.md): input
// through CDP on the view's debugger (real trusted events, so frameworks react as to a user),
// lookups and the outline through the injected scripts in scripts.ts. browsers.ts resolves the
// view, checks the operator's pause and records usage, then calls these.
//
// Coordinates: the scripts answer in the top viewport's CSS pixels; CDP input goes to the view
// as drawn, so every point is multiplied by `v.scale` (< 1 while the page is laid out wider
// than the pane and drawn scaled down). Screenshots clip in CSS pixels and ask for scale
// 1/devicePixelRatio, so the agent gets one image pixel per CSS pixel whatever the emulation.
//
// Dialogs: while alert/confirm is open the page's main thread is blocked, so it answers no CDP
// command, and the command that opened it (the click's mouse release, a key press, the select's
// dispatch) stays pending until the dialog is answered (Electron 43 probe). So every input
// action runs inside settle, which returns as soon as a dialog opens and reports it in the
// result; browser_dialog answers through `v.dialogReply` (browsers.ts owns the dialog).
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BrowserActionResult, BrowserConsoleEntry, BrowserNetworkEntry, BrowserPageInfo } from '@kermanych/api';
import { cdp, exceptionMessage, run, type CdpException, type CdpRemoteObject } from './cdp';
import { parseKey, type KeySpec } from './keys';
import {
  ANIMATION_FRAMES_SCRIPT,
  clickPointScript,
  elementBoxScript,
  fileInputScript,
  focusFieldScript,
  PAGE_HINT_SCRIPT,
  selectScript,
  SNAPSHOT_SCRIPT,
  TEXT_LIMIT,
  waitScript,
} from './scripts';
import { assertNoDialog, SETTLE_MS, type SessionView } from './view';

// After an input, how long the page gets to paint twice before settle looks for a navigation
// (a hidden window may not paint at all).
const FRAMES_MS = 500;
// browser_wait's poll interval.
const POLL_MS = 150;
// Margin around an element screenshot, CSS pixels.
const SHOT_PAD = 8;
// Chromium's capture breaks down on very tall surfaces; a full-page screenshot stops there
// (an image cannot say it was cut, so the cut is silent; the agent can scroll and take more).
const SHOT_MAX_HEIGHT = 16_384;

export function pageInfo(v: SessionView): BrowserPageInfo {
  return { url: v.wc.getURL(), title: v.wc.getTitle() };
}

// The page after an action that started at `since` (epoch ms): plus the dialog it is blocked
// on and the popup window the action opened, which the agent cannot drive.
function actionResult(v: SessionView, since: number): BrowserActionResult {
  return {
    ...pageInfo(v),
    ...(v.dialog ? { dialog: v.dialog } : {}),
    ...(v.popup && v.popup.at >= since ? { popup: v.popup.url } : {}),
  };
}

// Resolves when the page opens a JavaScript dialog (at once when one is open already), for
// racing anything that would otherwise wait on a page that answers nothing until the dialog
// is. browsers.ts calls the waiters from its '-run-dialog' handler, after setting v.dialog.
function dialogOpened(v: SessionView): { promise: Promise<void>; dispose: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  const waiter = () => resolve();
  v.dialogWaiters.add(waiter);
  if (v.dialog) resolve();
  return { promise, dispose: () => v.dialogWaiters.delete(waiter) };
}

export async function load(v: SessionView, url: string): Promise<void> {
  v.status = undefined;
  const loading = v.wc.loadURL(url).then(
    () => undefined,
    (err: Error & { code?: string }) => (err.code === 'ERR_ABORTED' ? undefined : err),
  );
  // An alert in the page's load handlers holds the load open until it is answered.
  const dialog = dialogOpened(v);
  try {
    const failure = await Promise.race([loading, sleep(SETTLE_MS).then(() => undefined), dialog.promise.then(() => undefined)]);
    if (failure) throw new Error(`Could not load ${url}: ${failure.code ?? failure.message}`);
  } finally {
    dialog.dispose();
  }
}

export async function snapshot(v: SessionView): Promise<BrowserPageInfo & { text: string }> {
  assertNoDialog(v);
  const out = await run<{ text: string }>(v, SNAPSHOT_SCRIPT);
  return { ...pageInfo(v), text: out.text || '(the page shows no text and no interactive elements)' };
}

export async function click(v: SessionView, ref: string): Promise<BrowserActionResult> {
  assertNoDialog(v);
  const since = Date.now();
  // Throws when the element is hidden or another element covers every point tried.
  const first = await run<{ x: number; y: number }>(v, clickPointScript(ref));
  await settle(v, async () => {
    await cdp(v, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x * v.scale, y: first.y * v.scale });
    // Moving the pointer changes what is hovered: a hover menu the pointer just left closes
    // and the layout under the point shifts. Hit-test again where things are now, so the
    // press lands on the element and not on whatever moved into its place.
    const at = await run<{ x: number; y: number }>(v, clickPointScript(ref));
    const x = at.x * v.scale, y = at.y * v.scale;
    if (at.x !== first.x || at.y !== first.y) await cdp(v, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp(v, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp(v, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  });
  return actionResult(v, since);
}

export async function type(v: SessionView, ref: string, text: string, opts: { clear: boolean; submit: boolean }): Promise<BrowserActionResult> {
  assertNoDialog(v);
  const since = Date.now();
  const focused = await run<string>(v, focusFieldScript(ref, opts.clear));
  if (focused !== 'ok') {
    throw new Error(`"${ref}" is a <${focused.slice('not-editable:'.length)}>, not a text field; use browser_click for buttons and checkboxes, browser_select for selects`);
  }
  await settle(v, async () => {
    // insertText replaces the selection the focus script made when clearing.
    if (text) await cdp(v, 'Input.insertText', { text });
    else if (opts.clear) await key(v, parseKey('Backspace'));
    if (opts.submit) await key(v, parseKey('Enter'));
  });
  return actionResult(v, since);
}

export async function press(v: SessionView, combo: string): Promise<BrowserActionResult> {
  assertNoDialog(v);
  const since = Date.now();
  const spec = parseKey(combo);
  await settle(v, () => key(v, spec));
  return actionResult(v, since);
}

// The pointer comes to rest over the element (hit-tested like a click), so :hover styles,
// mouseenter menus and tooltips show up in the next snapshot.
export async function hover(v: SessionView, ref: string): Promise<BrowserActionResult> {
  assertNoDialog(v);
  const since = Date.now();
  const at = await run<{ x: number; y: number }>(v, clickPointScript(ref));
  await settle(v, async () => {
    await cdp(v, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x * v.scale, y: at.y * v.scale });
  });
  return actionResult(v, since);
}

export async function select(v: SessionView, ref: string, values: string[]): Promise<BrowserActionResult & { selected: string[] }> {
  assertNoDialog(v);
  const since = Date.now();
  // A change handler that opens a dialog blocks the script after the options were set; the
  // values then stand for the labels the script could not return.
  let selected = values;
  await settle(v, async () => {
    selected = await run<string[]>(v, selectScript(ref, values));
  });
  return { ...actionResult(v, since), selected };
}

export async function history(v: SessionView, action: 'back' | 'forward' | 'reload'): Promise<BrowserActionResult> {
  assertNoDialog(v);
  const nav = v.wc.navigationHistory;
  if (action === 'back' && !nav.canGoBack()) throw new Error('Nothing to go back to');
  if (action === 'forward' && !nav.canGoForward()) throw new Error('Nothing to go forward to');
  const since = Date.now();
  // A load focuses the view (Electron 43): the operator's typing in the app must not follow.
  v.suppressFocusUntil = since + SETTLE_MS;
  await settle(v, async () => {
    if (action === 'back') nav.goBack();
    else if (action === 'forward') nav.goForward();
    else v.wc.reload();
  });
  return actionResult(v, since);
}

export async function waitFor(
  v: SessionView,
  opts: { text?: string; selector?: string; gone: boolean; timeoutMs: number },
): Promise<BrowserPageInfo & { waitedMs: number }> {
  assertNoDialog(v);
  if (opts.text === undefined && opts.selector === undefined) throw new Error('Pass the text or the selector to wait for');
  const start = Date.now();
  const deadline = start + opts.timeoutMs;
  const script = waitScript(opts);
  const dialog = dialogOpened(v);
  try {
    for (;;) {
      // A poll during a navigation fails (the context is gone): that is a miss, not an error.
      const state = await Promise.race([
        run<{ present?: boolean; invalid?: true }>(v, script).catch(() => undefined),
        dialog.promise.then(() => undefined),
        sleep(Math.max(deadline - Date.now(), POLL_MS)).then(() => undefined),
      ]);
      assertNoDialog(v);
      if (state?.invalid) throw new Error(`"${opts.selector}" is not a valid CSS selector`);
      if (state && state.present !== opts.gone) return { ...pageInfo(v), waitedMs: Date.now() - start };
      if (Date.now() >= deadline) break;
      await Promise.race([sleep(POLL_MS), dialog.promise]);
      assertNoDialog(v);
    }
    const what =
      (opts.selector !== undefined ? `${opts.selector}${opts.text !== undefined ? ` holding "${opts.text}"` : ''}` : `"${opts.text}"`) +
      (opts.gone ? ' to go away' : ' to appear');
    const hint = await Promise.race([run<{ title: string; text: string }>(v, PAGE_HINT_SCRIPT).catch(() => undefined), sleep(1_000).then(() => undefined)]);
    const shows = hint ? ` — the page shows «${hint.title}»: ${hint.text || '(no text)'}` : '';
    throw new Error(`Timed out after ${Math.round(opts.timeoutMs / 100) / 10}s waiting for ${what}${shows}`);
  } finally {
    dialog.dispose();
  }
}

interface LayoutMetrics {
  cssLayoutViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  cssContentSize: { x: number; y: number; width: number; height: number };
}

export async function screenshot(v: SessionView, opts: { fullPage: boolean; ref?: string }): Promise<{ data: string; mimeType: 'image/png' }> {
  assertNoDialog(v);
  let clip: { x: number; y: number; width: number; height: number; scale: number };
  // Capturing past the viewport makes Chromium lay the page out at the captured size for the
  // shot (100vh blocks grow), so only the shots that need it ask for it.
  let beyond: boolean;
  if (opts.ref) {
    const b = await run<{ left: number; top: number; right: number; bottom: number; scrollX: number; scrollY: number; innerWidth: number; innerHeight: number; dpr: number }>(
      v,
      elementBoxScript(opts.ref),
    );
    // Page coordinates (the clip's space): viewport box plus scroll, clamped at the page origin.
    const x = Math.max(0, b.left + b.scrollX - SHOT_PAD), y = Math.max(0, b.top + b.scrollY - SHOT_PAD);
    const width = b.right + b.scrollX + SHOT_PAD - x, height = Math.min(b.bottom + b.scrollY + SHOT_PAD - y, SHOT_MAX_HEIGHT);
    beyond = x < b.scrollX || y < b.scrollY || x + width > b.scrollX + b.innerWidth || y + height > b.scrollY + b.innerHeight;
    clip = { x, y, width, height, scale: 1 / b.dpr };
  } else {
    const [metrics, dpr] = await Promise.all([cdp<LayoutMetrics>(v, 'Page.getLayoutMetrics'), run<number>(v, 'devicePixelRatio')]);
    if (opts.fullPage) {
      const c = metrics.cssContentSize;
      clip = { x: c.x, y: c.y, width: c.width, height: Math.min(c.height, SHOT_MAX_HEIGHT), scale: 1 / dpr };
      beyond = true;
    } else {
      const l = metrics.cssLayoutViewport;
      clip = { x: l.pageX, y: l.pageY, width: l.clientWidth, height: l.clientHeight, scale: 1 / dpr };
      beyond = false;
    }
  }
  const { data } = await cdp<{ data: string }>(v, 'Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: beyond });
  return { data, mimeType: 'image/png' };
}

// Sets the files of an <input type=file> as a file chooser would; Chromium fires the input's
// `input` and `change` itself.
export async function upload(v: SessionView, ref: string, paths: string[]): Promise<BrowserActionResult> {
  assertNoDialog(v);
  if (!paths.length) throw new Error('Pass the absolute paths of the files to upload');
  const relative = paths.filter((p) => !path.isAbsolute(p));
  if (relative.length) throw new Error(`Upload paths must be absolute: ${relative.join(', ')}`);
  const problems = await Promise.all(
    paths.map((p) => stat(p).then((s) => (s.isFile() ? undefined : `${p} (not a file)`), () => `${p} (no such file)`)),
  );
  const bad = problems.filter((p) => p !== undefined);
  if (bad.length) throw new Error(`Cannot upload ${bad.join(', ')}`);
  const since = Date.now();
  const res = await cdp<{ result: CdpRemoteObject; exceptionDetails?: CdpException }>(v, 'Runtime.evaluate', {
    expression: fileInputScript(ref, paths.length),
    returnByValue: false,
    objectGroup: 'kermanych-upload',
  });
  try {
    if (res.exceptionDetails) throw new Error(exceptionMessage(res.exceptionDetails));
    await settle(v, async () => {
      await cdp(v, 'DOM.setFileInputFiles', { files: paths, objectId: res.result.objectId });
    });
  } finally {
    void cdp(v, 'Runtime.releaseObjectGroup', { objectGroup: 'kermanych-upload' }).catch(() => {});
  }
  return actionResult(v, since);
}

export async function answerDialog(v: SessionView, opts: { accept: boolean }): Promise<BrowserActionResult> {
  const d = v.dialog;
  const reply = v.dialogReply;
  if (!d || !reply) throw new Error('No JavaScript dialog is open');
  const since = Date.now();
  reply(opts.accept);
  // The reply clears v.dialog at once; a page that opens the next dialog right away replaces
  // it instead, and the result reports that one. The action that opened the dialog resumes now
  // (a confirmed delete navigates, …).
  if (!v.dialog) await settle(v, async () => {});
  return actionResult(v, since);
}

export function consoleEntries(v: SessionView, opts: { clear: boolean }): BrowserConsoleEntry[] {
  const entries = [...v.log];
  if (opts.clear) v.log.length = 0;
  return entries;
}

export function networkEntries(v: SessionView, opts: { clear: boolean; filter?: string }): BrowserNetworkEntry[] {
  const entries = opts.filter ? v.network.filter((e) => e.url.includes(opts.filter!)) : [...v.network];
  if (opts.clear) v.network.length = 0;
  return entries;
}

export async function evaluate(v: SessionView, expression: string): Promise<string> {
  assertNoDialog(v);
  const res = await cdp<{ result: CdpRemoteObject; exceptionDetails?: CdpException }>(v, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: false,
    userGesture: true,
    replMode: true, // top-level await and re-declarable let/const, as in the DevTools console
    objectGroup: 'kermanych-evaluate',
  });
  try {
    if (res.exceptionDetails) throw new Error(exceptionMessage(res.exceptionDetails));
    const json = await serialize(v, res.result);
    return json.length > TEXT_LIMIT ? `${json.slice(0, TEXT_LIMIT)}… (truncated, ${json.length} characters in all)` : json;
  } finally {
    void cdp(v, 'Runtime.releaseObjectGroup', { objectGroup: 'kermanych-evaluate' }).catch(() => {});
  }
}

// JSON text of an evaluate result; objects JSON cannot express (DOM nodes, functions,
// cyclic graphs) fall back to the DevTools description (`div#app`, `ƒ foo()`).
async function serialize(v: SessionView, obj: CdpRemoteObject): Promise<string> {
  if (obj.type === 'undefined') return 'undefined';
  if (obj.unserializableValue) return obj.unserializableValue;
  if (!obj.objectId) return JSON.stringify(obj.value ?? null);
  const res = await cdp<{ result: CdpRemoteObject }>(v, 'Runtime.callFunctionOn', {
    objectId: obj.objectId,
    functionDeclaration: 'function () { if (this instanceof Node || typeof this === "function") return undefined; try { return JSON.stringify(this); } catch { return undefined; } }',
    returnByValue: true,
  });
  return typeof res.result.value === 'string' ? res.result.value : (obj.description ?? obj.type);
}

async function key(v: SessionView, spec: KeySpec): Promise<void> {
  const base = { modifiers: spec.modifiers, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode };
  await cdp(v, 'Input.dispatchKeyEvent', {
    type: spec.text ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}),
    ...(spec.commands ? { commands: spec.commands } : {}),
  });
  await cdp(v, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// Run an input action and let the page react before the agent looks again: two animation
// frames (the handlers' DOM updates are painted), then, if the action started a document
// navigation, its load (bounded by SETTLE_MS; the page keeps loading and the agent sees it in
// the next snapshot). A dialog the action opens ends the wait at once: its CDP call stays
// pending until the dialog is answered, resolves (or times out) later, and nobody awaits it.
export async function settle(v: SessionView, action: () => Promise<void>): Promise<void> {
  const { wc } = v;
  let navigating = false;
  const onStart = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (details.isMainFrame && !details.isSameDocument) navigating = true;
  };
  wc.on('did-start-navigation', onStart);
  const dialog = dialogOpened(v);
  try {
    const acting = action();
    acting.catch(() => {});
    await Promise.race([acting, dialog.promise]);
    if (v.dialog) return;
    await Promise.race([run(v, ANIMATION_FRAMES_SCRIPT).catch(() => {}), dialog.promise, sleep(FRAMES_MS)]);
    if (v.dialog || wc.isDestroyed()) return;
    if ((navigating || wc.isLoadingMainFrame()) && wc.isLoading()) {
      const loaded = Promise.withResolvers<void>();
      const onStop = () => loaded.resolve();
      wc.once('did-stop-loading', onStop);
      try {
        await Promise.race([loaded.promise, dialog.promise, sleep(SETTLE_MS)]);
      } finally {
        if (!wc.isDestroyed()) wc.off('did-stop-loading', onStop);
      }
    }
  } finally {
    dialog.dispose();
    if (!wc.isDestroyed()) wc.off('did-start-navigation', onStart);
  }
}
