// @vitest-environment happy-dom
// lib/drafts.ts keeps its drafts in one localStorage entry read at import, so every case imports
// a fresh module over the storage it sets up — the same way the app reads it on a restart.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type * as Drafts from '../src/lib/drafts';

async function freshDrafts(): Promise<typeof Drafts> {
  vi.resetModules();
  return import('../src/lib/drafts');
}

beforeEach(() => localStorage.clear());

describe('useDraft', () => {
  it('keeps each target its own text when the form switches between them', async () => {
    const { useDraft } = await freshDrafts();
    const text = ref('');
    const d = useDraft({ text });
    d.bind('session:a', { text: '' });
    text.value = 'for a';
    d.bind('session:b', { text: '' });
    expect(text.value).toBe('');
    text.value = 'for b';
    d.bind('session:a', { text: '' });
    expect(text.value).toBe('for a');
    d.bind('session:b', { text: '' });
    expect(text.value).toBe('for b');
  });

  it('survives a restart and is gone once the text is back to what the form opened with', async () => {
    let lib = await freshDrafts();
    const text = ref('');
    lib.useDraft({ text }).bind('session:a', { text: '' });
    text.value = 'half a thought';

    lib = await freshDrafts();
    expect(lib.hasDraft('session:a')).toBe(true);
    const again = ref('');
    lib.useDraft({ text: again }).bind('session:a', { text: '' });
    expect(again.value).toBe('half a thought');

    again.value = ''; // sent: the composer empties
    expect(lib.hasDraft('session:a')).toBe(false);
    expect((await freshDrafts()).hasDraft('session:a')).toBe(false);
  });

  it('drops a card draft typed against text the card no longer has', async () => {
    const { useDraft, hasDraft } = await freshDrafts();
    const title = ref('');
    const description = ref('');
    const d = useDraft({ title, description });
    d.bind('task:1', { title: 'Fix login', description: 'old' });
    description.value = 'old, and more';
    d.bind(null, { title: '', description: '' });

    // A teammate rewrote the description meanwhile.
    d.bind('task:1', { title: 'Fix login', description: 'new' });
    expect(description.value).toBe('new');
    expect(hasDraft('task:1')).toBe(false);
  });

  it('stores nothing while unbound and nothing after discard', async () => {
    const { useDraft, hasDraft } = await freshDrafts();
    const text = ref('');
    const d = useDraft({ text });
    d.bind(null, { text: 'selection' });
    text.value = 'selection, edited';
    d.bind('task-new:p', { text: '' });
    text.value = 'new card';
    d.discard();
    text.value = 'after save';
    expect(hasDraft('task-new:p')).toBe(false);
    expect(localStorage.getItem('kermanych.drafts')).toBe('{}');
  });

  it('forgets a draft untouched for over thirty days', async () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    localStorage.setItem(
      'kermanych.drafts',
      JSON.stringify({
        'session:old': { fields: { text: 'stale' }, base: { text: '' }, at: old },
        'session:new': { fields: { text: 'fresh' }, base: { text: '' }, at: Date.now() },
      }),
    );
    const { hasDraft } = await freshDrafts();
    expect(hasDraft('session:old')).toBe(false);
    expect(hasDraft('session:new')).toBe(true);
  });
});
