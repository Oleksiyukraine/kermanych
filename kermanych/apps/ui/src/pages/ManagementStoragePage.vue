<template>
  <section class="vault">
    <p class="vault__lead">
      {{ t('management.storage.leadBefore') }}
      <span class="vault__lead-workspace mono">{{ workspaceName }}</span>
      {{ t('management.storage.leadAfter') }}
    </p>

    <!-- Pending requests, for a manager/owner only. A developer never sees another person's
         request; a manager sees every one waiting in this workspace and answers it here. -->
    <div v-if="canManage && pending.length" class="vault__requests">
      <h3 class="vault__requests-title mono">{{ t('management.storage.pendingTitle') }}</h3>
      <div v-for="req in pending" :key="req.id" class="vault__request">
        <span class="vault__request-who">
          {{ t('management.storage.requestedBy', { who: memberName(req.requesterId) }) }}
        </span>
        <span class="vault__request-what mono">{{ passwordTitle(req.passwordId) }}</span>
        <div class="vault__request-actions">
          <KBtn
            variant="primary"
            :loading="deciding.busyFor(decideKey(req.id, true))"
            :disabled="deciding.busyFor(decideKey(req.id, false))"
            @click="deciding.run(decideKey(req.id, true), req, true)"
          >{{ t('management.storage.approve') }}</KBtn>
          <KBtn
            variant="ghost"
            :loading="deciding.busyFor(decideKey(req.id, false))"
            :disabled="deciding.busyFor(decideKey(req.id, true))"
            @click="deciding.run(decideKey(req.id, false), req, false)"
          >{{ t('management.storage.decline') }}</KBtn>
        </div>
      </div>
    </div>

    <div class="vault__toolbar">
      <KField v-model="query" :placeholder="t('management.storage.searchPlaceholder')" />
      <KBtn v-if="canManage" variant="primary" @click="openCreate()">
        {{ t('management.storage.newPassword') }}
      </KBtn>
    </div>

    <p v-if="store.loadError" class="vault__error">
      {{ t('management.storage.loadError', { error: store.loadError }) }}
    </p>

    <!-- Nothing for this workspace yet: rows-shaped placeholder, never the empty state. -->
    <KSkeleton v-else-if="phase === 'skeleton'" variant="rows" :rows="4" />

    <div v-else-if="phase === 'ready' && !rows.length" class="vault__blank">
      <span class="vault__blank-eyebrow mono">{{ t('management.storage.blankEyebrow') }}</span>
      <p class="vault__blank-text">
        {{ all.length ? t('management.storage.blankFiltered') : t('management.storage.blankEmpty') }}
      </p>
    </div>

    <KTable
      v-else-if="phase === 'ready'"
      class="vault__table"
      :columns="columns"
      :rows="rows"
      :row-key="(r: WorkspacePassword) => r.id"
    >
      <template #cell-title="{ row }">
        <span class="vault__title">{{ row.title }}</span>
      </template>

      <!-- Who may read this secret: owner, managers, approved grants — the same people
           can_read_password_secret admits. At most four faces, then a «+N» chip. -->
      <template #cell-holders="{ row }">
        <div class="vault__holders">
          <span
            v-tip="t('management.storage.holdersHint', { n: holdersOf(row.id).length })"
            class="vault__holders-count mono"
          >{{ holdersOf(row.id).length }}</span>
          <div class="vault__faces">
            <KAvatar
              v-for="h in holdersOf(row.id).slice(0, MAX_FACES)"
              :key="h.userId"
              :name="holderName(h)"
              :avatar-url="h.avatarUrl"
              :size="22"
            />
            <span
              v-if="holdersOf(row.id).length > MAX_FACES"
              v-tip="t('management.storage.holdersMore', { names: overflowNames(row.id) })"
              class="vault__more mono"
              role="img"
              :aria-label="t('management.storage.holdersMore', { names: overflowNames(row.id) })"
            >+{{ holdersOf(row.id).length - MAX_FACES }}</span>
          </div>
        </div>
      </template>

      <!-- Status and actions both hang on the caller's role, which comes off the roster: until
           it is in, a manager would be drawn as a developer (and offered «Запитати доступ»). -->
      <template #cell-status="{ row }">
        <KSkeleton v-if="rolePhase === 'skeleton'" width="90px" />
        <template v-else-if="rolePhase === 'ready'">
          <KTag v-if="canManage" plain>{{ t('management.storage.youManage') }}</KTag>
          <KTag v-else-if="statusOf(row.id) === 'approved'" plain class="vault__ok">
            {{ t('management.storage.statusApproved') }}
          </KTag>
          <KTag v-else-if="statusOf(row.id) === 'pending'" plain class="vault__wait">
            {{ t('management.storage.statusPending') }}
          </KTag>
          <KTag v-else-if="statusOf(row.id) === 'declined'" plain class="vault__no">
            {{ t('management.storage.statusDeclined') }}
          </KTag>
          <KTag v-else plain>{{ t('management.storage.statusNone') }}</KTag>
        </template>
      </template>

      <template #cell-actions="{ row }">
        <KSkeleton v-if="rolePhase === 'skeleton'" width="120px" />
        <div v-else-if="rolePhase === 'ready'" class="vault__actions">
          <!-- The password's owner — its filer, the workspace owner or a manager: share it with
               a member directly, no request in between. -->
          <KIconButton
            v-if="canShare(row)"
            :title="t('management.storage.share')"
            @click="openShare(row)"
          >👥</KIconButton>
          <!-- Manager/owner: open, edit, delete. -->
          <template v-if="canManage">
            <KIconButton
              :title="t('management.storage.view')"
              :loading="viewAction.busyFor(row.id)"
              @click="viewAction.run(row.id, row)"
            >👁</KIconButton>
            <KIconButton
              :title="t('management.storage.edit')"
              :loading="editAction.busyFor(row.id)"
              @click="editAction.run(row.id, row)"
            >✎</KIconButton>
            <KIconButton
              class="vault__danger"
              :title="t('management.storage.delete')"
              :loading="deleting.busyFor(row.id)"
              @click="remove(row)"
            >✕</KIconButton>
          </template>
          <!-- Developer with an approved grant: open only. -->
          <KIconButton
            v-else-if="statusOf(row.id) === 'approved'"
            :title="t('management.storage.view')"
            :loading="viewAction.busyFor(row.id)"
            @click="viewAction.run(row.id, row)"
          >👁</KIconButton>
          <!-- Developer awaiting a decision: the button is spent. -->
          <KBtn v-else-if="statusOf(row.id) === 'pending'" variant="ghost" disabled>
            {{ t('management.storage.requested') }}
          </KBtn>
          <!-- Otherwise (never asked, or declined): ask (again). -->
          <KBtn
            v-else
            variant="secondary"
            :loading="requesting.busyFor(row.id)"
            @click="requesting.run(row.id, row)"
          >
            {{ statusOf(row.id) === 'declined'
              ? t('management.storage.requestAgain')
              : t('management.storage.requestAccess') }}
          </KBtn>
        </div>
      </template>
    </KTable>

    <!-- ── view / reveal ─────────────────────────────────────────────────────── -->
    <KModal
      :model-value="viewOpen"
      :title="viewing?.title ?? ''"
      width="520px"
      @update:model-value="closeView"
    >
      <div v-if="viewSecret" class="vault__reveal">
        <label class="vault__reveal-label mono">{{ t('management.storage.secretLabel') }}</label>
        <div class="vault__reveal-row">
          <code class="vault__secret">{{ showSecret ? viewSecret.secret : mask(viewSecret.secret) }}</code>
          <KIconButton
            :title="showSecret ? t('management.storage.hideSecret') : t('management.storage.showSecret')"
            @click="showSecret = !showSecret"
          >{{ showSecret ? '🙈' : '👁' }}</KIconButton>
          <KIconButton :title="t('management.storage.copy')" @click="copy(viewSecret.secret)">⧉</KIconButton>
        </div>

        <!-- Additional fields: a secret one is masked like the main secret, a descriptive one
             is shown as-is. Both copy. -->
        <template v-for="(field, i) in viewSecret.fields" :key="i">
          <label class="vault__reveal-label mono">{{ field.label }}</label>
          <div class="vault__reveal-row">
            <code class="vault__secret">
              {{ field.secret && !revealedFields.has(i) ? mask(field.value) : field.value || '—' }}
            </code>
            <KIconButton
              v-if="field.secret"
              :title="revealedFields.has(i) ? t('management.storage.hideSecret') : t('management.storage.showSecret')"
              @click="toggleField(i)"
            >{{ revealedFields.has(i) ? '🙈' : '👁' }}</KIconButton>
            <KIconButton :title="t('management.storage.copy')" @click="copy(field.value)">⧉</KIconButton>
          </div>
        </template>

        <template v-if="viewSecret.requiresTwoFactor">
          <label class="vault__reveal-label mono">{{ t('management.storage.twoFactorLabel') }}</label>
          <div class="vault__reveal-row">
            <span class="vault__two-factor">
              {{ viewSecret.twoFactorOwner
                ? t('management.storage.twoFactorHeldBy', { owner: viewSecret.twoFactorOwner })
                : t('management.storage.twoFactorRequired') }}
            </span>
          </div>
        </template>

        <template v-if="viewSecret.filePath">
          <label class="vault__reveal-label mono">{{ t('management.storage.fileLabel') }}</label>
          <div class="vault__reveal-row">
            <span class="vault__file-name">{{ viewSecret.fileName ?? viewSecret.filePath }}</span>
            <KBtn variant="secondary" :loading="downloading" @click="runDownload(viewSecret.filePath)">
              {{ t('management.storage.download') }}
            </KBtn>
          </div>
        </template>
        <span v-if="copied" class="vault__copied mono">{{ t('management.storage.copied') }}</span>
      </div>

      <template #controls>
        <KBtn variant="ghost" @click="closeView(false)">{{ t('management.storage.close') }}</KBtn>
      </template>
    </KModal>

    <!-- ── share / remove access (the password's owner) ──────────────────────── -->
    <KModal
      :model-value="shareOpen"
      :title="t('management.storage.shareTitle', { title: sharing?.title ?? '' })"
      width="480px"
      persistent
      @update:model-value="closeShare"
    >
      <div class="vault__form">
        <p class="vault__note">{{ t('management.storage.shareNote') }}</p>
        <KSelect
          v-if="shareOptions.length"
          multiple
          :values="shareTo"
          :label="t('management.storage.shareWith')"
          :options="shareOptions"
          :summary="shareSummary"
          searchable
          @update:values="(v: string[]) => (shareTo = v)"
        />
        <p v-else class="vault__note">{{ t('management.storage.shareNobody') }}</p>

        <!-- Everyone who can read it now, and through what. A share (or an approved request)
             can be taken back here; the workspace owner and managers read through their seat,
             which is changed in the members panel, not here. -->
        <div v-if="sharing" class="vault__access">
          <label class="vault__reveal-label mono">{{ t('management.storage.colHolders') }}</label>
          <div v-for="h in holdersOf(sharing.id)" :key="h.userId" class="vault__access-row">
            <KAvatar :name="holderName(h)" :avatar-url="h.avatarUrl" :size="22" />
            <span class="vault__access-name">{{ holderName(h) }}</span>
            <KTag plain class="vault__access-via">{{ viaLabel(h) }}</KTag>
            <KBtn
              v-if="h.via === 'grant'"
              variant="ghost"
              :disabled="shareBusy || revoking === h.userId"
              @click="revoke(h)"
            >{{ revoking === h.userId ? t('management.storage.revoking') : t('management.storage.revoke') }}</KBtn>
          </div>
        </div>
        <p v-if="shareError" class="vault__form-error">{{ shareError }}</p>
      </div>

      <template #controls>
        <KBtn variant="ghost" :disabled="shareBusy" @click="closeShare(false)">
          {{ t('management.storage.close') }}
        </KBtn>
        <KBtn variant="primary" :disabled="shareBusy || !shareTo.length" @click="confirmShare">
          {{ shareBusy ? t('management.storage.sharing') : t('management.storage.share') }}
        </KBtn>
      </template>
    </KModal>

    <!-- ── create / edit (manager/owner) ─────────────────────────────────────── -->
    <KModal
      :model-value="editorOpen"
      :title="draft.id ? t('management.storage.editTitle') : t('management.storage.createTitle')"
      width="640px"
      persistent
      @update:model-value="closeEditor"
    >
      <div class="vault__form">
        <KField
          v-model="draft.title"
          :label="t('management.storage.fieldTitle')"
          :placeholder="t('management.storage.fieldTitlePlaceholder')"
        />
        <KField
          v-model="draft.secret"
          :label="t('management.storage.fieldSecret')"
          :placeholder="t('management.storage.fieldSecretPlaceholder')"
          :type="editorShowSecret ? 'text' : 'password'"
        />
        <button type="button" class="vault__link mono" @click="editorShowSecret = !editorShowSecret">
          {{ editorShowSecret ? t('management.storage.hideSecret') : t('management.storage.showSecret') }}
        </button>

        <!-- Additional fields. Each row is a label, a value and a «secret» box: a ticked value
             is masked here and in the view, an unticked one is plain descriptive text. -->
        <div class="vault__fields">
          <label class="vault__reveal-label mono">{{ t('management.storage.fieldsLabel') }}</label>
          <div v-for="(field, i) in draft.fields" :key="field.uid" class="vault__field-row">
            <KField
              v-model="field.label"
              class="vault__field-label"
              :placeholder="t('management.storage.fieldLabelPlaceholder')"
            />
            <KField
              v-model="field.value"
              class="vault__field-value"
              :placeholder="t('management.storage.fieldValuePlaceholder')"
              :type="field.secret && !editorShowSecret ? 'password' : 'text'"
            />
            <KCheckbox v-model="field.secret" :label="t('management.storage.fieldIsSecret')" />
            <KIconButton :title="t('management.storage.removeField')" @click="draft.fields.splice(i, 1)">✕</KIconButton>
          </div>
          <KBtn variant="ghost" class="vault__add-field" @click="addField()">
            {{ t('management.storage.addField') }}
          </KBtn>
        </div>

        <div class="vault__two-factor-field">
          <KCheckbox v-model="draft.requiresTwoFactor" :label="t('management.storage.twoFactorCheck')" />
          <KField
            v-if="draft.requiresTwoFactor"
            v-model="draft.twoFactorOwner"
            :label="t('management.storage.twoFactorOwner')"
            :placeholder="t('management.storage.twoFactorOwnerPlaceholder')"
          />
        </div>

        <div class="vault__file-field">
          <label class="vault__reveal-label mono">{{ t('management.storage.fileLabel') }}</label>
          <div class="vault__reveal-row">
            <span class="vault__file-name">{{ fileFieldLabel }}</span>
            <KBtn variant="secondary" @click="fileInput?.click()">
              {{ hasFile ? t('management.storage.replaceFile') : t('management.storage.attachFile') }}
            </KBtn>
            <KBtn v-if="hasFile" variant="ghost" @click="clearDraftFile()">
              {{ t('management.storage.removeFile') }}
            </KBtn>
          </div>
          <input ref="fileInput" type="file" class="vault__file-input" @change="onPick" />
        </div>

        <p v-if="editorError" class="vault__form-error">{{ editorError }}</p>
      </div>

      <template #controls>
        <KBtn variant="ghost" :disabled="saving" @click="closeEditor(false)">
          {{ t('management.storage.cancel') }}
        </KBtn>
        <KBtn variant="primary" :disabled="saving || !draft.title.trim()" @click="save">
          {{ saving ? t('management.storage.saving') : t('management.storage.save') }}
        </KBtn>
      </template>
    </KModal>
  </section>
</template>

<script setup lang="ts">
// The workspace password vault — the "Storage" management section. Three sights of one list:
//   * a manager/owner reads every secret, creates/edits/deletes, and answers access requests;
//   * a developer sees every TITLE (so the team knows which credentials exist) and, per row,
//     either an approved secret, a pending request, a declined mark, or a Request button.
// Every member also sees WHO may read each password (count + faces), never what is inside.
// A password's owner — the member who filed it, the workspace owner or a manager — may also
// share it with one or more members outright, which lands as each member's approved grant,
// and take any such grant back from the same dialog.
// A password's contents are its secret, any additional labelled fields (each secret or
// descriptive), a 2FA marker naming who holds the second factor, and an optional file.
// The screen owns view state only; every read and write goes through stores/passwords.ts,
// under the operator's own JWT, so RLS — not this file — is the authorization surface. What
// is drawn here is a courtesy that matches it, never a substitute for it.
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { confirmAction } from '../lib/confirm';
import type { PasswordHolder, WorkspacePassword, WorkspacePasswordField, WorkspacePasswordSecretPatch } from '@kermanych/cloud';
import KTable, { type KTableColumn } from 'components/kit/KTable.vue';
import KModal from 'components/kit/KModal.vue';
import KField from 'components/kit/KField.vue';
import KBtn from 'components/kit/KBtn.vue';
import KTag from 'components/kit/KTag.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import KAvatar from 'components/kit/KAvatar.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import { errorText, useAsyncAction, useKeyedAction } from '../composables/useAsyncAction';
import { useLoadPhase } from '../composables/useLoadPhase';
import { usePasswords } from 'stores/passwords';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { useAuth } from 'stores/auth';

const props = defineProps<{ workspaceId: string; workspaceName: string }>();
const store = usePasswords();
const projects = useProjects();
const auth = useAuth();
const { notify } = useOrchestrator();
const { t } = useI18n();

// Refetch on open and whenever the sidebar switches workspace. Members come too: the request
// panel names people, and canManage reads the caller's own seat off the roster. A roster that
// fails to load is remembered, so the row actions fall back to the developer view (RLS still
// decides) instead of waiting on a skeleton forever.
const rosterFailedFor = ref<string | null>(null);
watch(
  () => props.workspaceId,
  (id) => {
    if (!id) return;
    void store.load(id);
    if (!projects.members[id]) {
      rosterFailedFor.value = null;
      projects.loadMembers(id).catch((e: unknown) => {
        rosterFailedFor.value = id;
        notify(errorText(e), 'error');
      });
    }
  },
  { immediate: true },
);

const canManage = computed(() => projects.canManageWorkspace(props.workspaceId));
const all = computed(() => store.byWorkspace[props.workspaceId] ?? []);

// The vault for THIS workspace has not arrived yet. A refetch of a list already on screen
// keeps it (the slot stays filled); an error is drawn by its own paragraph.
const phase = useLoadPhase(() => !store.loadError && store.byWorkspace[props.workspaceId] === undefined);
// The caller's role is known once the roster is in — or at once for the workspace owner,
// whom myRole reads off the workspace row.
const rolePhase = useLoadPhase(
  () =>
    !canManage.value &&
    projects.members[props.workspaceId] === undefined &&
    rosterFailedFor.value !== props.workspaceId,
);

const query = ref('');
const rows = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q ? all.value.filter((p) => p.title.toLowerCase().includes(q)) : all.value;
});

