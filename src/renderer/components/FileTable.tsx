import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThHTMLAttributes } from 'react';
import { Button, Empty, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableProps } from 'antd';
import { FolderOpenOutlined } from '@ant-design/icons';
import type { FileRecord } from '@shared/types';
import { FILE_TYPES, fileTypeLabel } from '@shared/fileTypes';
import { formatBytes, formatCount, formatDateTime } from '@shared/format';
import { DEFAULT_FILE_SORT, type FileSort } from '../lib/filesFilter';
import { selectAllLoaded, type FilesSelection } from '../lib/filesSelection';

export interface FileTableProps {
  items: FileRecord[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  sort: FileSort;
  selection: FilesSelection;
  hasActiveFilters: boolean;
  onSortChange(sort: FileSort): void;
  onSelectionChange(selection: FilesSelection): void;
  onLoadMore(): void;
  onOpenDetail(file: FileRecord): void;
  onOpenExplorer(path: string): void;
  onFilterFolder(path: string): void;
  onClearFilters(): void;
}

const NAME_MIN_WIDTH = 120;
const NAME_MAX_WIDTH = 640;
const NAME_DEFAULT_WIDTH = 220;

interface ResizableHeaderCellProps extends ThHTMLAttributes<HTMLTableCellElement> {
  width?: number | string;
  onResize?: (event: React.MouseEvent) => void;
}

function ResizableHeaderCell({
  width,
  onResize,
  children,
  style,
  ...rest
}: ResizableHeaderCellProps): React.JSX.Element {
  return (
    <th {...rest} style={{ ...style, ...(width ? { width, position: 'relative' } : null) }}>
      {children}
      {onResize ? (
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label="调整名称列宽"
          title="拖动调整名称列宽"
          className="files-resize-handle"
          onMouseDown={onResize}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
    </th>
  );
}

function typeColor(type: FileRecord['type']): string {
  return FILE_TYPES.find((item) => item.key === type)?.color ?? '#bfbfbf';
}

function clampNameWidth(width: number): number {
  return Math.min(NAME_MAX_WIDTH, Math.max(NAME_MIN_WIDTH, Math.round(width)));
}

export default function FileTable({
  items,
  total,
  loading,
  loadingMore,
  sort,
  selection,
  hasActiveFilters,
  onSortChange,
  onSelectionChange,
  onLoadMore,
  onOpenDetail,
  onOpenExplorer,
  onFilterFolder,
  onClearFilters,
}: FileTableProps): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState(320);
  const [nameWidth, setNameWidth] = useState(NAME_DEFAULT_WIDTH);

  const startResize = useCallback(
    (event: React.MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = nameWidth;
      const onMove = (moveEvent: MouseEvent): void => {
        setNameWidth(clampNameWidth(startWidth + moveEvent.clientX - startX));
      };
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [nameWidth],
  );

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.height ?? 0);
      if (next > 0) setBodyHeight(Math.max(120, next - 4));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const body = wrapRef.current?.querySelector(
      '.ant-table-tbody-virtual-holder, .ant-table-body',
    ) as HTMLElement | null;
    if (!body) return;
    const onScroll = (): void => {
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 600) {
        onLoadMore();
      }
    };
    body.addEventListener('scroll', onScroll, { passive: true });
    return () => body.removeEventListener('scroll', onScroll);
  }, [onLoadMore, items.length, total, bodyHeight]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      onSelectionChange(selectAllLoaded(items.map((item) => item.id)));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [items, onSelectionChange]);

  const orderFor = (key: FileSort['sortBy']): 'ascend' | 'descend' | null => {
    if (sort.sortBy !== key) return null;
    return sort.sortOrder === 'asc' ? 'ascend' : 'descend';
  };

  const columns: NonNullable<TableProps<FileRecord>['columns']> = [
    {
      key: 'name',
      title: '名称',
      dataIndex: 'name',
      width: nameWidth,
      sorter: true,
      onHeaderCell: () => ({ width: nameWidth, onResize: startResize }),
      sortOrder: orderFor('name'),
      ellipsis: { showTitle: false },
      render: (_value, record) => (
        <Tooltip title={record.path} placement="topLeft">
          <span className="file-name">{record.name}</span>
        </Tooltip>
      ),
    },
    {
      key: 'directory',
      title: '位置',
      dataIndex: 'dirPath',
      width: 280,
      ellipsis: { showTitle: false },
      render: (_value, record) => (
        <Tooltip title={`${record.dirPath}（点击按此文件夹筛选）`} placement="topLeft">
          <button
            type="button"
            className="folder-link"
            onClick={(event) => {
              event.stopPropagation();
              onFilterFolder(record.dirPath);
            }}
          >
            {record.dirPath}
          </button>
        </Tooltip>
      ),
    },
    {
      key: 'type',
      title: '类型',
      dataIndex: 'type',
      width: 84,
      sorter: true,
      sortOrder: orderFor('type'),
      render: (_value, record) => (
        <Tag color={typeColor(record.type)}>{fileTypeLabel(record.type)}</Tag>
      ),
    },
    {
      key: 'size',
      title: '大小',
      dataIndex: 'size',
      width: 100,
      align: 'right',
      sorter: true,
      sortOrder: orderFor('size'),
      render: (_value, record) => (
        <Tooltip title={`${formatCount(record.size)} 字节`}>
          <span className="file-size">{formatBytes(record.size)}</span>
        </Tooltip>
      ),
    },
    {
      key: 'mtime',
      title: '修改时间',
      dataIndex: 'mtimeMs',
      width: 140,
      sorter: true,
      sortOrder: orderFor('mtime'),
      render: (_value, record) => (
        <Typography.Text type="secondary" className="file-time">
          {formatDateTime(record.mtimeMs)}
        </Typography.Text>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      width: 64,
      align: 'center',
      render: (_value, record) => (
        <Tooltip title="在资源管理器中定位">
          <Button
            type="text"
            size="small"
            icon={<FolderOpenOutlined />}
            onClick={(event) => {
              event.stopPropagation();
              onOpenExplorer(record.path);
            }}
          />
        </Tooltip>
      ),
    },
  ];

  const rowSelection: NonNullable<TableProps<FileRecord>['rowSelection']> = {
    selectedRowKeys: selection.keys,
    columnWidth: 44,
    onChange: (keys) => {
      onSelectionChange({ mode: 'subset', keys: keys.map(Number) });
    },
  };

  const handleTableChange: NonNullable<TableProps<FileRecord>['onChange']> = (
    _pagination,
    _filters,
    sorter,
    extra,
  ) => {
    if (extra.action !== 'sort') return;
    const active = Array.isArray(sorter) ? sorter[0] : sorter;
    if (!active || !active.order) {
      onSortChange(DEFAULT_FILE_SORT);
      return;
    }
    const key =
      active.columnKey === 'name' || active.columnKey === 'type' || active.columnKey === 'mtime'
        ? active.columnKey
        : 'size';
    onSortChange({
      sortBy: key,
      sortOrder: active.order === 'ascend' ? 'asc' : 'desc',
    });
  };

  return (
    <div className="files-table-wrap" ref={wrapRef}>
      <Table<FileRecord>
        rowKey="id"
        virtual
        size="small"
        tableLayout="fixed"
        columns={columns}
        dataSource={items}
        loading={loading}
        pagination={false}
        rowSelection={rowSelection}
        onChange={handleTableChange}
        components={{ header: { cell: ResizableHeaderCell } }}
        scroll={{ x: 668 + nameWidth, y: Math.max(120, bodyHeight - 42) }}
        rowClassName="file-row"
        onRow={(record) => ({
          onClick: (event) => {
            const target = event.target as HTMLElement;
            if (target.closest('.ant-table-selection-column')) return;
            if (target.closest('button')) return;
            onOpenDetail(record);
          },
          onDoubleClick: () => {
            onOpenExplorer(record.path);
          },
        })}
        locale={{
          emptyText: loading ? null : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={hasActiveFilters ? '没有符合条件的文件' : '索引中还没有文件'}
            >
              {hasActiveFilters ? <Button onClick={onClearFilters}>清空筛选</Button> : null}
            </Empty>
          ),
        }}
      />
      {loadingMore ? <span className="files-load-more">正在加载更多…</span> : null}
    </div>
  );
}
