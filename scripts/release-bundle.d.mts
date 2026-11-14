export const INSTALLER_DIR: string;
export const RUNTIME_DIR: string;
export const ENV_DIR: string;
export const GUIDE_NAME: string;
export const ENV_NOTE_NAME: string;
export const SUMS_NAME: string;

export interface BundleOptions {
  releaseDir: string;
  version: string;
  productName: string;
}

export function bundleNames(
  version: string,
  productName: string,
): { installer: string; executable: string; root: string; zip: string };
export function installGuide(version: string, productName: string): string;
export function runtimeEnvironmentNote(version: string, productName: string): string;
export function extractZip(zipPath: string, destination: string): void;
export function createReleaseBundle(
  options: BundleOptions,
): Promise<{ zipPath: string; fileCount: number; bytes: number; sha256: string }>;
export function verifyReleaseBundle(
  options: Partial<BundleOptions> & {
    zipPath: string;
    version: string;
    productName: string;
    launch?: boolean;
  },
): Promise<{ fileCount: number }>;
