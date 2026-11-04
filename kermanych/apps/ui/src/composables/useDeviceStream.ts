// apps/ui/src/composables/useDeviceStream.ts
// The session device's screen in the «Пристрій» tab (docs/specs/2026-11-03-mobile-device-
// preview.md, decisions 9, 12): frames from the api's `/device` socket.io namespace drawn on a
// <canvas>, and the operator's mouse and keyboard sent back as DeviceInput. The same in both
// builds — the device lives in the api, not in Electron main.
//
// A device is streamed only while some socket watches it, so the pane watches only while a
// device is booted, the pane is mounted and the window is visible, and says `unwatch` the moment
// any of that stops. `watch` carries the canvas's pixel size: a driver that can scale (Android)
// sends frames no bigger than that, so a resize re-watches (debounced).
import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import { io, type Socket } from 'socket.io-client';
import type { DeviceFrame, DeviceInput, DeviceRuntime, DeviceWatchReply } from '@kermanych/core';
import { getAuthToken } from '../lib/api';
import { SOCKET_ORIGIN } from '../lib/socket';
import { fitRect, rgbToRgba, screenPoint, wheelPixels, type ScreenRect } from '../lib/device-screen';

const ACK_MS = 10_000;
// A pane being dragged wider would re-watch on every pixel otherwise.
const REWATCH_MS = 250;
// Typed characters are sent as one `text` once typing pauses this long: a burst of keys is one
// round trip, and non-ASCII goes through the device clipboard (one paste), not per character.
const TEXT_COALESCE_MS = 40;
// The keys sent as `key` (core DeviceInput); every other single character is `text`.
const NAMED_KEYS: Record<string, true> = {
  Enter: true,
  Backspace: true,
  Tab: true,
  Escape: true,
  ArrowLeft: true,
  ArrowRight: true,
  ArrowUp: true,
  ArrowDown: true,
};

// ── The socket ─────────────────────────────────────────────────────────────
// One per window, shared by every mounted pane and closed with the last one. The handshake
// reads the token on every attempt, as `/terminal` does (stores/terminal.ts), so a refreshed
// token is the one presented.
//
// socket.io retries a dropped transport by itself, but not a handshake the server refused
// (`unauthorized` — a token the api does not hold yet) nor a server-side disconnect: the socket
// then stays down for good. The terminal revives it on its next call; a pane has no next call —
// it would sit on «Чекаю на зображення…» until a reload — so while anyone watches, this retries
// with a backoff, and every pane shows why meanwhile.
type Watcher = { sessionId: string; frame: (f: DeviceFrame) => void; connected: () => void; failed: (error: string) => void };
const watchers = new Set<Watcher>();
let socket: Socket | null = null;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;
let retryDelay = RETRY_MIN_MS;
let retryTimer: number | undefined;

function scheduleRetry(s: Socket): void {
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    if (socket === s && watchers.size && !s.connected && !s.active) s.connect();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
}

function connect(): Socket {
  if (socket) {
    if (!socket.connected && !socket.active) socket.connect();
    return socket;
  }
  const s = io(`${SOCKET_ORIGIN}/device`, { auth: (cb) => cb({ token: getAuthToken() }) });
  // A reconnect (an api restart, a network blip) drops the server's watch: every pane asks again.
  s.on('connect', () => {
    window.clearTimeout(retryTimer);
    retryDelay = RETRY_MIN_MS;
    for (const w of watchers) w.connected();
  });
  s.on('connect_error', (err: Error) => {
    for (const w of watchers) w.failed(err.message);
    if (!s.active) scheduleRetry(s);
  });
  s.on('disconnect', (reason: string) => {
    if (reason === 'io server disconnect') scheduleRetry(s);
  });
  s.on('frame', (f: DeviceFrame) => {
    for (const w of watchers) if (w.sessionId === f.sessionId) w.frame(f);
  });
  socket = s;
  return s;
}