const columns = computed<KTableColumn[]>(() => [
  { key: 'title', label: t('management.storage.colTitle') },
  { key: 'holders', label: t('management.storage.colHolders'), width: '220px' },
  { key: 'status', label: t('management.storage.colStatus'), width: '160px' },
  { key: 'actions', label: '', width: '240px', align: 'right' },
]);

// The caller's own request row per password, so the button state is a lookup rather than a
// scan. A developer sees only their rows; a manager sees all, but reads their own here.
const myAccess = computed(() => {
  const uid = auth.user?.id;
  const map = new Map<string, string>();
  if (!uid) return map;
  for (const a of store.accessByWorkspace[props.workspaceId] ?? []) {
    if (a.requesterId === uid) map.set(a.passwordId, a.status);
  }
  return map;
});
function statusOf(passwordId: string): string | undefined {
  return myAccess.value.get(passwordId);
}

const pending = computed(() =>
  (store.accessByWorkspace[props.workspaceId] ?? []).filter((a) => a.status === 'pending'),
);

function memberName(userId: string): string {
  const m = (projects.members[props.workspaceId] ?? []).find((x) => x.userId === userId);
  return m?.profile?.displayName ?? m?.profile?.githubUsername ?? userId;
}
function passwordTitle(passwordId: string): string {
  return all.value.find((p) => p.id === passwordId)?.title ?? passwordId;
}

