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

describe('launch mode', () => {
  it('opens on managed until a mode is picked, then on the picked one', async () => {
    const { readLaunchMode, writeLaunchMode } = await import('../src/lib/native-session');
    expect(readLaunchMode()).toBe('managed');
    writeLaunchMode('claude');
    expect(readLaunchMode()).toBe('claude');
  });

  it('falls back to managed for a stored value that is not a mode', async () => {
    localStorage.setItem('kermanych.launcher.mode', 'vim');
    const { readLaunchMode } = await import('../src/lib/native-session');
    expect(readLaunchMode()).toBe('managed');
  });
});

describe('useSplitRatio', () => {
  const key = (k: string) => new KeyboardEvent('keydown', { key: k });

  it('starts half and half, nudges with the arrows and keeps each side at 15%', async () => {
    const { useSplitRatio } = await import('../src/composables/useSplitRatio');
    const s = useSplitRatio('test.split');
    expect(s.ratio.value).toBe(0.5);
    s.onKeydown(key('ArrowRight'));
    expect(s.ratio.value).toBeCloseTo(0.52);
    for (let i = 0; i < 40; i++) s.onKeydown(key('ArrowLeft'));
    expect(s.ratio.value).toBeCloseTo(0.15);
  });

  it('remembers the ratio under its key, and reset goes back to half', async () => {
    const { useSplitRatio } = await import('../src/composables/useSplitRatio');
    useSplitRatio('test.split').onKeydown(key('ArrowRight'));
    const again = useSplitRatio('test.split');
    expect(again.ratio.value).toBeCloseTo(0.52);
    again.reset();
    expect(useSplitRatio('test.split').ratio.value).toBe(0.5);
    expect(useSplitRatio().ratio.value).toBe(0.5);
  });
});

describe('useRememberedChoice', () => {
  it('remembers a pick per scope and loads the scope it switches to', async () => {
    const { ref } = await import('vue');
    const { useRememberedChoice } = await import('../src/composables/useRememberedChoice');
    const scope = ref('a');
    const opts = [{ value: '' }, { value: 'p1' }, { value: 'p2' }];
    const pick = useRememberedChoice(() => `test.pick.${scope.value}`, () => opts, () => true);
    expect(pick.value).toBe('');
    pick.value = 'p1';
    await nextTick();
    scope.value = 'b';
    await nextTick();
    expect(pick.value).toBe('');
    scope.value = 'a';
    await nextTick();
    expect(pick.value).toBe('p1');
  });

  it('keeps a pick while loading and drops it to «anyone» once loaded without that option', async () => {
    const { ref } = await import('vue');
    const { useRememberedChoice } = await import('../src/composables/useRememberedChoice');
    localStorage.setItem('test.pick.c', 'gone');
    const opts = ref([{ value: '' }]);
    const loaded = ref(false);
    const pick = useRememberedChoice(() => 'test.pick.c', () => opts.value, () => loaded.value);
    expect(pick.value).toBe('gone');
    opts.value = [{ value: '' }, { value: 'p1' }];
    await nextTick();
    expect(pick.value).toBe('gone');
    loaded.value = true;
    await nextTick();
    expect(pick.value).toBe('');
    await nextTick();
    expect(localStorage.getItem('test.pick.c')).toBeNull();
  });
});
