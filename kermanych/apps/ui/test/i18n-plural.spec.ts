// @vitest-environment happy-dom
// boot/i18n.ts reads the stored locale from `localStorage` when it creates the instance, so
// this spec runs under a DOM environment that provides Web Storage.
import { describe, it, expect } from 'vitest';
import { i18n } from '../src/boot/i18n';

const t = (key: string, named: Record<string, unknown>, n: number) => {
  i18n.global.locale.value = 'uk';
  return i18n.global.t(key, named, n);
};

const todoAdded = (n: number) => t('management.chat.todoAdded', { n, items: 'x' }, n);

describe('uk plural forms', () => {
  it.each([1, 21, 31, 101])('n=%i takes the first form', (n) => {
    expect(todoAdded(n)).toBe(`Додано ${n} пункт до списку дій: x`);
  });

  it.each([2, 3, 4, 22, 23, 24, 102])('n=%i takes the second form', (n) => {
    expect(todoAdded(n)).toBe(`Додано ${n} пункти до списку дій: x`);
  });

  it.each([0, 5, 11, 12, 13, 14, 19, 20, 25, 30, 111, 112])('n=%i takes the third form', (n) => {
    expect(todoAdded(n)).toBe(`Додано ${n} пунктів до списку дій: x`);
  });

  it('keeps the built-in singular | plural choice for a two-form message', () => {
    const helper = (n: number) => t('notices.helper_added_instruction', { names: 'a' }, n);
    expect(helper(1)).toBe('хелпер a додав настанову');
    expect(helper(2)).toBe('хелпери a додали настанову');
    expect(helper(0)).toBe('хелпери a додали настанову');
  });
});
