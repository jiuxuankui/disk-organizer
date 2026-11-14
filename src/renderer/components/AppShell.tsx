import { useEffect } from 'react';
import { App as AntApp, Button, Layout, Menu, Progress, Typography } from 'antd';
import {
  CopyOutlined,
  FileTextOutlined,
  HomeOutlined,
  ScanOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { COPY } from '@shared/copy';
import { formatCount, formatDateTime } from '@shared/format';
import { isScanActive, useAppStore, type PageKey } from '../store/useAppStore';
import { closeTopOverlay } from '../lib/back';
import OverviewPage from '../pages/OverviewPage';
import FilesPage from '../pages/FilesPage';
import DuplicatesPage from '../pages/DuplicatesPage';
import SettingsPage from '../pages/SettingsPage';
import VideoPage from '../pages/VideoPage';
import OrganizePage from '../pages/OrganizePage';
import { FolderOpenOutlined } from '@ant-design/icons';
import { VideoCameraOutlined } from '@ant-design/icons';
import ScanSetupModal from './ScanSetupModal';
import ScanProgressPanel from './ScanProgressPanel';
import FileDetailDrawer from './FileDetailDrawer';
import DeleteFlow from './DeleteFlow';

const NAV_ITEMS = [
  { key: 'overview', icon: <HomeOutlined />, label: COPY.navOverview },
  { key: 'files', icon: <FileTextOutlined />, label: COPY.navFiles },
  { key: 'duplicates', icon: <CopyOutlined />, label: COPY.navDuplicates },
  { key: 'video', icon: <VideoCameraOutlined />, label: '视频压缩' },
  { key: 'organize', icon: <FolderOpenOutlined />, label: '归类整理' },
  { key: 'settings', icon: <SettingOutlined />, label: COPY.navSettings },
];

function SidebarFooter(): React.JSX.Element {
  const overview = useAppStore((state) => state.overview);
  const scanState = useAppStore((state) => state.scanState);
  const openScanModal = useAppStore((state) => state.openScanModal);
  const active = isScanActive(scanState);
  const scan = overview?.scan ?? null;

  let statusLine = '尚未扫描';
  let timeLine = '点击下方按钮开始';
  let driveLine = '';

  if (active && scanState) {
    statusLine = scanState.status === 'paused' ? COPY.scanPaused : COPY.scanInProgress;
    timeLine = `已发现 ${formatCount(scanState.filesFound)} 个文件`;
    driveLine = scanState.drives.join('、');
  } else if (scan) {
    statusLine = '已扫描';
    timeLine = formatDateTime(scan.finishedAt);
    driveLine = `${scan.drives.length} 块硬盘`;
  }

  return (
    <div className="sider-footer">
      <div className="sider-status">
        <div className="sider-status-label">{statusLine}</div>
        {active && scanState ? (
          <Progress
            percent={
              scanState.filesFound > 0
                ? Math.min(100, Math.floor((scanState.filesProcessed / scanState.filesFound) * 100))
                : 0
            }
            showInfo={false}
            size="small"
            status="active"
          />
        ) : null}
        <div className="sider-status-line">{timeLine}</div>
        {driveLine ? <div className="sider-status-line">{driveLine}</div> : null}
      </div>
      <Button
        type="primary"
        block
        icon={<ScanOutlined />}
        disabled={active}
        onClick={openScanModal}
      >
        {active ? COPY.scanInProgress : scan ? COPY.rescanAction : COPY.scanAction}
      </Button>
    </div>
  );
}

function PageContent({ page }: { page: PageKey }): React.JSX.Element {
  switch (page) {
    case 'files':
      return <FilesPage />;
    case 'duplicates':
      return <DuplicatesPage />;
    case 'settings':
      return <SettingsPage />;
    case 'video':
      return <VideoPage />;
    case 'organize':
      return <OrganizePage />;
    default:
      return <OverviewPage />;
  }
}

export default function AppShell(): React.JSX.Element {
  const page = useAppStore((state) => state.page);
  const setPage = useAppStore((state) => state.setPage);
  const notice = useAppStore((state) => state.notice);
  const clearNotice = useAppStore((state) => state.clearNotice);
  const scanState = useAppStore((state) => state.scanState);
  const active = isScanActive(scanState);
  const { message } = AntApp.useApp();

  useEffect(() => {
    if (!notice) return;
    message.open({ type: notice.kind, content: notice.text, key: notice.id });
    clearNotice();
  }, [notice, message, clearNotice]);

  useEffect(() => {
    let handledAt = 0;
    const back = (): void => {
      const now = Date.now();
      if (now - handledAt < 250) return;
      handledAt = now;
      if (closeTopOverlay()) return;
      useAppStore.getState().goBack();
    };
    const stop = window.api.onBackCommand(back);
    const onMouse = (event: MouseEvent): void => {
      if (event.button !== 3) return;
      event.preventDefault();
      back();
    };
    window.addEventListener('mouseup', onMouse);
    return () => {
      stop();
      window.removeEventListener('mouseup', onMouse);
    };
  }, []);

  return (
    <Layout className="app-shell">
      <Layout.Sider width={208} theme="light" className="app-sider" trigger={null}>
        <div className="app-brand">
          <Typography.Text strong className="app-brand-name">
            {COPY.appName}
          </Typography.Text>
          <Typography.Text type="secondary" className="app-brand-note">
            本机磁盘索引
          </Typography.Text>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[page]}
          items={NAV_ITEMS}
          onClick={({ key }) => setPage(key as PageKey)}
          className="app-nav"
        />
        <SidebarFooter />
      </Layout.Sider>
      <Layout className="app-main">
        {active ? <div className="scan-topline" aria-hidden /> : null}
        <div
          className={
            page === 'files'
              ? 'page-scroll page-files'
              : page === 'duplicates'
                ? 'page-scroll page-duplicates'
                : 'page-scroll'
          }
        >
          <PageContent page={page} />
        </div>
      </Layout>
      <ScanSetupModal />
      <ScanProgressPanel />
      <FileDetailDrawer />
      <DeleteFlow />
    </Layout>
  );
}
