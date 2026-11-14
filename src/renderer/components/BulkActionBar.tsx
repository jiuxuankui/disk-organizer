import { Button, Space, Tag, Tooltip } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { COPY } from '@shared/copy';
import { formatBytes, formatCount } from '@shared/format';

export interface BulkActionBarProps {
  count: number;
  bytes: number;
  allFiltered: boolean;
  total: number;
  canSelectAll: boolean;
  deleteDisabled?: boolean;
  deleteHint?: string;
  onSelectAll(): void;
  onClear(): void;
  onDelete(): void;
  onVideo(): void;
  onArchive(): void;
  compressDisabled?: boolean;
}

export default function BulkActionBar({
  count,
  bytes,
  allFiltered,
  total,
  canSelectAll,
  deleteDisabled = false,
  deleteHint,
  onSelectAll,
  onClear,
  onDelete,
  onVideo,
  onArchive,
  compressDisabled = false,
}: BulkActionBarProps): React.JSX.Element {
  return (
    <div className="bulk-bar" role="status">
      <Space size={12} wrap>
        <span className="bulk-summary">
          已选择 <strong>{formatCount(count)}</strong> 个文件，共{' '}
          <strong>{formatBytes(bytes)}</strong>
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
        <Button disabled={compressDisabled} onClick={onVideo}>
          压缩视频
        </Button>
        <Button disabled={compressDisabled} onClick={onArchive}>
          压缩打包
        </Button>
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