// ── who holds each password ─────────────────────────────────────────────────
// Grouped once per read rather than filtered per cell. The rpc already orders each
// password's holders owner → managers → grants, so the first MAX_FACES are stable.
const MAX_FACES = 4;
const holdersByPassword = computed(() => {
  const map = new Map<string, PasswordHolder[]>();
  for (const h of store.holdersByWorkspace[props.workspaceId] ?? []) {
    const list = map.get(h.passwordId);
    if (list) list.push(h);
    else map.set(h.passwordId, [h]);
  }
  return map;
});
function holdersOf(passwordId: string): PasswordHolder[] {
  return holdersByPassword.value.get(passwordId) ?? [];
}
// Same fallback chain as lib/members.ts handleOf, so a face here carries the name the
// board and the members panel give the same person.
function holderName(h: PasswordHolder): string {
  return h.githubUsername ?? h.displayName ?? h.userId;
}
function overflowNames(passwordId: string): string {
  return holdersOf(passwordId).slice(MAX_FACES).map(holderName).join(', ');
}

// ── request / decide ────────────────────────────────────────────────────────
// One busy flag per row: asking for one password neither spins nor blocks the others.
const requesting = useKeyedAction(async (_id: string, row: WorkspacePassword) => {
  try {
    await store.requestAccess(props.workspaceId, row.id);
  } catch (e) {
    throw new Error(t('management.storage.requestFailed', { error: errorText(e) }));
  }
  notify(t('management.storage.requestSent', { title: row.title }), 'info');
});

