<template>
  <!-- Between the toolbar and the page / screen, so a pick never covers what it was taken from;
       it scrolls on its own past a few entries, and folds to one row. -->
  <section v-if="picks.length" class="k-picks" :class="{ 'k-picks--folded': folded }">
    <button
      type="button"
      class="k-picks__head"
      :aria-expanded="!folded"
      v-tip="folded ? t('agents.browser.tray.expand') : t('agents.browser.tray.collapse')"
      @click="folded = !folded"
    >
      <span class="k-picks__caret" aria-hidden="true">{{ folded ? '▸' : '▾' }}</span>
      {{ t('agents.browser.tray.title', { n: picks.length }) }}
    </button>
    <template v-if="!folded">
      <div class="k-picks__list">
        <div v-for="p in picks" :key="p.id" class="k-picks__pick">
          <img
            v-if="p.pick.screenshot?.data"
            class="k-picks__thumb"
            :src="`data:${p.pick.screenshot.mimeType};base64,${p.pick.screenshot.data}`"
            alt=""
          />
          <div v-else class="k-picks__thumb k-picks__thumb--none mono">{{ entry(p).badge }}</div>
          <div class="k-picks__body">
            <span class="k-picks__title mono" v-tip="entry(p).title">{{ entry(p).title }}</span>
            <span v-if="entry(p).detail" class="k-picks__detail mono">{{ entry(p).detail }}</span>
            <input
              class="k-picks__comment"
              type="text"
              :value="p.comment"
              :placeholder="t('agents.browser.commentPlaceholder')"
              @input="browser.setComment(sessionId, p.id, ($event.target as HTMLInputElement).value)"
              @keydown.enter="sendOnModEnter"
            />
          </div>
          <button
            type="button"
            class="k-picks__x"
            :title="t('agents.browser.removePick')"
            :aria-label="t('agents.browser.removePick')"
            @click="browser.removePick(sessionId, p.id)"
          >✕</button>
        </div>
      </div>
      <input
        class="k-picks__comment k-picks__note"
        type="text"
        :value="browser.notes[sessionId] ?? ''"
        :placeholder="t('agents.browser.tray.notePlaceholder')"
        @input="browser.setNote(sessionId, ($event.target as HTMLInputElement).value)"
        @keydown.enter="sendOnModEnter"
      />
    </template>
    <div class="k-picks__actions">
      <KBtn variant="primary" :loading="sending" @click="emit('send')">{{ t('agents.browser.send') }}</KBtn>
      <KBtn variant="ghost" :disabled="sending" @click="browser.clearPicks(sessionId)">{{ t('agents.browser.clear') }}</KBtn>
    </div>
  </section>
</template>

<script setup lang="ts">
// The operator's picks tray of one session (stores/browser.ts): the elements pointed at with
// «◎ Вказати» in the session browser (KBrowserPane) or on the device screen (KDevicePane), a
// comment per element and one over all, and «Надіслати агенту» (the parent sends, through
// useSendPicks). One component for both panes, so the tray reads and sends the same wherever
// it was filled.
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import KBtn from './KBtn.vue';
import { useSessionBrowser } from 'stores/browser';
import { isDevicePick, type TrayPick } from '../../lib/browser-picks';

const props = defineProps<{ sessionId: string; sending: boolean }>();
const emit = defineEmits<{ send: [] }>();

const { t } = useI18n();
const browser = useSessionBrowser();
const picks = computed(() => browser.picks[props.sessionId] ?? []);
const folded = ref(false);

// What one entry shows: a browser element by its selector and component source; a device
// element by its type and label, and its id (the point when nothing was under it).
function entry(p: TrayPick): { badge: string; title: string; detail: string } {
  const pick = p.pick;
  if (isDevicePick(pick)) {
    const el = pick.element;
    const point = `${Math.round(pick.point.x)},${Math.round(pick.point.y)}`;
    if (!el) return { badge: point, title: t('agents.device.pickNoElement', { point }), detail: pick.deviceName };
    return { badge: el.type, title: el.label ? `${el.type} «${el.label}»` : el.type, detail: el.id ?? pick.deviceName };
  }
  const src = pick.source;
  return {
    badge: `<${pick.tag.toLowerCase()}>`,
    title: pick.selector,
    detail: src ? (src.line != null ? `${src.file}:${src.line}` : src.file) : '',
  };
}

function sendOnModEnter(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey) || props.sending) return;
  e.preventDefault();
  emit('send');
}
</script>

<style scoped lang="scss">
.k-picks {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--k-line);
  flex: none;
  max-height: 40%;
}
// Folded: the header and the actions share one row.
.k-picks--folded {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.k-picks__head {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-medium);
  color: var(--k-muted);
  background: transparent;
  border: none;
  cursor: pointer;

  &:hover {
    color: var(--k-text);
  }
}
.k-picks--folded .k-picks__head {
  align-self: center;
}
.k-picks__caret {
  width: 10px;
}

.k-picks__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  min-height: 0;
}

.k-picks__pick {
  display: flex;
  align-items: center;
  gap: 10px;
}

.k-picks__thumb {
  flex: none;
  width: 64px;
  height: 40px;
  object-fit: contain;
  background: var(--k-surface);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-sm);
}
.k-picks__thumb--none {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.k-picks__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.k-picks__title,
.k-picks__detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
}
.k-picks__title { color: var(--k-text); }
.k-picks__detail { color: var(--k-muted); }

.k-picks__comment {
  height: 24px;
  padding: 0 6px;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: transparent;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-sm);
  outline: none;

  &:focus {
    border-color: var(--k-accent);
  }
}
.k-picks__note {
  flex: none;
  height: 28px;
}

.k-picks__x {
  flex: none;
  border: none;
  background: transparent;
  color: var(--k-faint);
  cursor: pointer;

  &:hover {
    color: var(--k-danger);
  }
}

.k-picks__actions {
  display: flex;
  gap: 8px;
  flex: none;
}
</style>
