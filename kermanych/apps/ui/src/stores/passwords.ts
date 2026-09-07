// apps/ui/src/stores/passwords.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  WorkspacePassword,
  WorkspacePasswordAccess,
  WorkspacePasswordSecret,
} from '@kermanych/cloud';
import {
  clearPasswordFile as cloudClearFile,
  createWorkspacePassword as cloudCreate,
  decidePasswordAccess as cloudDecide,
  deleteWorkspacePassword as cloudDelete,
  getPasswordSecret as cloudGetSecret,
  listPasswordAccess as cloudListAccess,
  listWorkspacePasswords as cloudList,
  patchPasswordSecret as cloudPatchSecret,
  patchWorkspacePassword as cloudRename,
  requestPasswordAccess as cloudRequest,
  setPasswordFile as cloudSetFile,
  signedPasswordFileUrl as cloudSignedUrl,
} from '@kermanych/cloud';
import { useAuth } from './auth';
import { IS_PREVIEW } from '../lib/preview';
import { globalTr } from '../boot/i18n';

// The workspace password vault ("Storage"). Keyed by WORKSPACE, like the risk register: it
// is a screen you open for one group, and the group's membership plus each member's role is
// what decides who may read a secret.
//
// Three caches, because the vault is three reads with three different audiences:
//   * `byWorkspace` — the TITLES, which every member sees;
//   * `accessByWorkspace` — the request ledger the caller may see (own rows for a developer,
//     all rows for a manager/owner), the input for the Request/Approve/Decline buttons;
//   * `secretByPassword` — the SECRETS the caller has actually revealed. Never pre-loaded:
//     a developer without an approved grant gets `null` from the database, and a manager only
//     pays for the secrets they open.
//
// Deliberately no Realtime channel (the three tables are not in the supabase_realtime
// publication): the vault is edited a handful of times, by people looking at it. The screen
// refetches on open, exactly like the register.
export const usePasswords = defineStore('passwords', () => {
  const auth = useAuth();

  const byWorkspace = ref<Record<string, WorkspacePassword[]>>({});
  const accessByWorkspace = ref<Record<string, WorkspacePasswordAccess[]>>({});
  const secretByPassword = ref<Record<string, WorkspacePasswordSecret>>({});
  const loading = ref(false);
  // Inline on the screen, never a toast: an unreachable Supabase must not greet someone who
  // opened the vault only to read it (same call as the register).
  const loadError = ref<string | null>(null);

  // Replace-or-append keyed by id, then re-sorted by title so a rename does not jump the row.
  function upsertPassword(workspaceId: string, password: WorkspacePassword): void {
    const rows = (byWorkspace.value[workspaceId] ?? []).filter((p) => p.id !== password.id);
    rows.push(password);
    rows.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    byWorkspace.value = { ...byWorkspace.value, [workspaceId]: rows };
  }

  function upsertAccess(workspaceId: string, row: WorkspacePasswordAccess): void {
    const rows = (accessByWorkspace.value[workspaceId] ?? []).filter((a) => a.id !== row.id);
    rows.unshift(row);
    accessByWorkspace.value = { ...accessByWorkspace.value, [workspaceId]: rows };
  }

  async function load(workspaceId: string): Promise<void> {
    await auth.ready;
    // A preview signs in against a cloudless api (lib/preview.ts): there is no Supabase
    // project behind it, so there is no vault to read.
    if (IS_PREVIEW || !auth.user || !workspaceId) return;
    loading.value = true;
    loadError.value = null;
    try {
      const [passwords, access] = await Promise.all([
        cloudList(auth.client, workspaceId),
        cloudListAccess(auth.client, workspaceId),
      ]);
      byWorkspace.value = { ...byWorkspace.value, [workspaceId]: passwords };
      accessByWorkspace.value = { ...accessByWorkspace.value, [workspaceId]: access };
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  // Writes THROW so the editor can keep its form open and say WHY. Manager/owner only by RLS;
  // a developer's insert is refused on the title row before anything else runs.
  async function create(
    workspaceId: string,
    input: { title: string; secret: string },
    file?: File | null,
  ): Promise<WorkspacePassword> {
    if (!auth.user) throw new Error(globalTr.t('common.notify.signInFirst'));
    const { password, secret } = await cloudCreate(auth.client, { workspaceId, ...input }, file);
    upsertPassword(workspaceId, password);
    secretByPassword.value = { ...secretByPassword.value, [password.id]: secret };
    return password;
  }

  async function rename(workspaceId: string, id: string, title: string): Promise<WorkspacePassword> {
    const updated = await cloudRename(auth.client, id, { title });
    upsertPassword(workspaceId, updated);
    return updated;
  }

  async function saveSecret(passwordId: string, secret: string): Promise<WorkspacePasswordSecret> {
    const saved = await cloudPatchSecret(auth.client, passwordId, secret);
    secretByPassword.value = { ...secretByPassword.value, [passwordId]: saved };
    return saved;
  }

  async function attachFile(
    passwordId: string,
    file: File,
    previousPath?: string,
  ): Promise<WorkspacePasswordSecret> {
    const saved = await cloudSetFile(auth.client, passwordId, file, previousPath);
    secretByPassword.value = { ...secretByPassword.value, [passwordId]: saved };
    return saved;
  }

  async function removeFile(passwordId: string, filePath: string): Promise<WorkspacePasswordSecret> {
    const saved = await cloudClearFile(auth.client, passwordId, filePath);
    secretByPassword.value = { ...secretByPassword.value, [passwordId]: saved };
    return saved;
  }

  // Reveal one secret. Returns the cached copy if it is already open; otherwise reads it. A
  // `null` is not an error — it is the database saying "not permitted", which the screen draws
  // as the locked card. Real failures (offline) throw.
  async function reveal(passwordId: string): Promise<WorkspacePasswordSecret | null> {
    const cached = secretByPassword.value[passwordId];
    if (cached) return cached;
    const secret = await cloudGetSecret(auth.client, passwordId);
    if (secret) secretByPassword.value = { ...secretByPassword.value, [passwordId]: secret };
    return secret;
  }

  async function fileUrl(filePath: string): Promise<string | null> {
    return cloudSignedUrl(auth.client, filePath);
  }

  // Removes a password for good — secret and every access row cascade in Postgres, the file
  // object is removed by the cloud helper. THROWS like create: the commonest failure here is
  // one the operator can act on ("delete is manager-only"). The revealed secret cache supplies
  // the file path so the object goes with the row.
  async function remove(workspaceId: string, id: string): Promise<void> {
    if (!auth.user) throw new Error(globalTr.t('common.notify.signInFirst'));
    await cloudDelete(auth.client, id, secretByPassword.value[id]?.filePath);
    byWorkspace.value = {
      ...byWorkspace.value,
      [workspaceId]: (byWorkspace.value[workspaceId] ?? []).filter((p) => p.id !== id),
    };
    accessByWorkspace.value = {
      ...accessByWorkspace.value,
      [workspaceId]: (accessByWorkspace.value[workspaceId] ?? []).filter((a) => a.passwordId !== id),
    };
    const nextSecrets = { ...secretByPassword.value };
    delete nextSecrets[id];
    secretByPassword.value = nextSecrets;
  }

  // A developer asks to see one secret. THROWS so the button can report a refusal. Merges the
  // returned row so the button flips to "requested" without a refetch.
  async function requestAccess(workspaceId: string, passwordId: string): Promise<WorkspacePasswordAccess> {
    if (!auth.user) throw new Error(globalTr.t('common.notify.signInFirst'));
    const row = await cloudRequest(auth.client, passwordId);
    upsertAccess(workspaceId, row);
    return row;
  }

  // A manager/owner approves or declines. Merges the decided row in place.
  async function decideAccess(
    workspaceId: string,
    requestId: string,
    approve: boolean,
  ): Promise<WorkspacePasswordAccess> {
    const row = await cloudDecide(auth.client, requestId, approve);
    upsertAccess(workspaceId, row);
    return row;
  }

  return {
    byWorkspace,
    accessByWorkspace,
    secretByPassword,
    loading,
    loadError,
    load,
    create,
    rename,
    saveSecret,
    attachFile,
    removeFile,
    reveal,
    fileUrl,
    remove,
    requestAccess,
    decideAccess,
  };
});
