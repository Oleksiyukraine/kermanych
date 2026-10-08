// The session browser (docs/specs/2026-10-05-embedded-browser.md): one Electron WebContentsView
// per agent session, shared by the operator (the renderer's Браузер tab positions it over a
// placeholder through the `kermanych:browser:*` IPC below) and the session's agent (the api's
// MCP endpoint calls the BrowserHost methods, handed to it through `bootstrap({ browser })`).
//
// Views are never detached once created. The one the operator looks at sits at the bounds the
// renderer reports; every other one is *parked* with exactly one pixel inside the window's
// bottom-right corner — probed on Electron 43, a detached view does not lay out (CDP clicks
// miss) and cannot be captured, a `setVisible(false)` one captures only at random, a view fully
// outside the window times out, and a one-pixel-inside view renders and captures reliably. So
// the agent can drive a session the operator is not looking at and still take screenshots.
//
// Electron 43 facts the code below leans on (throwaway probes on this machine):
// - `loadURL` (and reload/back/forward) gives the view keyboard focus, parked or not: an agent's
//   navigation stole the operator's typing from a modal in the app. Hence the focus guard.
// - CDP `Input.dispatchMouseEvent` emits `before-mouse-event` just like a real mouse (same
//   fields, global coordinates included), so that event alone cannot tell the operator from
//   the agent; `agentBusy` does. CDP key events do NOT emit `before-input-event`, so the
//   shortcuts below only ever see the operator's keys.
// - JavaScript dialogs go through Electron's internal '-run-dialog' event; its default handler
//   pops a native message box on the app window that nothing but a click closes. The views
//   replace it (see wire).
// - `enableDeviceEmulation` is dropped by every cross-document navigation (same origin too);
//   it is re-applied on `did-navigate`, which mostly lands before the new page's first script
//   (one probe run saw an inline script read the pane's width first; the page then gets a
//   resize). Zoom (`setZoomFactor`) is shared by every view of an origin in a partition, so it
//   is never used.
// - A popup window allowed from `setWindowOpenHandler` (no partition given) shares the opener's
//   session and keeps `window.opener`.
import { app, ipcMain, session, shell, WebContentsView, type BrowserWindow, type Rectangle } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  BrowserActionResult,
  BrowserConsoleEntry,
  BrowserDialogInfo,
  BrowserHost,
  BrowserNetworkEntry,
  BrowserPageInfo,
  BrowserTarget,
  BrowserViewport,
} from '@kermanych/api';
import { isExternalScheme, navigationAllowed, normalizeUrl } from '../../src/lib/browser-url';
import * as actions from './actions';
import { cdp, run } from './cdp';
import { PICKER_SCRIPT, type PickResult } from './scripts';
import { assertNoDialog, CONSOLE_LIMIT, DEFAULT_SIZE, NETWORK_LIMIT, SETTLE_MS, type SessionView } from './view';

// Live views at most: each is a renderer process. The least recently used one that is safe to
// drop (see evictable) is closed when another session needs a view.
const MAX_LIVE_VIEWS = 6;
// A view nobody looked at and the agent did not use for this long is closed.
const IDLE_CLOSE_MS = 20 * 60_000;
// Never closed while the agent may be mid-task in it.
const AGENT_RECENT_MS = 2 * 60_000;
const IDLE_CHECK_MS = 60_000;
// Picks' crops in $TMPDIR/kermanych-browser/<session>/ are removed at startup after this.
const TEMP_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
// An HTTP sign-in nobody answers is cancelled (the page gets its 401) after this.
const AUTH_TIMEOUT_MS = 2 * 60_000;
// hide({ freeze }) waits this long for the frame; an overlay must not open late for it.
const FREEZE_CAPTURE_MS = 150;
const LAST_URLS_WRITE_MS = 1_000;
// A resize resolves once the page lays out at the new width, or after this.
const RESIZE_SETTLE_MS = 1_000;
const VIEWPORT_LIMITS = { width: [320, 3840], height: [240, 2400] } as const;
// A popup window whose window.open features name no size (OAuth sign-ins mostly do).
const POPUP_SIZE = { width: 520, height: 680 };
const LOCAL_HOST = /^(localhost|.+\.localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

const PAUSED_MESSAGE =
  "The operator has taken over this session's browser (agent control is paused). Do not retry; tell the operator what you need and wait for them to hand control back.";

// Shortcuts with Cmd (macOS) / Ctrl (elsewhere) held, by KeyboardEvent.code. Zoom keys and
// Cmd+W are swallowed: zoom is shared by every view of the origin in the project's partition
// (it would rescale the same site in the other sessions and the agent's coordinates), and the
// default app menu's Cmd+W would close the Kermanych window itself.
const MOD_SHORTCUTS: Record<string, 'reload' | 'focus-address' | 'find' | 'swallow'> = {
  KeyR: 'reload',
  KeyL: 'focus-address',
  KeyF: 'find',
  KeyW: 'swallow',
  Equal: 'swallow',
  Minus: 'swallow',
  Digit0: 'swallow',
  NumpadAdd: 'swallow',
  NumpadSubtract: 'swallow',
  Numpad0: 'swallow',
};

function tempDir(sessionId: string): string {
  return path.join(tmpdir(), 'kermanych-browser', sessionId.replace(/[^\w.-]/g, '_'));
}

function clampViewport(viewport: { width: number; height?: number }): { width: number; height?: number } {
  const clamp = (n: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, Math.round(n)));
  return {
    width: clamp(viewport.width, VIEWPORT_LIMITS.width),
    ...(viewport.height !== undefined ? { height: clamp(viewport.height, VIEWPORT_LIMITS.height) } : {}),
  };
}

