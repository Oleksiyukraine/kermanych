<script setup lang="ts">
// Pairing (spec → Pairing and devices). The QR opens `<url>/#pair=<code>`:
// - on an iPhone in Safari the code is NOT spent: the home-screen app keeps storage apart from
//   Safari (measured as the spec asked), so a key stored here would be invisible to the installed
//   app — the screen walks through installing and typing the 6-digit short code there instead;
// - everywhere else the code is traded for a device key at once.
// Without a key the screen asks for the 6 digits «Підключити телефон» shows under the QR.
import { onMounted, ref } from "vue";
import { api } from "../lib/api";
import { useAction } from "../lib/async";
import { isIos, isStandalone, thisDeviceName } from "../lib/device";
import { t } from "../lib/i18n";
import { clearPairHash } from "../lib/route";
import { paired, state } from "../lib/store";
import KButton from "./KButton.vue";

const props = defineProps<{ code?: string }>();

const CODE_LENGTH = 6;

/** `install`: the iOS steps; `auto`: trading the QR's code; `enter`: the code field. */
const mode = ref<"install" | "auto" | "enter">("enter");
const digits = ref("");

const { run: pair, busy, error } = useAction(async (code: string) => {
  const res = await api.pair({ code, name: thisDeviceName() });
  paired(res.key);
  clearPairHash();
});

async function pairFromLink(): Promise<void> {
  if (!props.code) return;
  mode.value = "auto";
  await pair(props.code);
  // Still here: the code was refused; the field lets the operator type a fresh short code.
  mode.value = "enter";
}

function onInput(e: Event): void {
  const el = e.target as HTMLInputElement;
  digits.value = el.value.replace(/\D/g, "").slice(0, CODE_LENGTH);
  el.value = digits.value;
  // iOS / Android fill the whole code from the keyboard's suggestion: send it straight away.
  if (digits.value.length === CODE_LENGTH && !busy.value) void pair(digits.value);
}

function submit(): void {
  if (digits.value.length === CODE_LENGTH) void pair(digits.value);
}

onMounted(() => {
  if (!props.code) return;
  if (isIos() && !isStandalone()) mode.value = "install";
  else void pairFromLink();
});
</script>

<template>
  <main class="pair pad-x">
    <img class="pair__icon" src="/icons/icon-192.png" alt="" width="72" height="72" />

    <template v-if="mode === 'install'">
      <h1 class="pair__title">{{ t("pair.iosTitle") }}</h1>
      <p class="muted">{{ t("pair.iosWhy") }}</p>
      <ol class="pair__steps">
        <li>{{ t("pair.iosStep1") }}</li>
        <li>{{ t("pair.iosStep2") }}</li>
        <li>{{ t("pair.iosStep3") }}</li>
        <li>{{ t("pair.iosStep4") }}</li>
      </ol>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <KButton variant="ghost" block :loading="busy" @click="pairFromLink()">{{ t("pair.iosHere") }}</KButton>
    </template>

    <template v-else-if="mode === 'auto'">
      <h1 class="pair__title">{{ t("pair.title") }}</h1>
      <p class="pair__progress muted"><span class="spinner" aria-hidden="true" />{{ t("pair.pairing") }}</p>
    </template>

    <form v-else class="pair__form" @submit.prevent="submit">
      <h1 class="pair__title">{{ t("pair.title") }}</h1>
      <p v-if="state.pairNotice" class="pair__notice" role="status">{{ state.pairNotice }}</p>
      <p class="muted">{{ t("pair.where") }}</p>
      <label class="pair__label" for="pair-code">{{ t("pair.codeLabel") }}</label>
      <input
        id="pair-code"
        class="pair__code"
        :value="digits"
        type="text"
        inputmode="numeric"
        autocomplete="one-time-code"
        pattern="[0-9]*"
        :maxlength="CODE_LENGTH"
        placeholder="••••••"
        :disabled="busy"
        :aria-invalid="error ? true : undefined"
        @input="onInput"
      />
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <KButton type="submit" variant="primary" block :loading="busy" :disabled="digits.length !== CODE_LENGTH">
        {{ t("pair.submit") }}
      </KButton>
      <KButton v-if="state.key && props.code" variant="ghost" block @click="clearPairHash()">{{ t("pair.toList") }}</KButton>
    </form>
  </main>
</template>

<style scoped>
.pair {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  max-width: 480px;
  width: 100%;
  margin: 0 auto;
  padding-top: calc(var(--k-sp-7) + env(safe-area-inset-top));
  padding-bottom: calc(var(--k-sp-6) + env(safe-area-inset-bottom));
}
.pair__icon {
  border-radius: 16px;
}
.pair__title {
  margin: var(--k-sp-2) 0 0;
  font-size: 22px;
  font-weight: var(--k-fw-semibold);
}
.pair p {
  margin: 0;
}
.pair__form {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}
.pair__notice {
  padding: var(--k-sp-3);
  border-radius: var(--k-r);
  background: color-mix(in srgb, var(--k-warning) 14%, var(--k-surface));
}
.pair__label {
  margin-top: var(--k-sp-2);
  font-size: var(--k-fs-base);
  color: var(--k-muted);
}
.pair__code {
  height: 56px;
  padding: 0 var(--k-sp-4);
  border-radius: var(--k-r);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  background: var(--k-surface);
  font-family: var(--k-font-mono);
  font-size: 28px;
  letter-spacing: 0.4em;
  text-align: center;
}
.pair__code[aria-invalid] {
  border-color: var(--k-danger);
}
.pair__steps {
  margin: 0;
  padding-left: var(--k-sp-5);
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}
.pair__progress {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}
</style>
