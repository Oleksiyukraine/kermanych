import { describe, expect, it } from 'vitest';
import { SYNERGY_CONTEXT_MARK, synergyRequestOf } from '@kermanych/core';
import type { TrayPick } from '../src/lib/browser-picks';
import { synergyOutgoing } from '../src/lib/synergy-outgoing';

// «Синергія», decision 8 (docs/specs/2026-11-06-synergy.md): what a request to a Синергія
// session carries, whichever way it was sent.
function pick(comment = ''): TrayPick {
  return {
    id: Math.random().toString(36),
    comment,
    pick: {
      url: 'http://localhost:5173/users/42',
      selector: 'main > button.save',
      tag: 'BUTTON',
      text: 'Зберегти',
      html: '',
      styles: {},
      rect: { x: 0, y: 0, width: 10, height: 10 },
      viewport: { width: 1280, height: 800 },
      scroll: { x: 0, y: 0 },
      more: false,
      screenshot: { data: 'iVBORw0KGgo=', mimeType: 'image/png', path: '/tmp/p.png' },
    },
  };
}

const PAGE = 'http://localhost:5173/users/42';

describe('synergyOutgoing', () => {
  it('adds the current page to a typed request with an empty tray', () => {
    const out = synergyOutgoing('прибери кнопку', [], { page: PAGE, picks: [] });
    expect(synergyRequestOf(out.text)).toEqual({ request: 'прибери кнопку', page: PAGE });
    expect(out.images).toEqual([]);
  });

  it('attaches the picks and their crops after the operator’s images, with the general comment', () => {
    const own = { data: 'AAAA', mimeType: 'image/png' as const };
    const out = synergyOutgoing('оце перемісти ліворуч', [own], { page: PAGE, picks: [pick()], note: 'обидві' });
    expect(synergyRequestOf(out.text).request).toBe('оце перемісти ліворуч');
    expect(out.text).toContain(SYNERGY_CONTEXT_MARK);
    expect(out.text).toContain('Загальний коментар: обидві');
    expect(out.text).toContain('main > button.save');
    expect(out.images).toEqual([own, { data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
  });

  it('makes the tray’s comment the request when nothing was typed («Надіслати агенту»), not repeating it', () => {
    const out = synergyOutgoing('', [], { page: PAGE, picks: [pick()], note: 'прибери це' });
    expect(synergyRequestOf(out.text).request).toBe('прибери це');
    expect(out.text).not.toContain('Загальний коментар');
  });

  it('leaves a message with no page and no picks as the words alone', () => {
    expect(synergyOutgoing(' зроби темнішим ', [], { picks: [] }).text).toBe('зроби темнішим');
  });
});