// `width=…,height=…` of window.open's features string, else POPUP_SIZE.
function popupSize(features: string): { width: number; height: number } {
  const read = (name: string) => Number(new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*(\\d+)`, 'i').exec(features)?.[1]) || undefined;
  return { width: read('width') ?? POPUP_SIZE.width, height: read('height') ?? POPUP_SIZE.height };
}

// `report.pdf`, else `report (1).pdf`, `report (2).pdf`, … — a download never overwrites a file,
// nor another download still in flight (`reserved`: Chromium writes the final name only when
// it finishes; two downloads of one file picked the same name in the probe). Sync:
// will-download needs the save path before its handler returns.
function freeDownloadPath(dir: string, filename: string, reserved: Set<string>): string {
  const { name, ext } = path.parse(filename || 'download');
  let candidate = path.join(dir, `${name}${ext}`);
  for (let n = 1; existsSync(candidate) || reserved.has(candidate); n++) candidate = path.join(dir, `${name} (${n})${ext}`);
  return candidate;
}

export class SessionBrowsers implements BrowserHost {
  private win: BrowserWindow | undefined;
  private readonly views = new Map<string, SessionView>();
  private shown: SessionView | undefined;
  // The placeholder's bounds the renderer last reported for the shown view.
  private pane: Rectangle = { x: 0, y: 0, ...DEFAULT_SIZE };
  // Bumped by every show: hide({ freeze }) awaits a capture and must not park a view the
  // renderer showed again meanwhile.
  private showSeq = 0;
  private readonly guardedPartitions = new Set<string>();
  // Save paths of downloads in progress (freeDownloadPath).
  private readonly downloading = new Set<string>();
  // sessionId → the last http(s) URL its browser was at, kept in userData across restarts and
  // idle closes so the pane and the agent can go back there.
  private readonly lastUrls = new Map<string, string>();
  private readonly lastUrlsFile = path.join(app.getPath('userData'), 'session-browser.json');
  private readonly lastUrlsLoaded: Promise<void>;
  private lastUrlsTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.registerIpc();
    this.lastUrlsLoaded = this.loadLastUrls();
    void this.sweepTempFiles();
    setInterval(() => this.closeIdle(), IDLE_CHECK_MS).unref();
  }

  // Bind to the app window: views are its child views, and state events go to its renderer.
  attach(win: BrowserWindow): void {
    this.win = win;
    win.on('resize', () => {
      for (const v of this.views.values()) if (v !== this.shown) this.layout(v);
    });
    win.on('closed', () => {
      this.win = undefined;
      // The app is going away, not the sessions: keep their temp files and last URLs.
      for (const id of [...this.views.keys()]) this.teardown(id);
    });
  }

  // ---- BrowserHost (the agent's MCP tools) ----

  async navigate(target: BrowserTarget, url: string): Promise<BrowserPageInfo & { status?: number }> {
    const href = normalizeUrl(url);
    const existing = this.views.get(target.sessionId);
    if (existing?.agentPaused) throw new Error(PAUSED_MESSAGE);
    const v = this.ensure(target.sessionId, target.projectId);
    this.touch(v);
    v.agentBusy++;
    try {
      await this.load(v, href, true);
    } finally {
      v.agentBusy--;
    }
    return { ...actions.pageInfo(v), ...(v.status ? { status: v.status } : {}) };
  }

  async snapshot(target: BrowserTarget): Promise<BrowserPageInfo & { text: string }> {
    return this.agent(target, (v) => actions.snapshot(v));
  }

  async click(target: BrowserTarget, ref: string): Promise<BrowserActionResult> {
    return this.agent(target, (v) => actions.click(v, ref));
  }

  async type(target: BrowserTarget, ref: string, text: string, opts: { clear: boolean; submit: boolean }): Promise<BrowserActionResult> {
    return this.agent(target, (v) => actions.type(v, ref, text, opts));
  }

  async press(target: BrowserTarget, key: string): Promise<BrowserActionResult> {
    return this.agent(target, (v) => actions.press(v, key));
  }

  async hover(target: BrowserTarget, ref: string): Promise<BrowserActionResult> {
    return this.agent(target, (v) => actions.hover(v, ref));
  }

  async select(target: BrowserTarget, ref: string, values: string[]): Promise<BrowserActionResult & { selected: string[] }> {
    return this.agent(target, (v) => actions.select(v, ref, values));
  }

  async history(target: BrowserTarget, action: 'back' | 'forward' | 'reload'): Promise<BrowserActionResult> {
    return this.agent(target, (v) => actions.history(v, action));
  }

  async waitFor(
    target: BrowserTarget,
    opts: { text?: string; selector?: string; gone: boolean; timeoutMs: number },
  ): Promise<BrowserPageInfo & { waitedMs: number }> {
    return this.agent(target, (v) => actions.waitFor(v, opts));
  }

  // The agent's viewport is the operator's too (one page): the pane shows the same layout width.
  async resize(target: BrowserTarget, viewport: { width: number; height?: number } | null): Promise<BrowserPageInfo & { viewport: BrowserViewport }> {
    return this.agent(target, async (v) => {
      assertNoDialog(v);
      v.viewport = viewport && clampViewport(viewport);
      this.layout(v);
      this.emit(v);
      const expected = v.viewport?.width ?? (v === this.shown ? this.pane.width : v.width);
      // The page lays out at the new bounds / emulation a frame or two later; report what it
      // actually uses, not what was asked.
      const deadline = Date.now() + RESIZE_SETTLE_MS;
      let size = await run<BrowserViewport>(v, '({ width: innerWidth, height: innerHeight })');
      while (size.width !== expected && Date.now() < deadline) {
        await sleep(50);
        size = await run<BrowserViewport>(v, '({ width: innerWidth, height: innerHeight })');
      }
      return { ...actions.pageInfo(v), viewport: size };
    });
  }

  async screenshot(target: BrowserTarget, opts: { fullPage: boolean; ref?: string }): Promise<{ data: string; mimeType: 'image/png' }> {
    return this.agent(target, (v) => actions.screenshot(v, opts));
  }

  async upload(target: BrowserTarget, ref: string, paths: string[]): Promise<BrowserActionResult> {
    return this.agent(target, (v) => actions.upload(v, ref, paths));
  }

  async dialog(target: BrowserTarget, opts: { accept: boolean }): Promise<BrowserActionResult> {
    return this.agent(target, (v) => actions.answerDialog(v, opts));
  }

  async console(target: BrowserTarget, opts: { clear: boolean }): Promise<BrowserConsoleEntry[]> {
    return this.agent(target, (v) => actions.consoleEntries(v, opts));
  }

  async network(target: BrowserTarget, opts: { clear: boolean; filter?: string }): Promise<BrowserNetworkEntry[]> {
    return this.agent(target, (v) => actions.networkEntries(v, opts));
  }

  async evaluate(target: BrowserTarget, expression: string): Promise<string> {
    return this.agent(target, (v) => actions.evaluate(v, expression));
  }

  has(sessionId: string): boolean {
    return this.views.has(sessionId);
  }

  // The session was deleted: everything of its browser goes, temp files and last URL included.
  close(sessionId: string): void {
    this.teardown(sessionId);
    if (this.lastUrls.delete(sessionId)) this.saveLastUrls();
    void rm(tempDir(sessionId), { recursive: true, force: true }).catch(() => {});
  }

  // ---- The renderer's side (Браузер tab) ----

  private show(sessionId: string, projectId: string, bounds: KermanychBrowserBounds): void {
    const v = this.ensure(sessionId, projectId);
    const previous = this.shown;
    this.showSeq++;
    this.shown = v;
    this.pane = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    };
    v.width = this.pane.width;
    v.height = this.pane.height;
    v.usedAt = Date.now();
    if (previous && previous !== v) {
      previous.usedAt = Date.now();
      this.layout(previous);
    }
    this.layout(v);
  }

  private async hide(freeze: boolean): Promise<string | null> {
    const v = this.shown;
    if (!v) return null;
    const seq = this.showSeq;
    let frame: string | null = null;
    if (freeze && !v.wc.isDestroyed()) {
      const capture = v.wc.capturePage().then(
        (image) => (image.isEmpty() ? null : image.toDataURL()),
        () => null,
      );
      frame = await Promise.race([capture, sleep(FREEZE_CAPTURE_MS).then(() => null)]);
    }
    if (this.showSeq === seq && this.shown === v) {
      this.shown = undefined;
      v.usedAt = Date.now();
      this.layout(v);
    }
    return frame;
  }

  private async pick(sessionId: string): Promise<KermanychBrowserPick | null> {
    const v = this.views.get(sessionId);
    if (!v || !v.wc.getURL()) return null;
    v.endPick?.();
    const wc = v.wc;
    const ended = Promise.withResolvers<null>();
    const onNavigate = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (details.isMainFrame && !details.isSameDocument) ended.resolve(null);
    };
    wc.on('did-start-navigation', onNavigate);
    v.endPick = () => ended.resolve(null);
    // Hover and Esc reach the page only while the view has focus: the operator asked for it,
    // so a pending focus guard (an agent load a moment ago) must not take it back.
    v.suppressFocusUntil = 0;
    wc.focus();
    let result: PickResult | null;
    try {
      const picking = wc.executeJavaScript(PICKER_SCRIPT, true) as Promise<PickResult | null>;
      picking.catch(() => {});
      result = await Promise.race([picking, ended.promise]);
    } catch {
      result = null;
    } finally {
      if (!wc.isDestroyed()) wc.off('did-start-navigation', onNavigate);
      if (v.endPick) v.endPick = undefined;
    }
    if (!result || wc.isDestroyed()) return null;
    const { clip, ...pick } = result;
    const screenshot = clip ? await this.crop(v, clip) : undefined;
    return { url: wc.getURL(), ...pick, ...(screenshot ? { screenshot } : {}) };
  }

  private async cancelPick(sessionId: string): Promise<void> {
    const v = this.views.get(sessionId);
    if (!v) return;
    v.endPick?.();
    // Takes the overlay and the swallowing listeners off the page.
    await v.wc.executeJavaScript('window.__kermanychPick && window.__kermanychPick.cancel()', true).catch(() => {});
  }

  private async crop(v: SessionView, clip: NonNullable<PickResult['clip']>): Promise<KermanychBrowserPick['screenshot']> {
    try {
      const { data } = await cdp<{ data: string }>(v, 'Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
      const dir = tempDir(v.sessionId);
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `pick-${Date.now()}.png`);
      await writeFile(file, Buffer.from(data, 'base64'));
      return { data, mimeType: 'image/png', path: file };
    } catch {
      // The pick is useful without its picture (the page navigated, the capture timed out).
      return undefined;
    }
  }

  // Empty query: the find bar is open with nothing to look for yet — highlights go, the bar stays.
  private find(v: SessionView, query: string, forward: boolean): void {
    if (!query) {
      v.wc.stopFindInPage('clearSelection');
      v.find = { query, matches: 0, active: 0 };
    } else {
      // Electron's `findNext` is inverted from its name: true starts a new find session (a new
      // query), false steps to the next/previous match of the current one (probed: a new
      // query with findNext false reports nothing).
      const newQuery = v.find?.query !== query;
      v.wc.findInPage(query, { forward, findNext: newQuery });
      if (newQuery) v.find = { query, matches: 0, active: 0 };
    }
    this.emit(v);
  }

  private stopFind(v: SessionView): void {
    v.wc.stopFindInPage('clearSelection');
    v.find = null;
    this.emit(v);
  }

  private answerAuth(v: SessionView, id: string, credentials: { username: string; password: string } | null): void {
    const auth = v.auth;
    if (!auth || auth.id !== id) return;
    v.auth = undefined;
    if (credentials) auth.reply(credentials.username, credentials.password);
    else auth.reply();
    this.emit(v);
  }

  private state(v: SessionView): KermanychBrowserState {
    return {
      sessionId: v.sessionId,
      url: v.wc.getURL(),
      title: v.wc.getTitle(),
      loading: v.wc.isLoading(),
      canGoBack: v.wc.navigationHistory.canGoBack(),
      canGoForward: v.wc.navigationHistory.canGoForward(),
      agentAt: v.agentAt,
      agentPaused: v.agentPaused,
      viewport: v.viewport,
      scale: v.scale,
      error: v.error ?? null,
      crashed: v.crashed !== undefined,
      dialog: v.dialog ?? null,
      auth: v.auth ? { id: v.auth.id, host: v.auth.host, realm: v.auth.realm, isProxy: v.auth.isProxy } : null,
      find: v.find,
    };
  }

  private emit(v: SessionView): void {
    if (v.wc.isDestroyed()) return;
    this.send('kermanych:browser:state-changed', this.state(v));
  }

  private send(channel: string, ...args: unknown[]): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(channel, ...args);
  }

  private registerIpc(): void {
    const withView = (sessionId: string, act: (v: SessionView) => void) => {
      const v = this.views.get(sessionId);
      if (v && !v.wc.isDestroyed()) act(v);
    };
    ipcMain.on('kermanych:browser:show', (_e, sessionId: string, projectId: string, bounds: KermanychBrowserBounds) => {
      this.show(sessionId, projectId, bounds);
    });
    ipcMain.handle('kermanych:browser:hide', (_e, opts?: { freeze?: boolean }) => this.hide(opts?.freeze === true));
    ipcMain.handle('kermanych:browser:navigate', async (_e, sessionId: string, projectId: string, url: string) => {
      const href = normalizeUrl(url);
      const v = this.ensure(sessionId, projectId);
      // Like Chrome: Enter in the address bar moves the keyboard into the page the operator is
      // looking at. A view that is not shown (navigated from elsewhere) must not take it.
      await this.load(v, href, v !== this.shown);
    });
    ipcMain.on('kermanych:browser:back', (_e, sessionId: string) => withView(sessionId, (v) => v.wc.navigationHistory.goBack()));
    ipcMain.on('kermanych:browser:forward', (_e, sessionId: string) => withView(sessionId, (v) => v.wc.navigationHistory.goForward()));
    ipcMain.on('kermanych:browser:reload', (_e, sessionId: string) => withView(sessionId, (v) => v.wc.reload()));
    ipcMain.on('kermanych:browser:stop', (_e, sessionId: string) => withView(sessionId, (v) => v.wc.stop()));
    ipcMain.on('kermanych:browser:devtools', (_e, sessionId: string) => withView(sessionId, (v) => v.wc.openDevTools({ mode: 'detach' })));
    ipcMain.handle('kermanych:browser:pick', (_e, sessionId: string) => this.pick(sessionId));
    ipcMain.on('kermanych:browser:cancel-pick', (_e, sessionId: string) => void this.cancelPick(sessionId));
    ipcMain.handle('kermanych:browser:answer-dialog', async (_e, sessionId: string, accept: boolean) => {
      const v = this.views.get(sessionId);
      if (!v) throw new Error('This session has no browser open');
      await actions.answerDialog(v, { accept });
    });
    ipcMain.on('kermanych:browser:answer-auth', (_e, sessionId: string, id: string, credentials: { username: string; password: string } | null) => {
      withView(sessionId, (v) => this.answerAuth(v, id, credentials));
    });
    ipcMain.on('kermanych:browser:set-agent-paused', (_e, sessionId: string, paused: boolean) => {
      withView(sessionId, (v) => {
        v.agentPaused = paused;
        this.emit(v);
      });
    });
    ipcMain.on('kermanych:browser:set-viewport', (_e, sessionId: string, projectId: string, viewport: KermanychBrowserViewport) => {
      const v = this.ensure(sessionId, projectId);
      v.viewport = viewport && clampViewport(viewport);
      this.layout(v);
      this.emit(v);
    });
    ipcMain.on('kermanych:browser:find', (_e, sessionId: string, query: string, forward: boolean) => {
      withView(sessionId, (v) => this.find(v, query, forward));
    });
    ipcMain.on('kermanych:browser:stop-find', (_e, sessionId: string) => withView(sessionId, (v) => this.stopFind(v)));
    ipcMain.handle('kermanych:browser:state', (_e, sessionId: string) => {
      const v = this.views.get(sessionId);
      return v ? this.state(v) : null;
    });
    ipcMain.handle('kermanych:browser:last-url', async (_e, sessionId: string) => {
      await this.lastUrlsLoaded;
      return this.lastUrls.get(sessionId) ?? null;
    });
  }

  // ---- Views ----

  private window(): BrowserWindow {
    if (!this.win || this.win.isDestroyed()) throw new Error('The session browser is not available: the Kermanych window is not open');
    return this.win;
  }

  // Place the view and set its layout width (the rules: docs/specs/2026-10-05-embedded-browser.md):
  // - shown, no viewport: the pane's bounds.
  // - shown, viewport not wider than the pane: the viewport's width at the pane's left, the
  //   pane's height (the pane's background shows beside it).
  // - shown, viewport wider than the pane: the pane's bounds, the page laid out at the
  //   viewport's width and drawn scaled down to fit (device emulation; `scale` < 1).
  // - parked: the viewport's size (height: the last one when it names none), else the last
  //   pane size, all but one pixel past the window's bottom-right corner (see the header) —
  //   so the agent always gets exactly the layout width it asked for.
  private layout(v: SessionView): void {
    if (v.wc.isDestroyed()) return;
    const before = v.scale;
    const vp = v.viewport;
    if (v === this.shown) {
      const pane = this.pane;
      v.scale = vp && vp.width > pane.width ? pane.width / vp.width : 1;
      v.view.setBounds(vp && v.scale === 1 ? { ...pane, width: vp.width } : pane);
    } else {
      v.scale = 1;
      const [width, height] = this.window().getContentSize() as [number, number];
      v.view.setBounds({ x: width - 1, y: height - 1, width: vp?.width ?? v.width, height: vp?.height ?? v.height });
    }
    if (v.scale < 1) this.emulate(v);
    else if (before < 1) v.wc.disableDeviceEmulation();
    if (v.scale !== before) this.emit(v);
  }

  // Device emulation for a viewport wider than the pane: the page sees a `viewport.width`-wide
  // window (innerWidth, media queries) and is drawn at `scale`. Per webContents, unlike zoom.
  private emulate(v: SessionView): void {
    const width = v.viewport?.width ?? this.pane.width;
    const size = { width, height: Math.round(this.pane.height / v.scale) };
    v.wc.enableDeviceEmulation({
      screenPosition: 'desktop',
      screenSize: size,
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: size,
      scale: v.scale,
    });
  }

  private ensure(sessionId: string, projectId: string): SessionView {
    const existing = this.views.get(sessionId);
    if (existing) return existing;
    const win = this.window();
    this.evictForNewView();
    const partition = `persist:kermanych-browser-${projectId}`;
    this.guardPartition(partition);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // A parked view must keep running timers and painting for the agent.
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const v: SessionView = {
      sessionId,
      projectId,
      view,
      wc: view.webContents,
      ...DEFAULT_SIZE,
      viewport: null,
      scale: 1,
      log: [],
      network: [],
      requests: new Map(),
      dialogWaiters: new Set(),
      find: null,
      agentPaused: false,
      agentAt: 0,
      agentBusy: 0,
      usedAt: Date.now(),
      suppressFocusUntil: 0,
      ensureDebugger: () => this.attachDebugger(v),
    };
    this.views.set(sessionId, v);
    win.contentView.addChildView(view);
    this.layout(v);
    this.wire(v);
    this.attachDebugger(v);
    return v;
  }

  // Once per partition (a project's sessions share one).
  private guardPartition(partition: string): void {
    if (this.guardedPartitions.has(partition)) return;
    this.guardedPartitions.add(partition);
    const ses = session.fromPartition(partition);
    // Page permission prompts have nobody to answer them: everything but clipboard writes and
    // fullscreen is refused.
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
    });
    // Sites sniff `Electron/…` (and the app's own product token) and serve a degraded page or
    // refuse sign-in; without them the UA is the plain Chrome one. Per session rather than per
    // webContents so popup windows and service workers send the same.
    const product = app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    ses.setUserAgent(ses.getUserAgent().replace(/ Electron\/\S+/, '').replace(new RegExp(` ${product}/\\S+`, 'i'), ''));
    // Downloads go straight to the OS downloads folder (no Save dialog: the agent may have
    // started it in a view nobody looks at), and both sides hear where it landed.
    ses.on('will-download', (_e, item, owner) => {
      const file = freeDownloadPath(app.getPath('downloads'), item.getFilename(), this.downloading);
      this.downloading.add(file);
      item.setSavePath(file);
      item.once('done', (_done, result) => {
        this.downloading.delete(file);
        if (result !== 'completed') return;
        const v = [...this.views.values()].find((candidate) => candidate.wc === owner);
        if (!v) return;
        const name = path.basename(file);
        this.record(v, { level: 'page', text: `Downloaded ${name} → ${file}`, at: Date.now() });
        this.send('kermanych:browser:download', v.sessionId, { name, path: file });
      });
    });
  }

  private wire(v: SessionView): void {
    const { wc } = v;
    const emit = () => this.emit(v);

    // Focus guard (probe: every load focuses the view). A focus that arrives while a load the
    // agent or a popup started is settling goes back to the app window, so the operator's
    // typing in the app is not stolen. The operator's own mouse press in the shown view lifts
    // the guard; CDP clicks emit the same event, so only presses with no agent call in flight
    // count (a real click during an agent call is then still guarded — rare and harmless: the
    // next click goes through).
    wc.on('before-mouse-event', (_e, mouse) => {
      if (mouse.type === 'mouseDown' && v.agentBusy === 0 && v === this.shown) v.suppressFocusUntil = 0;
    });
    wc.on('focus', () => {
      if (Date.now() < v.suppressFocusUntil && this.win && !this.win.isDestroyed()) this.win.webContents.focus();
    });

    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && this.shortcut(v, input)) event.preventDefault();
    });

    // window.open with features (`disposition: new-window`, e.g. an OAuth sign-in that posts
    // back to its opener) gets a real child window that keeps `window.opener`; the operator
    // completes it, the agent cannot drive it. `target=_blank` and plain window.open(url)
    // load in this view: there is one view per session.
    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      if (disposition === 'new-window' && navigationAllowed(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            ...(this.win && !this.win.isDestroyed() ? { parent: this.win } : {}),
            // window.open's width/height are the page's size, not the window frame's.
            ...popupSize(features),
            useContentSize: true,
            autoHideMenuBar: true,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
          },
        };
      }
      if (/^https?:/i.test(url)) {
        v.suppressFocusUntil = Date.now() + SETTLE_MS;
        void wc.loadURL(url).catch(() => {});
      } else if (isExternalScheme(url)) {
        this.openExternal(v, url);
      }
      return { action: 'deny' };
    });
    wc.on('did-create-window', (child, { url }) => {
      const cwc = child.webContents;
      const guardChild = (e: Electron.Event<{ url: string }>) => {
        if (navigationAllowed(e.url)) return;
        e.preventDefault();
        // The popup is on screen, so whatever happens in it is the operator's doing.
        if (isExternalScheme(e.url)) void shell.openExternal(e.url);
      };
      cwc.on('will-navigate', guardChild);
      cwc.on('will-redirect', guardChild);
      cwc.setWindowOpenHandler(({ url: next }) => {
        if (/^https?:/i.test(next)) void cwc.loadURL(next).catch(() => {});
        else if (isExternalScheme(next)) void shell.openExternal(next);
        return { action: 'deny' };
      });
      // A popup outlives neither its session's view nor the app window (its parent).
      const closeChild = () => {
        if (!child.isDestroyed()) child.close();
      };
      wc.once('destroyed', closeChild);
      child.once('closed', () => {
        if (!wc.isDestroyed()) wc.off('destroyed', closeChild);
      });
      v.popup = { url, at: Date.now() };
      this.record(v, { level: 'page', text: `Popup window opened: ${url} (the operator completes it; agent tools cannot drive it)`, at: Date.now() });
    });
    const guard = (e: Electron.Event<{ url: string }>) => {
      if (navigationAllowed(e.url)) return;
      e.preventDefault();
      if (isExternalScheme(e.url)) this.openExternal(v, e.url);
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);

    wc.on('did-start-loading', emit);
    wc.on('did-stop-loading', emit);
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      v.error = undefined;
      v.crashed = undefined;
      // A sign-in the previous navigation asked for is moot now.
      if (v.auth) this.answerAuth(v, v.auth.id, null);
      emit();
    });
    wc.on('did-navigate', (_e, url, httpResponseCode) => {
      v.status = httpResponseCode > 0 ? httpResponseCode : undefined;
      if (httpResponseCode > 0) v.error = undefined;
      // Device emulation does not survive a cross-document navigation (probed).
      if (v.scale < 1) this.emulate(v);
      this.rememberUrl(v.sessionId, url);
      emit();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) this.rememberUrl(v.sessionId, url);
      emit();
    });
    wc.on('page-title-updated', emit);
    // JavaScript dialogs. Electron's own '-run-dialog' handler (lib/browser/api/web-contents.ts)
    // shows a native message box on the app window — window-modal, invisible to the agent, and
    // left orphaned on screen when anything else answers the dialog (probed with CDP's
    // Page.handleJavaScriptDialog). Without a handler the dialog returns false unseen. So the
    // view gets its own: the dialog goes into the state (the pane shows a bar) and into the
    // agent's action result, and whoever answers first calls Electron's callback. Only alert and
    // confirm arrive: Electron's renderer throws «prompt() is not supported».
    const dialogs = wc as unknown as NodeJS.EventEmitter;
    dialogs.removeAllListeners('-run-dialog');
    dialogs.on('-run-dialog', (info: { dialogType: BrowserDialogInfo['type']; messageText: string }, callback: (accept: boolean, text: string) => void) => {
      const dialog: BrowserDialogInfo = { type: info.dialogType, message: info.messageText };
      let answered = false;
      v.dialog = dialog;
      v.dialogReply = (accept) => {
        if (answered) return;
        answered = true;
        if (v.dialog === dialog) {
          v.dialog = undefined;
          v.dialogReply = undefined;
          emit();
        }
        callback(accept, '');
      };
      // An agent action that set it off returns now instead of waiting on the blocked page.
      for (const waiter of [...v.dialogWaiters]) waiter(dialog);
      this.record(v, { level: 'page', text: `JavaScript ${dialog.type} dialog opened: «${dialog.message}» — the page waits for an answer`, at: Date.now() });
      emit();
    });
    // Chromium drops a pending dialog itself (a navigation, the page closing): its callback is
    // dead, so nobody may answer it any more.
    dialogs.on('-cancel-dialogs', () => {
      if (!v.dialog) return;
      v.dialog = undefined;
      v.dialogReply = undefined;
      emit();
    });
    // «Leave site?»: Electron cancels the unload unless this is prevented, which would silently
    // block every navigation the agent or the operator starts away from a page with unsaved
    // state; leaving is what they asked for.
    wc.on('will-prevent-unload', (event) => event.preventDefault());

    wc.on('console-message', (details) => {
      // Electron's own dev-build security banner, not the page's.
      if (details.sourceId.startsWith('node:electron/')) return;
      this.record(v, {
        level: details.level,
        text: details.message,
        ...(details.sourceId ? { source: `${details.sourceId}:${details.lineNumber}` } : {}),
        at: Date.now(),
      });
    });
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (errorCode === -3) return; // ERR_ABORTED: superseded by another navigation
      this.record(v, { level: 'page', text: `${isMainFrame ? 'Page' : 'Frame'} failed to load: ${errorDescription} (${errorCode})`, source: validatedURL, at: Date.now() });
      if (isMainFrame) {
        v.error = { code: errorCode, description: errorDescription, url: validatedURL };
        emit();
      }
    });
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      v.crashed = details.reason;
      // Whatever the dead page was blocked on or doing is gone with it.
      v.dialog = undefined;
      v.dialogReply = undefined;
      v.endPick?.();
      this.record(v, { level: 'page', text: `The page crashed (${details.reason}, exit code ${details.exitCode})`, at: Date.now() });
      emit();
    });
    wc.on('found-in-page', (_e, result) => {
      if (!v.find) return;
      v.find = { query: v.find.query, matches: result.matches, active: result.activeMatchOrdinal };
      emit();
    });
    wc.on('login', (event, _details, authInfo, callback) => {
      event.preventDefault();
      // A new challenge (wrong password, another realm) replaces the unanswered one.
      if (v.auth) this.answerAuth(v, v.auth.id, null);
      const id = randomUUID();
      const timer = setTimeout(() => this.answerAuth(v, id, null), AUTH_TIMEOUT_MS);
      v.auth = {
        id,
        host: authInfo.host,
        realm: authInfo.realm,
        isProxy: authInfo.isProxy,
        reply: (username, password) => {
          clearTimeout(timer);
          callback(username, password);
        },
      };
      this.record(v, { level: 'page', text: `The page asked for HTTP sign-in at ${authInfo.host} — waiting for the operator`, at: Date.now() });
      emit();
    });
    // Dev servers on this machine often run with a self-signed certificate; anything else
    // keeps Chromium's verdict (the load fails with the certificate error).
    wc.on('certificate-error', (event, url, _error, _certificate, callback) => {
      let local = false;
      try {
        local = LOCAL_HOST.test(new URL(url).hostname);
      } catch {
        local = false;
      }
      if (local) event.preventDefault();
      callback(local);
    });

    wc.debugger.on('message', (_e, method, params) => {
      // The request log browser_network reads: an entry per request (a redirect closes the
      // hop and opens a new entry for the next URL), pushed at start so in-flight requests
      // show, completed in place through `requests`.
      if (method === 'Network.requestWillBeSent') {
        const now = Date.now();
        const hop = params.redirectResponse ? v.requests.get(params.requestId) : undefined;
        if (hop) {
          hop.status = params.redirectResponse.status;
          hop.ms = now - hop.at;
        }
        const entry: BrowserNetworkEntry = { method: params.request.method, url: params.request.url, ...(params.type ? { type: params.type } : {}), at: now };
        v.requests.set(params.requestId, entry);
        v.network.push(entry);
        if (v.network.length > NETWORK_LIMIT) v.network.splice(0, v.network.length - NETWORK_LIMIT);
      } else if (method === 'Network.responseReceived') {
        const { status, statusText, url } = params.response as { status: number; statusText: string; url: string };
        const entry = v.requests.get(params.requestId);
        if (entry) entry.status = status;
        if (status >= 400) this.record(v, { level: 'network', text: `HTTP ${status}${statusText ? ` ${statusText}` : ''}`, source: url, at: Date.now() });
      } else if (method === 'Network.loadingFinished') {
        const entry = v.requests.get(params.requestId);
        if (entry) entry.ms = Date.now() - entry.at;
        v.requests.delete(params.requestId);
      } else if (method === 'Network.loadingFailed') {
        const entry = v.requests.get(params.requestId);
        v.requests.delete(params.requestId);
        const reason = `${params.errorText}${params.blockedReason ? ` (${params.blockedReason})` : ''}`;
        if (entry) {
          entry.failed = params.canceled ? 'canceled' : reason;
          entry.ms = Date.now() - entry.at;
        }
        if (!params.canceled) this.record(v, { level: 'network', text: `Request failed: ${reason}`, ...(entry ? { source: entry.url } : {}), at: Date.now() });
      }
    });
    wc.on('destroyed', () => {
      if (this.views.get(v.sessionId) === v) this.teardown(v.sessionId);
    });
  }

  // A key press in the page (the operator's: CDP key events never reach before-input-event).
  // Returns whether it was the browser's, so the page does not get it.
  private shortcut(v: SessionView, input: Electron.Input): boolean {
    const mac = process.platform === 'darwin';
    const mod = mac ? input.meta : input.control;
    if (input.key === 'Escape' && v.find) {
      this.stopFind(v);
      return true;
    }
    if (input.key === 'F12' || (mod && (mac ? input.alt : input.shift) && input.code === 'KeyI')) {
      v.wc.openDevTools({ mode: 'detach' });
      return true;
    }
    const back = mac ? mod && input.code === 'BracketLeft' : input.alt && input.key === 'ArrowLeft';
    const forward = mac ? mod && input.code === 'BracketRight' : input.alt && input.key === 'ArrowRight';
    if (back || forward) {
      if (back) v.wc.navigationHistory.goBack();
      else v.wc.navigationHistory.goForward();
      return true;
    }
    if (!mod || input.alt) return false;
    const action = MOD_SHORTCUTS[input.code];
    if (action === 'reload') {
      if (input.shift) v.wc.reloadIgnoringCache();
      else v.wc.reload();
    } else if (action === 'focus-address' || action === 'find') {
      // The keyboard is in the view; the renderer can focus its input only once its own
      // webContents has focus back.
      this.win?.webContents.focus();
      this.send('kermanych:browser:shortcut', v.sessionId, action);
    }
    return action !== undefined;
  }

  // mailto:/tel: and the like go to the OS only when the operator clicked them: the page is the
  // one they are looking at and no agent tool call is in flight. An agent's click (shown view
  // or not) must not open a mail client on the operator's machine.
  private openExternal(v: SessionView, url: string): void {
    if (v === this.shown && v.agentBusy === 0) void shell.openExternal(url);
    else this.record(v, { level: 'page', text: `Blocked external link ${url} (only the operator's own click opens it)`, at: Date.now() });
  }

  // An explicit load (the agent's navigate, the address bar). `guardFocus`: the view must not
  // take the keyboard from the app (see wire).
  private async load(v: SessionView, url: string, guardFocus: boolean): Promise<void> {
    // A page blocked in a dialog does not unload until the dialog is answered, so the load
    // would sit behind it; whoever navigates away has decided against it.
    v.dialogReply?.(false);
    if (guardFocus) v.suppressFocusUntil = Date.now() + SETTLE_MS;
    await actions.load(v, url);
  }

  private attachDebugger(v: SessionView): void {
    try {
      v.wc.debugger.attach('1.3');
    } catch (err) {
      throw new Error(`Could not attach to the session browser's page: ${(err as Error).message}`);
    }
    v.requests.clear();
    void v.wc.debugger.sendCommand('Network.enable').catch(() => {});
    // The view rarely has OS focus (the operator works in the app, the view may be parked);
    // without this the page sees blur and some inputs ignore synthetic typing.
    void v.wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  }

  private record(v: SessionView, entry: BrowserConsoleEntry): void {
    v.log.push(entry);
    if (v.log.length > CONSOLE_LIMIT) v.log.splice(0, v.log.length - CONSOLE_LIMIT);
  }

  private touch(v: SessionView): void {
    v.agentAt = Date.now();
    v.usedAt = v.agentAt;
    this.emit(v);
  }

  // Every agent tool but navigate: the session's view with a live page in it, not paused by the
  // operator. Counts as agent use and marks agent input in flight for the focus guard.
  private async agent<T>(target: BrowserTarget, act: (v: SessionView) => T | Promise<T>): Promise<T> {
    const v = this.views.get(target.sessionId);
    if (v?.agentPaused) throw new Error(PAUSED_MESSAGE);
    if (!v || !v.wc.getURL()) {
      const last = this.lastUrls.get(target.sessionId);
      throw new Error(`This session has no page open — call browser_navigate first${last ? ` (last time it was at ${last})` : ''}`);
    }
    if (v.crashed) throw new Error(`The page crashed (${v.crashed}) — call browser_navigate to reload it`);
    this.touch(v);
    // Belt and braces for the emulation: a renderer swap the did-navigate hook missed would
    // otherwise leave the page at the pane's width while the agent believes otherwise.
    if (v.scale < 1) this.emulate(v);
    v.agentBusy++;
    try {
      return await act(v);
    } finally {
      v.agentBusy--;
    }
  }

  // Close the view and drop its state; the session's temp files and last URL stay (close()
  // removes those when the session itself is deleted). The renderer forgets its state.
  private teardown(sessionId: string): void {
    const v = this.views.get(sessionId);
    if (!v) return;
    this.views.delete(sessionId);
    if (this.shown === v) this.shown = undefined;
    v.endPick?.();
    if (v.auth) {
      v.auth.reply();
      v.auth = undefined;
    }
    if (this.win && !this.win.isDestroyed()) this.win.contentView.removeChildView(v.view);
    if (!v.wc.isDestroyed()) {
      if (v.wc.debugger.isAttached()) v.wc.debugger.detach();
      v.wc.close();
    }
    this.send('kermanych:browser:closed', sessionId);
  }

  // Whether closing the view now loses nothing anyone is in the middle of.
  private evictable(v: SessionView, now: number): boolean {
    return v !== this.shown && !v.dialog && !v.auth && !v.endPick && v.agentBusy === 0 && now - v.agentAt >= AGENT_RECENT_MS;
  }

  // Room for one more view under MAX_LIVE_VIEWS, least recently used first. When every view is
  // busy the new one is created anyway: refusing it would break the session asking.
  private evictForNewView(): void {
    const excess = this.views.size - MAX_LIVE_VIEWS + 1;
    if (excess <= 0) return;
    const now = Date.now();
    const candidates = [...this.views.values()].filter((v) => this.evictable(v, now)).sort((a, b) => a.usedAt - b.usedAt);
    for (const v of candidates.slice(0, excess)) this.teardown(v.sessionId);
  }

  private closeIdle(): void {
    const now = Date.now();
    for (const v of [...this.views.values()]) {
      if (this.evictable(v, now) && now - v.usedAt >= IDLE_CLOSE_MS) this.teardown(v.sessionId);
    }
  }

  private rememberUrl(sessionId: string, url: string): void {
    if (!/^https?:/i.test(url) || this.lastUrls.get(sessionId) === url) return;
    this.lastUrls.set(sessionId, url);
    this.saveLastUrls();
  }

  // Debounced: a single-page app changes its URL on every route.
  private saveLastUrls(): void {
    clearTimeout(this.lastUrlsTimer);
    this.lastUrlsTimer = setTimeout(() => {
      void (async () => {
        await this.lastUrlsLoaded;
        await writeFile(this.lastUrlsFile, JSON.stringify(Object.fromEntries(this.lastUrls))).catch(() => {});
      })();
    }, LAST_URLS_WRITE_MS);
  }

  private async loadLastUrls(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.lastUrlsFile, 'utf8')) as Record<string, unknown>;
      for (const [sessionId, url] of Object.entries(saved)) {
        // A URL recorded since startup is newer than the file's.
        if (typeof url === 'string' && !this.lastUrls.has(sessionId)) this.lastUrls.set(sessionId, url);
      }
    } catch {
      // No file yet (first run) or an unreadable one: start empty.
    }
  }

  // Picks' crops of sessions long gone (deleted sessions remove their own in close()).
  private async sweepTempFiles(): Promise<void> {
    const root = path.join(tmpdir(), 'kermanych-browser');
    try {
      const now = Date.now();
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        const { mtimeMs } = await stat(dir);
        if (now - mtimeMs > TEMP_MAX_AGE_MS) await rm(dir, { recursive: true, force: true });
      }
    } catch {
      // Nothing to sweep, or a directory vanished mid-way: next startup tries again.
    }
  }
}
