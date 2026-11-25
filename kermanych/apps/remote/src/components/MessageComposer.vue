<script setup lang="ts">
// Sending a message from the phone, photos from the camera included (decision 3). POST /message.
// The text and photos stay in the composer until the api accepts them, so a refused send (a
// native agent mid-work → native_busy; a «/command», which the phone may not run) loses nothing.
import { computed, nextTick, ref } from "vue";
import { useAction } from "../lib/async";
import { t } from "../lib/i18n";
import { MAX_IMAGES, prepareImage, type PreparedImage } from "../lib/images";
import { actions } from "../lib/store";
import KButton from "./KButton.vue";

const props = defineProps<{ sessionId: string }>();

const text = ref("");
const images = ref<PreparedImage[]>([]);
const field = ref<HTMLTextAreaElement>();
const picker = ref<HTMLInputElement>();
const photoError = ref<string | null>(null);

const canSend = computed(() => text.value.trim().length > 0 || images.value.length > 0);

const { run: send, busy: sending, error: sendError } = useAction(async () => {
  if (!canSend.value) return;
  await actions.message(
    props.sessionId,
    text.value.trim(),
    images.value.map(({ data, mimeType }) => ({ data, mimeType })),
  );
  text.value = "";
  images.value = [];
  await nextTick();
  fit();
});

const { run: addPhotos, busy: preparing } = useAction(async (files: File[]) => {
  photoError.value = null;
  const room = MAX_IMAGES - images.value.length;
  if (files.length > room) photoError.value = t("composer.photoLimit", { n: MAX_IMAGES });
  for (const file of files.slice(0, Math.max(0, room))) {
    try {
      images.value = [...images.value, await prepareImage(file)];
    } catch {
      photoError.value = t("composer.photoFailed");
    }
  }
});

function onPick(e: Event): void {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  // Cleared so picking the same photo again still fires `change`.
  input.value = "";
  if (files.length) void addPhotos(files);
}

function removePhoto(i: number): void {
  images.value = images.value.filter((_, j) => j !== i);
  photoError.value = null;
}

/** Grows the field with its text up to six lines; beyond that it scrolls. */
function fit(): void {
  const el = field.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 6 * 22 + 18)}px`;
}

const error = computed(() => sendError.value ?? photoError.value);
</script>

<template>
  <form class="composer" @submit.prevent="send()">
    <div v-if="images.length" class="composer__thumbs">
      <div v-for="(img, i) in images" :key="i" class="composer__thumb">
        <img :src="img.preview" :alt="t('session.photoAlt')" />
        <button type="button" class="composer__remove" :aria-label="t('composer.removePhoto')" :disabled="sending" @click="removePhoto(i)">
          <span>✕</span>
        </button>
      </div>
    </div>
    <p v-if="error" class="error-text composer__error" role="alert">{{ error }}</p>
    <div class="composer__row">
      <KButton
        class="composer__photo"
        variant="ghost"
        :aria-label="t('composer.photo')"
        :title="t('composer.photo')"
        :loading="preparing"
        :disabled="sending || images.length >= MAX_IMAGES"
        @click="picker?.click()"
      >
        <svg v-if="!preparing" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M4 8h3l2-3h6l2 3h3v11H4z" stroke-linejoin="round" />
          <circle cx="12" cy="13" r="3.5" />
        </svg>
      </KButton>
      <input ref="picker" class="composer__file" type="file" accept="image/*" capture="environment" multiple @change="onPick" />
      <textarea
        ref="field"
        v-model="text"
        class="composer__field"
        rows="1"
        :placeholder="t('composer.placeholder')"
        :disabled="sending"
        enterkeyhint="enter"
        @input="fit"
      />
      <KButton type="submit" variant="primary" :loading="sending" :disabled="!canSend || preparing">{{ t("composer.send") }}</KButton>
    </div>
  </form>
</template>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}
.composer__row {
  display: flex;
  align-items: flex-end;
  gap: var(--k-sp-2);
}
.composer__photo {
  flex: none;
  padding: 0;
  width: 44px;
}
.composer__file {
  display: none;
}
.composer__field {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  max-height: 150px;
  padding: 10px var(--k-sp-3);
  border-radius: var(--k-r);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  background: var(--k-surface);
  line-height: 22px;
  resize: none;
}
.composer__thumbs {
  display: flex;
  gap: var(--k-sp-4);
  overflow-x: auto;
  /* Room for the ✕ that sticks out of each thumbnail's corner (the row clips its overflow). */
  padding: 12px 12px 0 0;
}
.composer__thumb {
  position: relative;
  flex: none;
}
.composer__thumb img {
  display: block;
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: var(--k-r);
}
/* 44px hit area around a small visible ✕ in the thumbnail's corner. */
.composer__remove {
  position: absolute;
  top: -12px;
  right: -12px;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: none;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.composer__remove::before {
  content: "";
  position: absolute;
  inset: 11px;
  border-radius: 50%;
  background: var(--k-surface2);
  border: var(--k-rule-thin) solid var(--k-line-strong);
}
/* The ✕ above the circle drawn by ::before. */
.composer__remove > * {
  position: relative;
}
.composer__error {
  margin: 0;
}
</style>
