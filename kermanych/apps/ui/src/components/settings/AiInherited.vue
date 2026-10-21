<template>
  <!-- While the inherited layer is still being read it holds its place with a skeleton line
       instead of popping in under the list a moment later. -->
  <section v-if="phase === 'skeleton' || (phase === 'ready' && rows.length)" class="inh" :aria-label="t('aiTeam.inherited.title')">
    <p class="inh__title">{{ t('aiTeam.inherited.title') }}</p>
    <!-- Read-only on purpose: these are not this scope's own rows — they are what a session at
         this scope ALSO gets (system defaults, and for a project its workspace's rows). Shown so
         the operator sees the full picture, not to edit another scope's data. -->
    <KSkeleton v-if="phase === 'skeleton'" variant="line" width="40%" />
    <ul v-else class="inh__list">
      <li v-for="r in rows" :key="r.primary" class="inh__row">
        <span class="inh__name mono">{{ r.primary }}</span>
        <span class="inh__origin">{{ r.origin }}</span>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
// The layers a scope INHERITS (read-only), shown below its own editable list. Availability is a
// runtime fact — the launch merge already applies these; this only makes the inherited layer
// visible so the operator does not debug blind.
//
// What counts as inherited depends on the scope and the kind:
//   skills  · project → system defaults + the workspace's own skills
//           · user    → system defaults (there is no single project/workspace behind a user tab)
//   triggers· project → the workspace's own triggers (there are no default triggers)
//           · user    → nothing
// The workspace tab inherits nothing and renders no block.
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { DEFAULT_SKILLS } from '@kermanych/core';
import { listAiSkills, listAiTriggers, type AiOwner, type AiScope } from '@kermanych/cloud';
import { useAuth } from 'stores/auth';
import KSkeleton from 'components/kit/KSkeleton.vue';
import { useLoadPhase } from '../../composables/useLoadPhase';

const props = defineProps<{ kind: 'skills' | 'triggers'; scope: AiScope; workspace?: AiOwner | undefined }>();

const { t } = useI18n();
const auth = useAuth();

type Entry = { primary: string; origin: string };
const rows = ref<Entry[]>([]);
// The key whose read last finished (either way). A different current key is «not loaded yet».
const loadedFor = ref('');

function currentKey(): string {
  return `${props.kind}:${props.scope}:${props.workspace?.id ?? ''}`;
}
const phase = useLoadPhase(() => loadedFor.value !== currentKey());

watch(
  currentKey,
  () => {
    // The previous scope's inherited rows are not this scope's: dropped at once, not after the read.
    rows.value = [];
    void load();
  },
  { immediate: true },
);

async function load(): Promise<void> {
  const key = currentKey();
  try {
    // Keyed by name/slug so a workspace entry that shares a default's name is shown once, as the
    // workspace's — which is what the launch merge (workspace over default) resolves to.
    const byName = new Map<string, Entry>();
    if (props.kind === 'skills') {
      for (const d of DEFAULT_SKILLS) byName.set(d.name, { primary: d.name, origin: t('aiTeam.inherited.system') });
      if (props.workspace) {
        for (const s of (await listAiSkills(auth.client, props.workspace)).filter((s) => s.enabled)) {
          byName.set(s.name, { primary: s.name, origin: t('aiTeam.inherited.fromWorkspace') });
        }
      }
    } else if (props.workspace) {
      for (const tr of await listAiTriggers(auth.client, props.workspace)) {
        byName.set(tr.slug, { primary: tr.label, origin: t('aiTeam.inherited.fromWorkspace') });
      }
    }
    // A late read for a scope/workspace the operator has since left must not paint.
    if (key !== currentKey()) return;
    rows.value = [...byName.values()];
  } catch {
    if (key !== currentKey()) return;
    rows.value = [];
  } finally {
    if (key === currentKey()) loadedFor.value = key;
  }
}
</script>

<style scoped lang="scss">
.inh {
  margin-top: var(--k-sp-4);
  padding-top: var(--k-sp-3);
  border-top: var(--k-rule-thin) dashed var(--k-line);
}
.inh__title {
  margin: 0 0 6px;
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-faint);
}
.inh__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.inh__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12.5px;
  color: var(--k-muted);
}
.inh__origin {
  font-size: 11px;
  color: var(--k-faint);
}
</style>
