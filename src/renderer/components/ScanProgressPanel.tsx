import { App as AntApp, Button, Card, Progress, Space, Typography } from 'antd';
import { PauseOutlined, PlayCircleOutlined, StopOutlined } from '@ant-design/icons';
import { COPY } from '@shared/copy';
import { formatBytes, formatCount, formatDuration } from '@shared/format';
import { isScanActive, useAppStore } from '../store/useAppStore';
import { scanPhaseText, scanPercent } from '../lib/scan';
import { useElapsed } from '../lib/useElapsed';

export default function ScanProgressPanel(): React.JSX.Element | null {
  const scan = useAppStore((state) => state.scanState);
  const pauseScan = useAppStore((state) => state.pauseScan);
  const resumeScan = useAppStore((state) => state.resumeScan);
  const cancelScan = useAppStore((state) => state.cancelScan);
  const active = isScanActive(scan);
  const elapsed = useElapsed(scan?.startedAt ?? null, active);
  const { modal } = AntApp.useApp();

  if (!scan || !active) return null;
  const paused = scan.status === 'paused';

  const confirmCancel = (): void => {
    modal.confirm({
      title: '确认取消本次扫描？',
      content: '本次扫描结果不会保存，已有旧数据保持不变。',
      okText: '放弃本次扫描',
      cancelText: '继续扫描',
      autoFocusButton: 'cancel',
      okButtonProps: { danger: true },
      onOk: () => cancelScan(),
    });
  };

  return (
    <Card className="scan-panel" size="small">
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <div className="scan-panel-head">
          <Typography.Text strong>{paused ? COPY.scanPaused : COPY.scanInProgress}</Typography.Text>
          <Typography.Text type="secondary">{formatDuration(elapsed)}</Typography.Text>
        </div>
        <div className="scan-panel-phase">{scanPhaseText(scan)}</div>
        <Progress
          percent={scanPercent(scan)}
          status={paused ? 'normal' : 'active'}
          showInfo={scan.phase !== 'enumerating'}
        />
        <div className="scan-panel-stats">
          <span>{formatCount(scan.filesFound)} 个文件</span>
          <span>{formatBytes(scan.bytesProcessed)}</span>
        </div>
        <Typography.Text
          type="secondary"
          className="scan-current-path selectable-text"
          ellipsis={{ tooltip: scan.currentPath }}
        >
          {scan.currentPath || '准备中…'}
        </Typography.Text>
        <Space>
          {paused ? (
            <Button size="small" icon={<PlayCircleOutlined />} onClick={() => void resumeScan()}>
              {COPY.resumeAction}
            </Button>
          ) : (
            <Button size="small" icon={<PauseOutlined />} onClick={() => void pauseScan()}>
              {COPY.pauseAction}
            </Button>
          )}
          <Button size="small" danger icon={<StopOutlined />} onClick={confirmCancel}>
            {COPY.cancelAction}
          </Button>
        </Space>
      </Space>
    </Card>
  );
}
