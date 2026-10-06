import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A 401 from the local api signs the operator out (stores/auth.ts). That is right only when
// the api refused the token the ui is STILL holding. A request that left with a token the
// ui has since replaced — a refresh handed over mid-flight, or a sign-out followed by a new
// sign-in — used to sign out the fresh session too: bounced to /login, then a second login.
vi.mock('../src/boot/i18n', () => ({ globalTr: { t: (k: string) => k, te: () => false } }));

import { api, setAuthToken, setUnauthorizedHandler } from '../src/lib/api';

type Call = { authorization: string | undefined };
let calls: Call[];
let answer: (call: Call) => Response;
const unauthorized = vi.fn();

beforeEach(() => {
  calls = [];
  unauthorized.mockReset();
  setUnauthorizedHandler(unauthorized);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const call = { authorization: (init.headers as Record<string, string>).authorization };
      calls.push(call);
      return answer(call);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setAuthToken(undefined);
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const refused = () => new Response(JSON.stringify({ message: 'invalid access token' }), { status: 401 });

describe('local api 401 handling', () => {
  it('signs out when the api refuses the token the ui still holds', async () => {
    setAuthToken('A');
    answer = refused;
    await expect(api.listProjects()).rejects.toThrow();
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('re-sends a request refused for a replaced token with the current one, without signing out', async () => {
    setAuthToken('A');
    answer = (call) => {
      // The token rotates while the first request is in flight.
      if (call.authorization === 'Bearer A') {
        setAuthToken('B');
        return refused();
      }
      return json([]);
    };
    await expect(api.listProjects()).resolves.toEqual([]);
    expect(calls.map((c) => c.authorization)).toEqual(['Bearer A', 'Bearer B']);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('a stale refusal after sign-out does not reach the handler', async () => {
    setAuthToken('A');
    answer = () => {
      setAuthToken(undefined);
      return refused();
    };
    await expect(api.listProjects()).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('a non-401 refusal (a dead Jira token is 403) never signs out', async () => {
    setAuthToken('A');
    answer = () => new Response(JSON.stringify({ message: 'jira token invalid' }), { status: 403 });
    await expect(api.jiraSync('i1')).rejects.toThrow('jira token invalid');
    expect(unauthorized).not.toHaveBeenCalled();
  });
});
