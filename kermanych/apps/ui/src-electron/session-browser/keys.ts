// Key combinations (`Enter`, `Shift+Tab`, `Meta+a`) as CDP Input.dispatchKeyEvent fields. Pure.

// CDP `Input.dispatchKeyEvent` fields for one key combination (`Enter`, `Shift+Tab`, `Meta+a`).
export interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  modifiers: number; // CDP bits: Alt 1, Control 2, Meta 4, Shift 8
  text?: string;
  // macOS editing commands: Chromium does not map Cmd shortcuts of synthetic key events itself.
  commands?: string[];
}

const NAMED_KEYS: Record<string, [key: string, code: string, keyCode: number, text?: string]> = {
  enter: ['Enter', 'Enter', 13, '\r'],
  tab: ['Tab', 'Tab', 9],
  backspace: ['Backspace', 'Backspace', 8],
  delete: ['Delete', 'Delete', 46],
  escape: ['Escape', 'Escape', 27],
  esc: ['Escape', 'Escape', 27],
  space: [' ', 'Space', 32, ' '],
  ' ': [' ', 'Space', 32, ' '],
  arrowup: ['ArrowUp', 'ArrowUp', 38],
  arrowdown: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
  arrowright: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36],
  end: ['End', 'End', 35],
  pageup: ['PageUp', 'PageUp', 33],
  pagedown: ['PageDown', 'PageDown', 34],
  insert: ['Insert', 'Insert', 45],
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`f${i}`] = [`F${i}`, `F${i}`, 111 + i];

const PUNCTUATION: Record<string, [code: string, keyCode: number]> = {
  '-': ['Minus', 189], '=': ['Equal', 187], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191],
  ';': ['Semicolon', 186], "'": ['Quote', 222], '[': ['BracketLeft', 219], ']': ['BracketRight', 221],
  '\\': ['Backslash', 220], '`': ['Backquote', 192],
};

const MAC_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };

export function parseKey(combo: string, platform: NodeJS.Platform = process.platform): KeySpec {
  const m = /^((?:(?:Meta|Cmd|Command|Control|Ctrl|ControlOrMeta|Alt|Option|Shift)\+)*)(.+)$/i.exec(combo.trim());
  if (!m || !m[2]) throw new Error(`Empty key "${combo}"`);
  let modifiers = 0;
  for (const raw of m[1]!.split('+').filter(Boolean)) {
    const mod = raw.toLowerCase();
    if (mod === 'alt' || mod === 'option') modifiers |= 1;
    else if (mod === 'control' || mod === 'ctrl') modifiers |= 2;
    else if (mod === 'meta' || mod === 'cmd' || mod === 'command') modifiers |= 4;
    else if (mod === 'shift') modifiers |= 8;
    else modifiers |= platform === 'darwin' ? 4 : 2; // ControlOrMeta
  }
  const name = m[2];
  // A modified key is a shortcut, not typing: it must not insert its character.
  const typing = (modifiers & 7) === 0;
  const named = NAMED_KEYS[name.toLowerCase()];
  let spec: KeySpec;
  if (named) {
    const [key, code, keyCode, text] = named;
    spec = { key, code, keyCode, modifiers, ...(text && (typing || key === 'Enter') ? { text } : {}) };
  } else if ([...name].length === 1) {
    const shifted = (modifiers & 8) !== 0;
    let key = name, code = '', keyCode = 0;
    if (/^[a-z]$/i.test(name)) {
      key = shifted ? name.toUpperCase() : name;
      code = `Key${name.toUpperCase()}`;
      keyCode = name.toUpperCase().charCodeAt(0);
    } else if (/^[0-9]$/.test(name)) {
      code = `Digit${name}`;
      keyCode = name.charCodeAt(0);
    } else if (PUNCTUATION[name]) {
      [code, keyCode] = PUNCTUATION[name];
    }
    spec = { key, code, keyCode, modifiers, ...(typing ? { text: key } : {}) };
    const command = MAC_COMMANDS[name.toLowerCase()];
    if (platform === 'darwin' && command && (modifiers & 7) === 4) {
      spec.commands = [command === 'undo' && shifted ? 'redo' : command];
    }
  } else {
    throw new Error(`Unknown key "${name}" — use a KeyboardEvent.key name (Enter, Escape, Tab, ArrowDown, PageDown, F5, …) or a single character, optionally with Meta+/Control+/Alt+/Shift+`);
  }
  return spec;
}