// Keyed per request AND verdict, so the pressed button spins while its sibling is only
// disabled.
function decideKey(requestId: string, approve: boolean): string {
  return `${requestId}:${approve ? 'approve' : 'decline'}`;
}
const deciding = useKeyedAction(async (_key: string, req: { id: string }, approve: boolean) => {
  try {
    await store.decideAccess(props.workspaceId, req.id, approve);
  } catch (e) {
    const key = approve ? 'management.storage.approveFailed' : 'management.storage.declineFailed';
    throw new Error(t(key, { error: errorText(e) }));
  }
});

// ── share / remove access ───────────────────────────────────────────────────
// Mirrors can_share_password: the filer of the password while still on the roster, or anyone
// who manages the vault. UX gate only — share_password_with_members and revoke_password_access
// refuse everyone else.
function canShare(row: WorkspacePassword): boolean {
  if (canManage.value) return true;
  const uid = auth.user?.id;
  return !!uid && row.createdBy === uid && !!projects.myRole(props.workspaceId);
}

const shareOpen = ref(false);
const sharing = ref<WorkspacePassword | undefined>(undefined);
const shareTo = ref<string[]>([]);
const shareBusy = ref(false);
const shareError = ref<string | null>(null);
const revoking = ref('');

// Everyone else on the roster who cannot read this password yet — never the caller, whom
// share_password refuses. A member with a pending or declined ask is offered too: sharing
// turns that ask into the grant.
const shareOptions = computed<KSelectOption[]>(() => {
  const row = sharing.value;
  if (!row) return [];
  const holding = new Set(holdersOf(row.id).map((h) => h.userId));
  const uid = auth.user?.id;
  return (projects.members[props.workspaceId] ?? [])
    .filter((m) => m.userId !== uid && !holding.has(m.userId))
    .map((m) => ({ value: m.userId, label: memberName(m.userId) }));
});
const shareSummary = computed(() =>
  shareTo.value.length ? shareTo.value.map(memberName).join(', ') : t('management.storage.sharePick'),
);

