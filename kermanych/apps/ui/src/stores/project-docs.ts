import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { FileContent, TreeEntry } from '@kermanych/core';
import { api } from '../lib/api';

// Read-only view state for the Project Documentation screen. It owns NO document content of
// its own: trees and files are fetched live from the bound local checkout through the api on
// every navigation (decision A — nothing is cached in the cloud), and raw image bytes are
// turned into object URLs (the raw route needs the auth bearer, which an <img src> cannot
// carry, so the bytes are fetched by the authed api client and handed to the DOM as a blob).
export const useProjectDocs = defineStore('project-docs', () => {
  const activeProjectId = ref('');
  const openFolder = ref('');
  const openPath = ref('');
  const file = ref<FileContent | null>(null);
  const loadingFile = ref(false);
  const fileError = ref<string | null>(null);

  const urlCache = new Map<string, string>();

  function setActive(projectId: string): void {
    if (projectId === activeProjectId.value) return;
    activeProjectId.value = projectId;
    openFolder.value = '';
    openPath.value = '';
    file.value = null;
    fileError.value = null;
  }

  async function treeOf(projectId: string, folder: string, path: string): Promise<TreeEntry[]> {
    return api.projectDocsTree(projectId, folder, path);
  }

  async function openFile(projectId: string, folder: string, path: string): Promise<void> {
    openFolder.value = folder;
    openPath.value = path;
    loadingFile.value = true;
    fileError.value = null;
    try {
      file.value = await api.projectDocsFile(projectId, folder, path);
    } catch (e) {
      file.value = null;
      fileError.value = e instanceof Error ? e.message : String(e);
    } finally {
      loadingFile.value = false;
    }
  }

  async function rawUrl(projectId: string, folder: string, path: string): Promise<string> {
    const key = `${projectId}\u0000${folder}\u0000${path}`;
    const hit = urlCache.get(key);
    if (hit) return hit;
    const blob = await api.projectDocsRaw(projectId, folder, path);
    const url = URL.createObjectURL(blob);
    urlCache.set(key, url);
    return url;
  }

  function refreshIfActive(projectId: string): void {
    if (projectId !== activeProjectId.value || !openFolder.value || !openPath.value) return;
    // A pull may have changed images too; drop the object-URL cache so they refetch.
    releaseUrls();
    void openFile(projectId, openFolder.value, openPath.value);
  }

  function releaseUrls(): void {
    for (const url of urlCache.values()) URL.revokeObjectURL(url);
    urlCache.clear();
  }

  return { activeProjectId, openFolder, openPath, file, loadingFile, fileError, setActive, treeOf, openFile, rawUrl, refreshIfActive, releaseUrls };
});
