<script setup lang="ts">
// Answering an agent's question from the phone (decision 3). The request is the session's
// `pendingUiRequest` (RpcExtensionUIRequest), answered with POST /answer:
//   select → one button per option ({ value })   confirm → Так / Ні ({ confirmed })
//   input / editor → a text field ({ value })    always «Скасувати» ({ cancelled: true }).
// After the api accepts, the form stays locked until the session's update clears the question
// (the socket echo), at most PENDING_MAX_MS.
import { computed, ref } from "vue";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@kermanych/core";
import { useAction, usePending } from "../lib/async";
import { t } from "../lib/i18n";
import { actions } from "../lib/store";
import KButton from "./KButton.vue";

const props = defineProps<{ sessionId: string; request: RpcExtensionUIRequest }>();

const text = ref("");
/** Which button sent the answer that is running — that one spins, every one is locked. */
const pressed = ref("");
const answered = usePending();

type Reply = { type: "value"; value: string } | { type: "confirmed"; confirmed: boolean } | { type: "cancelled" };

const { run, busy, error } = useAction(async (button: string, reply: Reply) => {
  pressed.value = button;
  const base = { type: "extension_ui_response" as const, id: props.request.id };
  const res: RpcExtensionUIResponse =
    reply.type === "value"
      ? { ...base, value: reply.value }
      : reply.type === "confirmed"
        ? { ...base, confirmed: reply.confirmed }
        : { ...base, cancelled: true };
  await actions.answer(props.sessionId, res);
  answered.mark(props.request.id);
});

const locked = computed(() => busy.value || answered.has(props.request.id));
const spins = (button: string) => busy.value && pressed.value === button;
</script>

<template>
  <section class="question" :aria-busy="locked || undefined">
    <h2 class="question__title">{{ request.title || t("question.title") }}</h2>
    <p v-if="request.message" class="question__message">{{ request.message }}</p>

    <div v-if="request.method === 'select'" class="question__options">
      <KButton
        v-for="(option, i) in request.options ?? []"
        :key="i"
        block
        :loading="spins(`option-${i}`)"
        :disabled="locked"
        @click="run(`option-${i}`, { type: 'value', value: option })"
      >
        {{ option }}
      </KButton>
    </div>

    <div v-else-if="request.method === 'confirm'" class="question__row">
      <KButton variant="primary" block :loading="spins('yes')" :disabled="locked" @click="run('yes', { type: 'confirmed', confirmed: true })">
        {{ t("question.yes") }}
      </KButton>
      <KButton block :loading="spins('no')" :disabled="locked" @click="run('no', { type: 'confirmed', confirmed: false })">
        {{ t("question.no") }}
      </KButton>
    </div>

    <form v-else class="question__input" @submit.prevent="run('answer', { type: 'value', value: text })">
      <textarea
        v-model="text"
        class="question__field"
        :rows="request.method === 'editor' ? 5 : 2"
        :placeholder="request.placeholder || t('question.placeholder')"
        :disabled="locked"
      />
      <KButton type="submit" variant="primary" block :loading="spins('answer')" :disabled="locked">{{ t("question.answer") }}</KButton>
    </form>

    <KButton variant="ghost" block :loading="spins('cancel')" :disabled="locked" @click="run('cancel', { type: 'cancelled' })">
      {{ t("question.cancel") }}
    </KButton>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.question {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  border-radius: var(--k-r-lg);
  border: var(--k-rule-thin) solid color-mix(in srgb, var(--k-accent) 45%, var(--k-line));
  background: var(--k-surface);
  max-height: 55dvh;
  overflow-y: auto;
}
.question__title {
  margin: 0;
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
}
.question__message {
  margin: 0;
  color: var(--k-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.question__options,
.question__input {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}
.question__row {
  display: flex;
  gap: var(--k-sp-2);
}
.question__field {
  width: 100%;
  padding: var(--k-sp-2) var(--k-sp-3);
  border-radius: var(--k-r);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  background: var(--k-bg);
  resize: vertical;
}
.question p.error-text {
  margin: 0;
}
</style>
