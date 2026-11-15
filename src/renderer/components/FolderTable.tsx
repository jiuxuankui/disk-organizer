import { useEffect, useMemo, useRef, useState } from 'react';
import { Checkbox, Empty, Table, Typography } from 'antd';
import type { TableProps } from 'antd';
import { CaretRightOutlined } from '@ant-design/icons';
import type { FileRecord, FolderContents, FolderFacet } from '@shared/types';
import { formatBytes, formatCount, formatDateTime } from '@shared/format';
import { fileTypeLabel } from '@shared/fileTypes';
import { isSameOrSubPath, isStrictSubPath } from '../lib/filesFilter';

export interface FolderTableProps {
  folders: FolderFacet[];
  loading: boolean;
  selectedFolders: Set<string>;
  selectedFiles: Set<number>;
  onToggleFolder(folder: FolderFacet, checked: boolean): void;
  onToggleFile(file: FileRecord, checked: boolean): void;
  onEnter(folder: FolderFacet): void;
  onOpenFile(file: FileRecord): void;
  loadContents(parentDir: string): Promise<FolderContents>;
}

type FolderRow =
  | {
      kind: 'folder';
      key: string;
      node: FolderFacet;
      depth: number;
      expanded: boolean;
      disabled: boolean;
    }
  | { kind: 'file'; key: string; file: FileRecord; depth: number; disabled: boolean }
  | { kind: 'hint'; key: string; parent: string; depth: number; totalFiles: number }
  | { kind: 'loading'; key: string; parent: string; depth: number }
  | { kind: 'empty'; key: string; parent: string; depth: number };

const INDENT = 20;
const isMessageRow = (row: FolderRow): boolean =>
  row.kind === 'hint' || row.kind === 'loading' || row.kind === 'empty';

