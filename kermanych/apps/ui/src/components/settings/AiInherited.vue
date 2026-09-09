<template>
  <section v-if="rows.length" class="inh" :aria-label="t('aiTeam.inherited.title')">
    <p class="inh__title">{{ t('aiTeam.inherited.title') }}</p>
    <!-- Read-only on purpose: these belong to the workspace, and a project member editing them
         here would be editing someone else's scope. They are shown so the operator can SEE what
         a session in this project also gets (triggers fire as a union), not to change it. -->
    <ul class="inh__list">
      <li v-for="r in rows" :key="r.primary" class="inh__row">
        <span class="inh__name">{{ r.primary }}</span>
        <span v-if="r.secondary" class="inh__sub mono">{{ r.secondary }}</span>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
// The workspace-scoped skills or triggers a PROJECT inherits, shown read-only below the
// project's own editable list. Availability is a runtime fact (the launch merge already applies
// them); this is purely so the operator can see the inherited layer rather than debug blind.
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { listAiSkills, listAiTriggers, type AiOwner } from '@kermanych/cloud';
import { useAuth } from 'stores/auth';

const props = defineProps<{ kind: 'skills' | 'triggers'; workspace: AiOwner }>();

const { t } = useI18n();
const auth = useAuth();

type Entry = { primary: string; secondary?: string };
const rows = ref<Entry[]>([]);

// Re-read whenever the inherited workspace or the kind changes. A failure just leaves the block
// empty (and so hidden): the inherited layer is informational, never a reason to error the pane.
watch(
  () => `${props.kind}:${props.workspace.scope}:${props.workspace.id}`,
  () => {
    void load();
  },
  { immediate: true },
);

async function load(): Promise<void> {
  const key = `${props.kind}:${props.workspace.id}`;
  try {
    const next: Entry[] =
      props.kind === 'skills'
        ? (await listAiSkills(auth.client, props.workspace))
            .filter((s) => s.enabled)
            .map((s) => ({ primary: s.name }))
        : (await listAiTriggers(auth.client, props.workspace)).map((tr) => ({
            primary: tr.label,
            secondary: tr.slug,
          }));
    // A late read for a workspace the operator has since navigated away from must not paint.
    if (key !== `${props.kind}:${props.workspace.id}`) return;
    rows.value = next;
  } catch {
    if (key !== `${props.kind}:${props.workspace.id}`) return;
    rows.value = [];
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
.inh__sub {
  font-size: 11px;
  color: var(--k-faint);
}
</style>
