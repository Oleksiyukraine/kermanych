import { describe, it, expect } from 'vitest';
import { readBucket } from '../src/lib/buckets';

// bucketOf itself is core's and tested there (packages/core/test/buckets.spec.ts).

describe('readBucket', () => {
  it('reads the retired buckets as agents and drops anything else', () => {
    expect(readBucket('active')).toBe('agents');
    expect(readBucket('waiting')).toBe('agents');
    expect(readBucket('errors')).toBe('agents');
    expect(readBucket('completed')).toBe('completed');
    expect(readBucket('tasks')).toBe('tasks');
    expect(readBucket('toString')).toBeUndefined();
    expect(readBucket('archived')).toBeUndefined();
    expect(readBucket(3)).toBeUndefined();
  });
});
