// apps/ui/src/stores/app-update.ts
//
// The renderer half of desktop releases (docs/specs/2026-10-12-desktop-releases-and-updates.md):
// the update banner's state, the cloud's minimum version gate, and «What's new».
// Main owns electron-updater (src-electron/updater.ts); this store only mirrors its state.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { getMinAppVersion } from '@kermanych/cloud';
import {
  changelogBetween,
  changelogEntries,
  compareAppVersions,
  isBelowMinimumVersion,
  type ChangelogEntry,
} from '@kermanych/core';
// The changelog as of THIS build: «What's new» after an update works offline.
import bundledChangelog from '../../../../CHANGELOG.md?raw';
import { useAuth } from './auth';

export const APP_VERSION = process.env.APP_VERSION;
// The version whose «What's new» this machine has already shown. Device-local on purpose:
// it tracks what this install has displayed, not anything about the account.
const LAST_SEEN_KEY = 'kermanych.lastSeenVersion';
const POLICY_EVERY_MS = 4 * 60 * 60 * 1000;
export const RELEASES_URL = 'https://github.com/Oleksiyukraine/kermanych/releases/latest';

// What the «What's new» dialog shows. `entries: null` while the notes of a downloaded version
// are being fetched; an empty list when they could not be (the dialog links the release page).
export type WhatsNew = { title: 'installed' | 'ready' | 'all'; version: string; entries: ChangelogEntry[] | null };

export const useAppUpdate = defineStore('app-update', () => {
  const bridge = window.kermanych?.updates;
  // Only a packaged desktop build updates and is gated; a dev run and the web build never are.
  const packaged = bridge?.packaged ?? false;
  const state = ref<KermanychUpdateState>({ phase: 'idle' });
  const minVersion = ref<string | null>(null);
  const whatsNew = ref<WhatsNew | null>(null);
  // The banner's ✕ hides it for this run; the next quit installs the update anyway.
  const bannerDismissed = ref(false);

  const unsupported = computed(() => packaged && isBelowMinimumVersion(APP_VERSION, minVersion.value));
  const readyVersion = computed(() => (state.value.phase === 'ready' ? state.value.version : null));

  let started = false;
  async function init(): Promise<void> {
    if (started || !bridge) return;
    started = true;
    bridge.onState((s) => {
      state.value = s;
    });
    state.value = await bridge.state();
    if (!packaged) return;
    showAfterUpdate();
    await refreshPolicy();
    setInterval(() => void refreshPolicy(), POLICY_EVERY_MS);
  }

  async function refreshPolicy(): Promise<void> {
    // Unreadable (offline, cloud down) → null → nothing is blocked.
    minVersion.value = await getMinAppVersion(useAuth().client).catch(() => null);
    // A locked-out app should not wait up to 4 hours for its own next check.
    if (unsupported.value && state.value.phase === 'idle') await bridge?.check();
  }

  // First launch of a newer version on this machine: show every section since the last one
  // shown here. A fresh install (nothing recorded) only records its version.
  function showAfterUpdate(): void {
    const seen = localStorage.getItem(LAST_SEEN_KEY);
    localStorage.setItem(LAST_SEEN_KEY, APP_VERSION);
    if (!seen || compareAppVersions(APP_VERSION, seen) !== 1) return;
    const entries = changelogBetween(bundledChangelog, seen, APP_VERSION);
    if (entries.length) whatsNew.value = { title: 'installed', version: APP_VERSION, entries };
  }

  // The banner's «What's new»: the downloaded version's CHANGELOG.md, cut to the versions
  // between this one and it.
  async function openReadyNotes(): Promise<void> {
    const version = readyVersion.value;
    if (!version || !bridge) return;
    whatsNew.value = { title: 'ready', version, entries: null };
    const markdown = await bridge.changelog(version);
    const entries = markdown ? changelogBetween(markdown, APP_VERSION, version) : [];
    if (whatsNew.value?.version === version) whatsNew.value = { title: 'ready', version, entries };
  }

  // Settings → «Загальне»: this build's whole changelog.
  function openAllNotes(): void {
    whatsNew.value = { title: 'all', version: APP_VERSION, entries: changelogEntries(bundledChangelog) };
  }

  function install(): void {
    bridge?.install();
  }

  return {
    packaged,
    state,
    minVersion,
    unsupported,
    readyVersion,
    whatsNew,
    bannerDismissed,
    init,
    openReadyNotes,
    openAllNotes,
    install,
  };
});