function viaLabel(h: PasswordHolder): string {
  if (h.via === 'owner') return t('management.storage.viaOwner');
  if (h.via === 'manager') return t('management.storage.viaManager');
  return t('management.storage.viaGrant');
}

function openShare(row: WorkspacePassword): void {
  sharing.value = row;
  shareTo.value = [];
  shareError.value = null;
  shareOpen.value = true;
}
function closeShare(open: boolean): void {
  if (open || shareBusy.value) return;
  shareOpen.value = false;
  sharing.value = undefined;
}
async function confirmShare(): Promise<void> {
  const row = sharing.value;
  const userIds = shareTo.value;
  if (!row || !userIds.length) return;
  shareBusy.value = true;
  shareError.value = null;
  try {
    await store.share(props.workspaceId, row.id, userIds);
  } catch (e) {
    shareError.value = t('management.storage.shareFailed', { error: errorText(e) });
    return;
  } finally {
    shareBusy.value = false;
  }
  notify(t('management.storage.shared', { title: row.title, who: userIds.map(memberName).join(', ') }), 'info');
  closeShare(false);
}

// Takes one member's share back. The dialog stays open: the row leaves the list, and the
// member is offered in the picker again.
async function revoke(h: PasswordHolder): Promise<void> {
  const row = sharing.value;
  if (!row) return;
  const ok = await confirmAction({
    title: t('confirmations.revokeGrant.title'),
    message: t('confirmations.revokeGrant.message', { who: holderName(h), title: row.title }),
    confirmLabel: t('confirmations.label.revoke'),
  });
  if (!ok || sharing.value?.id !== row.id) return;
  revoking.value = h.userId;
  shareError.value = null;
  try {
    await store.revoke(props.workspaceId, row.id, h.userId);
    notify(t('management.storage.revoked', { title: row.title, who: holderName(h) }), 'info');
  } catch (e) {
    shareError.value = t('management.storage.revokeFailed', { error: errorText(e) });
  } finally {
    revoking.value = '';
  }
}