// The server keeps one watch per socket and session, so `unwatch` goes out only when no other
// pane of this window still watches that session: a pane unmounting while its replacement
// already watches (the tab ↔ «Поруч із логом» swap) must not stop the replacement's stream.
function release(w: Watcher): void {
  watchers.delete(w);
  if (!socket) return;
  if (![...watchers].some((o) => o.sessionId === w.sessionId)) socket.emit('unwatch', { sessionId: w.sessionId });
  if (watchers.size) return;
  window.clearTimeout(retryTimer);
  retryDelay = RETRY_MIN_MS;
  socket.disconnect();
  socket = null;
}

export type DeviceStreamOptions = {
  sessionId: string;
  canvas: Ref<HTMLCanvasElement | null>;
  // A device is booted (the preview state carries it): only then is there a screen to watch.
  active: () => boolean;
  // «◎ Вказати» is armed: the pane takes the click, nothing goes to the device.
  blocked: () => boolean;
};

export function useDeviceStream(opts: DeviceStreamOptions) {
  // What the last `watch` answered: the device, or why it cannot be shown.
  const runtime = ref<DeviceRuntime | null>(null);
  const error = ref<string | null>(null);
  // The size of the last frame drawn (null before the first): its aspect ratio is the screen's.
  const frameSize = ref<{ width: number; height: number } | null>(null);

  const visible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden');
  // The canvas's CSS size; its pixel size is this times devicePixelRatio.
  const box = ref({ width: 0, height: 0 });

  // ── Watching ──────────────────────────────────────────────────────────────
  let watching = false;
  let watchSeq = 0;
  let rewatchTimer: number | undefined;
  // A watch the server accepted that has not produced a single frame yet is asked again, with a
  // growing pause: an upstream that failed to start (a helper not up yet early in a boot) is
  // only restarted by a new watch. Once a frame has been drawn, silence is a still screen.
  const STALL_MIN_MS = 4_000;
  const STALL_MAX_MS = 30_000;
  let stallDelay = STALL_MIN_MS;
  let stallTimer: number | undefined;
  const me: Watcher = {
    sessionId: opts.sessionId,
    frame: onFrame,
    connected: () => void sync(true),
    failed: (e) => {
      if (watching) error.value = e;
    },
  };

  function pixelSize(): { width: number; height: number } {
    const dpr = window.devicePixelRatio || 1;
    return { width: Math.round(box.value.width * dpr), height: Math.round(box.value.height * dpr) };
  }

  async function sync(force = false): Promise<void> {
    const want = opts.active() && visible.value && box.value.width > 0 && box.value.height > 0;
    if (!want) {
      if (watching) unwatch();
      return;
    }
    if (watching && !force) return;
    watchers.add(me);
    watching = true;
    const s = connect();
    if (!s.connected) return; // `connect` re-runs this with force.
    const seq = ++watchSeq;
    window.clearTimeout(stallTimer);
    try {
      const reply = (await s.timeout(ACK_MS).emitWithAck('watch', { sessionId: opts.sessionId, ...pixelSize() })) as DeviceWatchReply;
      if (seq !== watchSeq) return;
      if (reply.ok) {
        runtime.value = reply.runtime;
        error.value = null;
        if (!frameSize.value) {
          stallTimer = window.setTimeout(() => {
            if (watching && !frameSize.value) void sync(true);
          }, stallDelay);
          stallDelay = Math.min(stallDelay * 2, STALL_MAX_MS);
        }
      } else error.value = reply.error;
    } catch (e) {
      if (seq === watchSeq) error.value = e instanceof Error ? e.message : String(e);
    }
  }

  function unwatch(): void {
    watching = false;
    watchSeq += 1;
    window.clearTimeout(stallTimer);
    stallDelay = STALL_MIN_MS;
    release(me);
  }

  function scheduleRewatch(): void {
    window.clearTimeout(rewatchTimer);
    rewatchTimer = window.setTimeout(() => void sync(true), REWATCH_MS);
  }

  watch([opts.active, visible], () => void sync());
  // The device went away (◼, a crash): its last frame no longer shows anything live.
  watch(opts.active, (on) => {
    if (on) return;
    runtime.value = null;
    error.value = null;
    clearScreen();
  });

  // ── Drawing ───────────────────────────────────────────────────────────────
  // A frame arriving while the previous one is still decoding replaces any frame already
  // waiting: the screen shows the newest, never a backlog.
  let decoding = false;
  let waiting: DeviceFrame | null = null;
  let bitmap: ImageBitmap | null = null;
  // RGB888 frames go through a canvas of the frame's own size, reused while the size holds, and
  // are then scaled onto the screen like a decoded JPEG.
  let rgbCanvas: HTMLCanvasElement | null = null;
  let rgbImage: ImageData | null = null;
  let source: CanvasImageSource | null = null;

  function onFrame(f: DeviceFrame): void {
    if (!watching) return;
    window.clearTimeout(stallTimer);
    stallDelay = STALL_MIN_MS;
    if (decoding) {
      waiting = f;
      return;
    }
    void decode(f);
  }

  async function decode(f: DeviceFrame): Promise<void> {
    decoding = true;
    try {
      const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
      if (f.kind === 'jpeg') {
        const next = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
        bitmap?.close();
        bitmap = next;
        source = next;
      } else {
        if (!rgbCanvas) rgbCanvas = document.createElement('canvas');
        if (!rgbImage || rgbImage.width !== f.width || rgbImage.height !== f.height) {
          rgbCanvas.width = f.width;
          rgbCanvas.height = f.height;
          rgbImage = new ImageData(f.width, f.height);
        }
        rgbToRgba(bytes, rgbImage.data, f.width * f.height);
        rgbCanvas.getContext('2d')?.putImageData(rgbImage, 0, 0);
        source = rgbCanvas;
      }
      if (watching) {
        if (frameSize.value?.width !== f.width || frameSize.value?.height !== f.height) frameSize.value = { width: f.width, height: f.height };
        paint();
      }
    } catch {
      // A frame that does not decode is skipped; the next one repaints.
    } finally {
      decoding = false;
      const next = waiting;
      waiting = null;
      if (next) void decode(next);
    }
  }

  function paint(): void {
    const canvas = opts.canvas.value;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!source || !frameSize.value) return;
    const r = fitRect(frameSize.value, { width: canvas.width, height: canvas.height });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, r.x, r.y, r.width, r.height);
  }

  function clearScreen(): void {
    bitmap?.close();
    bitmap = null;
    source = null;
    frameSize.value = null;
    paint();
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  function send(input: DeviceInput): void {
    if (!watching || !socket?.connected) return;
    socket.emit('input', { sessionId: opts.sessionId, input });
  }

  // Where the screen is drawn in the canvas, in CSS pixels: the last frame's aspect, else the
  // device's own before the first frame.
  function screenRect(): ScreenRect {
    const size = frameSize.value ?? runtime.value?.screen ?? null;
    return size ? fitRect(size, box.value) : { x: 0, y: 0, width: 0, height: 0 };
  }

  // A mouse event → fractions of the device screen; null on the letterbox (unless clamped).
  function pointAt(e: MouseEvent, clamp = false): { x: number; y: number } | null {
    const canvas = opts.canvas.value;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return screenPoint(e.clientX - r.left, e.clientY - r.top, screenRect(), clamp);
  }

  // A drag: begin where it went down, moves at most once per frame, end where it was released.
  let dragId: number | null = null;
  let last: { x: number; y: number } | null = null;
  let moveQueued = false;
  function flushMove(): void {
    moveQueued = false;
    if (dragId !== null && last) send({ type: 'touch', phase: 'move', ...last });
  }
  function onPointerDown(e: PointerEvent): void {
    if (opts.blocked() || e.button !== 0 || dragId !== null) return;
    const p = pointAt(e);
    if (!p) return;
    e.preventDefault();
    opts.canvas.value?.focus();
    opts.canvas.value?.setPointerCapture(e.pointerId);
    dragId = e.pointerId;
    last = p;
    send({ type: 'touch', phase: 'begin', ...p });
  }
  function onPointerMove(e: PointerEvent): void {
    if (e.pointerId !== dragId) return;
    last = pointAt(e, true);
    if (moveQueued) return;
    moveQueued = true;
    requestAnimationFrame(flushMove);
  }
  function endDrag(e: PointerEvent): void {
    if (e.pointerId !== dragId) return;
    const p = pointAt(e, true) ?? last;
    dragId = null;
    moveQueued = false;
    if (p) send({ type: 'touch', phase: 'end', ...p });
    last = null;
  }

  // Wheel steps add up within a frame and go as one `scroll` at the point under the cursor.
  let scroll: { x: number; y: number; dx: number; dy: number } | null = null;
  function onWheel(e: WheelEvent): void {
    if (opts.blocked()) return;
    const p = pointAt(e);
    const r = screenRect();
    if (!p || r.width <= 0) return;
    e.preventDefault();
    const dx = wheelPixels(e.deltaX, e.deltaMode, r.width) / r.width;
    const dy = wheelPixels(e.deltaY, e.deltaMode, r.height) / r.height;
    if (scroll) {
      scroll = { ...p, dx: scroll.dx + dx, dy: scroll.dy + dy };
      return;
    }
    scroll = { ...p, dx, dy };
    requestAnimationFrame(() => {
      if (scroll) send({ type: 'scroll', ...scroll });
      scroll = null;
    });
  }

  let text = '';
  let textTimer: number | undefined;
  function flushText(): void {
    window.clearTimeout(textTimer);
    if (text) send({ type: 'text', text });
    text = '';
  }
  function typeText(chunk: string): void {
    text += chunk;
    window.clearTimeout(textTimer);
    textTimer = window.setTimeout(flushText, TEXT_COALESCE_MS);
  }
  // Shortcuts with ⌘ / Ctrl stay the app's (⌘V arrives as `paste` below); Alt combinations that
  // type a character (macOS option layer) are text like any other key.
  function onKeyDown(e: KeyboardEvent): void {
    if (opts.blocked() || e.isComposing || e.metaKey || e.ctrlKey) return;
    if (NAMED_KEYS[e.key]) {
      e.preventDefault();
      flushText();
      send({ type: 'key', key: e.key });
    } else if ([...e.key].length === 1) {
      e.preventDefault();
      typeText(e.key);
    }
  }
  function onCompositionEnd(e: CompositionEvent): void {
    if (!opts.blocked() && e.data) typeText(e.data);
  }
  function onPaste(e: ClipboardEvent): void {
    if (opts.blocked() || document.activeElement !== opts.canvas.value) return;
    const pasted = e.clipboardData?.getData('text/plain');
    if (!pasted) return;
    e.preventDefault();
    typeText(pasted);
    flushText();
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  function onVisibility(): void {
    visible.value = document.visibilityState !== 'hidden';
  }
  const resize = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const { width, height } = entry.contentRect;
    if (width === box.value.width && height === box.value.height) return;
    box.value = { width, height };
    const canvas = opts.canvas.value;
    if (canvas) {
      const px = pixelSize();
      canvas.width = px.width;
      canvas.height = px.height;
      paint();
    }
    if (watching) scheduleRewatch();
    else void sync();
  });

  function attach(el: HTMLCanvasElement): void {
    resize.observe(el);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('lostpointercapture', endDrag);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('compositionend', onCompositionEnd);
  }
  function detach(el: HTMLCanvasElement): void {
    resize.unobserve(el);
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', endDrag);
    el.removeEventListener('pointercancel', endDrag);
    el.removeEventListener('lostpointercapture', endDrag);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('keydown', onKeyDown);
    el.removeEventListener('compositionend', onCompositionEnd);
  }
  // The canvas comes and goes with the device (the pane's empty states replace it).
  watch(
    opts.canvas,
    (el, old) => {
      if (old) detach(old);
      if (el) attach(el);
      else box.value = { width: 0, height: 0 };
    },
    { flush: 'post' },
  );

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('paste', onPaste);
  });
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('paste', onPaste);
    window.clearTimeout(rewatchTimer);
    flushText();
    if (watching) unwatch();
    resize.disconnect();
    if (opts.canvas.value) detach(opts.canvas.value);
    bitmap?.close();
    bitmap = null;
  });

  return { runtime, error, frameSize, send, pointAt };
}
