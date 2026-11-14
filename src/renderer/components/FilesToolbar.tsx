import { useCallback, useState } from 'react';
import { App as AntApp, Button, Input, Modal, Select, Space, Tag, Typography } from 'antd';
import type { InputNumberProps } from 'antd';
import { InputNumber } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import type { FileTypeKey, FolderFacet } from '@shared/types';
import { FILE_TYPES } from '@shared/fileTypes';
import { formatCount } from '@shared/format';
import {
  activeFilterTags,
  applySizePreset,
  applyTimePreset,
  folderFromSelectionKey,
  folderSelectionKey,
  hasActiveFilters,
  SIZE_PRESETS,
  sizePresetKey,
  TIME_PRESETS,
  type FilesFilters,
  type FilterTag,
} from '../lib/filesFilter';
import { useBackClose } from '../lib/back';

const MB = 1024 * 1024;

export interface DriveFilterOption {
  drive: string;
  label: string;
  online: boolean;
}

export interface FilesToolbarProps {
  filters: FilesFilters;
  searchInput: string;
  drives: DriveFilterOption[];
  folders: FolderFacet[];
  onFiltersChange: (patch: Partial<FilesFilters>) => void;
  onSearchChange: (value: string) => void;
  onClear: () => void;
  onRemoveTag: (key: FilterTag['key']) => void;
}

export default function FilesToolbar({
  filters,
  searchInput,
  drives,
  folders,
  onFiltersChange,
  onSearchChange,
  onClear,
  onRemoveTag,
}: FilesToolbarProps): React.JSX.Element {
  const { message } = AntApp.useApp();
  const [customOpen, setCustomOpen] = useState(false);
  const [customMin, setCustomMin] = useState<number | null>(null);
  const [customMax, setCustomMax] = useState<number | null>(null);
  const closeCustom = useCallback(() => setCustomOpen(false), []);
  useBackClose(customOpen, closeCustom);

  const tags = activeFilterTags(filters, searchInput);
  const sizeKey = sizePresetKey(filters.minSize, filters.maxSize);
  const folderKey = folderSelectionKey(filters.folder);
  const visibleFolders = filters.drive
    ? folders.filter((folder) => folder.drive === filters.drive)
    : folders;
  const folderOptions = visibleFolders.map((folder) => ({
    value: `root:${folder.path}`,
    label: `${folder.drive} ${folder.name}（${formatCount(folder.count)} 个）`,
    title: folder.path,
  }));
  if (
    filters.folder &&
    !folderOptions.some((option) => option.value === folderKey)
  ) {
    folderOptions.unshift({
      value: folderKey,
      label: filters.folder.path,
      title: filters.folder.path,
    });
  }

  const openCustomSize = (): void => {
    setCustomMin(filters.minSize === null ? null : filters.minSize / MB);
    setCustomMax(filters.maxSize === null ? null : filters.maxSize / MB);
    setCustomOpen(true);
  };

  const applyCustomSize = (): void => {
    if (customMin !== null && customMax !== null && customMin > customMax) {
      message.error('最小大小不能大于最大大小');
      return;
    }
    onFiltersChange({
      minSize: customMin === null ? null : Math.round(customMin * MB),
      maxSize: customMax === null ? null : Math.round(customMax * MB),
    });
    setCustomOpen(false);
  };

  return (
    <div className="files-toolbar-wrap">
      <div className="files-toolbar">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索文件名或路径"
          value={searchInput}
          onChange={(event) => onSearchChange(event.target.value)}
          className="files-search"
        />
        <Select
          value={filters.drive ?? ''}
          className="files-select files-select-drive"
          onChange={(value) => onFiltersChange({ drive: value || null, folder: null })}
          options={[
            { value: '', label: '全部硬盘' },
            ...drives.map((drive) => ({
              value: drive.drive,
              label: `${drive.drive}${drive.label ? ` ${drive.label}` : ''}${drive.online ? '' : '（未连接）'}`,
            })),
          ]}
        />
        <Select
          value={filters.type ?? 'all'}
          className="files-select"
          onChange={(value) =>
            onFiltersChange({ type: value === 'all' ? null : (value as FileTypeKey) })
          }
          options={[
            { value: 'all', label: '全部类型' },
            ...FILE_TYPES.map((item) => ({ value: item.key, label: item.label })),
          ]}
        />
        <Select
          value={folderKey}
          className="files-select files-select-folder"
          onChange={(value) => {
            const folder = folderFromSelectionKey(visibleFolders, value);
            const owner = folder
              ? visibleFolders.find((item) => item.path === folder.path)
              : null;
            onFiltersChange(owner ? { folder, drive: owner.drive } : { folder });
          }}
          options={[{ value: 'all', label: '全部文件夹' }, ...folderOptions]}
        />
        <Select
          value={sizeKey}
          className="files-select files-select-size"
          onChange={(value) => {
            if (value === 'custom') {
              openCustomSize();
              return;
            }
            const preset = SIZE_PRESETS.find((item) => item.key === value);
            if (preset) onFiltersChange(applySizePreset(preset));
          }}
          options={[
            ...SIZE_PRESETS.map((item) => ({ value: item.key, label: item.label })),
            { value: 'custom', label: '自定义范围…' },
          ]}
        />
        <Select
          value={filters.timePreset}
          className="files-select"
          onChange={(value) => onFiltersChange({ ...applyTimePreset(value), timePreset: value })}
          options={TIME_PRESETS.map((item) => ({ value: item.key, label: item.label }))}
        />
        {hasActiveFilters(filters, searchInput) ? (
          <Button type="link" onClick={onClear}>
            清除筛选
          </Button>
        ) : null}
      </div>

      {tags.length > 0 ? (
        <div className="files-tags">
          <Typography.Text type="secondary" className="files-tags-label">
            筛选
          </Typography.Text>
          {tags.map((tag) => (
            <Tag key={tag.key} closable onClose={() => onRemoveTag(tag.key)}>
              {tag.label}
            </Tag>
          ))}
        </div>
      ) : null}

      <Modal
        title="自定义文件大小范围"
        open={customOpen}
        okText="应用"
        cancelText="取消"
        onOk={applyCustomSize}
        onCancel={() => setCustomOpen(false)}
        destroyOnHidden
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            留空表示不限制该端，输入单位为 MB。
          </Typography.Text>
          <Space>
            <SizeInput label="最小" value={customMin} onChange={setCustomMin} />
            <SizeInput label="最大" value={customMax} onChange={setCustomMax} />
          </Space>
        </Space>
      </Modal>
    </div>
  );
}

function SizeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: InputNumberProps<number>['onChange'];
}): React.JSX.Element {
  return (
    <Space size={6}>
      <Typography.Text>{label}</Typography.Text>
      <InputNumber
        min={0}
        value={value}
        onChange={onChange}
        placeholder="不限"
        addonAfter="MB"
        style={{ width: 150 }}
      />
    </Space>
  );
}
