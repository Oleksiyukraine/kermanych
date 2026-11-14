<template>
  <!-- «Надіслати відгук» (docs/specs/2026-11-13-feedback-form.md). Mounted once in MainLayout;
       the header icon and Налаштування → «Загальне» open it through stores/feedback.ts. -->
  <KModal
    :model-value="feedback.open"
    :title="t('feedback.title')"
    width="560px"
    :persistent="sending.busy.value"
    @update:model-value="(v: boolean) => { if (!v) feedback.hide(); }"
  >
    <form
      class="fb"
      @submit.prevent="submit"
      @paste="feedback.onPaste($event)"
      @dragover.prevent
      @drop.prevent="feedback.onDrop($event)"
      @keydown.meta.enter.prevent="submit"
      @keydown.ctrl.enter.prevent="submit"
    >
      <p class="fb__blurb">{{ t('feedback.blurb') }}</p>
      <div>
        <KToggle
          :options="kindLabels"
          :model-value="kindLabel"
          :disabled="sending.busy.value"
          @update:model-value="pickKind"
        />
      </div>
      <KField
        ref="field"
        v-model="feedback.message"
        multiline
        :rows="7"
        :label="t('feedback.message')"
        :placeholder="t(`feedback.placeholder.${feedback.kind}`)"
        :disabled="sending.busy.value"
      />
      <div class="fb__attach">
        <button
          type="button"
          class="fb__attach-btn mono"
          :disabled="sending.busy.value || feedback.images.length >= FEEDBACK_MAX_IMAGES"
          @click="fileInput?.click()"
        >{{ t('feedback.addImage') }}</button>
        <input
          ref="fileInput"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          class="fb__file"
          @change="onPick"
        />
        <span class="fb__note">{{ t('feedback.imageHint', { max: FEEDBACK_MAX_IMAGES }) }}</span>
      </div>
      <KAttachStrip v-if="feedback.images.length" :images="feedback.images" @remove="feedback.removeImage" />
      <p v-if="feedback.imageError" class="fb__error" role="alert">{{ feedback.imageError }}</p>
      <p v-if="feedback.refusal" class="fb__error" role="alert">{{ feedback.refusal }}</p>
      <p v-if="error" class="fb__error" role="alert">{{ error }}</p>
      <p class="fb__note">
        {{ t('feedback.context', { version: APP_VERSION ?? '—' }) }}
        <template v-if="account">{{ t('feedback.account', { account }) }}</template>
      </p>
      <button type="submit" hidden />
    </form>
    <template #controls>
      <KBtn variant="ghost" :disabled="sending.busy.value" @click="feedback.hide()">{{ t('feedback.cancel') }}</KBtn>
      <KBtn variant="primary" :loading="sending.busy.value" :disabled="!feedback.canSend" @click="submit">
        {{ t('feedback.send') }}
      </KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { FEEDBACK_KINDS, FEEDBACK_MAX_IMAGES, type FeedbackKind } from '@kermanych/cloud';
import KModal from 'components/kit/KModal.vue';
import KField from 'components/kit/KField.vue';
import KBtn from 'components/kit/KBtn.vue';
import KToggle from 'components/kit/KToggle.vue';
import KAttachStrip from 'components/kit/KAttachStrip.vue';
import { useAsyncAction, errorText } from '../../composables/useAsyncAction';
import { useFeedback } from '../../stores/feedback';
import { useAuth } from '../../stores/auth';
import { APP_VERSION } from '../../stores/app-update';

const { t, locale } = useI18n();
const route = useRoute();
const feedback = useFeedback();
const auth = useAuth();

const field = ref<InstanceType<typeof KField> | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
// The last send's failure, shown inside the modal with the draft intact (README «Async states»).
const error = ref<string | null>(null);

const account = computed(() => (auth.profile?.githubUsername ? `@${auth.profile.githubUsername}` : ''));

// KToggle speaks in labels; the store in kinds.
const kindLabels = computed(() => FEEDBACK_KINDS.map((k) => t(`feedback.kinds.${k}`)));
const kindLabel = computed(() => t(`feedback.kinds.${feedback.kind}`));
function pickKind(label: string): void {
  const picked = FEEDBACK_KINDS.find((k: FeedbackKind) => t(`feedback.kinds.${k}`) === label);
  if (picked) feedback.kind = picked;
}

function onPick(e: Event): void {
  const input = e.target as HTMLInputElement;
  if (input.files) void feedback.addImages(input.files);
  input.value = '';
}

const sending = useAsyncAction(
  // The screen is the route's NAME, never its params: a report needs «where», not which ids.
  () => feedback.send({ screen: typeof route.name === 'string' ? route.name : undefined, locale: locale.value }),
  { onError: (e) => { error.value = errorText(e); } },
);

function submit(): void {
  if (!feedback.canSend) return;
  error.value = null;
  void sending.run();
}

watch(
  () => feedback.open,
  async (open) => {
    if (!open) return;
    error.value = null;
    await nextTick();
    field.value?.focus();
  },
);
</script>

<style scoped lang="scss">
.fb {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.fb__blurb {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--k-muted);
}

.fb__attach {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.fb__attach-btn {
  padding: 6px 10px;
  background: transparent;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r);
  color: var(--k-muted);
  font-size: 12px;
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: var(--k-accent);
    color: var(--k-text);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.fb__file {
  display: none;
}

.fb__note {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--k-muted);
}

.fb__error {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--k-accent);
}
</style>
