<template>
  <section class="int">
    <p class="int__lead">
      Підключіть зовнішні сервіси до воркспейсу
      <span class="int__lead-workspace mono">{{ workspaceName }}</span>
    </p>

    <div class="int__grid">
      <article
        v-for="brand in BRANDS"
        :key="brand.id"
        class="int__tile"
        :style="{ '--brand': brand.color }"
      >
        <span class="int__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path :d="brand.path" fill="currentColor" />
          </svg>
        </span>
        <h3 class="int__name">{{ brand.name }}</h3>
        <p class="int__blurb">{{ brand.blurb }}</p>

        <!-- Jira is live; the other tiles keep the original presentation-only foot. -->
        <div v-if="brand.id === 'jira'" class="int__foot">
          <span class="int__state mono">
            <i class="int__state-dot" :class="{ 'int__state-dot--on': !!jira.integration }" aria-hidden="true"></i>
            <template v-if="jira.integration">підключено · {{ jira.integration.boardName }}</template>
            <template v-else>не підключено</template>
          </span>
          <button
            v-if="jira.integration"
            class="int__cta"
            type="button"
            @click="openSettings"
          >Налаштувати</button>
          <button
            v-else
            v-tip="canConnect ? '' : 'Підключає власник воркспейсу'"
            class="int__cta"
            type="button"
            :disabled="!canConnect"
            @click="openConnect"
          >Підключити</button>
        </div>
        <div v-else v-tip="'У розробці'" class="int__foot">
          <span class="int__state mono">
            <i class="int__state-dot" aria-hidden="true"></i>не підключено
          </span>
          <button class="int__cta" type="button" disabled>Підключити</button>
        </div>
      </article>
    </div>

    <!-- CONNECT — the owner's three steps: site → personal token → board. -->
    <KModal v-model="connectOpen" title="Підключити Jira" width="520px">
      <div class="int__flow">
        <template v-if="connectStep === 'site'">
          <KField
            v-model="siteInput"
            label="Адреса Jira Cloud"
            placeholder="team.atlassian.net"
            @keydown.enter="siteNext"
          />
          <p class="int__hint">Сайт вашої команди в Jira Cloud. Досить домену — https додамо самі.</p>
        </template>

        <template v-else-if="connectStep === 'token'">
          <KField v-model="emailInput" label="Email акаунта Atlassian" placeholder="you@company.com" />
          <KField v-model="tokenInput" label="API-токен" type="password" placeholder="ATATT…" />
          <p class="int__hint">
            Токен створюється за хвилину:
            <a class="int__link" href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">id.atlassian.com → API tokens</a>.
            Він лишається лише на цій машині й у хмару не потрапляє.
          </p>
        </template>

        <template v-else>
          <KSelect
            v-model="boardPick"
            label="Дошка"
            :options="boardOptions"
            placeholder="вибрати дошку…"
            searchable
          />
          <p class="int__hint">Одна дошка на воркспейс — її колонки й тікети зʼявляться на «Дошці».</p>
        </template>

        <p v-if="flowError" class="int__error mono">{{ flowError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="connectOpen = false">Скасувати</KBtn>
        <KBtn v-if="connectStep === 'site'" variant="primary" :disabled="!siteInput.trim() || busy" @click="siteNext">Далі</KBtn>
        <KBtn v-else-if="connectStep === 'token'" variant="primary" :disabled="!emailInput.trim() || !tokenInput.trim() || busy" @click="tokenNext">
          {{ busy ? 'Перевіряємо…' : 'Далі' }}
        </KBtn>
        <KBtn v-else variant="primary" :disabled="!boardPick || busy" @click="connectFinish">
          {{ busy ? 'Підключаємо…' : 'Підключити' }}
        </KBtn>
      </template>
    </KModal>

    <!-- SETTINGS — the connected tile's card: facts, the member's own token, owner actions. -->
    <KModal v-model="settingsOpen" title="Jira" width="520px">
      <div v-if="jira.integration" class="int__flow">
        <dl class="int__facts">
          <div><dt>Сайт</dt><dd class="mono">{{ jira.integration.siteUrl }}</dd></div>
          <div><dt>Дошка</dt><dd>{{ jira.integration.boardName }}</dd></div>
          <div><dt>Проєкт</dt><dd class="mono">{{ jira.integration.projectKey }}</dd></div>
        </dl>

        <div class="int__token">
          <p class="int__token-state">
            <template v-if="jira.tokenPresent">
              Ваш токен на цій машині: <span class="mono">{{ jira.tokenEmail }}</span>
            </template>
            <template v-else>
              Токена немає — дошка для вас лише для читання. Додайте свій API-токен, щоб діяти від свого імені.
            </template>
          </p>
          <template v-if="tokenEditing || !jira.tokenPresent">
            <KField v-model="emailInput" label="Email акаунта Atlassian" placeholder="you@company.com" />
            <KField v-model="tokenInput" label="API-токен" type="password" placeholder="ATATT…" />
            <p class="int__hint">
              <a class="int__link" href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">id.atlassian.com → API tokens</a>
            </p>
            <div class="int__row">
              <KBtn variant="secondary" :disabled="!emailInput.trim() || !tokenInput.trim() || busy" @click="saveToken">
                {{ busy ? 'Перевіряємо…' : 'Зберегти токен' }}
              </KBtn>
              <KBtn v-if="tokenEditing" variant="ghost" @click="tokenEditing = false">Скасувати</KBtn>
            </div>
          </template>
          <div v-else class="int__row">
            <KBtn variant="ghost" @click="startTokenEdit">Замінити токен</KBtn>
            <KBtn variant="ghost" @click="removeToken">Прибрати з цієї машини</KBtn>
          </div>
        </div>

        <p v-if="flowError" class="int__error mono">{{ flowError }}</p>

        <div v-if="isOwner" class="int__danger">
          <KBtn variant="ghost" @click="changeBoard">Змінити дошку</KBtn>
          <KBtn variant="ghost" @click="disconnect">Відключити Jira</KBtn>
        </div>
      </div>
      <template #controls>
        <KBtn variant="primary" @click="settingsOpen = false">Готово</KBtn>
      </template>
    </KModal>
  </section>
</template>

<script setup lang="ts">
// Integrations — Jira is the first LIVE tile: the workspace-level connection (owner) and
// this member's personal token (everyone) both live here. Linear and Slack stay the
// presentation-only tiles they were.
//
// It takes the same props every section gets from ManagementPage, so the workspace it
// connects is already named for it.
import { computed, onMounted, ref, watch } from 'vue';
import KBtn from 'components/kit/KBtn.vue';
import KField from 'components/kit/KField.vue';
import KModal from 'components/kit/KModal.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import { api, type JiraBoardOption } from '../lib/api';
import { useJira } from 'stores/jira';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';

const props = defineProps<{ workspaceId: string; workspaceName: string }>();

const jira = useJira();
const cloud = useProjects();
const local = useOrchestrator();

const isOwner = computed(() => cloud.isWorkspaceOwner(props.workspaceId));
const canConnect = computed(() => isOwner.value);

// ── connect stepper ───────────────────────────────────────────────────────────
const connectOpen = ref(false);
const connectStep = ref<'site' | 'token' | 'board'>('site');
const siteInput = ref('');
const emailInput = ref('');
const tokenInput = ref('');
const boards = ref<JiraBoardOption[]>([]);
const boardPick = ref('');
const busy = ref(false);
const flowError = ref('');

const settingsOpen = ref(false);
const tokenEditing = ref(false);

// Boards without a project cannot be mirrored (the JQL needs a project key), so they are
// not offered rather than failing at the last step.
const boardOptions = computed<KSelectOption[]>(() =>
  boards.value
    .filter((b) => !!b.projectKey)
    .map((b) => ({ value: String(b.id), label: `${b.name} · ${b.projectKey}` })),
);

function openConnect(): void {
  connectStep.value = 'site';
  siteInput.value = jira.integration?.siteUrl ?? '';
  flowError.value = '';
  connectOpen.value = true;
}

function openSettings(): void {
  flowError.value = '';
  tokenEditing.value = false;
  emailInput.value = '';
  tokenInput.value = '';
  settingsOpen.value = true;
}

async function siteNext(): Promise<void> {
  const site = siteInput.value.trim();
  if (!site) return;
  flowError.value = '';
  busy.value = true;
  try {
    // A token already on this machine for this site skips the token step entirely.
    const status = await api.jiraTokenStatus(site);
    if (status.present) {
      await loadBoards();
      connectStep.value = 'board';
    } else {
      connectStep.value = 'token';
    }
  } catch (e) {
    flowError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function tokenNext(): Promise<void> {
  flowError.value = '';
  busy.value = true;
  try {
    await api.jiraSetToken(siteInput.value.trim(), emailInput.value.trim(), tokenInput.value.trim());
    tokenInput.value = '';
    await loadBoards();
    connectStep.value = 'board';
  } catch (e) {
    flowError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function loadBoards(): Promise<void> {
  boards.value = await api.jiraBoards(siteInput.value.trim());
  boardPick.value = boardOptions.value[0]?.value ?? '';
}

async function connectFinish(): Promise<void> {
  if (!boardPick.value) return;
  flowError.value = '';
  busy.value = true;
  try {
    await api.jiraConnect(props.workspaceId, siteInput.value.trim(), Number(boardPick.value));
    await jira.probe(props.workspaceId);
    connectOpen.value = false;
    local.notify('Jira підключено — дошка зʼявиться на «Дошці» у вкладці «Jira»', 'info');
  } catch (e) {
    flowError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

// ── settings actions ──────────────────────────────────────────────────────────
function startTokenEdit(): void {
  tokenEditing.value = true;
  emailInput.value = jira.tokenEmail ?? '';
  tokenInput.value = '';
}

async function saveToken(): Promise<void> {
  const site = jira.integration?.siteUrl;
  if (!site) return;
  flowError.value = '';
  busy.value = true;
  try {
    await api.jiraSetToken(site, emailInput.value.trim(), tokenInput.value.trim());
    tokenInput.value = '';
    tokenEditing.value = false;
    await refreshTokenState();
    local.notify('Токен збережено на цій машині', 'info');
  } catch (e) {
    flowError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function removeToken(): Promise<void> {
  const site = jira.integration?.siteUrl;
  if (!site) return;
  await api.jiraDeleteToken(site);
  await refreshTokenState();
}

async function refreshTokenState(): Promise<void> {
  const site = jira.integration?.siteUrl;
  if (!site) return;
  try {
    const status = await api.jiraTokenStatus(site);
    jira.tokenPresent = status.present;
    jira.tokenEmail = status.email;
  } catch {
    jira.tokenPresent = false;
  }
}

function changeBoard(): void {
  settingsOpen.value = false;
  openConnect();
}

async function disconnect(): Promise<void> {
  flowError.value = '';
  try {
    await api.jiraDisconnect(props.workspaceId);
    settingsOpen.value = false;
    await jira.probe(props.workspaceId);
    local.notify('Jira відключено — дзеркало дошки видалено', 'info');
  } catch (e) {
    flowError.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(() => {
  void jira.probe(props.workspaceId).then(refreshTokenState);
});
watch(
  () => props.workspaceId,
  (id) => {
    void jira.probe(id).then(refreshTokenState);
  },
);

type Brand = {
  id: string;
  name: string;
  blurb: string;
  // Display colour, NOT the raw brand hex. Each is mixed toward `--k-text` in the
  // stylesheet, which is what keeps one value legible in both palettes: on the dark
  // set it lightens, on the light set it darkens. A raw #4A154B (Slack aubergine)
  // is invisible on near-black; a raw #36C5F0 washes out on white.
  color: string;
  // Official marks, single path, 24×24 — simple-icons (CC0). Kept as data rather
  // than five inline <svg> blocks so a fourth service is one row.
  path: string;
};

const BRANDS: readonly Brand[] = [
  {
    id: 'linear',
    name: 'Linear',
    blurb: 'Задачі та цикли команди',
    color: '#5E6AD2',
    path: 'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z',
  },
  {
    id: 'jira',
    name: 'Jira',
    blurb: 'Тікети, спринти, беклог',
    color: '#0052CC',
    path: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z',
  },
  {
    id: 'slack',
    name: 'Slack',
    blurb: 'Сповіщення в канал',
    color: '#36C5F0',
    path: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
  },
];
</script>

<style scoped lang="scss">
.int {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  // Same measure as the docked composer, so the column and the input share an edge.
  width: min(680px, 100%);
  padding: var(--k-sp-4) 0;
}

.int__lead {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  color: var(--k-muted);
}

.int__lead-workspace {
  color: var(--k-text);
}

.int__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: var(--k-sp-3);
}

.int__tile {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-4);
  background: color-mix(in srgb, var(--k-surface2) 40%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
  transition:
    border-color 0.16s ease,
    background 0.16s ease,
    transform 0.16s ease;

  // The surface answers the pointer even though the action does not: the disabled
  // button is what states «not yet», not a dead tile.
  &:hover {
    transform: translateY(-1px);
    border-color: color-mix(in srgb, var(--brand) 45%, var(--k-line));
    background: color-mix(in srgb, var(--k-surface2) 62%, transparent);
  }
}

.int__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--k-r);
  // Brand hue, legibility borrowed from the text token — see the `color` note above.
  color: color-mix(in srgb, var(--brand) 76%, var(--k-text));
  background: color-mix(in srgb, var(--brand) 14%, transparent);
  border: var(--k-rule-thin) solid color-mix(in srgb, var(--brand) 28%, transparent);

  svg {
    width: 18px;
    height: 18px;
    display: block;
  }
}

.int__name {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  letter-spacing: -0.01em;
  color: var(--k-text);
}

.int__blurb {
  margin: 0;
  flex: 1;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.4;
  color: var(--k-muted);
}

.int__foot {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--k-sp-2);
  margin-top: var(--k-sp-1);
}

.int__state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  letter-spacing: 0.04em;
  white-space: nowrap;
  color: var(--k-faint);
}

// Hollow while nothing is live behind it; the connected dot fills — a live link is a
// running thing, the same vocabulary as a session dot.
.int__state-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--k-r-pill);
  border: var(--k-rule-thin) solid var(--k-faint);

  &--on {
    border-color: var(--k-success);
    background: var(--k-success);
  }
}

.int__cta {
  appearance: none;
  // Full width, on its own row: side by side with the status line it overflowed a
  // three-up tile and broke «не підключено» across two lines.
  width: 100%;
  padding: 6px var(--k-sp-3);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
  background: transparent;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-pill);
  cursor: pointer;

  &:disabled {
    cursor: not-allowed;
    color: var(--k-faint);
    border-color: var(--k-line);
  }
}

// ── the connect/settings modals ────────────────────────────────────────────────
.int__flow {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.int__hint {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.4;
  color: var(--k-muted);
}

.int__link {
  color: var(--k-accent);
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.int__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
}

.int__facts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;

  div {
    display: flex;
    gap: var(--k-sp-2);
    font-size: var(--k-fs-sm);
  }

  dt {
    width: 72px;
    flex: none;
    color: var(--k-muted);
  }

  dd {
    margin: 0;
    color: var(--k-text);
  }
}

.int__token {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  background: color-mix(in srgb, var(--k-surface2) 40%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
}

.int__token-state {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.4;
  color: var(--k-text);
}

.int__row {
  display: flex;
  gap: var(--k-sp-2);
}

.int__danger {
  display: flex;
  gap: var(--k-sp-2);
  padding-top: var(--k-sp-2);
  border-top: var(--k-rule-thin) solid var(--k-line);
}

@media (prefers-reduced-motion: reduce) {
  .int__tile:hover {
    transform: none;
  }
}
</style>