// ── view / reveal ─────────────────────────────────────────────────────────────
const viewOpen = ref(false);
const viewing = ref<WorkspacePassword | undefined>(undefined);
const showSecret = ref(false);
// Indices of the additional fields whose secret value is currently unmasked.
const revealedFields = ref(new Set<number>());
const copied = ref(false);
const viewSecret = computed(() => (viewing.value ? store.secretByPassword[viewing.value.id] : undefined));

// Reveal can be a round trip (the cached secret is instant): the row's 👁 / ✎ spins until the
// dialog opens or the refusal arrives.
const viewAction = useKeyedAction(
  async (_id: string, row: WorkspacePassword) => {
    showSecret.value = false;
    revealedFields.value = new Set();
    copied.value = false;
    const secret = await store.reveal(row.id);
    if (!secret) {
      notify(t('management.storage.noAccess'), 'error');
      return;
    }
    viewing.value = row;
    viewOpen.value = true;
  },
  { onError: (e) => notify(t('management.storage.revealFailed', { error: errorText(e) }), 'error') },
);
function closeView(open: boolean): void {
  if (open) return;
  viewOpen.value = false;
  viewing.value = undefined;
}
function toggleField(i: number): void {
  const next = new Set(revealedFields.value);
  if (!next.delete(i)) next.add(i);
  revealedFields.value = next;
}

function mask(secret: string): string {
  return secret ? '•'.repeat(Math.min(secret.length, 24)) : '—';
}
async function copy(secret: string): Promise<void> {
  await navigator.clipboard.writeText(secret);
  copied.value = true;
}
const { run: runDownload, busy: downloading } = useAsyncAction(
  async (filePath: string) => {
    const url = await store.fileUrl(filePath);
    if (url) window.open(url, '_blank', 'noopener');
    else notify(t('management.storage.downloadFailed'), 'error');
  },
  { onError: () => notify(t('management.storage.downloadFailed'), 'error') },
);

// ── create / edit ─────────────────────────────────────────────────────────────
const editorOpen = ref(false);
const editorShowSecret = ref(false);
const editorError = ref<string | null>(null);
const saving = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

// `id` absent = create. `original` records what was loaded so a save only sends what
// changed. `pickedFile` is a fresh upload; `removeExisting` marks the existing one for
// detach; `existingFile` is the name/path already stored. Each draft field carries a local
// `uid` so Vue keeps its inputs attached to the right row when one above it is removed.
type DraftField = WorkspacePasswordField & { uid: number };
let nextFieldUid = 0;
const draft = reactive<{
  id?: string;
  title: string;
  secret: string;
  fields: DraftField[];
  requiresTwoFactor: boolean;
  twoFactorOwner: string;
}>({ title: '', secret: '', fields: [], requiresTwoFactor: false, twoFactorOwner: '' });
const pickedFile = ref<File | null>(null);
const removeExisting = ref(false);
const existingFile = reactive<{ path: string | undefined; name: string | undefined }>({
  path: undefined,
  name: undefined,
});
const original = reactive({
  title: '',
  secret: '',
  fields: '[]', // JSON of the loaded fields, for a cheap structural compare
  requiresTwoFactor: false,
  twoFactorOwner: '',
});

