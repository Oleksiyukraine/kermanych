import { describe, expect, it } from 'vitest';
import type { Profile, WorkspaceMember } from '@kermanych/cloud';
import { handleOf, resolveAssignee } from '../src/lib/members';

function member(userId: string, profile?: Profile): WorkspaceMember {
  return {
    workspaceId: 'w1',
    userId,
    role: 'developer',
    addedAt: '2026-01-01T00:00:00.000Z',
    ...(profile ? { profile } : {}),
  };
}

describe('handleOf', () => {
  it('prefers the GitHub handle, then the display name, then the raw id', () => {
    expect(handleOf(member('u1', { id: 'u1', githubUsername: 'dan', displayName: 'Данило К.' }))).toBe('dan');
    expect(handleOf(member('u2', { id: 'u2', displayName: 'Данило К.' }))).toBe('Данило К.');
    expect(handleOf(member('u3'))).toBe('u3');
  });
});

describe('resolveAssignee', () => {
  const roster = [
    member('u1', { id: 'u1', githubUsername: 'dan', avatarUrl: 'https://pics/dan.png' }),
    member('u2', { id: 'u2', displayName: 'Дарʼя Ковальчук' }),
  ];

  it('returns null only when nobody is assigned', () => {
    expect(resolveAssignee(undefined, roster)).toBeNull();
    expect(resolveAssignee(null, roster)).toBeNull();
    // '' is what KSelect's placeholder writes back, and it means the same thing.
    expect(resolveAssignee('', roster)).toBeNull();
  });

  it('carries the picture when the profile has one', () => {
    expect(resolveAssignee('u1', roster)).toEqual({ name: 'dan', avatarUrl: 'https://pics/dan.png' });
  });

  // The board renders initials for this one, so the KEY must be absent rather than
  // undefined — the avatar decides on `!!avatarUrl`, and an unset key is also what
  // exactOptionalPropertyTypes demands of an optional field.
  it('omits avatarUrl entirely for a member with no picture', () => {
    const resolved = resolveAssignee('u2', roster);
    expect(resolved).toEqual({ name: 'Дарʼя Ковальчук' });
    expect(resolved && 'avatarUrl' in resolved).toBe(false);
  });

  // The regression this guards: an assigned card must never render as unassigned just
  // because the roster read has not landed (or failed). Unresolvable ≠ unassigned.
  it('falls back to the raw id instead of null when the roster cannot resolve the id', () => {
    expect(resolveAssignee('u9', roster)).toEqual({ name: 'u9' });
    expect(resolveAssignee('u9', [])).toEqual({ name: 'u9' });
  });
});
