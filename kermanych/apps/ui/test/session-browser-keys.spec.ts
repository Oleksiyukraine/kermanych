import { describe, expect, it } from 'vitest';
import { parseKey } from '../src-electron/session-browser/keys';

describe('parseKey', () => {
  it('maps named keys to their CDP key, code and virtual key code', () => {
    expect(parseKey('Enter', 'linux')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0, text: '\r' });
    expect(parseKey('Tab', 'linux')).toEqual({ key: 'Tab', code: 'Tab', keyCode: 9, modifiers: 0 });
    expect(parseKey('esc', 'linux')).toMatchObject({ key: 'Escape', code: 'Escape', keyCode: 27 });
    expect(parseKey('arrowdown', 'linux')).toMatchObject({ key: 'ArrowDown', keyCode: 40 });
    expect(parseKey('F5', 'linux')).toMatchObject({ key: 'F5', code: 'F5', keyCode: 116 });
    expect(parseKey('Space', 'linux')).toMatchObject({ key: ' ', code: 'Space', text: ' ' });
  });

  it('types single characters with their codes', () => {
    expect(parseKey('a', 'linux')).toEqual({ key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, text: 'a' });
    expect(parseKey('5', 'linux')).toEqual({ key: '5', code: 'Digit5', keyCode: 53, modifiers: 0, text: '5' });
    expect(parseKey('/', 'linux')).toEqual({ key: '/', code: 'Slash', keyCode: 191, modifiers: 0, text: '/' });
    expect(parseKey('é', 'linux')).toEqual({ key: 'é', code: '', keyCode: 0, modifiers: 0, text: 'é' });
  });

  it('combines modifiers into CDP bits; Shift alone still types, the others make a shortcut', () => {
    expect(parseKey('Shift+a', 'linux')).toMatchObject({ key: 'A', modifiers: 8, text: 'A' });
    expect(parseKey('shift+TAB', 'linux')).toEqual({ key: 'Tab', code: 'Tab', keyCode: 9, modifiers: 8 });
    expect(parseKey('Cmd+Option+Ctrl+Shift+x', 'linux').modifiers).toBe(15);
    expect(parseKey('Control+a', 'linux')).not.toHaveProperty('text');
    expect(parseKey('Alt+Space', 'linux')).not.toHaveProperty('text');
    // Enter submits with modifiers too (Ctrl+Enter in chat boxes), so it keeps its text.
    expect(parseKey('Control+Enter', 'linux')).toMatchObject({ modifiers: 2, text: '\r' });
  });

  it('reads ControlOrMeta per platform', () => {
    expect(parseKey('ControlOrMeta+c', 'darwin').modifiers).toBe(4);
    expect(parseKey('ControlOrMeta+c', 'linux').modifiers).toBe(2);
    expect(parseKey('ControlOrMeta+c', 'win32').modifiers).toBe(2);
  });

  it('adds the macOS editing command to Cmd shortcuts only on darwin', () => {
    expect(parseKey('Meta+a', 'darwin')).toEqual({ key: 'a', code: 'KeyA', keyCode: 65, modifiers: 4, commands: ['selectAll'] });
    expect(parseKey('Cmd+v', 'darwin').commands).toEqual(['paste']);
    expect(parseKey('Meta+z', 'darwin').commands).toEqual(['undo']);
    expect(parseKey('Meta+Shift+z', 'darwin').commands).toEqual(['redo']);
    expect(parseKey('Meta+a', 'linux')).not.toHaveProperty('commands');
    // Not a plain Cmd shortcut: no command.
    expect(parseKey('Meta+Alt+a', 'darwin')).not.toHaveProperty('commands');
    expect(parseKey('Control+a', 'darwin')).not.toHaveProperty('commands');
  });

  it('rejects empty and unknown keys with a hint', () => {
    expect(() => parseKey('', 'linux')).toThrow('Empty key ""');
    expect(() => parseKey('   ', 'linux')).toThrow('Empty key');
    expect(() => parseKey('Foo', 'linux')).toThrow(/Unknown key "Foo" — use a KeyboardEvent\.key name/);
    expect(() => parseKey('Meta+', 'linux')).toThrow('Unknown key "Meta+"');
  });
});
