// The main window's geometry across launches: its last normal bounds, and whether it was
// maximized or full screen. Kept in userData like the theme file (window-theme.json) — main
// needs it before the window exists, when the renderer's localStorage is out of reach.
//
// A saved position is used only when it still lands on a connected display: a window last
// left on an external monitor that is gone now would otherwise open off screen.
import { BrowserWindow, screen, type Rectangle } from 'electron';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

export type WindowState = {
  bounds: Rectangle;
  maximized: boolean;
  fullScreen: boolean;
};

const DEFAULT_SIZE = { width: 1400, height: 900 };
const MIN_VISIBLE = 64; // px of the window that must overlap a display to count as on screen
const SAVE_DELAY_MS = 400;

function onSomeDisplay(b: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w >= MIN_VISIBLE && h >= MIN_VISIBLE;
  });
}

function isRect(v: unknown): v is Rectangle {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]));
}

/** The options to open the window with: the saved size, and the saved place when it is visible. */
export function readWindowState(file: string): { bounds: Partial<Rectangle> & { width: number; height: number }; maximized: boolean; fullScreen: boolean } {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<WindowState>;
    if (isRect(raw.bounds) && raw.bounds.width >= 400 && raw.bounds.height >= 300) {
      const b = raw.bounds;
      return {
        bounds: onSomeDisplay(b) ? b : { width: b.width, height: b.height },
        maximized: raw.maximized === true,
        fullScreen: raw.fullScreen === true,
      };
    }
  } catch {
    /* first launch or an unreadable file: the default size, centred */
  }
  return { bounds: { ...DEFAULT_SIZE }, maximized: false, fullScreen: false };
}

/**
 * Saves the window's state on every move/resize (debounced) and on close. The bounds kept are
 * the NORMAL ones (`getNormalBounds`), so un-maximizing after the next launch returns to the
 * size the operator chose, not to the screen size.
 */
export function trackWindowState(win: BrowserWindow, file: string): void {
  let timer: NodeJS.Timeout | undefined;
  const snapshot = (): WindowState => ({
    bounds: win.getNormalBounds(),
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
  });
  const save = (state: WindowState): void => {
    void writeFile(file, JSON.stringify(state)).catch(() => {});
  };
  const later = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!win.isDestroyed()) save(snapshot());
    }, SAVE_DELAY_MS);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
    win.on(ev as 'resize', later);
  }
  // `close`, not `closed`: the window's geometry can still be read here.
  win.on('close', () => {
    clearTimeout(timer);
    save(snapshot());
  });
}
