// @vitest-environment happy-dom
// diffShown and rememberedViewMode read localStorage at module load, so each case re-imports a fresh module.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('diffShown', () => {
  it('shows the diff when nothing is stored', async () => {
    const { diffShown } = await import('../src/lib/doc-preview');
    expect(diffShown.value).toBe(true);
  });

  it('remembers «off» for the next load', async () => {
    const first = await import('../src/lib/doc-preview');
    first.diffShown.value = false;
    await nextTick();
    expect(localStorage.getItem('kermanych.diffView.showDiff')).toBe('0');

    vi.resetModules();
    const second = await import('../src/lib/doc-preview');
    expect(second.diffShown.value).toBe(false);
  });
});

describe('rememberedViewMode', () => {
  it('starts on source and remembers a pick for the next load', async () => {
    const first = await import('../src/lib/doc-preview');
    expect(first.rememberedViewMode.value).toBe('source');
    first.rememberedViewMode.value = 'preview';
    await nextTick();

    vi.resetModules();
    const second = await import('../src/lib/doc-preview');
    expect(second.rememberedViewMode.value).toBe('preview');
  });

  it('ignores a stored value that is not a mode', async () => {
    localStorage.setItem('kermanych.fileView.mode', 'sideways');
    const { rememberedViewMode } = await import('../src/lib/doc-preview');
    expect(rememberedViewMode.value).toBe('source');
  });
});
