<template>
  <KModal :model-value="modelValue" :title="t('releaseSlack.title')" width="560px" @update:model-value="(v: boolean) => emit('update:modelValue', v)">
    <div class="rs">
      <p class="rs__hint">{{ t('releaseSlack.lead') }}</p>

      <dl v-if="row" class="rs__facts">
        <div><dt>{{ t('releaseSlack.teamFact') }}</dt><dd>{{ row.teamName }}</dd></div>
        <div><dt>{{ t('releaseSlack.channelFact') }}</dt><dd class="mono">#{{ row.channelName }}</dd></div>
      </dl>
      <p v-else class="rs__state">{{ isOwner ? t('releaseSlack.noChannelOwner') : t('releaseSlack.noChannelMember') }}</p>

      <!-- This member's Slack account on THIS machine: what the note is posted as. -->
      <div class="rs__box">
        <p class="rs__state">
          <template v-if="account.connected">{{ t('releaseSlack.connectedAs', { user: account.userName, team: account.teamName }) }}</template>
          <template v-else>{{ t('releaseSlack.notConnected') }}</template>
        </p>
        <p v-if="!store.canConnect" class="rs__hint">{{ t('releaseSlack.desktopOnly') }}</p>
        <div v-else class="rs__row">
          <KBtn
            v-if="!account.connected || clientIdChanged"
            variant="secondary"
            :disabled="!connectClientId || busy"
            :loading="connecting"
            @click="connectAccount"
          >
            {{ account.connected ? t('releaseSlack.reconnectWithClientId') : t('releaseSlack.connect') }}
          </KBtn>
          <KBtn v-if="account.connected" variant="ghost" :disabled="busy" @click="disconnectAccount">
            {{ t('releaseSlack.disconnect') }}
          </KBtn>
        </div>
      </div>

      <!-- Owner: which Slack app every member authorizes, and the channel. -->
      <template v-if="isOwner">
        <ol class="rs__hint rs__steps">
          <li>
            {{ t('releaseSlack.stepApp') }}
            <a class="rs__link" href="#" @click.prevent="copyManifest">{{ t('releaseSlack.copyManifest') }}</a>
          </li>
          <li>{{ t('releaseSlack.stepClientId') }}</li>
          <li>{{ t('releaseSlack.stepChannel') }}</li>
        </ol>
        <KField v-model="clientIdInput" :label="t('releaseSlack.clientIdLabel')" placeholder="1234567890.1234567890" :disabled="busy" />

        <template v-if="account.connected && !clientIdChanged">
          <KSelect
            v-if="channelOptions.length"
            v-model="channelPick"
            :label="t('releaseSlack.channelLabel')"
            :options="channelOptions"
            :placeholder="t('releaseSlack.channelPlaceholder')"
            searchable
          />
          <p v-else-if="!loadingChannels" class="rs__state">{{ t('releaseSlack.noChannels') }}</p>
          <div class="rs__row">
            <KBtn variant="ghost" :loading="loadingChannels" @click="loadChannels">{{ t('releaseSlack.refresh') }}</KBtn>
            <KBtn variant="primary" :disabled="!channelPick || busy || channelPick === row?.channelId" :loading="saving" @click="saveChannel">
              {{ t('releaseSlack.save') }}
            </KBtn>
          </div>
        </template>

        <div v-if="row" class="rs__danger">
          <KBtn variant="ghost" :disabled="busy" @click="removeChannel">{{ t('releaseSlack.remove') }}</KBtn>
        </div>
      </template>

      <p v-if="error" class="rs__error mono">{{ error }}</p>
    </div>
    <template #controls>
      <KBtn variant="primary" @click="emit('update:modelValue', false)">{{ t('releaseSlack.done') }}</KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// The Release Notes section's Slack settings: the channel notes are sent to (owner) and
// this member's Slack account, which every note is posted as. All state is in
// stores/release-slack.ts; this modal only drives it.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import KModal from 'components/kit/KModal.vue';
import KBtn from 'components/kit/KBtn.vue';
import KField from 'components/kit/KField.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import { useReleaseSlack } from 'stores/release-slack';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { api, type SlackChannelOption } from '../../lib/api';
import { SLACK_MANIFEST } from '../../lib/slack-manifest';

