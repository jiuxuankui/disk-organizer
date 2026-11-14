import koffi from 'koffi';
import type { DriveInfo } from '@shared/types';
import { toExtendedPath } from './filesystem';

export const DRIVE_UNKNOWN = 0;
export const DRIVE_NO_ROOT_DIR = 1;
export const DRIVE_REMOVABLE = 2;
export const DRIVE_FIXED = 3;
export const DRIVE_REMOTE = 4;
export const DRIVE_CDROM = 5;
export const DRIVE_RAMDISK = 6;

export const FILE_ATTRIBUTE_READONLY = 0x1;
export const FILE_ATTRIBUTE_HIDDEN = 0x2;
export const FILE_ATTRIBUTE_SYSTEM = 0x4;
export const FILE_ATTRIBUTE_DIRECTORY = 0x10;
export const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;

export interface WindowsFileAttributes {
  attributes: number;
  hidden: boolean;
  system: boolean;
  directory: boolean;
  reparsePoint: boolean;
  readonly: boolean;
}

interface Win32Api {
  moveFileNoReplace(source: string, target: string): void;
  getDriveType(root: string): number;
  getLogicalDrives(): number;
  getVolumeInformation(root: string): {
    label: string;
    fileSystem: string;
    serial: number;
  } | null;
  getVolumeNameForMountPoint(root: string): string | null;
  getDiskSpace(root: string): { totalBytes: number; freeBytes: number } | null;
  getFileAttributes(path: string): number;
  getRegistryDword(
    hive: 'currentUser' | 'localMachine',
    subKey: string,
    value: string,
  ): number | null;
}

let cachedApi: Win32Api | null = null;

