// «Надіслати відгук» (docs/specs/2026-11-13-feedback-form.md): whether the modal is open, and
// the draft. The draft lives here rather than in the modal so a modal closed by accident keeps
// the text and the screenshots until the report is sent (decision 6).
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  FEEDBACK_MAX_IMAGE_BYTES,
  FEEDBACK_MAX_IMAGES,
  FEEDBACK_MAX_LENGTH,
  FeedbackRateLimitedError,
  sendFeedback,
  type FeedbackKind,
} from '@kermanych/cloud';
import { useImageAttach } from '../composables/useImageAttach';
import { imageToFile } from '../lib/images';
import { globalTr } from '../boot/i18n';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';
import { APP_VERSION } from './app-update';

/** What the modal knows and the store does not: where the report was written from. */
export type FeedbackContext = { screen?: string | undefined; locale?: string | undefined };

export const useFeedback = defineStore('feedback', () => {
  const auth = useAuth();
  const orch = useOrchestrator();

  const open = ref(false);
  const kind = ref<FeedbackKind>('bug');
  const message = ref('');
  const attach = useImageAttach();

  // Why the draft cannot go yet, said under the form; null when it can. An empty text is not a
  // refusal: the disabled «Надіслати» says enough.
  const refusal = computed<string | null>(() => {
    const length = message.value.trim().length;
    if (length > FEEDBACK_MAX_LENGTH) {
      return globalTr.t('feedback.tooLong', { length, max: FEEDBACK_MAX_LENGTH });
    }
    if (attach.images.value.length > FEEDBACK_MAX_IMAGES) {
      return globalTr.t('feedback.tooManyImages', { max: FEEDBACK_MAX_IMAGES });
    }
    // The base64 payload is 4/3 of the bytes; the bucket refuses anything above 10 MiB.
    const big = attach.images.value.find((img) => Math.floor((img.data.length * 3) / 4) > FEEDBACK_MAX_IMAGE_BYTES);
    if (big) return globalTr.t('feedback.imageTooLarge', { name: big.name, max: FEEDBACK_MAX_IMAGE_BYTES / 1024 / 1024 });
    return null;
  });

  const canSend = computed(() => message.value.trim().length > 0 && !refusal.value && attach.reading.value === 0);

  function show(): void {
    open.value = true;
  }

  function hide(): void {
    open.value = false;
  }

  function clear(): void {
    kind.value = 'bug';
    message.value = '';
    attach.clear();
  }

  /** Send the draft. Throws with operator-facing text; on success clears it, closes and thanks. */
  async function send(context: FeedbackContext = {}): Promise<void> {
    if (!auth.user) throw new Error(globalTr.t('common.notify.signInFirst'));
    if (!canSend.value) return;
    try {
      await sendFeedback(
        auth.client,
        auth.user.id,
        {
          kind: kind.value,
          message: message.value,
          appVersion: APP_VERSION,
          client: window.kermanych ? 'desktop' : 'web',
          userAgent: navigator.userAgent,
          locale: context.locale,
          screen: context.screen,
        },
        attach.images.value.map(imageToFile),
      );
    } catch (e) {
      if (e instanceof FeedbackRateLimitedError) throw new Error(globalTr.t('feedback.rateLimited'));
      throw e;
    }
    clear();
    open.value = false;
    orch.notify(globalTr.t('feedback.sent'));
  }

  return {
    open,
    kind,
    message,
    images: attach.images,
    imageError: attach.error,
    reading: attach.reading,
    addImages: attach.addFiles,
    onPaste: attach.onPaste,
    onDrop: attach.onDrop,
    removeImage: attach.remove,
    refusal,
    canSend,
    show,
    hide,
    send,
  };
});
