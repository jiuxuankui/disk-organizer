import { Button, Tag, Tooltip, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { COPY } from '@shared/copy';
import { formatBytes, formatCount } from '@shared/format';

export interface DuplicatesBulkBarProps {
  count: number;
  bytes: number;
  wholeGroups: number;
  suggesting: boolean;
  deleteDisabled?: boolean;
  deleteHint?: string;
  renameDisabled?: boolean;
  renameHint?: string;
  onSuggest(): void;
  onClear(): void;
  onDelete(): void;
  onRename?(): void;
}

export default function DuplicatesBulkBar({
  count,
  bytes,
  wholeGroups,
  suggesting,
  deleteDisabled = false,
  deleteHint,
  renameDisabled = false,
  renameHint,
  onSuggest,
  onClear,
  onDelete,
  onRename,
}: DuplicatesBulkBarProps): React.JSX.Element {
  return (
    <div className="dup-bulk-bar">
      <div className="dup-bulk-summary">
        {count > 0 ? (
          <>
            <Typography.Text>
              已勾选 <strong>{formatCount(count)}</strong> 个文件，可释放{' '}
              <strong>{formatBytes(bytes)}</strong>
            </Typography.Text>
            {wholeGroups > 0 ? (
              <Tag color="red">{wholeGroups} 组将被全部删除</Tag>
            ) : null}
          </>
        ) : (
          <Typography.Text type="secondary">{COPY.duplicateEmptySelection}</Typography.Text>
        )}
      </div>
      <div className="dup-bulk-actions">
        <Button loading={suggesting} onClick={onSuggest}>
          {COPY.suggestSelect}
        </Button>
        <Button disabled={count === 0} onClick={onClear}>
          取消选择
        </Button>
        {onRename ? (
          <Tooltip title={renameDisabled ? renameHint : '把勾选的文件加入批量重命名列表'}>
            <span>
              <Button
                icon={<EditOutlined />}
                disabled={count === 0 || renameDisabled}
                onClick={onRename}
              >
                批量重命名
              </Button>
            </span>
          </Tooltip>
        ) : null}
        <Tooltip title={deleteDisabled ? deleteHint : undefined}>
          <span>
            <Button danger disabled={count === 0 || deleteDisabled} onClick={onDelete}>
              {COPY.deleteAction}
            </Button>
          </span>
        </Tooltip>
      </div>
    </div>
  );
}
