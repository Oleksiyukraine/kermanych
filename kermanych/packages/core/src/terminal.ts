// Lines a terminal keeps above its screen — in the ui's xterm view and in the api's
// headless copy that repaints a re-attaching view (apps/api/src/terminal/terminal.service.ts).
// One number, so a re-attach restores exactly what the view could have scrolled to.
export const TERMINAL_SCROLLBACK = 5000;
