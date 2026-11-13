import { Alert, Button, Checkbox, Tag, Tooltip, Typography } from 'antd';
import { FolderOpenOutlined, DownOutlined, RightOutlined } from '@ant-design/icons';
import type { DuplicateGroup, DuplicateMember } from '@shared/types';
import { COPY } from '@shared/copy';
import { formatDateTime } from '@shared/format';
import { fileTypeLabel } from '@shared/fileTypes';
import {
  describeGroupMeta,
  groupAllSelected,
  groupSelectedCount,
  toggleGroupSelection,
} from '../lib/duplicates';

function extensionLabel(ext: string): string {
  return ext ? ext.toUpperCase() : '无扩展名';
}

export interface DuplicateGroupCardProps {
  group: DuplicateGroup;
  selected: Set<number>;
  expanded: boolean;
  onToggleExpand(groupId: number): void;
  onSelectionChange(next: Set<number>): void;
  onToggleMember(member: DuplicateMember, checked: boolean): void;
  onOpenExplorer(path: string): void;
}

export default function DuplicateGroupCard({
  group,
  selected,
  expanded,
  onToggleExpand,
  onSelectionChange,
  onToggleMember,
  onOpenExplorer,
}: DuplicateGroupCardProps): React.JSX.Element {
  const selectedCount = groupSelectedCount(group, selected);
  const allSelected = groupAllSelected(group, selected);

  return (
    <div className={`dup-group${allSelected ? ' dup-group-danger' : ''}`}>
      <div
        className="dup-group-head"
        role="button"
        tabIndex={0}
        onClick={() => onToggleExpand(group.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggleExpand(group.id);
          }
        }}
      >
        <Checkbox
          checked={allSelected}
          indeterminate={selectedCount > 0 && !allSelected}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            onSelectionChange(toggleGroupSelection(group, selected, event.target.checked));
          }}
        />
        <div className="dup-group-main">
          <div className="dup-group-title">
            <span className="dup-group-size">{describeGroupMeta(group)}</span>
            <Tag>{fileTypeLabel(group.type)}</Tag>
            {group.extensions.length > 1 ? (
              <Tag color="orange">
                扩展名不一致：{group.extensions.map(extensionLabel).join(' / ')}
              </Tag>
            ) : null}
            {allSelected ? <Tag color="red">{COPY.deleteWholeGroupWarning}</Tag> : null}
          </div>
          <Typography.Text type="secondary" className="dup-group-sub">
            {group.drives.join('、')} · 文件大小{' '}
            {group.size.toLocaleString('zh-CN')} 字节
          </Typography.Text>
        </div>
        <Button
          type="text"
          size="small"
          icon={expanded ? <DownOutlined /> : <RightOutlined />}
          onClick={(event) => {
            event.stopPropagation();
            onToggleExpand(group.id);
          }}
        />
      </div>

      {expanded ? (
        <div className="dup-group-body">
          {group.mixedExt ? (
            <Alert
              type="warning"
              showIcon
              className="dup-group-alert"
              message="本组文件的扩展名不一致，请确认它们确实是同一内容，避免误删改过后缀的文件"
            />
          ) : null}
          {group.members.map((member) => {
            const checked = selected.has(member.fileId);
            return (
              <div className="dup-member" key={member.fileId}>
                <Checkbox
                  checked={checked}
                  onChange={(event) => onToggleMember(member, event.target.checked)}
                />
                <div className="dup-member-main">
                  <div className="dup-member-name-line">
                    <Tooltip title={member.path} placement="topLeft">
                      <span className="selectable-text dup-member-name">{member.name}</span>
                    </Tooltip>
                    {member.suggestedKeep ? (
                      <Tag color="green">{COPY.suggestedKeep}</Tag>
                    ) : null}
                  </div>
                  <Tooltip title={member.path} placement="topLeft">
                    <span className="selectable-text dup-member-path">{member.path}</span>
                  </Tooltip>
                </div>
                <span className="dup-member-drive">{member.drive}</span>
                <span className="dup-member-time">{formatDateTime(member.mtimeMs)}</span>
                <Tooltip title="在资源管理器中定位">
                  <Button
                    type="text"
                    size="small"
                    icon={<FolderOpenOutlined />}
                    onClick={() => onOpenExplorer(member.path)}
                  />
                </Tooltip>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
