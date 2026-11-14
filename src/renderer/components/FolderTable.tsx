import { useEffect, useMemo, useRef, useState } from 'react';
import { Empty, Table, Typography } from 'antd';
import type { TableProps } from 'antd';
import { CaretRightOutlined } from '@ant-design/icons';
import type { FolderFacet } from '@shared/types';
import { formatBytes, formatCount } from '@shared/format';

export interface FolderTableProps {
  folders: FolderFacet[];
  loading: boolean;
  onEnter(folder: FolderFacet): void;
  loadChildren(parentDir: string): Promise<FolderFacet[]>;
}

type FolderRow =
  | { kind: 'folder'; key: string; node: FolderFacet; depth: number; expanded: boolean }
  | { kind: 'empty'; key: string; depth: number }
  | { kind: 'loading'; key: string; depth: number };

const INDENT = 20;

export default function FolderTable({
  folders,
  loading,
  onEnter,
  loadChildren,
}: FolderTableProps): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Map<string, FolderFacet[]>>(() => new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const requestRef = useRef(0);

  useEffect(() => {
    requestRef.current += 1;
    setExpanded(new Set());
    setChildren(new Map());
    setLoadingPaths(new Set());
  }, [folders]);

  const toggle = async (folder: FolderFacet): Promise<void> => {
    const key = folder.path;
    if (expanded.has(key)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(key));
    if (children.has(key) || loadingPaths.has(key)) return;
    const sequence = requestRef.current;
    setLoadingPaths((current) => new Set(current).add(key));
    try {
      const result = await loadChildren(folder.path);
      if (sequence !== requestRef.current) return;
      setChildren((current) => new Map(current).set(key, result));
    } catch {
      if (sequence === requestRef.current) {
        setChildren((current) => new Map(current).set(key, []));
      }
    } finally {
      if (sequence === requestRef.current) {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  };

  const rows = useMemo(() => {
    const result: FolderRow[] = [];
    const walk = (nodes: FolderFacet[], depth: number): void => {
      for (const node of nodes) {
        const isExpanded = expanded.has(node.path);
        result.push({ kind: 'folder', key: node.path, node, depth, expanded: isExpanded });
        if (!isExpanded) continue;
        const loaded = children.get(node.path);
        if (loaded === undefined) {
          result.push({ kind: 'loading', key: `${node.path}#loading`, depth: depth + 1 });
        } else if (loaded.length === 0) {
          result.push({ kind: 'empty', key: `${node.path}#empty`, depth: depth + 1 });
        } else {
          walk(loaded, depth + 1);
        }
      }
    };
    walk(folders, 0);
    return result;
  }, [folders, expanded, children]);

  const columns: NonNullable<TableProps<FolderRow>['columns']> = [
    {
      title: '名称',
      key: 'name',
      render: (_value, row) => {
        const indent = { paddingLeft: row.depth * INDENT };
        if (row.kind !== 'folder') {
          return (
            <Typography.Text type="secondary" style={indent}>
              {row.kind === 'loading' ? '加载中…' : '没有子文件夹'}
            </Typography.Text>
          );
        }
        return (
          <span className="folder-name" style={indent}>
            <button
              type="button"
              className="folder-expand"
              aria-label={`${row.expanded ? '收起' : '展开'} ${row.node.name}`}
              title={row.expanded ? '收起' : '展开'}
              onClick={(event) => {
                event.stopPropagation();
                void toggle(row.node);
              }}
            >
              <CaretRightOutlined rotate={row.expanded ? 90 : 0} />
            </button>
            <span className="folder-name-text">{row.node.name}</span>
          </span>
        );
      },
    },
    {
      title: '路径',
      key: 'path',
      width: 360,
      ellipsis: { showTitle: true },
      render: (_value, row) =>
        row.kind === 'folder' ? (
          <Typography.Text type="secondary" ellipsis={{ tooltip: row.node.path }}>
            {row.node.path}
          </Typography.Text>
        ) : null,
    },
    {
      title: '文件数',
      key: 'count',
      width: 100,
      align: 'right',
      render: (_value, row) => (row.kind === 'folder' ? formatCount(row.node.count) : null),
    },
    {
      title: '大小',
      key: 'bytes',
      width: 110,
      align: 'right',
      render: (_value, row) => (row.kind === 'folder' ? formatBytes(row.node.bytes) : null),
    },
  ];

  return (
    <Table<FolderRow>
      className="folder-table"
      rowKey="key"
      size="small"
      tableLayout="fixed"
      columns={columns}
      dataSource={rows}
      loading={loading}
      pagination={false}
      scroll={{ x: 700 }}
      rowClassName={(row) => (row.kind === 'folder' ? 'folder-row' : 'folder-hint-row')}
      onRow={(row) => ({
        onClick: () => {
          if (row.kind === 'folder') onEnter(row.node);
        },
      })}
      locale={{
        emptyText: loading ? null : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前条件下没有文件夹" />
        ),
      }}
    />
  );
}