function addField(): void {
  draft.fields.push({ uid: nextFieldUid++, label: '', value: '', secret: false });
}

// The fields as they will be stored: labels trimmed, fully blank rows dropped (an «Add
// field» click that was never filled in), values verbatim — a secret is never trimmed.
// `null` when a row has a value but no label; Postgres would refuse it anyway, and the
// editor says why instead.
function collectFields(): WorkspacePasswordField[] | null {
  const out: WorkspacePasswordField[] = [];
  for (const f of draft.fields) {
    const label = f.label.trim();
    if (!label && !f.value) continue;
    if (!label) return null;
    out.push({ label, value: f.value, secret: f.secret });
  }
  return out;
}

const hasFile = computed(() => !!pickedFile.value || (!!existingFile.path && !removeExisting.value));
const fileFieldLabel = computed(() => {
  if (pickedFile.value) return pickedFile.value.name;
  if (existingFile.path && !removeExisting.value) return existingFile.name ?? existingFile.path;
  return t('management.storage.noFile');
});

function resetDraft(): void {
  draft.title = '';
  draft.secret = '';
  draft.fields = [];
  draft.requiresTwoFactor = false;
  draft.twoFactorOwner = '';
  delete draft.id;
  pickedFile.value = null;
  removeExisting.value = false;
  existingFile.path = undefined;
  existingFile.name = undefined;
  original.title = '';
  original.secret = '';
  original.fields = '[]';
  original.requiresTwoFactor = false;
  original.twoFactorOwner = '';
  editorError.value = null;
  editorShowSecret.value = false;
  if (fileInput.value) fileInput.value.value = '';
}

function openCreate(): void {
  resetDraft();
  editorOpen.value = true;
}

const editAction = useKeyedAction(
  async (_id: string, row: WorkspacePassword) => {
    resetDraft();
    // A manager can always read the secret; load it so the form is prefilled with real values
    // rather than a masked placeholder that a blank save would then wipe.
    const secret = await store.reveal(row.id);
    draft.id = row.id;
    draft.title = row.title;
    draft.secret = secret?.secret ?? '';
    const fields = secret?.fields ?? [];
    draft.fields = fields.map((f) => ({ ...f, uid: nextFieldUid++ }));
    draft.requiresTwoFactor = secret?.requiresTwoFactor ?? false;
    draft.twoFactorOwner = secret?.twoFactorOwner ?? '';
    original.title = row.title;
    original.secret = secret?.secret ?? '';
    original.fields = JSON.stringify(fields);
    original.requiresTwoFactor = draft.requiresTwoFactor;
    original.twoFactorOwner = draft.twoFactorOwner;
    existingFile.path = secret?.filePath;
    existingFile.name = secret?.fileName;
    editorOpen.value = true;
  },
  { onError: (e) => notify(t('management.storage.revealFailed', { error: errorText(e) }), 'error') },
);

function closeEditor(open: boolean): void {
  if (open || saving.value) return;
  editorOpen.value = false;
  resetDraft();
}

function onPick(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0] ?? null;
  if (file) {
    pickedFile.value = file;
    removeExisting.value = false;
  }
}
function clearDraftFile(): void {
  pickedFile.value = null;
  removeExisting.value = true;
  if (fileInput.value) fileInput.value.value = '';
}

async function save(): Promise<void> {
  const title = draft.title.trim();
  if (!title) return;
  const fields = collectFields();
  if (!fields) {
    editorError.value = t('management.storage.fieldLabelMissing');
    return;
  }
  const twoFactorOwner = draft.requiresTwoFactor ? draft.twoFactorOwner.trim() : '';
  saving.value = true;
  editorError.value = null;
  try {
    if (draft.id) await saveEdit(draft.id, title, fields, twoFactorOwner);
    else
      await store.create(
        props.workspaceId,
        {
          title,
          secret: draft.secret,
          fields,
          requiresTwoFactor: draft.requiresTwoFactor,
          ...(twoFactorOwner ? { twoFactorOwner } : {}),
        },
        pickedFile.value,
      );
    editorOpen.value = false;
    resetDraft();
  } catch (e) {
    editorError.value = errorText(e);
  } finally {
    saving.value = false;
  }
}

// Only what changed is sent: a title rename never rewrites the secret row, and the secret
// row's patch carries only the columns that moved, so two managers editing different parts
// do not clobber each other.
async function saveEdit(
  id: string,
  title: string,
  fields: WorkspacePasswordField[],
  twoFactorOwner: string,
): Promise<void> {
  if (title !== original.title) await store.rename(props.workspaceId, id, title);
  const patch: WorkspacePasswordSecretPatch = {};
  if (draft.secret !== original.secret) patch.secret = draft.secret;
  if (JSON.stringify(fields) !== original.fields) patch.fields = fields;
  if (draft.requiresTwoFactor !== original.requiresTwoFactor) patch.requiresTwoFactor = draft.requiresTwoFactor;
  if (twoFactorOwner !== original.twoFactorOwner) patch.twoFactorOwner = twoFactorOwner || null;
  if (Object.keys(patch).length) await store.saveSecret(id, patch);
  if (pickedFile.value) await store.attachFile(id, pickedFile.value, existingFile.path);
  else if (removeExisting.value && existingFile.path) await store.removeFile(id, existingFile.path);
}

