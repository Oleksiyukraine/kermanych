import { describe, expect, it } from 'vitest';
import {
  composePicksMessage,
  loadPicksTray,
  picksImages,
  PICKS_STORAGE_KEY,
  savePicksTray,
  type TrayPick,
} from '../src/lib/browser-picks';

function pick(over: Partial<KermanychBrowserPick> = {}, comment = ''): TrayPick {
  return {
    id: Math.random().toString(36),
    comment,
    pick: {
      url: 'http://localhost:5173/board',
      selector: 'main > .card:nth-child(2)',
      tag: 'DIV',
      text: '',
      html: '',
      styles: {},
      rect: { x: 0, y: 0, width: 10, height: 10 },
      viewport: { width: 1280, height: 800 },
      scroll: { x: 0, y: 0 },
      more: false,
      ...over,
    },
  };
}

const shot = { data: 'iVBORw0KGgo=', mimeType: 'image/png' as const, path: '/tmp/kermanych-browser/s1/pick-1.png' };

describe('composePicksMessage', () => {
  it('gives a native session the screenshot path and a managed one a pointer to the attached image', () => {
    const picks = [pick({ screenshot: shot })];
    const native = composePicksMessage(picks, { native: true });
    const managed = composePicksMessage(picks, { native: false });
    expect(native).toContain(`Скриншот: ${shot.path}`);
    expect(managed).not.toContain(shot.path);
    expect(managed).toContain('Скриншот: зображення 1 у вкладенні');
    expect(picksImages(picks, { native: true })).toEqual([]);
    expect(picksImages(picks, { native: false })).toEqual([{ data: shot.data, mimeType: 'image/png' }]);
  });

  it('numbers every pick and counts attached images only over picks that have a screenshot', () => {
    const msg = composePicksMessage(
      [pick({ screenshot: shot }, 'перший'), pick({}, 'другий'), pick({ screenshot: shot }, 'третій')],
      { native: false },
    );
    expect(msg.startsWith('Елементи, вказані на сторінці в браузері сесії (3):')).toBe(true);
    const sections = msg.split(/\n(?=## Елемент )/).slice(1);
    expect(sections.map((s) => s.split('\n')[0])).toEqual(['## Елемент 1', '## Елемент 2', '## Елемент 3']);
    expect(sections[0]).toContain('Коментар: перший');
    expect(sections[0]).toContain('зображення 1 у вкладенні');
    expect(sections[1]).not.toContain('Скриншот');
    expect(sections[2]).toContain('зображення 2 у вкладенні');
  });

  it('writes every field a pick carries', () => {
    const msg = composePicksMessage(
      [
        pick(
          {
            text: '  Зберегти \n  зміни ',
            html: '<button class="btn">Зберегти зміни</button>',
            styles: { display: 'flex', color: 'rgb(0, 0, 0)' },
            source: { file: 'src/components/SaveBar.vue', line: 12, component: 'SaveBar' },
          },
          '  кнопка зʼїхала  ',
        ),
      ],
      { native: false },
    );
    expect(msg).toContain('Коментар: кнопка зʼїхала\n');
    expect(msg).toContain('Сторінка: http://localhost:5173/board');
    expect(msg).toContain('Селектор: `main > .card:nth-child(2)` (<div>)');
    expect(msg).toContain('Компонент: SaveBar — src/components/SaveBar.vue:12');
    expect(msg).toContain('Текст: «Зберегти зміни»');
    expect(msg).toContain('Стилі: display: flex; color: rgb(0, 0, 0)');
    expect(msg).toContain('HTML:\n```html\n<button class="btn">Зберегти зміни</button>\n```');
  });

  it('omits the lines of fields a pick does not have', () => {
    const msg = composePicksMessage([pick()], { native: true });
    for (const label of ['Загальний коментар:', 'Коментар:', 'Фрейм:', 'Компонент:', 'Текст:', 'Стилі:', 'HTML:', 'Скриншот:']) {
      expect(msg).not.toContain(label);
    }
    expect(msg).toContain('Сторінка:');
    expect(msg).toContain('Селектор:');
  });

  it('states the window, scroll offset and element box the operator saw, and the frame when there is one', () => {
    const msg = composePicksMessage(
      [
        pick({
          frame: 'http://localhost:5173/embed',
          viewport: { width: 390, height: 844 },
          scroll: { x: 0, y: 1200 },
          rect: { x: 12.4, y: 300.6, width: 366, height: 48 },
        }),
      ],
      { native: false },
    );
    expect(msg).toMatch(/^Фрейм: http:\/\/localhost:5173\/embed$/m);
    expect(msg).toMatch(/^Вікно: 390×844, прокрутка 0,1200$/m);
    expect(msg).toMatch(/^Розташування: 12,301 366×48$/m);
  });

  it('puts the general comment first, before the element list, and ignores a blank one', () => {
    const msg = composePicksMessage([pick()], { native: false, comment: '  весь хедер з’їхав  ' });
    expect(msg.split('\n\n')[0]).toBe('Загальний коментар: весь хедер з’їхав');
    expect(msg.split('\n\n')[1]).toMatch(/^Елементи, вказані/);
    expect(composePicksMessage([pick()], { native: false, comment: '   ' })).not.toContain('Загальний коментар');
  });

  it('names a crop that lost its image bytes by its file path, even for a managed session', () => {
    const picks = [pick({ screenshot: { ...shot, data: '' } }), pick({ screenshot: shot })];
    const msg = composePicksMessage(picks, { native: false });
    const sections = msg.split(/\n(?=## Елемент )/).slice(1);
    expect(sections[0]).toContain(`Скриншот: ${shot.path}`);
    expect(sections[1]).toContain('Скриншот: зображення 1 у вкладенні');
    expect(picksImages(picks, { native: false })).toEqual([{ data: shot.data, mimeType: 'image/png' }]);
  });

  it('names a component source without a line or component name by its file alone', () => {
    const msg = composePicksMessage([pick({ source: { file: 'src/App.svelte' } })], { native: false });
    expect(msg).toMatch(/^Компонент: src\/App\.svelte$/m);
  });

  it('fences HTML that itself contains a backtick fence with a longer one', () => {
    const html = '<pre>```js\nlet a = 1;\n```</pre><code>````</code>';
    const msg = composePicksMessage([pick({ html })], { native: false });
    expect(msg).toContain(`HTML:\n\`\`\`\`\`html\n${html}\n\`\`\`\`\``);
  });
});

// A Storage double whose setItem refuses values past `limit` characters, like a full quota.
function storage(limit = Number.POSITIVE_INFINITY): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => {
      if (v.length > limit) throw new DOMException('quota', 'QuotaExceededError');
      data.set(k, v);
    },
  };
}

describe('picks tray persistence', () => {
  it('round-trips picks and general comments', () => {
    const s = storage();
    const tray = { picks: { s1: [pick({ screenshot: shot }, 'зламано')] }, notes: { s1: 'загальне' } };
    savePicksTray(s, tray);
    expect(loadPicksTray(s)).toEqual(tray);
  });

  it('drops the image bytes but keeps the file path when the full tray does not fit', () => {
    const big = { ...shot, data: 'A'.repeat(10_000) };
    const s = storage(5_000);
    savePicksTray(s, { picks: { s1: [pick({ screenshot: big })] }, notes: {} });
    const restored = loadPicksTray(s).picks.s1![0]!.pick.screenshot;
    expect(restored).toEqual({ ...big, data: '' });
  });

  it('never throws: a tray that fits in no form leaves nothing stale behind', () => {
    const s = storage(10);
    s.data.set(PICKS_STORAGE_KEY, 'stale');
    expect(() => savePicksTray(s, { picks: { s1: [pick()] }, notes: {} })).not.toThrow();
    expect(s.data.has(PICKS_STORAGE_KEY)).toBe(false);
  });

  it('clears the key once every tray is empty', () => {
    const s = storage();
    savePicksTray(s, { picks: { s1: [pick()] }, notes: {} });
    savePicksTray(s, { picks: {}, notes: {} });
    expect(s.data.has(PICKS_STORAGE_KEY)).toBe(false);
  });

  it('reads a missing or corrupt value as an empty tray', () => {
    const s = storage();
    expect(loadPicksTray(s)).toEqual({ picks: {}, notes: {} });
    s.data.set(PICKS_STORAGE_KEY, '{not json');
    expect(loadPicksTray(s)).toEqual({ picks: {}, notes: {} });
  });
});
