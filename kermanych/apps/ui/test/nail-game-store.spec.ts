// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { NailGameTooSoonError, type NailGameLeaderRow } from '@kermanych/cloud';
import { useNailGame } from '../src/stores/nail-game';

// «Гвіздки» (docs/specs/2026-11-18-nail-hammer-minigame.md, decisions 4–8). What a player would
// notice: a «Новий рекорд!» that is not one, a place from the wrong scope, a raw database word,
// and one scope's leaderboard showing under the other.
type Opts = { workspaceId?: string | undefined; limit?: number | undefined };
const leaderboard = vi.fn<(client: unknown, opts: Opts) => Promise<NailGameLeaderRow[]>>();
const submitScore = vi.fn<(client: unknown, score: number) => Promise<void>>();

vi.mock('@kermanych/cloud', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  nailGameLeaderboard: (client: unknown, opts: Opts) => leaderboard(client, opts),
  submitNailGameScore: (client: unknown, score: number) => submitScore(client, score),
}));
vi.mock('../src/stores/auth', () => ({ useAuth: () => ({ user: { id: 'me' }, client: {} }) }));
// The machine's model catalog, as GET /models would fill it.
const catalog: { id: string }[] = [];
vi.mock('../src/stores/orchestrator', () => ({
  useOrchestrator: () => ({ selectedWorkspaceId: 'w1', notify: vi.fn(), models: catalog, loadModels: async () => undefined }),
}));
vi.mock('../src/stores/projects', () => ({ useProjects: () => ({ workspaces: [{ id: 'w1', name: 'Team' }] }) }));
vi.mock('../src/boot/i18n', () => ({ globalTr: { t: (k: string) => k, te: () => false } }));

const row = (userId: string, bestScore: number, place: number, players: number): NailGameLeaderRow => ({
  place,
  userId,
  githubUsername: userId,
  displayName: null,
  avatarUrl: null,
  bestScore,
  achievedAt: '2026-11-18T10:00:00Z',
  players,
});

describe('nail game store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    leaderboard.mockReset();
    submitScore.mockReset();
  });

  it('a score above the previous best is a record, and the place comes from the scope on screen', async () => {
    const game = useNailGame();
    game.scope = 'workspace';
    let saved = false;
    submitScore.mockImplementation(async () => {
      saved = true;
    });
    leaderboard.mockImplementation(async (_c, opts) => {
      if (!opts.workspaceId) return saved ? [row('a', 90, 1, 40), row('me', 31, 7, 40)] : [row('a', 90, 1, 40), row('me', 20, 9, 40)];
      return [row('me', 31, 2, 3)];
    });

    const result = await game.submit(31);

    expect(submitScore).toHaveBeenCalledWith({}, 31);
    expect(result).toEqual({ score: 31, record: true, place: 2, players: 3 });
    expect(game.myBest).toBe(31);
    expect(game.board?.map((r) => r.userId)).toEqual(['me']);
  });

  it('a score below the best is not a record', async () => {
    const game = useNailGame();
    leaderboard.mockResolvedValue([row('me', 50, 1, 1)]);
    submitScore.mockResolvedValue();
    expect((await game.submit(12)).record).toBe(false);
  });

  it('saves nothing for 0, and words the too-soon refusal', async () => {
    const game = useNailGame();
    expect(await game.submit(0)).toEqual({ score: 0, record: false, place: null, players: null });
    expect(submitScore).not.toHaveBeenCalled();

    leaderboard.mockResolvedValue([]);
    submitScore.mockRejectedValue(new NailGameTooSoonError());
    await expect(game.submit(5)).rejects.toThrow('nailGame.tooSoon');
  });

  it('saves the score even when the leaderboard cannot load, and claims no record then', async () => {
    const game = useNailGame();
    leaderboard.mockRejectedValue(new Error('PGRST202'));
    submitScore.mockResolvedValue();

    expect(await game.submit(14)).toEqual({ score: 14, record: false, place: null, players: null });
    expect(submitScore).toHaveBeenCalledWith({}, 14);
    expect(game.boardError).toBe('PGRST202');
  });

  it('a late reply for the other scope never shows in this one', async () => {
    const game = useNailGame();
    const all = Promise.withResolvers<NailGameLeaderRow[]>();
    const ws = Promise.withResolvers<NailGameLeaderRow[]>();
    leaderboard.mockImplementation((_c, opts) => (opts.workspaceId ? ws.promise : all.promise));

    game.show();
    expect(game.board).toBeUndefined();
    game.setScope('workspace');
    ws.resolve([row('me', 3, 1, 1)]);
    await ws.promise;
    await Promise.resolve();
    all.resolve([row('a', 90, 1, 2), row('me', 3, 2, 2)]);
    await all.promise;
    await Promise.resolve();

    expect(game.board?.map((r) => r.userId)).toEqual(['me']);
    expect(game.myBest).toBe(3);
  });

  it('keeps up to three distinct opponents, and drops one the catalog no longer lists', async () => {
    localStorage.setItem('kermanych.nail-game.opponents', JSON.stringify(['gone-model', 'claude-opus-5']));
    catalog.splice(0, catalog.length, { id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' });
    leaderboard.mockResolvedValue([]);
    const game = useNailGame();
    game.setOpponents(['a', 'a', 'b', 'c', 'd']);
    expect(game.opponents).toEqual(['a', 'b', 'c']);

    game.setOpponents(['gone-model', 'claude-opus-5']);
    game.show();
    await vi.waitFor(() => expect(game.catalogLoaded).toBe(true));
    expect(game.opponents).toEqual(['claude-opus-5']);
    catalog.splice(0);
  });
});