export default function FolderTable({
  folders,
  loading,
  selectedFolders,
  selectedFiles,
  onToggleFolder,
  onToggleFile,
  onEnter,
  onOpenFile,
  loadContents,
}: FolderTableProps): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [contents, setContents] = useState<Map<string, FolderContents>>(() => new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [bodyHeight, setBodyHeight] = useState(320);
  const requestRef = useRef(0);
  const wrapRef = useRef<HTMLDivElement>(null);

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
    requestRef.current += 1;
    setExpanded(new Set());
    setContents(new Map());
    setLoadingPaths(new Set());
  }, [folders]);

  const selectedFolderPaths = useMemo(() => [...selectedFolders], [selectedFolders]);

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
    if (contents.has(key) || loadingPaths.has(key)) return;
    const sequence = requestRef.current;
    setLoadingPaths((current) => new Set(current).add(key));
    try {
      const result = await loadContents(key);
      if (sequence !== requestRef.current) return;
      setContents((current) => new Map(current).set(key, result));
    } catch {
      if (sequence === requestRef.current) {
        setContents((current) =>
          new Map(current).set(key, { folders: [], files: [], totalFiles: 0 }),
        );
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
    const isCoveredFolder = (path: string): boolean =>
      selectedFolderPaths.some((folder) => isStrictSubPath(path, folder));
    const isCoveredFile = (path: string): boolean =>
      selectedFolderPaths.some((folder) => isSameOrSubPath(path, folder));
    const result: FolderRow[] = [];
    const walk = (nodes: FolderFacet[], depth: number): void => {
      for (const node of nodes) {
        const isExpanded = expanded.has(node.path);
        result.push({
          kind: 'folder',
          key: node.path,
          node,
          depth,
          expanded: isExpanded,
          disabled: isCoveredFolder(node.path),
        });
        if (!isExpanded) continue;
        const loaded = contents.get(node.path);
        if (loaded === undefined) {
          result.push({
            kind: 'loading',
            key: `${node.path}#loading`,
            parent: node.path,
            depth: depth + 1,
          });
          continue;
        }
        if (loaded.folders.length === 0 && loaded.files.length === 0) {
          result.push({
            kind: 'empty',
            key: `${node.path}#empty`,
            parent: node.path,
            depth: depth + 1,
          });
          continue;
        }
        walk(loaded.folders, depth + 1);
        for (const file of loaded.files) {
          result.push({
            kind: 'file',
            key: `file:${file.id}`,
            file,
            depth: depth + 1,
            disabled: isCoveredFile(file.path),
          });
        }
        if (loaded.totalFiles > loaded.files.length) {
          result.push({
            kind: 'hint',
            key: `${node.path}#hint`,
            parent: node.path,
            depth: depth + 1,
            totalFiles: loaded.totalFiles,
          });
        }
      }
    };
    walk(folders, 0);
    return result;
  }, [folders, expanded, contents, selectedFolderPaths]);

  const columns: NonNullable<TableProps<FolderRow>['columns']> = [
    {
      key: 'select',
      width: 44,
      onCell: (row) => (isMessageRow(row) ? { colSpan: 0 } : {}),
      render: (_value, row) => {
        if (row.kind === 'folder') {
          return (
            <Checkbox
              aria-label={`选择文件夹 ${row.node.name}`}
              checked={selectedFolders.has(row.node.path)}
              disabled={row.disabled}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onToggleFolder(row.node, event.target.checked)}
            />
          );
        }
        if (row.kind === 'file') {
          return (
            <Checkbox
              aria-label={`选择文件 ${row.file.name}`}
              checked={selectedFiles.has(row.file.id)}
              disabled={row.disabled}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onToggleFile(row.file, event.target.checked)}
            />
          );
        }
        return null;
      },
    },
    {
      title: '名称',
      key: 'name',
      onCell: (row) => (isMessageRow(row) ? { colSpan: 5 } : {}),
      render: (_value, row) => {
        const indent = { paddingLeft: row.depth * INDENT };
        if (row.kind === 'hint') {
          return (
            <Typography.Text type="secondary" style={indent}>
              共 {formatCount(row.totalFiles)} 个文件，进入文件夹查看全部
            </Typography.Text>
          );
        }
        if (row.kind === 'loading' || row.kind === 'empty') {
          return (
            <Typography.Text type="secondary" style={indent}>
              {row.kind === 'loading' ? '加载中…' : '没有子文件夹或文件'}
            </Typography.Text>
          );
        }
        if (row.kind === 'file') {
          return (
            <span className="folder-name" style={indent}>
              <span className="folder-file-icon" aria-hidden />
              <span className="folder-name-text">{row.file.name}</span>
            </span>
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
      title: '路径 / 类型',
      key: 'path',
      width: 320,
      ellipsis: { showTitle: true },
      onCell: (row) => (isMessageRow(row) ? { colSpan: 0 } : {}),
      render: (_value, row) => {
        if (row.kind === 'folder') {
          return (
            <Typography.Text type="secondary" ellipsis={{ tooltip: row.node.path }}>
              {row.node.path}
            </Typography.Text>
          );
        }
        if (row.kind === 'file') return fileTypeLabel(row.file.type);
        return null;
      },
    },
    {
      title: '文件数 / 大小',
      key: 'count',
      width: 120,
      align: 'right',
      onCell: (row) => (isMessageRow(row) ? { colSpan: 0 } : {}),
      render: (_value, row) => {
        if (row.kind === 'folder') return formatCount(row.node.count);
        if (row.kind === 'file') return formatBytes(row.file.size);
        return null;
      },
    },
    {
      title: '大小 / 修改时间',
      key: 'bytes',
      width: 150,
      align: 'right',
      onCell: (row) => (isMessageRow(row) ? { colSpan: 0 } : {}),
      render: (_value, row) => {
        if (row.kind === 'folder') return formatBytes(row.node.bytes);
        if (row.kind === 'file') return formatDateTime(row.file.mtimeMs);
        return null;
      },
    },
  ];

  return (
    <div className="files-table-wrap folder-table-wrap" ref={wrapRef}>
      <Table<FolderRow>
        className="folder-table"
        rowKey="key"
        size="small"
        tableLayout="fixed"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
        scroll={{ x: 720, y: Math.max(120, bodyHeight - 42) }}
        rowClassName={(row) =>
          row.kind === 'folder'
            ? 'folder-row'
            : row.kind === 'file'
              ? 'folder-file-row'
              : 'folder-hint-row'
        }
        onRow={(row) => ({
          onClick: () => {
            if (row.kind === 'folder') onEnter(row.node);
            else if (row.kind === 'file') onOpenFile(row.file);
          },
        })}
        locale={{
          emptyText: loading ? null : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前条件下没有文件夹" />
          ),
        }}
      />
    </div>
  );
}
