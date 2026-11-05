import { describe, expect, it } from 'vitest';
import { FIND_MAX_HITS, findHits, markHtml } from '../src/lib/find-in-text';

describe('findHits', () => {
  it('finds every match by line and column, ignoring case by default', () => {
    expect(findHits(['Foo foo', 'bar', 'FOO'], 'foo')).toEqual([
      { line: 0, start: 0, end: 3 },
      { line: 0, start: 4, end: 7 },
      { line: 2, start: 0, end: 3 },
    ]);
  });

  it('matches case when asked to', () => {
    expect(findHits(['Foo foo'], 'foo', { matchCase: true })).toEqual([{ line: 0, start: 4, end: 7 }]);
  });

  it('matches whole words only when asked to', () => {
    expect(findHits(['id idx _id id.x (id)', 'id'], 'id', { wholeWord: true })).toEqual([
      { line: 0, start: 0, end: 2 },
      { line: 0, start: 11, end: 13 },
      { line: 0, start: 17, end: 19 },
      { line: 1, start: 0, end: 2 },
    ]);
  });

  it('treats letters of any script and digits as word characters', () => {
    expect(findHits(['кіт кітець 2кіт кіт'], 'кіт', { wholeWord: true })).toEqual([
      { line: 0, start: 0, end: 3 },
      { line: 0, start: 16, end: 19 },
    ]);
  });

  it('keeps looking past a rejected match that overlaps a whole word', () => {
    expect(findHits(['aa a'], 'a', { wholeWord: true })).toEqual([{ line: 0, start: 3, end: 4 }]);
    expect(findHits(['aaa-aa'], 'aa', { wholeWord: true })).toEqual([{ line: 0, start: 4, end: 6 }]);
  });

  it('does not overlap matches', () => {
    expect(findHits(['aaaa'], 'aa')).toEqual([
      { line: 0, start: 0, end: 2 },
      { line: 0, start: 2, end: 4 },
    ]);
  });

  it('finds nothing for an empty query', () => {
    expect(findHits(['abc'], '')).toEqual([]);
  });

  it('stops at the cap', () => {
    expect(findHits(['a'.repeat(FIND_MAX_HITS + 50)], 'a')).toHaveLength(FIND_MAX_HITS);
  });
});

describe('markHtml', () => {
  it('wraps a range of plain text', () => {
    expect(markHtml('hello world', [{ start: 6, end: 11, cls: 'hit' }])).toBe('hello <mark class="hit">world</mark>');
  });

  it('counts an entity as one character', () => {
    expect(markHtml('a &lt;b&gt; c', [{ start: 2, end: 5, cls: 'hit' }])).toBe(
      'a <mark class="hit">&lt;b&gt;</mark> c',
    );
  });

  it('closes and reopens the mark around tags it crosses, so nesting stays valid', () => {
    const html = '<span class="hljs-attr">&quot;name&quot;</span>: <span class="hljs-string">&quot;x&quot;</span>';
    // `name": "x` — from inside the key across into the value.
    expect(markHtml(html, [{ start: 1, end: 10, cls: 'hit' }])).toBe(
      '<span class="hljs-attr">&quot;<mark class="hit">name&quot;</mark></span><mark class="hit">: </mark>'
        + '<span class="hljs-string"><mark class="hit">&quot;x</mark>&quot;</span>',
    );
  });

  it('marks several ranges with their own classes', () => {
    expect(markHtml('ab ab', [
      { start: 0, end: 2, cls: 'a' },
      { start: 3, end: 5, cls: 'b' },
    ])).toBe('<mark class="a">ab</mark> <mark class="b">ab</mark>');
  });

  it('leaves html without ranges alone', () => {
    expect(markHtml('<span>x</span>', [])).toBe('<span>x</span>');
  });
});
