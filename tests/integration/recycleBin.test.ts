import { describe, expect, it } from 'vitest';
import {
  computeEffectiveCapacity,
  defaultRecycleBinCapacityBytes,
  evaluateBatchDecision,
  evaluateRecycleDecision,
  readRecycleBinPolicy,
  type RecycleBinPolicy,
} from '../../src/main/services/recycleBinService';

const GIB = 1024 ** 3;

function policy(overrides: Partial<RecycleBinPolicy> = {}): RecycleBinPolicy {
  return {
    available: true,
    blockReason: null,
    volumeGuid: '\\\\?\\Volume{00000000-0000-0000-0000-000000000000}',
    noRecycleFiles: false,
    nukeOnDelete: false,
    configuredMaxCapacityMB: 10240,
    maxCapacityBytes: 10 * 1024 ** 3,
    defaultCapacityUsed: false,
    ...overrides,
  };
}

describe('recycle bin capacity rules', () => {
  it('uses the configured MaxCapacity when present', () => {
    expect(computeEffectiveCapacity(512, 500 * GIB)).toEqual({
      bytes: 512 * 1024 * 1024,
      defaultCapacityUsed: false,
    });
  });

  it('falls back to 5 percent up to 40GB and 10 percent above', () => {
    expect(computeEffectiveCapacity(0, 20 * GIB).bytes).toBe(1 * GIB);
    expect(computeEffectiveCapacity(null, 20 * GIB).bytes).toBe(1 * GIB);
    expect(computeEffectiveCapacity(0, 100 * GIB).bytes).toBe(10 * GIB);
    expect(defaultRecycleBinCapacityBytes(0)).toBe(0);
  });

  it('fails closed when capacity cannot be derived', () => {
    expect(computeEffectiveCapacity(null, 0).bytes).toBe(0);
    const blocked = evaluateRecycleDecision(
      policy({ available: false, blockReason: 'unavailable', maxCapacityBytes: 0 }),
      1,
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('unavailable');
  });
});

describe('recycle bin decisions', () => {
  it('allows a file within remaining capacity', () => {
    const decision = evaluateRecycleDecision(policy(), 1024 ** 3, 2 * 1024 ** 3);
    expect(decision.allowed).toBe(true);
    expect(decision.message).toBeNull();
  });

  it('blocks a file larger than remaining capacity', () => {
    const decision = evaluateRecycleDecision(policy(), 9 * 1024 ** 3, 2 * 1024 ** 3);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('too-large');
    expect(decision.message).toContain('暂停删除');
  });

  it('blocks batches whose total exceeds remaining capacity', () => {
    const decision = evaluateBatchDecision(policy(), [4 * 1024 ** 3, 4 * 1024 ** 3], 3 * 1024 ** 3);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('batch-too-large');
  });

  it('allows batches within remaining capacity', () => {
    const decision = evaluateBatchDecision(policy(), [1024 ** 3, 2 * 1024 ** 3], 0);
    expect(decision.allowed).toBe(true);
  });
});

describe.runIf(process.platform === 'win32')('live recycle bin policy', () => {
  it('reads a coherent policy for the system drive', () => {
    const result = readRecycleBinPolicy('C:\\');
    expect(typeof result.available).toBe('boolean');
    expect(typeof result.noRecycleFiles).toBe('boolean');
    expect(typeof result.nukeOnDelete).toBe('boolean');
    expect(result.maxCapacityBytes).toBeGreaterThan(0);
    expect(result.volumeGuid).toMatch(/^\\\\\?\\Volume\{[0-9a-f-]+\}$/i);
    if (result.available) {
      expect(result.blockReason).toBeNull();
    } else {
      expect(result.blockReason).toBe('unavailable');
    }
  });
});