const props = defineProps<{ modelValue: boolean; workspaceId: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const { t } = useI18n();
const store = useReleaseSlack();
const projects = useProjects();
const local = useOrchestrator();

const isOwner = computed(() => projects.isWorkspaceOwner(props.workspaceId));
const row = computed(() => store.settings[props.workspaceId] ?? null);
const account = computed(() => store.accounts[props.workspaceId] ?? { connected: false as const });

const clientIdInput = ref('');
const channels = ref<SlackChannelOption[]>([]);
const channelPick = ref('');
const loadingChannels = ref(false);
const connecting = ref(false);
const saving = ref(false);
const working = ref(false);
const error = ref('');
const busy = computed(() => connecting.value || saving.value || working.value);

// A member authorizes the app the row names; the owner, the one in the field.
const connectClientId = computed(() => (isOwner.value ? clientIdInput.value.trim() : row.value?.clientId) ?? '');

// The channel row takes its app from the owner's own token, so a Client ID edited after
// connecting needs a fresh authorization against that app before a channel can be saved.
const clientIdChanged = computed(
  () => isOwner.value && account.value.connected && clientIdInput.value.trim() !== account.value.clientId,
);

const channelOptions = computed<KSelectOption[]>(() =>
  channels.value.map((c) => ({
    value: c.id,
    label: c.isPrivate ? `#${c.name} · ${t('releaseSlack.private')}` : `#${c.name}`,
  })),
);

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    error.value = '';
    channels.value = [];
    await store.load(props.workspaceId);
    const acc = account.value;
    clientIdInput.value = row.value?.clientId ?? (acc.connected ? acc.clientId : '');
    channelPick.value = row.value?.channelId ?? '';
    if (isOwner.value && acc.connected) void loadChannels();
  },
  { immediate: true },
);

async function attempt(flag: { value: boolean }, fn: () => Promise<void>): Promise<void> {
  error.value = '';
  flag.value = true;
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    flag.value = false;
  }
}

// Only channels the owner is in come back — a member can post only where they are, and
// the list grows by joining a channel in Slack and pressing Refresh.
function loadChannels(): Promise<void> {
  return attempt(loadingChannels, async () => {
    channels.value = await api.slackAccountChannels(props.workspaceId);
    if (!channels.value.some((c) => c.id === channelPick.value)) channelPick.value = channels.value[0]?.id ?? '';
  });
}

function connectAccount(): Promise<void> {
  return attempt(connecting, async () => {
    const acc = await store.connect(props.workspaceId, isOwner.value ? clientIdInput.value.trim() : undefined);
    if (acc.connected) local.notify(t('releaseSlack.notify.connected', { user: acc.userName }), 'info');
    if (isOwner.value) await loadChannels();
  });
}

function disconnectAccount(): Promise<void> {
  return attempt(working, () => store.disconnect(props.workspaceId));
}

function saveChannel(): Promise<void> {
  return attempt(saving, async () => {
    const saved = await store.saveChannel(props.workspaceId, channelPick.value);
    local.notify(t('releaseSlack.notify.channelSet', { channel: `#${saved.channelName}` }), 'info');
  });
}

function removeChannel(): Promise<void> {
  return attempt(working, () => store.removeChannel(props.workspaceId));
}

async function copyManifest(): Promise<void> {
  try {
    await navigator.clipboard.writeText(JSON.stringify(SLACK_MANIFEST, null, 2));
    local.notify(t('slack.notify.copied'), 'info');
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}
</script>

<style scoped lang="scss">
// The Integrations tile's modal vocabulary (ManagementIntegrationsPage .int__*), so both
// Slack settings read as one integration.
.rs {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.rs__hint {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.4;
  color: var(--k-muted);
}

.rs__steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: var(--k-sp-4);
}

.rs__link {
  color: var(--k-accent);
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.rs__state {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.4;
  color: var(--k-text);
}

.rs__facts {
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

.rs__box {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  background: color-mix(in srgb, var(--k-surface2) 40%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
}

.rs__row {
  display: flex;
  gap: var(--k-sp-2);
}

.rs__danger {
  display: flex;
  gap: var(--k-sp-2);
  padding-top: var(--k-sp-2);
  border-top: var(--k-rule-thin) solid var(--k-line);
}

.rs__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
}
</style>