// ── delete ──────────────────────────────────────────────────────────────────
// The confirm stays outside the action: the ✕ spins for the delete, not while the operator
// reads the question.
const deleting = useKeyedAction(async (_id: string, row: WorkspacePassword) => {
  try {
    await store.remove(props.workspaceId, row.id);
  } catch (e) {
    throw new Error(t('management.storage.deleteFailed', { title: row.title, error: errorText(e) }));
  }
  if (viewing.value?.id === row.id) closeView(false);
});
async function remove(row: WorkspacePassword): Promise<void> {
  const ok = await confirmAction({
    title: t('confirmations.deletePassword'),
    message: t('management.storage.deleteConfirm', { title: row.title }),
    confirmLabel: t('confirmations.label.delete'),
  });
  if (ok) void deleting.run(row.id, row);
}
</script>

<style scoped lang="scss">
.vault {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  width: 100%;
  padding: var(--k-sp-3) 0;
}

.vault__lead {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  line-height: 1.5;
  color: var(--k-muted);
}

.vault__lead-workspace {
  color: var(--k-text);
}

.vault__requests {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  background: color-mix(in srgb, var(--k-warning) 10%, transparent);
  border-left: var(--k-rule-strong) solid var(--k-warning);
  border-radius: var(--k-r-lg);
}

.vault__requests-title {
  margin: 0;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.vault__request {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  font-size: var(--k-fs-sm);
}

.vault__request-who {
  color: var(--k-text);
}

.vault__request-what {
  color: var(--k-muted);
}

.vault__request-actions {
  display: flex;
  gap: var(--k-sp-2);
  margin-left: auto;
}

.vault__toolbar {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.vault__error {
  margin: 0;
  padding: var(--k-sp-3);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-accent) 10%, transparent);
  border-left: var(--k-rule-strong) solid var(--k-accent);
}

.vault__blank {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-6);
  background: color-mix(in srgb, var(--k-surface2) 30%, transparent);
  border: var(--k-rule-thin) dashed var(--k-line-strong);
  border-radius: var(--k-r-lg);
}

.vault__blank-eyebrow {
  font-size: var(--k-fs-xs);
  letter-spacing: 0.2em;
  color: var(--k-muted);
}

.vault__blank-text {
  margin: 0;
  font-size: var(--k-fs-md);
  color: var(--k-muted);
}

.vault__title {
  color: var(--k-text);
}

.vault__ok {
  color: var(--k-success);
}
.vault__wait {
  color: var(--k-warning);
}
.vault__no {
  color: var(--k-danger);
}

.vault__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--k-sp-2);
}

.vault__danger:focus-visible {
  color: var(--k-danger);
}

.vault__reveal,
.vault__form {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.vault__reveal-label {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.vault__reveal-row {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.vault__secret {
  flex: 1;
  padding: var(--k-sp-2);
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-surface2) 50%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-sm);
  word-break: break-all;
}

.vault__copied {
  font-size: var(--k-fs-xs);
  color: var(--k-success);
}

.vault__file-name {
  flex: 1;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
  word-break: break-all;
}

.vault__file-field {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.vault__file-input {
  display: none;
}

.vault__link {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  font-family: var(--k-font-mono);
  font-size: 10px;
  color: var(--k-accent);
  cursor: pointer;
}

.vault__form-error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-danger);
}

.vault__holders {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.vault__holders-count {
  min-width: 1.5em;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.vault__faces {
  display: flex;
  align-items: center;
  gap: 2px;
}

// The overflow chip is round on purpose, so «+N more» never reads as one more (square) face.
.vault__more {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  font-size: 10px;
  color: var(--k-text);
  background: var(--k-surface2);
  border: 1px solid var(--k-line-strong);
  border-radius: 50%;
}

.vault__fields,
.vault__two-factor-field {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

// The share dialog's «People with access»: one row per reader, a revoke button on shares.
.vault__access {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  margin-top: var(--k-sp-2);
}

.vault__access-row {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-height: 32px;
}

.vault__access-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vault__access-via {
  flex: none;
}

.vault__field-row {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.vault__field-label {
  flex: 0 0 34%;
  min-width: 0;
}

.vault__field-value {
  flex: 1;
  min-width: 0;
}

.vault__add-field {
  align-self: flex-start;
}

.vault__two-factor {
  font-size: var(--k-fs-sm);
  color: var(--k-text);
}

.vault__note {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-muted);
}
</style>
