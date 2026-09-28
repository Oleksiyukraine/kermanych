import { defineStore } from 'pinia';
import { ref } from 'vue';
import { isDocImagePath, type DocLinkEmbedCheck, type FileContent, type TreeEntry } from '@kermanych/core';
import {
  createProjectDocLink,
  deleteProjectDocLink,
  listProjectDocLinks,
  patchProjectDocLink,
  type ProjectDocLink,
  type ProjectDocLinkPatch,
} from '@kermanych/cloud';
import { api } from '../lib/api';
import { IS_PREVIEW } from '../lib/preview';
import { globalTr } from '../boot/i18n';
import { useAuth } from './auth';

// View state for the Project Documentation screen. Two sources feed its preview pane:
//
//   * repository files — fetched live from the bound local checkout through the api on every
//     navigation (decision A — nothing is cached in the cloud); raw image bytes are turned
//     into object URLs (the raw route needs the auth bearer, which an <img src> cannot carry,
//     so the bytes are fetched by the authed api client and handed to the DOM as a blob);
//   * documentation links — rows of `project_doc_links`, read from the cloud under the
//     operator's own JWT. Only the pointer is stored; the page itself is loaded by the
//     preview's iframe straight from its host.
//
// The screen shows them on two tabs, and each tab keeps its own selection: opening a file
// switches to the Repository tab without closing the open link, and vice versa, so going back
// to a tab finds the page the reader left there.
export type DocSource = 'repo' | 'links';

