import { Button, Select, Space, Typography } from 'antd';
import { BulbOutlined } from '@ant-design/icons';
import { FILE_TYPES } from '@shared/fileTypes';
import type { DuplicateFilters } from '../lib/duplicates';
import {
  DUPLICATE_MIN_SIZE_OPTIONS,
  DUPLICATE_SORT_OPTIONS,
  duplicateSortValue,
  parseDuplicateSort,
} from '../lib/duplicates';

export interface DuplicateDriveOption {
  drive: string;
  label: string;
  online: boolean;
}

export interface DuplicatesToolbarProps {
  filters: DuplicateFilters;
  drives: DuplicateDriveOption[];
  suggesting: boolean;
  onFiltersChange: (patch: Partial<DuplicateFilters>) => void;
  onSuggest: () => void;
}

export default function DuplicatesToolbar({
  filters,
  drives,
  suggesting,
  onFiltersChange,
  onSuggest,
}: DuplicatesToolbarProps): React.JSX.Element {
  return (
    <div className="dup-toolbar">
      <Select
        className="dup-select-drive"
        value={filters.drive ?? 'all'}
        onChange={(value) =>
          onFiltersChange({ drive: value === 'all' ? null : String(value) })
        }
        options={[
          { value: 'all', label: '全部硬盘' },
          ...drives.map((drive) => ({
            value: drive.drive,
            label: `${drive.drive}${drive.label ? ` ${drive.label}` : ''}${drive.online ? '' : '（未连接）'}`,
          })),
        ]}
      />
      <Select
        className="dup-select-size"
        value={filters.minSize}
        onChange={(value) => onFiltersChange({ minSize: Number(value) })}
        options={DUPLICATE_MIN_SIZE_OPTIONS.map((item) => ({
          value: item.value,
          label: `最小 ${item.label}`,
        }))}
      />
      <Select
        className="dup-select-type"
        value={filters.type ?? 'all'}
        onChange={(value) =>
          onFiltersChange({ type: value === 'all' ? null : (value as DuplicateFilters['type']) })
        }
        options={[
          { value: 'all', label: '全部类型' },
          ...FILE_TYPES.map((item) => ({ value: item.key, label: item.label })),
        ]}
      />
      <Select
        className="dup-select-sort"
        value={duplicateSortValue(filters)}
        onChange={(value) => onFiltersChange(parseDuplicateSort(String(value)))}
        options={DUPLICATE_SORT_OPTIONS.map((item) => ({
          value: item.value,
          label: item.label,
        }))}
      />
      <span className="dup-toolbar-spacer" />
      <Space size={8}>
        <Typography.Text type="secondary">按建议保留每组修改时间最早的文件</Typography.Text>
        <Button icon={<BulbOutlined />} loading={suggesting} onClick={onSuggest}>
          一键按建议勾选
        </Button>
      </Space>
    </div>
  );
}
