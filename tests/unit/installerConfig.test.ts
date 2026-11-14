import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const INSTALLER_SCRIPT = path.join(ROOT, 'build', 'installer.nsh');

interface PackageJson {
  build?: {
    appId?: string;
    nsis?: {
      oneClick?: boolean;
      perMachine?: boolean;
      allowToChangeInstallationDirectory?: boolean;
      deleteAppDataOnUninstall?: boolean;
      include?: string;
      artifactName?: string;
    };
  };
}

function readPackage(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as PackageJson;
}

describe('Windows installer upgrade behaviour', () => {
  it('keeps user data and installs over an existing version in place', () => {
    const pkg = readPackage();
    expect(pkg.build?.appId).toBe('com.local.diskorganizer');
    expect(pkg.build?.nsis?.perMachine).toBe(false);
    expect(pkg.build?.nsis?.oneClick).toBe(false);
    expect(pkg.build?.nsis?.allowToChangeInstallationDirectory).toBe(true);
    expect(pkg.build?.nsis?.deleteAppDataOnUninstall).toBe(false);
    expect(pkg.build?.nsis?.artifactName).toBe('DiskOrganizer-Setup-${version}.exe');
  });

  it('includes an upgrade script that reuses the previous install directory', () => {
    const pkg = readPackage();
    expect(pkg.build?.nsis?.include).toBe('build/installer.nsh');
    expect(fs.existsSync(INSTALLER_SCRIPT)).toBe(true);

    const script = fs.readFileSync(INSTALLER_SCRIPT, 'utf8');
    expect(script).toContain('!macro customInit');
    expect(script).toContain('InstallLocation');
    expect(script).toContain('StrCpy $INSTDIR $R9');
    expect(script).toContain('${Silent}');
    expect(script).toContain('覆盖安装');
    expect(script).toContain('之前的扫描结果和设置会保留');
    expect(script).not.toContain('RMDir /r $LOCALAPPDATA');
    expect(script).not.toContain('Delete "$LOCALAPPDATA');
  });
});
