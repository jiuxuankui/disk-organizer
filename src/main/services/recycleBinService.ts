import { readRegistryDword, getVolumeNameForMountPoint, getDriveInfo } from './windowsService';

export type RecycleBlockReason = 'unavailable' | 'too-large' | 'batch-too-large';

export interface RecycleBinPolicy {
  available: boolean;
  blockReason: RecycleBlockReason | null;
  volumeGuid: string | null;
  noRecycleFiles: boolean;
  nukeOnDelete: boolean;
  configuredMaxCapacityMB: number | null;
  maxCapacityBytes: number;
  defaultCapacityUsed: boolean;
}

const BITBUCKET_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket';
const EXPLORER_POLICY_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer';
const GIB = 1024 * 1024 * 1024;

export function defaultRecycleBinCapacityBytes(totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  const ratio = totalBytes > 40 * GIB ? 0.1 : 0.05;
  return Math.floor(totalBytes * ratio);
}

export function computeEffectiveCapacity(
  configuredMaxCapacityMB: number | null,
  totalBytes: number,
): { bytes: number; defaultCapacityUsed: boolean } {
  if (configuredMaxCapacityMB !== null && configuredMaxCapacityMB > 0) {
    return { bytes: configuredMaxCapacityMB * 1024 * 1024, defaultCapacityUsed: false };
  }
  return { bytes: defaultRecycleBinCapacityBytes(totalBytes), defaultCapacityUsed: true };
}

function readDwordWithMachineFallback(subKey: string, value: string): number | null {
  const currentUser = readRegistryDword('currentUser', subKey, value);
  if (currentUser !== null) return currentUser;
  return readRegistryDword('localMachine', subKey, value);
}

export function readRecycleBinPolicy(driveRoot: string): RecycleBinPolicy {
  const drive = getDriveInfo(driveRoot);
  const totalBytes = drive?.totalBytes ?? 0;
  const volumeGuid = getVolumeNameForMountPoint(driveRoot);

  const noRecycleFiles = readDwordWithMachineFallback(EXPLORER_POLICY_KEY, 'NoRecycleFiles') === 1;

  let nukeOnDelete = false;
  let configuredMaxCapacityMB: number | null = null;
  if (volumeGuid) {
    const braceIndex = volumeGuid.indexOf('{');
    const volumeSubKey = braceIndex >= 0 ? volumeGuid.slice(braceIndex) : volumeGuid;
    const key = `${BITBUCKET_KEY}\\Volume\\${volumeSubKey}`;
    nukeOnDelete = readRegistryDword('currentUser', key, 'NukeOnDelete') === 1;
    configuredMaxCapacityMB = readRegistryDword('currentUser', key, 'MaxCapacity');
  }
  if (!nukeOnDelete) {
    nukeOnDelete = readDwordWithMachineFallback(BITBUCKET_KEY, 'NukeOnDelete') === 1;
  }

  const capacity = computeEffectiveCapacity(configuredMaxCapacityMB, totalBytes);
  const available = !noRecycleFiles && !nukeOnDelete && capacity.bytes > 0;

  return {
    available,
    blockReason: available ? null : 'unavailable',
    volumeGuid,
    noRecycleFiles,
    nukeOnDelete,
    configuredMaxCapacityMB,
    maxCapacityBytes: capacity.bytes,
    defaultCapacityUsed: capacity.defaultCapacityUsed,
  };
}

export interface RecycleDecision {
  allowed: boolean;
  reason: RecycleBlockReason | null;
  message: string | null;
}

export function evaluateRecycleDecision(
  policy: RecycleBinPolicy,
  fileSize: number,
  usedBytes = 0,
): RecycleDecision {
  if (!policy.available) {
    return {
      allowed: false,
      reason: 'unavailable',
      message: 'Windows 回收站当前不可用，删除功能已暂停',
    };
  }
  if (!Number.isFinite(fileSize) || fileSize < 0) {
    return { allowed: false, reason: 'unavailable', message: '无法读取文件大小，已停止删除' };
  }
  const remaining = policy.maxCapacityBytes - Math.max(0, usedBytes);
  if (fileSize > remaining) {
    return {
      allowed: false,
      reason: 'too-large',
      message:
        '文件超过 Windows 回收站容量上限，无法保证可还原，已暂停删除。可先清空回收站或调大回收站容量后重试。',
    };
  }
  return { allowed: true, reason: null, message: null };
}

export function evaluateBatchDecision(
  policy: RecycleBinPolicy,
  sizes: number[],
  usedBytes = 0,
): RecycleDecision {
  if (!policy.available) return evaluateRecycleDecision(policy, 0, usedBytes);
  const total = sizes.reduce((sum, size) => sum + Math.max(0, size), 0);
  const remaining = policy.maxCapacityBytes - Math.max(0, usedBytes);
  if (total > remaining) {
    return {
      allowed: false,
      reason: 'batch-too-large',
      message:
        '所选文件总大小超过 Windows 回收站剩余容量，无法保证全部可还原，已暂停删除。可减少选择、清空回收站或调大回收站容量后重试。',
    };
  }
  return { allowed: true, reason: null, message: null };
}
