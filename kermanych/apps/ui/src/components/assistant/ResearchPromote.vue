<template>
  <!-- ▶ of a research (docs/specs/2026-11-16-research-mode.md, decision 7): the research turns
       into an agent in place — as «Нова задача» or as «Глибокий аналіз» — in a project of the
       workspace, its own preselected. -->
  <span ref="anchorEl" class="rpro">
    <KIconButton
      :loading="busy"
      :disabled="disabled"
      :title="busy ? t('research.promote.running') : t('research.promote.open')"
      aria-haspopup="dialog"
      :aria-expanded="menu.open.value"
      @click="menu.toggle()"
    >▶</KIconButton>
  </span>
  <Teleport to="body">
    <div
      v-if="menu.open.value"
      ref="menuEl"
      class="rpro__menu"
      role="dialog"
      :aria-label="t('research.promote.title')"
    >
      <p class="rpro__title mono">{{ t('research.promote.title') }}</p>
      <p class="rpro__caption">{{ t('research.promote.caption') }}</p>
      <div v-if="projects.length > 1" class="rpro__projects" role="radiogroup" :aria-label="t('research.promote.project')">
        <button
          v-for="p in projects"
          :key="p.id"
          type="button"
          class="rpro__project"
          role="radio"
          :aria-checked="p.id === projectId"
          @click="projectId = p.id"
        >
          <span class="rpro__check" aria-hidden="true">{{ p.id === projectId ? '●' : '○' }}</span>
          <span class="rpro__name">{{ p.name }}</span>
        </button>
      </div>
      <p v-else-if="projects.length === 1" class="rpro__single mono">{{ projects[0]!.name }}</p>
      <div class="rpro__actions">
        <KBtn variant="primary" :disabled="!projectId" @click="pick(false)">{{ t('research.promote.task') }}</KBtn>
        <KBtn variant="secondary" :disabled="!projectId" @click="pick(true)">
          <KIcon name="analysis" />{{ t('research.promote.deep') }}
        </KBtn>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import KBtn from 'components/kit/KBtn.vue';
import KIcon from 'components/kit/KIcon.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import { useAnchoredMenu } from '../../composables/useAnchoredMenu';

const props = defineProps<{
  // The workspace's projects bound on this machine — promotion grows a worktree there.
  projects: readonly { id: string; name: string }[];
  // The research's own project, preselected on every opening.
  homeProjectId: string;
  busy?: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{ promote: [projectId: string, deepAnalysis: boolean] }>();

const { t } = useI18n();
const anchorEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menu = useAnchoredMenu(anchorEl, menuEl);

const projectId = ref('');
watch(menu.open, (open) => {
  if (!open) return;
  const home = props.projects.find((p) => p.id === props.homeProjectId);
  projectId.value = home?.id ?? props.projects[0]?.id ?? '';
});

function pick(deep: boolean): void {
  const id = projectId.value;
  menu.close();
  if (id) emit('promote', id, deep);
}
</script>

<style scoped lang="scss">
.rpro {
  display: inline-flex;
}

// Above the avatar window (5000) and Quasar dialogs (6000), like the kit's menus.
.rpro__menu {
  position: fixed;
  z-index: 6500;
  width: 300px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  background: var(--k-surface);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  box-shadow: var(--k-shadow-toast);
}

.rpro__title {
  margin: 0;
  font-size: var(--k-fs-xs);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-accent);
}

.rpro__caption {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.45;
  color: var(--k-muted);
}

.rpro__projects {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rpro__project {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: 6px var(--k-sp-2);
  border: none;
  border-radius: var(--k-r-sm);
  background: transparent;
  color: var(--k-text);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  text-align: left;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    background: var(--k-surface2);
    outline: none;
  }

  &[aria-checked='true'] .rpro__check {
    color: var(--k-accent);
  }
}

.rpro__check {
  flex: none;
  color: var(--k-muted);
  font-size: 10px;
}

.rpro__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rpro__single {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-text);
}

.rpro__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-2);
  margin-top: var(--k-sp-1);

  :deep(.k-icon) {
    margin-right: 6px;
  }
}
</style>
