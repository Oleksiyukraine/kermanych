import { describe, expect, it } from 'vitest';
import {
  TODO_MAX_HTML,
  TODO_MAX_ITEMS,
  mergeTodo,
  newTodoItem,
  numberOf,
  sanitizeInline,
  todoPlainText,
  type TodoItem,
} from '../src/lib/home-todo';

const row = (over: Partial<TodoItem> = {}): TodoItem => ({
  id: 'x',
  kind: 'check',
  html: '',
  done: false,
  ...over,
});

describe('sanitizeInline', () => {
  it('keeps the inline vocabulary and strips its attributes', () => {
    expect(sanitizeInline('a <b>bold</b> and <em>soft</em><br>')).toBe(
      'a <b>bold</b> and <em>soft</em><br>',
    );
    expect(sanitizeInline('<b onclick="x()" style="color:red">bold</b>')).toBe('<b>bold</b>');
  });

  it('drops disallowed tags but keeps their text', () => {
    expect(sanitizeInline('<script>alert(1)</script><div>text</div>')).toBe('alert(1)text');
    expect(sanitizeInline('<span style="font-weight:700">heavy</span>')).toBe('heavy');
    expect(sanitizeInline('<img src=x onerror=alert(1)>after')).toBe('after');
  });

  it('escapes a stray < that opens no tag and is idempotent', () => {
    expect(sanitizeInline('1 < 2 and <b>ok</b>')).toBe('1 &lt; 2 and <b>ok</b>');
    const once = sanitizeInline('1 < 2 <i data-x="y">i</i><video>v</video>');
    expect(sanitizeInline(once)).toBe(once);
  });

  it('caps runaway input at TODO_MAX_HTML', () => {
    expect(sanitizeInline('a'.repeat(TODO_MAX_HTML + 100)).length).toBe(TODO_MAX_HTML);
  });
});

describe('numberOf', () => {
  it('counts a consecutive numbered run and restarts after a checklist row', () => {
    const items = [
      row({ kind: 'number' }),
      row({ kind: 'number' }),
      row({ kind: 'check' }),
      row({ kind: 'number' }),
    ];
    expect(numberOf(items, 0)).toBe(1);
    expect(numberOf(items, 1)).toBe(2);
    expect(numberOf(items, 2)).toBe(0);
    expect(numberOf(items, 3)).toBe(1);
  });
});

describe('mergeTodo', () => {
  it('returns an empty list for a missing or non-array blob', () => {
    expect(mergeTodo(null)).toEqual([]);
    expect(mergeTodo('nonsense')).toEqual([]);
    expect(mergeTodo({})).toEqual([]);
  });

  it('heals rows: unknown kind falls back, done only survives on check, html is sanitized', () => {
    const out = mergeTodo([
      { id: 'a', kind: 'ghost', html: '<div>x</div>', done: true },
      { id: 'b', kind: 'number', html: '<b>n</b>', done: true },
      { kind: 'check', html: 'no id' },
      { id: 'junk' }, // no html → dropped
      'nonsense',
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ id: 'a', kind: 'check', html: 'x', done: true });
    expect(out[1]).toEqual({ id: 'b', kind: 'number', html: '<b>n</b>', done: false });
    expect(out[2]!.kind).toBe('check');
    expect(out[2]!.id).not.toBe('');
  });

  it('caps the list at TODO_MAX_ITEMS', () => {
    const blob = Array.from({ length: TODO_MAX_ITEMS + 5 }, (_, i) => ({
      id: `i${i}`,
      kind: 'check',
      html: 'x',
    }));
    expect(mergeTodo(blob)).toHaveLength(TODO_MAX_ITEMS);
  });
});

describe('newTodoItem', () => {
  it('mints a fresh sanitized row of the asked kind', () => {
    const item = newTodoItem('number', '<div><b>x</b></div>');
    expect(item.kind).toBe('number');
    expect(item.html).toBe('<b>x</b>');
    expect(item.done).toBe(false);
    expect(item.id).not.toBe(newTodoItem('check').id);
  });
});

describe('todoPlainText', () => {
  it('sheds inline tags, decodes the entity vocabulary and collapses whitespace', () => {
    expect(todoPlainText('подзвонити <b>Олі</b>&nbsp;о <i>10</i>')).toBe('подзвонити Олі о 10');
    expect(todoPlainText('a&lt;b &amp; c&gt;d &quot;q&quot; &#39;s&#39;')).toBe('a<b & c>d "q" \'s\'');
    expect(todoPlainText('перший<br>другий')).toBe('перший другий');
    // Raw markup goes through the sanitizer first, so a stored blob cannot smuggle tags.
    expect(todoPlainText('<div onclick="x()">текст</div>')).toBe('текст');
  });
});