export const useProjectDocs = defineStore('project-docs', () => {
  const auth = useAuth();
  const activeProjectId = ref('');
  // Which tab the screen shows. Store-held (not page-local) because a file is also opened from
  // outside the screen — a documentation citation in the management chat — and must land on
  // the tab that draws it.
  const source = ref<DocSource>('repo');
  const openFolder = ref('');
  const openPath = ref('');
  const file = ref<FileContent | null>(null);
  // Object URL of the open file when it is an image (SVG included): images are shown as the
  // picture they draw, so their bytes come from the raw route and never through `file`.
  const imageUrl = ref<string | null>(null);
  const loadingFile = ref(false);
  const fileError = ref<string | null>(null);
  // Guards openFile against an out-of-order answer: an image and a text file load through
  // different routes, so a slow earlier click must not overwrite a later one.
  let openSeq = 0;
  // Bumped by refreshIfActive so the docs screen re-fetches the currently-expanded tree
  // level after a pull (files added/removed under an open folder must appear).
  const refreshNonce = ref(0);

  // The active project's links, in the order they were added.
  const links = ref<ProjectDocLink[]>([]);
  const linksLoading = ref(false);
  // Inline on the screen, never a toast: an unreachable cloud must not greet someone who came
  // to read the repository docs (same call as stores/risks.ts).
  const linksError = ref<string | null>(null);
  const openLinkId = ref('');
  // Per embed URL, for the life of the app: whether the host lets the page be framed. A
  // missing key means «not asked yet»; the answer is a property of the host, not the project.
  const embedChecks = ref<Record<string, DocLinkEmbedCheck>>({});
  const embedInFlight = new Set<string>();

  const urlCache = new Map<string, string>();

  function setActive(projectId: string): void {
    if (projectId === activeProjectId.value) return;
    // Free the object URLs of the project we are leaving before its state is dropped, and
    // orphan any open still in flight so it cannot land in the new project's preview.
    releaseUrls();
    openSeq += 1;
    activeProjectId.value = projectId;
    openFolder.value = '';
    openPath.value = '';
    file.value = null;
    setImage(null);
    fileError.value = null;
    openLinkId.value = '';
    links.value = [];
    void loadLinks(projectId);
  }

  // The open image's URL is owned here, not by urlCache: the screen releases the cache when it
  // unmounts, and an image still selected on return must not point at a revoked URL.
  function setImage(url: string | null): void {
    if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
    imageUrl.value = url;
  }

  async function treeOf(projectId: string, folder: string, path: string): Promise<TreeEntry[]> {
    return api.projectDocsTree(projectId, folder, path);
  }

  async function openFile(projectId: string, folder: string, path: string): Promise<void> {
    const seq = ++openSeq;
    source.value = 'repo';
    openFolder.value = folder;
    openPath.value = path;
    loadingFile.value = true;
    fileError.value = null;
    file.value = null;
    setImage(null);
    try {
      if (isDocImagePath(path)) {
        const url = URL.createObjectURL(await api.projectDocsRaw(projectId, folder, path));
        if (seq === openSeq) setImage(url);
        else URL.revokeObjectURL(url);
      } else {
        const fc = await api.projectDocsFile(projectId, folder, path);
        if (seq === openSeq) file.value = fc;
      }
    } catch (e) {
      if (seq === openSeq) fileError.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (seq === openSeq) loadingFile.value = false;
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
    if (projectId !== activeProjectId.value) return;
    // A pull may have changed the tree and images too: bump the nonce so the screen re-fetches
    // its open tree level, and drop the object-URL cache so images refetch (the open file,
    // image or not, is re-read below).
    refreshNonce.value += 1;
    releaseUrls();
    if (!openFolder.value || !openPath.value) return;
    void openFile(projectId, openFolder.value, openPath.value);
  }

  function releaseUrls(): void {
    for (const url of urlCache.values()) URL.revokeObjectURL(url);
    urlCache.clear();
  }

  async function loadLinks(projectId: string): Promise<void> {
    await auth.ready;
    // A preview signs in against a cloudless api (lib/preview.ts): there are no links to read.
    if (IS_PREVIEW || !auth.user || !projectId) return;
    linksLoading.value = true;
    linksError.value = null;
    try {
      const rows = await listProjectDocLinks(auth.client, projectId);
      if (projectId === activeProjectId.value) links.value = rows;
    } catch (e) {
      if (projectId === activeProjectId.value) linksError.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (projectId === activeProjectId.value) linksLoading.value = false;
    }
  }

  // Show the link on the Links tab. The open file stays open on the Repository tab.
  function openLink(id: string): void {
    source.value = 'links';
    openLinkId.value = id;
  }

  // Writes THROW so the add/edit dialog can stay open and say why; the row lands in the list
  // only once Postgres has accepted it (the audit columns are server-stamped).
  async function addLink(projectId: string, title: string, url: string): Promise<ProjectDocLink> {
    if (!auth.user) throw new Error(globalTr.t('common.notify.signInFirst'));
    const created = await createProjectDocLink(auth.client, { projectId, title, url });
    if (projectId === activeProjectId.value) links.value = [...links.value, created];
    return created;
  }

  async function saveLink(id: string, patch: ProjectDocLinkPatch): Promise<ProjectDocLink> {
    if (!auth.user) throw new Error(globalTr.t('common.notify.signInFirst'));
    const saved = await patchProjectDocLink(auth.client, id, patch);
    links.value = links.value.map((l) => (l.id === id ? saved : l));
    return saved;
  }

  async function removeLink(id: string): Promise<void> {
    if (!auth.user) throw new Error(globalTr.t('common.notify.signInFirst'));
    await deleteProjectDocLink(auth.client, id);
    links.value = links.value.filter((l) => l.id !== id);
    if (openLinkId.value === id) openLinkId.value = '';
  }

  // Ask the local api once per embed URL whether its host allows framing. A failure of the
  // api itself is recorded as «unknown», which the screen treats as «try the iframe».
  async function checkEmbed(embedUrl: string): Promise<void> {
    if (embedChecks.value[embedUrl] || embedInFlight.has(embedUrl)) return;
    embedInFlight.add(embedUrl);
    let res: DocLinkEmbedCheck;
    try {
      res = await api.docsEmbedCheck(embedUrl);
    } catch {
      res = { embeddable: null, reason: 'unreachable' };
    } finally {
      embedInFlight.delete(embedUrl);
    }
    embedChecks.value = { ...embedChecks.value, [embedUrl]: res };
  }

  return {
    source, activeProjectId, openFolder, openPath, file, imageUrl, loadingFile, fileError, refreshNonce,
    links, linksLoading, linksError, openLinkId, embedChecks,
    setActive, treeOf, openFile, rawUrl, refreshIfActive, releaseUrls,
    loadLinks, openLink, addLink, saveLink, removeLink, checkEmbed,
  };
});
