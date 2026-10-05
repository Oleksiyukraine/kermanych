import { describe, expect, it } from 'vitest';
import { composePicksMessage, picksImages, type TrayPick } from '../src/lib/browser-picks';

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
    for (const label of ['Коментар:', 'Компонент:', 'Текст:', 'Стилі:', 'HTML:', 'Скриншот:']) {
      expect(msg).not.toContain(label);
    }
    expect(msg).toContain('Сторінка:');
    expect(msg).toContain('Селектор:');
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
