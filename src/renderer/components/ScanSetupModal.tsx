import { useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Space, Switch, Typography } from 'antd';
import type { DriveInfo } from '@shared/types';
import { COPY } from '@shared/copy';
import { formatBytes } from '@shared/format';
import { isScanActive, useAppStore } from '../store/useAppStore';
import { useBackClose } from '../lib/back';

function defaultSelected(): string[] {
  const state = useAppStore.getState();
  const onlineLetters = new Set(
    state.drives.filter((drive) => drive.ready).map((drive) => drive.letter),
  );
  const lastRange =
    state.overview?.scan?.drives.filter((letter) => onlineLetters.has(letter)) ?? [];
  if (lastRange.length > 0) return lastRange;
  const configured =
    state.settings?.scanDrives.filter((letter) => onlineLetters.has(letter)) ?? [];
  return configured.length > 0 ? configured : [...onlineLetters];
}

function ScanSetupForm(): React.JSX.Element {
  const drives = useAppStore((state) => state.drives);
  const settings = useAppStore((state) => state.settings);
  const startScan = useAppStore((state) => state.startScan);
  const close = useAppStore((state) => state.closeScanModal);
  const scanState = useAppStore((state) => state.scanState);

  const [selectedOverride, setSelectedOverride] = useState<string[] | null>(null);
  const [skipHiddenOverride, setSkipHiddenOverride] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);

  const online = useMemo(() => drives.filter((drive) => drive.ready), [drives]);
  const selected = selectedOverride ?? defaultSelected();
  const skipHiddenSystem = skipHiddenOverride ?? settings?.skipHiddenSystem ?? true;
  const scanning = isScanActive(scanState);

  const toggle = (drive: DriveInfo, checked: boolean): void => {
    const current = selectedOverride ?? defaultSelected();
    setSelectedOverride(
      checked
        ? [...new Set([...current, drive.letter])]
        : current.filter((item) => item !== drive.letter),
    );
  };

  const handleStart = async (): Promise<void> => {
    if (selected.length === 0) return;
    setStarting(true);
    const ok = await startScan({
      drives: selected,
      excludedPaths: settings?.excludedPaths ?? [],
      skipHiddenSystem,
    });
    if (!ok) setStarting(false);
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message={COPY.scanReadOnlyNote}
        description={COPY.dataLocalNote}
      />

      <div>
        <Typography.Text strong>{COPY.setupDrivesLabel}</Typography.Text>
        {online.length === 0 ? (
          <Alert
            style={{ marginTop: 8 }}
            type="warning"
            showIcon
            message="没有检测到可用的本地固定硬盘"
          />
        ) : (
          <div className="scan-drive-list">
            {drives.map((drive) => (
              <label
                key={drive.letter}
                className={`scan-drive-option${drive.ready ? '' : ' scan-drive-option-offline'}`}
              >
                <Checkbox
                  checked={selected.includes(drive.letter)}
                  disabled={!drive.ready || starting}
                  onChange={(event) => toggle(drive, event.target.checked)}
                />
                <span className="scan-drive-letter">{drive.letter}</span>
                <span className="scan-drive-label">{drive.label || '本地磁盘'}</span>
                <span className="scan-drive-capacity">
                  {drive.ready
                    ? `${formatBytes(drive.freeBytes)} 可用 / ${formatBytes(drive.totalBytes)}`
                    : '未连接'}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div>
        <Typography.Text strong>{COPY.setupExcludedLabel}</Typography.Text>
        <div className="scan-excluded-list">
          {(settings?.excludedPaths ?? []).map((item) => (
            <span key={item} className="scan-excluded-item selectable-text">
              {item}
            </span>
          ))}
        </div>
        <Typography.Text type="secondary" className="panel-note">
          {COPY.setupExcludedNote}
        </Typography.Text>
      </div>

      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Text>{COPY.setupSkipHiddenLabel}</Typography.Text>
        <Switch
          checked={skipHiddenSystem}
          onChange={setSkipHiddenOverride}
          disabled={starting}
        />
      </Space>

      {scanning ? (
        <Alert
          type="warning"
          showIcon
          message="当前有扫描正在进行，完成或取消后才能开始新的扫描"
        />
      ) : null}

      <div className="modal-footer-actions">
        <Button onClick={close} disabled={starting}>
          {COPY.cancelAction}
        </Button>
        <Button
          type="primary"
          loading={starting}
          disabled={selected.length === 0 || online.length === 0 || scanning}
          onClick={() => void handleStart()}
        >
          {COPY.setupStartAction}
        </Button>
      </div>
    </Space>
  );
}

export default function ScanSetupModal(): React.JSX.Element {
  const open = useAppStore((state) => state.scanModalOpen);
  const close = useAppStore((state) => state.closeScanModal);
  const hasScan = useAppStore((state) => Boolean(state.overview?.scan));
  useBackClose(open, close);

  return (
    <Modal
      open={open}
      title={hasScan ? COPY.setupRescanTitle : COPY.setupTitle}
      onCancel={close}
      width={620}
      maskClosable={false}
      footer={null}
      destroyOnHidden
    >
      {open ? <ScanSetupForm /> : null}
    </Modal>
  );
}
