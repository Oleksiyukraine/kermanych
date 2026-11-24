// Prototype fixtures for docs/design/2026-11-24-status-line-redo. Nothing here calls the api.
export type StageState = 'done' | 'running' | 'waiting' | 'failed' | 'todo';
export type Stage = { key: string; label: string; state: StageState; note?: string };
export type Check = { state: StageState; text: string; action?: string };

export type Fixture = {
  title: string;
  branch: string;
  /** The one status word (what KStatusDot + the card row show today). */
  status: string;
  tone: 'running' | 'waiting' | 'done' | 'error' | 'cold';
  /** One sentence: what is going on and what the operator owes. */
  headline: string;
  action?: string;
  stages: Stage[];
  checks: Check[];
};

const STAGES = (s: Partial<Record<string, [StageState, string?]>>): Stage[] =>
  (
    [
      ['task', 'Задача'],
      ['work', 'Агент'],
      ['pr', 'ПР'],
      ['ci', 'CI'],
      ['review', 'Ревʼю'],
      ['merge', 'Злиття'],
    ] as const
  ).map(([key, label]) => {
    const [state, note] = s[key] ?? ['todo'];
    return note === undefined ? { key, label, state } : { key, label, state, note };
  });

export const FIXTURES: Record<string, Fixture> = {
  working: {
    title: 'Пагінація списку',
    branch: 'feature/pagination',
    status: 'виконує',
    tone: 'running',
    headline: 'Агент працює · bash: pnpm test · тиша 12 с',
    stages: STAGES({ task: ['done'], work: ['running', 'pnpm test · 4 хв'] }),
    checks: [
      { state: 'running', text: 'Агент працює — bash: pnpm test, 4 хв' },
      { state: 'todo', text: 'ПР ще не відкрито' },
    ],
  },
  waiting: {
    title: 'Пагінація списку',
    branch: 'feature/pagination',
    status: 'чекає',
    tone: 'waiting',
    headline: 'Агент чекає вашої відповіді · 5 хв',
    action: 'Відповісти',
    stages: STAGES({ task: ['done'], work: ['waiting', 'питання · 5 хв'] }),
    checks: [
      { state: 'waiting', text: 'Агент поставив питання 5 хв тому', action: 'Відповісти' },
      { state: 'todo', text: 'ПР ще не відкрито' },
    ],
  },
  review: {
    title: 'Пагінація списку',
    branch: 'feature/pagination',
    status: 'на ревʼю',
    tone: 'waiting',
    headline: 'ПР #41 · CI йде 3/4 · 2 нових коментарі',
    stages: STAGES({
      task: ['done'],
      work: ['done'],
      pr: ['done', '#41'],
      ci: ['running', '3/4'],
      review: ['waiting', '2 коментарі'],
    }),
    checks: [
      { state: 'running', text: 'CI: 3 з 4 перевірок пройшли, e2e ще йде' },
      { state: 'waiting', text: 'Ревʼю: 2 нових коментарі, агент їх отримає після CI' },
      { state: 'done', text: 'Конфліктів з dev немає' },
      { state: 'todo', text: 'Петля: авто · коло 1 з 3' },
    ],
  },
  failed: {
    title: 'Пагінація списку',
    branch: 'feature/pagination',
    status: 'на ревʼю',
    tone: 'error',
    headline: 'ПР #41 · CI впав: e2e · петля на паузі',
    action: 'Продовжити петлю',
    stages: STAGES({
      task: ['done'],
      work: ['done'],
      pr: ['done', '#41'],
      ci: ['failed', '1 з 4 впала'],
      review: ['todo'],
    }),
    checks: [
      { state: 'failed', text: 'CI: впала e2e (1 з 4)' },
      { state: 'done', text: 'Ревʼю: approved' },
      { state: 'done', text: 'Конфліктів з dev немає' },
      { state: 'failed', text: 'Петля на паузі: 3 кола без вас', action: 'Продовжити петлю' },
    ],
  },
  ready: {
    title: 'Пагінація списку',
    branch: 'feature/pagination',
    status: 'на ревʼю',
    tone: 'done',
    headline: 'ПР #41 готовий до злиття',
    action: 'Відкрити ПР',
    stages: STAGES({
      task: ['done'],
      work: ['done'],
      pr: ['done', '#41'],
      ci: ['done', '4/4'],
      review: ['done', 'approved'],
      merge: ['waiting', 'можна зливати'],
    }),
    checks: [
      { state: 'done', text: 'CI: 4 з 4 пройшли' },
      { state: 'done', text: 'Ревʼю: approved' },
      { state: 'done', text: 'Конфліктів з dev немає' },
    ],
  },
};

export const STATES = Object.keys(FIXTURES);
