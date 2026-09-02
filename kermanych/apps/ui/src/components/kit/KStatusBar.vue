<template>
  <div class="k-statusbar">
    <div class="k-statusbar__left">
      <span class="k-statusbar__agg k-statusbar__agg--running">
        <span class="k-statusbar__glyph" aria-hidden="true">●</span>
        <span class="mono">{{ counts.running }}</span> {{ t('kit.statusBar.running') }}
      </span>
      <span class="k-statusbar__agg">
        <span class="k-statusbar__glyph" aria-hidden="true">◌</span>
        <span class="mono">{{ counts.waiting }}</span> {{ t('kit.statusBar.waiting') }}
      </span>
      <span class="k-statusbar__agg">
        <span class="k-statusbar__glyph" aria-hidden="true">✓</span>
        <span class="mono">{{ counts.done }}</span> {{ t('kit.statusBar.done') }}
      </span>
      <span v-if="counts.error" class="k-statusbar__agg k-statusbar__agg--error">
        <span class="k-statusbar__glyph" aria-hidden="true">✕</span>
        <span class="mono">{{ counts.error }}</span> {{ t('kit.statusBar.errors') }}
      </span>
    </div>

    <div class="k-statusbar__right">
      <span v-if="model" class="mono k-statusbar__tele">{{ model }}</span>
      <span v-if="tokens != null" class="mono k-statusbar__tele">{{ tokenLabel }} {{ t('kit.statusBar.tokens') }}</span>
      <span v-if="costLabel" class="mono k-statusbar__tele">{{ costLabel }} {{ t('kit.statusBar.today') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
// Aliased: `tokens` is also the name of this component's prop.
import { tokens as fmtTokens, usd } from '../../lib/format';

// The window status bar (design-system section 07). Left carries the fleet
// aggregate — only the running count is accented — right carries telemetry.
// Every number is mono.
const props = defineProps<{
  counts: { running: number; waiting: number; done: number; error?: number };
  model?: string;
  tokens?: number;
  cost?: number;
}>();

const { t } = useI18n();

const tokenLabel = computed(() => fmtTokens(props.tokens ?? 0));
const costLabel = computed(() => usd(props.cost ?? 0));
</script>

<style scoped lang="scss">
.k-statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 30px;
  padding: 0 14px;
  background: var(--k-surface);
  border-top: 2px solid var(--k-line-strong);
  font-family: var(--k-font-ui);
  font-size: 12px;
  color: var(--k-muted);
}

.k-statusbar__left,
.k-statusbar__right {
  display: flex;
  align-items: center;
  gap: 20px;
}

.k-statusbar__agg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.k-statusbar__glyph {
  font-size: 10px;
  color: var(--k-muted);
}

// only the running aggregate carries the accent.
.k-statusbar__agg--running .k-statusbar__glyph {
  color: var(--k-accent);
}

.k-statusbar__agg--error .k-statusbar__glyph {
  color: var(--k-accent);
}

.mono {
  font-family: var(--k-font-mono);
  color: var(--k-text);
}

.k-statusbar__tele {
  color: var(--k-muted);
}
</style>
