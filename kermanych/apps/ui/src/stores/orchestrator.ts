// apps/ui/src/stores/orchestrator.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Socket } from 'socket.io-client';
import type {
  BranchPrefix,
  ImageInput,
  Group,
  Session,
  TranscriptEntry,
  ServerEvent,
  RpcExtensionUIResponse,
} from '@kermanych/core';
import { connectSocket } from '../lib/socket';
import { api, type MessageMode } from '../lib/api';

export type Toast = { id: string; message: string; kind: 'error' | 'info' };

export const useOrchestrator = defineStore('orchestrator', () => {
  const groups = ref<Group[]>([]);
  const sessions = ref<Session[]>([]);
  const transcripts = ref<Record<string, TranscriptEntry[]>>({});
  const selectedGroupId = ref<string | undefined>(undefined);
  const selectedSessionId = ref<string | undefined>(undefined);
  const previews = ref<Record<string, string>>({});
  const toasts = ref<Toast[]>([]);

  let socket: Socket | undefined;

  // Reduce a ServerEvent into state — mirrors the legacy MVP store exactly.
  function reduce(e: ServerEvent): void {
    if (e.type === 'snapshot') {
      groups.value = e.groups;
      sessions.value = e.sessions;
    } else if (e.type === 'group_update') {
      groups.value = [
        ...groups.value.filter((g) => g.id !== e.group.id),
        e.group,
      ];
    } else if (e.type === 'group_removed') {
      groups.value = groups.value.filter((g) => g.id !== e.groupId);
      sessions.value = sessions.value.filter((x) => x.groupId !== e.groupId);
    } else if (e.type === 'session_update') {
      sessions.value = [
        ...sessions.value.filter((x) => x.id !== e.session.id),
        e.session,
      ];
    } else if (e.type === 'session_removed') {
      sessions.value = sessions.value.filter((x) => x.id !== e.sessionId);
      if (previews.value[e.sessionId]) {
        const next = { ...previews.value };
        delete next[e.sessionId];
        previews.value = next;
      }
    } else if (e.type === 'transcript_append') {
      transcripts.value = {
        ...transcripts.value,
        [e.sessionId]: [...(transcripts.value[e.sessionId] ?? []), e.entry],
      };
    } else if (e.type === 'transcript_reset') {
      transcripts.value = { ...transcripts.value, [e.sessionId]: e.entries };
    }
  }

  function connect(): void {
    if (socket) return;
    socket = connectSocket(reduce);
  }

  function selectGroup(id: string): void {
    selectedGroupId.value = id;
    selectedSessionId.value = undefined;
  }

  function selectSession(id?: string): void {
    selectedSessionId.value = id;
  }

  // Actions delegating to the REST api.
  function createGroup(name: string, projectDir: string, carryFiles?: string[]) {
    return api.createGroup(name, projectDir, carryFiles);
  }

  function deleteGroup(id: string) {
    return api.deleteGroup(id);
  }

  function createSession(
    groupId: string,
    name: string,
    task: string,
    model?: string,
    images?: ImageInput[],
    worktree = true,
    prefix: BranchPrefix = 'feature',
  ) {
    return api.createSession(groupId, name, task, model, images, worktree, prefix);
  }

  function sendMessage(id: string, text: string, mode: MessageMode, images?: ImageInput[]) {
    return api.sendMessage(id, text, mode, images);
  }

  function answerUi(id: string, res: RpcExtensionUIResponse) {
    return api.answerUi(id, res);
  }

  function stopSession(id: string) {
    return api.stopSession(id);
  }

  function deleteSession(id: string) {
    return api.deleteSession(id);
  }

  function archiveSession(id: string) {
    return api.archiveSession(id);
  }

  function unarchiveSession(id: string) {
    return api.unarchiveSession(id);
  }

  async function loadTranscript(id: string) {
    const entries = await api.loadTranscript(id);
    transcripts.value = { ...transcripts.value, [id]: entries };
    return entries;
  }

  async function startPreview(id: string) {
    const res = await api.startPreview(id);
    if (res.url) previews.value = { ...previews.value, [id]: res.url };
    return res;
  }

  async function stopPreview(id: string) {
    await api.stopPreview(id);
    const next = { ...previews.value };
    delete next[id];
    previews.value = next;
  }

  function updateGroup(id: string, patch: { previewCommand?: string; apiCommand?: string; carryFiles?: string[] }) {
    return api.updateGroup(id, patch);
  }

  function getEnv(id: string, file?: string) {
    return api.getEnv(id, file);
  }

  function saveEnv(id: string, patch: { file?: string; set?: Record<string, string>; remove?: string[] }) {
    return api.saveEnv(id, patch);
  }

  function finishInfo(id: string) {
    return api.finishInfo(id);
  }

  async function finishSession(id: string) {
    const res = await api.finish(id);
    // preview is stopped server-side on finish; drop its local url too.
    if (previews.value[id]) {
      const next = { ...previews.value };
      delete next[id];
      previews.value = next;
    }
    return res;
  }

  // Minimal transient notifications. notify() pushes a toast that auto-dismisses;
  // components read `toasts` and may dismiss one early.
  function notify(message: string, kind: Toast['kind'] = 'info', ms = 4000) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    toasts.value = [...toasts.value, { id, message, kind }];
    setTimeout(() => dismissToast(id), ms);
  }

  function dismissToast(id: string) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  function openEditor(id: string) {
    return api.openEditor(id);
  }

  function resolveConflict(id: string) {
    return api.resolveConflict(id);
  }

  return {
    groups,
    sessions,
    transcripts,
    selectedGroupId,
    selectedSessionId,
    connect,
    selectGroup,
    selectSession,
    createGroup,
    deleteGroup,
    createSession,
    sendMessage,
    answerUi,
    stopSession,
    deleteSession,
    loadTranscript,
    previews,
    startPreview,
    stopPreview,
    updateGroup,
    getEnv,
    saveEnv,
    finishInfo,
    finishSession,
    archiveSession,
    unarchiveSession,
    toasts,
    notify,
    dismissToast,
    openEditor,
    resolveConflict,
  };
});
