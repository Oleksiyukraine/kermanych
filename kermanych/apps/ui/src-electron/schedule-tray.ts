// Background mode while scheduled tasks are active (docs/specs/2026-11-06-scheduled-tasks.md,
// decision 4). The api reports, through `bootstrap({ schedules })`, whether any scheduled task is
// enabled and which one fires next. While one is, closing the window only hides it (main asks
// `keepsRunning`), and a menu-bar icon offers «Відкрити Керманич», the next firing and
// «Завершити». With none enabled the icon goes and closing quits as before.
//
// Main has no word of the renderer's language, so the labels follow the system one: Ukrainian for
// `uk*`, English otherwise.
import { app, Menu, nativeImage, Tray, type NativeImage } from 'electron';
import type { ScheduleTrayState } from '@kermanych/core';

type Labels = { open: string; none: string; quit: string; tooltip: string };

const UK: Labels = { open: 'Відкрити Керманич', none: 'Немає найближчих', quit: 'Завершити', tooltip: 'Керманич' };
const EN: Labels = { open: 'Open Kermanych', none: 'Nothing scheduled', quit: 'Quit', tooltip: 'Kermanych' };

export type ScheduleTrayOptions = {
  /** The tray image's candidate paths, the first that loads wins (packaged, then dev source tree). */
  iconPaths: string[];
  /** Show and focus the main window. */
  open: () => void;
  /** The real quit (main sets its `quitting` flag through `before-quit`). */
  quit: () => void;
  /** Called after the tray stops being active, e.g. to surface a hidden window. */
  onInactive?: () => void;
};

export class ScheduleTray {
  private state: ScheduleTrayState = { active: false };
  private tray: Tray | undefined;
  private icon: NativeImage | undefined;
  private readonly labels: Labels;
  private readonly locale: string;

  constructor(private readonly opts: ScheduleTrayOptions) {
    const system = app.getLocale();
    const uk = /^uk\b/i.test(system);
    this.labels = uk ? UK : EN;
    this.locale = uk ? 'uk' : 'en';
  }

  /** True while any scheduled task is enabled: closing the window hides it instead of quitting. */
  get keepsRunning(): boolean {
    return this.state.active;
  }

  /** The api's latest report. Safe to call before the app is ready; the tray appears once it is. */
  update(next: ScheduleTrayState): void {
    const wasActive = this.state.active;
    this.state = next;
    if (!app.isReady()) {
      void app.whenReady().then(() => this.render());
      return;
    }
    this.render();
    if (wasActive && !next.active) this.opts.onInactive?.();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = undefined;
  }

  private render(): void {
    if (!this.state.active) {
      this.destroy();
      return;
    }
    if (!this.tray) {
      const icon = this.loadIcon();
      if (!icon) return;
      this.tray = new Tray(icon);
      this.tray.setToolTip(this.labels.tooltip);
      // macOS and Windows: a click opens the window, the secondary click shows the menu. Linux's
      // AppIndicator has no click events, so the menu is attached there and opens on any click.
      if (process.platform !== 'linux') {
        this.tray.on('click', () => this.opts.open());
        this.tray.on('right-click', () => this.tray?.popUpContextMenu(this.menu()));
      }
    }
    if (process.platform === 'linux') this.tray.setContextMenu(this.menu());
  }

  private menu(): Menu {
    return Menu.buildFromTemplate([
      { label: this.labels.open, click: () => this.opts.open() },
      { label: this.nextLine(), enabled: false },
      { type: 'separator' },
      { label: this.labels.quit, click: () => this.opts.quit() },
    ]);
  }

  // «Вітаміни · 19:00» today, «Вітаміни · 7 лист. 19:00» on another day (the system's time zone).
  private nextLine(): string {
    const next = this.state.next;
    if (!next) return this.labels.none;
    const at = new Date(next.at);
    if (Number.isNaN(at.getTime())) return this.labels.none;
    const time = new Intl.DateTimeFormat(this.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
    const now = new Date();
    const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
    const when = sameDay ? time : `${new Intl.DateTimeFormat(this.locale, { day: 'numeric', month: 'short' }).format(at)} ${time}`;
    return `${next.name} · ${when}`;
  }

  private loadIcon(): NativeImage | undefined {
    if (this.icon) return this.icon;
    for (const p of this.opts.iconPaths) {
      // `trayTemplate.png` + `trayTemplate@2x.png`: the @2x file is picked up for Retina, and the
      // `Template` suffix makes macOS tint the black glyph for a light or dark menu bar.
      const image = nativeImage.createFromPath(p);
      if (image.isEmpty()) continue;
      if (process.platform === 'darwin') image.setTemplateImage(true);
      this.icon = image;
      return image;
    }
    return undefined;
  }
}
