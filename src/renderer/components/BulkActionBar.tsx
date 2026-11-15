import { Button, Space, Tag, Tooltip } from 'antd';
import { DeleteOutlined, EditOutlined, FolderOutlined } from '@ant-design/icons';
import { COPY } from '@shared/copy';
import { formatBytes, formatCount } from '@shared/format';

export interface BulkActionBarProps {
  count: number;
  bytes: number;
  allFiltered: boolean;
  total: number;
  canSelectAll: boolean;
  folderView?: boolean;
  folderCount?: number;
  folderFileCount?: number;
  showCompress?: boolean;
  deleteDisabled?: boolean;
  deleteHint?: string;
  moveDisabled?: boolean;
  moveHint?: string;
  renameDisabled?: boolean;
  renameHint?: string;
  onSelectAll(): void;
  onClear(): void;
  onDelete(): void;
  onMove?(): void;
  onRename?(): void;
  onVideo?(): void;
  onArchive?(): void;
  compressDisabled?: boolean;
}

export default function BulkActionBar({
  count,
  bytes,
  allFiltered,
  total,
  canSelectAll,
  folderView = false,
  folderCount = 0,
  folderFileCount = 0,
  showCompress = true,
  deleteDisabled = false,
  deleteHint,
  moveDisabled = false,
  moveHint,
  renameDisabled = false,
  renameHint,
  onSelectAll,
  onClear,
  onDelete,
  onMove,
  onRename,
  onVideo,
  onArchive,
  compressDisabled = false,
}: BulkActionBarProps): React.JSX.Element {
  return (
    <div className="bulk-bar" role="status">
      <Space size={12} wrap>
        <span className="bulk-summary">
          {folderView ? (
            <>
              已选 <strong>{formatCount(folderCount)}</strong> 个文件夹（共{' '}
              <strong>{formatCount(folderFileCount)}</strong> 个文件）、
              <strong>{formatCount(count)}</strong> 个文件，合计{' '}
              <strong>{formatBytes(bytes)}</strong>
            </>
          ) : (
            <>
              已选择 <strong>{formatCount(count)}</strong> 个文件，共{' '}
              <strong>{formatBytes(bytes)}</strong>
            </>
          )}
        </span>
        {allFiltered ? <Tag color="blue">全部筛选结果</Tag> : null}
      </Space>
      <Space size={8} wrap>
        {canSelectAll ? (
          <Button type="link" onClick={onSelectAll}>
            选择全部 {formatCount(total)} 个筛选结果
          </Button>
        ) : null}
        <Button onClick={onClear}>取消选择</Button>
        {showCompress && onVideo && onArchive ? (
          <>
            <Button disabled={compressDisabled} onClick={onVideo}>
              压缩视频
            </Button>
            <Button disabled={compressDisabled} onClick={onArchive}>
              压缩打包
            </Button>
          </>
        ) : null}
        {onRename ? (
          <Tooltip title={renameDisabled ? renameHint : '把所选项目加入批量重命名列表'}>
            <span>
              <Button icon={<EditOutlined />} disabled={renameDisabled} onClick={onRename}>
                批量重命名
              </Button>
            </span>
          </Tooltip>
        ) : null}
        {onMove ? (
          <Tooltip title={moveDisabled ? moveHint : '移动到其他文件夹'}>
            <span>
              <Button icon={<FolderOutlined />} disabled={moveDisabled} onClick={onMove}>
                移动到文件夹
              </Button>
            </span>
          </Tooltip>
        ) : null}
        <Tooltip title={deleteDisabled ? deleteHint : undefined}>
          <span>
            <Button danger icon={<DeleteOutlined />} disabled={deleteDisabled} onClick={onDelete}>
              {COPY.deleteAction}
            </Button>
          </span>
        </Tooltip>
      </Space>
    </div>
  );
}
