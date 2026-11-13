import { useEffect } from 'react';
import { Alert, Button, Card, Progress, Space, Spin, Typography } from 'antd';
import { CheckCircleOutlined, SyncOutlined } from '@ant-design/icons';
import type { FileRecord, FolderUsage, ScanProgress } from '@shared/types';
import { COPY } from '@shared/copy';
import { formatBytes, formatCount, formatDateTime, formatDuration } from '@shared/format';
import { isScanActive, useAppStore } from '../store/useAppStore';
import { scanPhaseText, scanPercent } from '../lib/scan';
import { useElapsed } from '../lib/useElapsed';
import PageHeader from '../components/PageHeader';
import DriveCards from '../components/DriveCards';
import TypeComposition from '../components/TypeComposition';
import TopLists from '../components/TopLists';
import SkippedDetails from '../components/SkippedDetails';

function InlineScanProgress({ scan }: { scan: ScanProgress }): React.JSX.Element {
  const elapsed = useElapsed(scan.startedAt, true);
  return (
    <Card className="inline-scan">
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {scanPhaseText(scan)}
          </Typography.Title>
          <Typography.Text type="secondary">
            已用时 {formatDuration(elapsed)}
          </Typography.Text>
        </Space>
        <Progress percent={scanPercent(scan)} status="active" />
        <div className="scan-stat-grid">
          <div>
            <div className="scan-stat-value">{formatCount(scan.filesFound)}</div>
            <div className="scan-stat-label">已发现文件</div>
          </div>
          <div>
            <div className="scan-stat-value">{formatCount(scan.filesProcessed)}</div>
            <div className="scan-stat-label">已统计文件</div>
          </div>
          <div>
            <div className="scan-stat-value">{formatBytes(scan.bytesProcessed)}</div>
            <div className="scan-stat-label">已扫描大小</div>
          </div>
          <div>
            <div className="scan-stat-value">{scan.drives.join('、')}</div>
            <div className="scan-stat-label">扫描范围</div>
          </div>
        </div>
        <Typography.Text type="secondary" className="scan-current-path selectable-text" ellipsis>
          {scan.currentPath || '准备中…'}
        </Typography.Text>
      </Space>
    </Card>
  );
}

function GuideCard(): React.JSX.Element {
  const openScanModal = useAppStore((state) => state.openScanModal);
  return (
    <Card className="guide-card">
      <div className="guide-content">
        <div className="guide-badge">本机</div>
        <Typography.Title level={3} style={{ margin: '8px 0' }}>
          {COPY.noScanYet}
        </Typography.Title>
        <Typography.Paragraph type="secondary" className="guide-note">
          扫描后即可在这里看到每块硬盘的容量、已识别文件和占用构成。
        </Typography.Paragraph>
        <Button type="primary" size="large" onClick={openScanModal}>
          {COPY.firstScanAction}
        </Button>
        <div className="guide-points">
          <span>
            <CheckCircleOutlined /> 扫描全程只读，不修改任何文件
          </span>
          <span>
            <CheckCircleOutlined /> {COPY.dataLocalNote}
          </span>
          <span>
            <CheckCircleOutlined /> 删除的文件进入 Windows 回收站，可随时还原
          </span>
        </div>
      </div>
    </Card>
  );
}

export default function OverviewPage(): React.JSX.Element {
  const loading = useAppStore((state) => state.loading);
  const overview = useAppStore((state) => state.overview);
  const scanState = useAppStore((state) => state.scanState);
  const selectedDrive = useAppStore((state) => state.selectedDrive);
  const selectDrive = useAppStore((state) => state.selectDrive);
  const openScanModal = useAppStore((state) => state.openScanModal);
  const refreshOverview = useAppStore((state) => state.refreshOverview);
  const openDetail = useAppStore((state) => state.openDetail);
  const openInExplorer = useAppStore((state) => state.openInExplorer);
  const browseToFiles = useAppStore((state) => state.browseToFiles);
  const requestDelete = useAppStore((state) => state.requestDelete);
  const recycleUnavailable = useAppStore(
    (state) => state.recycleStatus?.available === false,
  );
  const active = isScanActive(scanState);

  useEffect(() => {
    const onFocus = (): void => {
      void refreshOverview(true);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshOverview]);

  if (loading && !overview) {
    return (
      <div className="page-center">
        <Spin size="large" tip={COPY.loading}>
          <div style={{ width: 200, height: 80 }} />
        </Spin>
      </div>
    );
  }

  const scan = overview?.scan ?? null;
  const current =
    overview?.drives.find((drive) => drive.drive === selectedDrive) ??
    overview?.drives[0] ??
    null;
  const skippedTotal = scan?.skipped.reduce((sum, item) => sum + item.count, 0) ?? 0;
  const drives = overview?.drives ?? [];

  const handleOpenFile = (file: FileRecord): void => {
    openDetail(file);
  };
  const handleOpenFolder = (folder: FolderUsage): void => {
    if (!current) return;
    browseToFiles({ drive: current.drive, rootPath: folder.path });
  };
  const handleViewAll = (): void => {
    browseToFiles({ drive: current?.drive ?? null });
  };

  return (
    <div className="page-overview">
      <PageHeader
        title={COPY.navOverview}
        extra={
          <Space size={12}>
            {scan ? (
              <Typography.Text type="secondary">
                上次扫描 {formatDateTime(scan.finishedAt)}
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary">尚未扫描</Typography.Text>
            )}
            <Button
              icon={<SyncOutlined />}
              disabled={active}
              onClick={openScanModal}
              type={scan ? 'default' : 'primary'}
            >
              {scan ? COPY.rescanAction : COPY.scanAction}
            </Button>
          </Space>
        }
      />

      {!scan ? (
        active && scanState ? (
          <InlineScanProgress scan={scanState} />
        ) : (
          <GuideCard />
        )
      ) : (
        <>
          {active ? <Alert type="info" showIcon message={COPY.scanUpdating} /> : null}
          {skippedTotal > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={COPY.partialScanHint(skippedTotal)}
              description={<SkippedDetails skipped={scan.skipped} total={skippedTotal} />}
            />
          ) : null}
          {current && !current.online ? (
            <Alert type="warning" showIcon message={COPY.offlineDriveWarning} />
          ) : null}

          {drives.length > 0 ? (
            <DriveCards drives={drives} selected={current?.drive ?? null} onSelect={selectDrive} />
          ) : (
            <Alert type="warning" showIcon message="未检测到本地固定硬盘" />
          )}

          {current ? (
            <>
              <TypeComposition
                drive={current}
                onDrillType={(type) =>
                  browseToFiles({ drive: current.drive, type })
                }
              />
              <TopLists
                files={current.topFiles}
                folders={current.topFolders}
                deleteDisabled={active || recycleUnavailable}
                deleteHint={
                  active ? '扫描完成后可删除文件' : COPY.recycleBinUnavailable
                }
                onOpenFile={handleOpenFile}
                onOpenLocation={(path) => void openInExplorer(path)}
                onOpenFolder={handleOpenFolder}
                onViewAll={handleViewAll}
                onDeleteFile={(file) => void requestDelete([file.id])}
              />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
