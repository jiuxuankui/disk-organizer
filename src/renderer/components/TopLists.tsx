import { Button, Empty, Tooltip, Typography } from 'antd';
import { DeleteOutlined, FolderOpenOutlined } from '@ant-design/icons';
import type { FileRecord, FolderUsage } from '@shared/types';
import { COPY } from '@shared/copy';
import { formatBytes } from '@shared/format';
import { ratioPercent } from '../lib/usage';

interface TopListsProps {
  files: FileRecord[];
  folders: FolderUsage[];
  deleteDisabled?: boolean;
  deleteHint?: string;
  onOpenFile: (file: FileRecord) => void;
  onOpenLocation: (path: string) => void;
  onOpenFolder: (folder: FolderUsage) => void;
  onViewAll: () => void;
  onDeleteFile: (file: FileRecord) => void;
}

function TopPanel({
  title,
  action,
  children,
}: {
  title: string;
  action: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="panel top-panel">
      <div className="panel-head">
        <Typography.Title level={5} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function TopLists({
  files,
  folders,
  deleteDisabled = false,
  deleteHint,
  onOpenFile,
  onOpenLocation,
  onOpenFolder,
  onViewAll,
  onDeleteFile,
}: TopListsProps): React.JSX.Element {
  const maxFile = files[0]?.size ?? 0;
  const maxFolder = folders[0]?.bytes ?? 0;

  return (
    <div className="top-grid">
      <TopPanel
        title="最大的文件"
        action={
          <Button type="link" size="small" onClick={onViewAll}>
            {COPY.viewAllAction}
          </Button>
        }
      >
        {files.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有文件数据" />
        ) : (
          <div className="top-list">
            {files.map((file, index) => (
              <div
                key={file.id}
                className="top-row top-row-clickable"
                role="button"
                tabIndex={0}
                onClick={() => onOpenFile(file)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onOpenFile(file);
                }}
              >
                <span className="top-rank">{index + 1}</span>
                <div className="top-main">
                  <div className="top-line">
                    <Tooltip title={file.path} placement="topLeft">
                      <span className="top-name selectable-text">{file.name}</span>
                    </Tooltip>
                    <span className="top-size">{formatBytes(file.size)}</span>
                  </div>
                  <div className="ratio-bar">
                    <span style={{ width: `${ratioPercent(file.size, maxFile)}%` }} />
                  </div>
                </div>
                <Button
                  type="text"
                  size="small"
                  aria-label={`打开 ${file.name} 所在位置`}
                  icon={<FolderOpenOutlined />}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenLocation(file.path);
                  }}
                />
                <Tooltip title={deleteDisabled ? deleteHint : `删除 ${file.name}`}>
                  <span>
                    <Button
                      type="text"
                      size="small"
                      danger
                      disabled={deleteDisabled}
                      aria-label={`删除 ${file.name}`}
                      icon={<DeleteOutlined />}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteFile(file);
                      }}
                    />
                  </span>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </TopPanel>

      <TopPanel
        title="最大的文件夹"
        action={
          <Button type="link" size="small" onClick={onViewAll}>
            {COPY.viewAllAction}
          </Button>
        }
      >
        {folders.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有文件夹数据" />
        ) : (
          <div className="top-list">
            {folders.map((folder, index) => (
              <div
                key={folder.path}
                className="top-row top-row-clickable"
                role="button"
                tabIndex={0}
                onClick={() => onOpenFolder(folder)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onOpenFolder(folder);
                }}
              >
                <span className="top-rank">{index + 1}</span>
                <div className="top-main">
                  <div className="top-line">
                    <Tooltip title={folder.path} placement="topLeft">
                      <span className="top-name selectable-text">{folder.name}</span>
                    </Tooltip>
                    <span className="top-size">{formatBytes(folder.bytes)}</span>
                  </div>
                  <div className="ratio-bar ratio-bar-folder">
                    <span style={{ width: `${ratioPercent(folder.bytes, maxFolder)}%` }} />
                  </div>
                </div>
                <span className="top-count">{folder.count.toLocaleString('zh-CN')} 个</span>
              </div>
            ))}
          </div>
        )}
      </TopPanel>
    </div>
  );
}
