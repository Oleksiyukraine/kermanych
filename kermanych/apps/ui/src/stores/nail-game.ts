// «Гвіздки», the one-minute break game (docs/specs/2026-11-18-nail-hammer-minigame.md): whether
// the overlay is open, the leaderboard per scope, and saving a finished round. The round itself
// lives in the overlay (lib/nail-game.ts holds its rules).
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  NailGameTooSoonError,
  nailGameLeaderboard,
  submitNailGameScore,
  type NailGameLeaderRow,
} from '@kermanych/cloud';
import { globalTr } from '../boot/i18n';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';
import { useProjects } from './projects';

export type NailGameScope = 'all' | 'workspace';

/** What the result screen says about a saved round. */
export type NailGameResult = { score: number; record: boolean; place: number | null; players: number | null };

const ALL = 'all';
/** How many players a leaderboard shows; the player's own row may follow them. */
export const NAIL_GAME_BOARD_LIMIT = 10;

export const useNailGame = defineStore('nail-game', () => {
  const auth = useAuth();
  const orch = useOrchestrator();
  const projects = useProjects();

  const open = ref(false);
  const scope = ref<NailGameScope>('all');

  // The workspace in the sidebar's scope; with none, «Свій простір» is not offered.
  const workspace = computed(() => {
    const id = orch.selectedWorkspaceId;
    return id ? (projects.workspaces.find((w) => w.id === id) ?? null) : null;
  });
  // The key a leaderboard is stored under: `all`, or the workspace id.
  const scopeKey = computed(() => (scope.value === 'workspace' && workspace.value ? workspace.value.id : ALL));

  // undefined = not loaded for that scope yet, [] = nobody has played there.
  const boards = ref<Record<string, NailGameLeaderRow[] | undefined>>({});
  const boardErrors = ref<Record<string, string | undefined>>({});
  const board = computed(() => boards.value[scopeKey.value]);
  const boardError = computed(() => boardErrors.value[scopeKey.value] ?? null);

  const ownRow = (rows: NailGameLeaderRow[] | undefined) => rows?.find((r) => r.userId === auth.user?.id) ?? null;
  /** The player's best score on the whole leaderboard; null before their first round. */
  const myBest = computed(() => ownRow(boards.value[ALL])?.bestScore ?? null);

  // A reply is stored under the key it was asked for, so a late one for the other scope never
  // shows in this one.
  async function fetchBoard(key: string): Promise<NailGameLeaderRow[]> {
    const rows = await nailGameLeaderboard(auth.client, {
      workspaceId: key === ALL ? undefined : key,
      limit: NAIL_GAME_BOARD_LIMIT,
    });
    boards.value = { ...boards.value, [key]: rows };
    boardErrors.value = { ...boardErrors.value, [key]: undefined };
    return rows;
  }

  /** Load one scope's leaderboard (the current one by default); a failure is shown in place of it. */
  async function loadBoard(key: string = scopeKey.value): Promise<void> {
    try {
      await fetchBoard(key);
    } catch (e) {
      boardErrors.value = { ...boardErrors.value, [key]: e instanceof Error ? e.message : String(e) };
    }
  }

  function show(): void {
    open.value = true;
    void loadBoard();
    // The personal best («Новий рекорд!») is read from the whole leaderboard.
    if (scopeKey.value !== ALL && boards.value[ALL] === undefined) void loadBoard(ALL);
  }

  function hide(): void {
    open.value = false;
  }

  function setScope(next: NailGameScope): void {
    scope.value = next;
    void loadBoard();
  }

  /**
   * Save a finished round and refresh the leaderboards. Throws with player-facing text only when
   * the score itself was not saved: a leaderboard that fails to load leaves the place unknown
   * (and shows its own error), never a «Зберегти ще раз» for a score already in. A score of 0 is
   * not saved: there is nothing to rank.
   */
  async function submit(score: number): Promise<NailGameResult> {
    if (!auth.user) throw new Error(globalTr.t('common.notify.signInFirst'));
    if (score <= 0) return { score, record: false, place: null, players: null };
    // The best before this round; undefined when it cannot be read, so no record is claimed.
    if (boards.value[ALL] === undefined) await loadBoard(ALL);
    const before = boards.value[ALL];
    const previous = before === undefined ? undefined : (ownRow(before)?.bestScore ?? null);
    try {
      await submitNailGameScore(auth.client, score);
    } catch (e) {
      if (e instanceof NailGameTooSoonError) throw new Error(globalTr.t('nailGame.tooSoon'));
      throw e;
    }
    const key = scopeKey.value;
    await Promise.all([loadBoard(ALL), key === ALL ? null : loadBoard(key)]);
    // A refresh that failed leaves the board from before this round: its place is not this score's.
    const fresh = ownRow(boards.value[key]);
    const own = fresh && fresh.bestScore >= score ? fresh : null;
    return {
      score,
      record: previous === null || (previous !== undefined && score > previous),
      place: own?.place ?? null,
      players: own?.players ?? null,
    };
  }

  return {
    open,
    scope,
    workspace,
    board,
    boardError,
    myBest,
    show,
    hide,
    setScope,
    loadBoard,
    submit,
  };
});
