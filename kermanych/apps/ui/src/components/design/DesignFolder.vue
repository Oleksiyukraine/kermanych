<template>
  <!-- The saved design as people read it: the README and the screenshots, from the worktree. -->
  <section class="design-folder">
    <header class="design-folder__head">
      <span class="design-folder__path mono">{{ session.designDir }}/</span>
    </header>
    <KSkeleton v-if="phase === 'skeleton'" variant="lines" :rows="8" />
    <template v-else-if="phase === 'ready'">
      <p v-if="error" class="design-folder__error" role="alert">{{ error }}</p>
      <p v-else-if="readme === null" class="design-folder__note mono">{{ t('design.folder.notSaved') }}</p>
      <template v-else>
        <ul v-if="screens.length" class="design-folder__screens">
          <li v-for="s in screens" :key="s.path" class="design-folder__screen">
            <img :src="s.url" :alt="s.path" />
            <span class="design-folder__name mono">{{ s.path.split('/').pop() }}</span>
          </li>
        </ul>
        <p v-else class="design-folder__note mono">{{ t('design.folder.noScreens') }}</p>
        <div class="design-folder__readme k-log__markdown" v-html="renderMarkdown(readme)"></div>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
// The «Дизайн» page's view of a design's saved folder where there is no canvas — the web build
// has no session browser (docs/specs/2026-10-29-design-tab.md, «Web build»). It reads the README
// and the screenshots from the design's worktree on open and again whenever a turn ends, the
// moments «Зберегти дизайн» or the agent may have changed them. The README is rendered through
// the same html-escaping renderer the transcript uses; its relative image links are not
// resolved, so the screenshots are shown above it instead.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { designReadmePath, type Session } from '@kermanych/core';
import { api } from '../../lib/api';
import { renderMarkdown } from '../../lib/markdown';
import { readDesignScreens } from '../../lib/design-screens';
import { errorText } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KSkeleton from 'components/kit/KSkeleton.vue';

const props = defineProps<{ session: Session & { designDir: string } }>();
const { t } = useI18n();

// Only the first read of a design is a skeleton; a re-read after a turn keeps what is shown.
const loaded = ref(false);
// null: the README is not there yet (nothing saved); a string: its text.
const readme = ref<string | null>(null);
const screens = ref<{ path: string; url: string }[]>([]);
const error = ref<string | null>(null);
const phase = useLoadPhase(() => !loaded.value);

let generation = 0;

function dropScreens(): void {
  for (const s of screens.value) URL.revokeObjectURL(s.url);
  screens.value = [];
}

async function load(): Promise<void> {
  const gen = ++generation;
  const s = props.session;
  try {
    let text: string | null;
    try {
      const file = await api.sessionFile(s.id, designReadmePath(s.designDir));
      text = file.binary ? null : file.content;
    } catch {
      text = null; // the folder or its README does not exist yet
    }
    const read = text === null ? [] : await readDesignScreens(s.id, s.designDir);
    if (gen !== generation) return;
    dropScreens();
    readme.value = text;
    screens.value = read.map((r) => ({ path: r.path, url: URL.createObjectURL(r.file) }));
    error.value = null;
  } catch (e) {
    if (gen === generation) error.value = errorText(e);
  } finally {
    if (gen === generation) loaded.value = true;
  }
}

const running = computed(() => props.session.status === 'thinking' || props.session.status === 'tool');
watch(
  () => props.session.id,
  () => {
    loaded.value = false;
    void load();
  },
  { immediate: true },
);
watch(running, (now, before) => {
  if (before && !now) void load();
});
onBeforeUnmount(() => {
  generation += 1;
  dropScreens();
});
</script>

<style scoped lang="scss">
.design-folder {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 20px;
  overflow: auto;
  height: 100%;
}

.design-folder__path {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.design-folder__note {
  margin: 0;
  font-size: 12.5px;
  color: var(--k-muted);
}

.design-folder__error {
  margin: 0;
  font-size: 12.5px;
  color: var(--k-accent);
}

.design-folder__screens {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.design-folder__screen {
  display: flex;
  flex-direction: column;
  gap: 4px;

  img {
    display: block;
    height: 220px;
    width: auto;
    border: 1px solid var(--k-line);
    border-radius: var(--k-r-sm);
  }
}

.design-folder__name {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}
</style>