function loadWin32(): Win32Api {
  if (cachedApi) return cachedApi;

  const kernel32 = koffi.load('kernel32.dll');
  const advapi32 = koffi.load('advapi32.dll');

  const GetDriveTypeW = kernel32.func(
    'uint32_t __stdcall GetDriveTypeW(const char16_t *lpRootPathName)',
  );
  const GetLogicalDrives = kernel32.func('uint32_t __stdcall GetLogicalDrives()');
  const GetVolumeInformationW = kernel32.func(
    'int __stdcall GetVolumeInformationW(const char16_t *lpRootPathName, _Out_ uint8_t *lpVolumeNameBuffer, uint32_t nVolumeNameSize, _Out_ uint32_t *lpVolumeSerialNumber, _Out_ uint32_t *lpMaximumComponentLength, _Out_ uint32_t *lpFileSystemFlags, _Out_ uint8_t *lpFileSystemNameBuffer, uint32_t nFileSystemNameSize)',
  );
  const GetVolumeNameForVolumeMountPointW = kernel32.func(
    'int __stdcall GetVolumeNameForVolumeMountPointW(const char16_t *lpszVolumeMountPoint, _Out_ uint8_t *lpszVolumeName, uint32_t cchBufferLength)',
  );
  const GetDiskFreeSpaceExW = kernel32.func(
    'int __stdcall GetDiskFreeSpaceExW(const char16_t *lpDirectoryName, _Out_ uint64_t *lpFreeBytesAvailableToCaller, _Out_ uint64_t *lpTotalNumberOfBytes, _Out_ uint64_t *lpTotalNumberOfFreeBytes)',
  );
  const GetFileAttributesW = kernel32.func(
    'uint32_t __stdcall GetFileAttributesW(const char16_t *lpFileName)',
  );
  const RegGetValueW = advapi32.func(
    'int __stdcall RegGetValueW(uintptr_t hkey, const char16_t *lpSubKey, const char16_t *lpValue, uint32_t dwFlags, _Out_ uint32_t *pdwType, _Out_ uint8_t *pvData, _Inout_ uint32_t *pcbData)',
  );

  const HKEY_CURRENT_USER = 0x80000001;
  const HKEY_LOCAL_MACHINE = 0x80000002;
  const RRF_RT_REG_DWORD = 0x10;
  const ERROR_FILE_NOT_FOUND = 2;

  function decodeUtf16(buffer: Buffer): string {
    for (let i = 0; i + 1 < buffer.length; i += 2) {
      if (buffer.readUInt16LE(i) === 0) {
        return buffer.subarray(0, i).toString('utf16le');
      }
    }
    return buffer.toString('utf16le');
  }

  const MoveFileExW = kernel32.func(
    'int __stdcall MoveFileExW(const char16_t *source, const char16_t *target, uint32_t flags)',
  );
  const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()');

  const api: Win32Api = {
    moveFileNoReplace(source, target) {
      if (MoveFileExW(toExtendedPath(source), toExtendedPath(target), 0)) return;
      const code = GetLastError();
      throw new Error(
        code === 80 || code === 183
          ? '目标已存在，未覆盖任何文件'
          : `移动失败（Windows ${code}），未覆盖目标`,
      );
    },
    getDriveType(root) {
      return GetDriveTypeW(root);
    },
    getLogicalDrives() {
      return GetLogicalDrives();
    },
    getVolumeInformation(root) {
      const labelBuf = Buffer.alloc(261 * 2);
      const fsNameBuf = Buffer.alloc(261 * 2);
      const serial = [0];
      const maxComponent = [0];
      const fsFlags = [0];
      const ok = GetVolumeInformationW(
        root,
        labelBuf,
        261,
        serial,
        maxComponent,
        fsFlags,
        fsNameBuf,
        261,
      );
      if (!ok) return null;
      return {
        label: decodeUtf16(labelBuf),
        fileSystem: decodeUtf16(fsNameBuf),
        serial: serial[0] >>> 0,
      };
    },
    getVolumeNameForMountPoint(root) {
      const buffer = Buffer.alloc(1024);
      const ok = GetVolumeNameForVolumeMountPointW(root, buffer, 512);
      if (!ok) return null;
      return decodeUtf16(buffer).replace(/\\$/, '');
    },
    getDiskSpace(root) {
      const freeToCaller = [0n];
      const total = [0n];
      const totalFree = [0n];
      const ok = GetDiskFreeSpaceExW(root, freeToCaller, total, totalFree);
      if (!ok) return null;
      return {
        totalBytes: Number(total[0]),
        freeBytes: Number(totalFree[0]),
      };
    },
    getFileAttributes(path) {
      return GetFileAttributesW(toExtendedPath(path));
    },
    getRegistryDword(hive, subKey, value) {
      const data = Buffer.alloc(4);
      const size = [4];
      const type = [0];
      const hkey = hive === 'currentUser' ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE;
      const rc = RegGetValueW(hkey, subKey, value, RRF_RT_REG_DWORD, type, data, size);
      if (rc === ERROR_FILE_NOT_FOUND) return null;
      if (rc !== 0) return null;
      if (type[0] !== 4) return null;
      return data.readUInt32LE(0);
    },
  };

  cachedApi = api;
  return api;
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

export function getDriveType(root: string): number {
  if (!isWindows()) return DRIVE_UNKNOWN;
  return loadWin32().getDriveType(root);
}

export function getDriveInfo(root: string): DriveInfo | null {
  if (!isWindows()) return null;
  const normalizedRoot = root.replace(/\\?$/, '') + '\\';
  const type = getDriveType(normalizedRoot);
  if (type === DRIVE_NO_ROOT_DIR || type === DRIVE_UNKNOWN) return null;
  const volume = loadWin32().getVolumeInformation(normalizedRoot);
  const space = loadWin32().getDiskSpace(normalizedRoot);
  return {
    letter: normalizedRoot.slice(0, 2).toUpperCase(),
    root: normalizedRoot,
    label: volume?.label ?? '',
    fileSystem: volume?.fileSystem ?? '',
    serial: volume ? volume.serial.toString(16).padStart(8, '0') : '',
    totalBytes: space?.totalBytes ?? 0,
    freeBytes: space?.freeBytes ?? 0,
    type,
    ready: Boolean(volume && space),
  };
}

export function listFixedDrives(): DriveInfo[] {
  if (!isWindows()) return [];
  const mask = loadWin32().getLogicalDrives();
  const drives: DriveInfo[] = [];
  for (let i = 0; i < 26; i++) {
    if ((mask & (1 << i)) === 0) continue;
    const root = `${String.fromCharCode(65 + i)}:\\`;
    if (getDriveType(root) !== DRIVE_FIXED) continue;
    const info = getDriveInfo(root);
    if (info) drives.push(info);
  }
  return drives;
}

export function moveFileNoReplace(source: string, target: string): void {
  if (!isWindows()) throw new Error('文件移动仅支持 Windows');
  loadWin32().moveFileNoReplace(source, target);
}

export function readFileAttributes(path: string): WindowsFileAttributes | null {
  if (!isWindows()) return null;
  const attributes = loadWin32().getFileAttributes(path);
  if (attributes === INVALID_FILE_ATTRIBUTES) return null;
  return {
    attributes,
    hidden: (attributes & FILE_ATTRIBUTE_HIDDEN) !== 0,
    system: (attributes & FILE_ATTRIBUTE_SYSTEM) !== 0,
    directory: (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0,
    reparsePoint: (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
    readonly: (attributes & FILE_ATTRIBUTE_READONLY) !== 0,
  };
}

export function getVolumeNameForMountPoint(root: string): string | null {
  if (!isWindows()) return null;
  return loadWin32().getVolumeNameForMountPoint(root);
}

export function readRegistryDword(
  hive: 'currentUser' | 'localMachine',
  subKey: string,
  value: string,
): number | null {
  if (!isWindows()) return null;
  return loadWin32().getRegistryDword(hive, subKey, value);
}

export function formatDriveLabel(drive: DriveInfo): string {
  const letter = drive.letter.replace(':', '');
  return drive.label ? `${letter}: ${drive.label}` : `${letter}:`;
}
