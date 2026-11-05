// @vitest-environment happy-dom
// findRanges walks a rendered document (KDocPreview's Markdown) and needs real DOM Ranges.
import { describe, expect, it } from 'vitest';
import { findRanges } from '../src/lib/find-in-text';

function doc(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}
const texts = (ranges: Range[]) => ranges.map((r) => r.toString());

describe('findRanges', () => {
  it('finds matches in the rendered text, ignoring case by default', () => {
    const el = doc('<h1>Next.js</h1><p>Read the next guide.</p>');
    expect(texts(findRanges(el, 'next'))).toEqual(['Next', 'next']);
  });

  it('finds a match that crosses inline elements', () => {
    const el = doc('<p>run <code>next</code> dev</p>');
    const [range] = findRanges(el, 'run next dev');
    expect(range?.toString()).toBe('run next dev');
    expect(range?.startContainer.textContent).toBe('run ');
    expect(range?.endContainer.textContent).toBe(' dev');
  });

  it('does not join the end of one block to the start of the next', () => {
    const el = doc('<p>foo</p><p>bar</p>');
    expect(findRanges(el, 'foobar')).toEqual([]);
    expect(texts(findRanges(el, 'foo', { wholeWord: true }))).toEqual(['foo']);
  });

  it('honours match case and whole word', () => {
    const el = doc('<p>Next next nextjs</p>');
    expect(texts(findRanges(el, 'next', { matchCase: true }))).toEqual(['next', 'next']);
    expect(findRanges(el, 'next', { wholeWord: true })).toHaveLength(2);
  });

  it('finds nothing for an empty query', () => {
    expect(findRanges(doc('<p>x</p>'), '')).toEqual([]);
  });
});
