import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Empty, Typography } from 'antd';
import type { FileRecord, FolderFacet, PagedResult } from '@shared/types';
import { COPY } from '@shared/copy';
import { PAGE_SIZE } from '@shared/constants';
import { formatBytes, formatCount, formatDateTime } from '@shared/format';
import PageHeader from '../components/PageHeader';
import FilesToolbar from '../components/FilesToolbar';
import FileTable from '../components/FileTable';
import FolderTable from '../components/FolderTable';
import BulkActionBar from '../components/BulkActionBar';
import ArchiveModal from '../components/ArchiveModal';
import MoveModal, { type MoveSelection } from '../components/MoveModal';
import { VIDEO_EXTENSIONS } from '@shared/video';
import { ORGANIZE_MATCH_LIMIT } from '@shared/organize';
import { RENAME_ITEM_LIMIT } from '@shared/rename';
import {
  buildFileQuery,
  DEFAULT_FILE_SORT,
  DEFAULT_FILES_FILTERS,
  filtersFromPrefill,
  folderFromDirectory,
  folderFromSubtree,
  hasActiveFilters,
  withoutFilter,
  type FileSort,
  type FilesFilters,
  type FilterTag,
} from '../lib/filesFilter';
import {
  appendLoadedKeys,
  canSelectAllFiltered,
  clearSelection,
  selectedBytes,
  selectedCount,
  selectAllFiltered,
  type FilesSelection,
} from '../lib/filesSelection';
import {
  emptyFolderSelection,
  folderSelectionTotals,
  toggleFolderFileSelection,
  toggleFolderSelection,
  type FolderSelectionState,
} from '../lib/folderSelection';
import { describeError, isScanActive, useAppStore } from '../store/useAppStore';

export default function FilesPage(): React.JSX.Element {
  const overview = useAppStore((state) => state.overview);
  const prefill = useAppStore((state) => state.filesPrefill);
  const clearFilesPrefill = useAppStore((state) => state.clearFilesPrefill);
  const openDetail = useAppStore((state) => state.openDetail);
  const openInExplorer = useAppStore((state) => state.openInExplorer);
  const openScanModal = useAppStore((state) => state.openScanModal);
  const pushNotice = useAppStore((state) => state.pushNotice);
  const requestDelete = useAppStore((state) => state.requestDelete);
  const dataVersion = useAppStore((state) => state.dataVersion);
  const scanState = useAppStore((state) => state.scanState);
  const deletePhase = useAppStore((state) => state.deletePhase);
  const scanning = isScanActive(scanState);

  const scanId = overview?.scan?.id ?? null;
  const [filters, setFilters] = useState<FilesFilters>(() => filtersFromPrefill(prefill));
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<FileSort>(DEFAULT_FILE_SORT);
  const [firstLevelFolders, setFirstLevelFolders] = useState<FolderFacet[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [folderSelection, setFolderSelection] =
    useState<FolderSelectionState>(emptyFolderSelection);
  const [items, setItems] = useState<FileRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [loadedPage, setLoadedPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selection, setSelection] = useState<FilesSelection>(clearSelection());
  const [archiveIds, setArchiveIds] = useState<number[] | null>(null);
  const [moveSelection, setMoveSelection] = useState<MoveSelection | null>(null);
  const [preparing, setPreparing] = useState(false);
  const requestRef = useRef(0);
  const loadingRef = useRef(false);
  const loadingMoreRef = useRef(false);

  const baseQuery = useMemo(
    () => buildFileQuery({ filters, sort, search, page: 1, pageSize: PAGE_SIZE }),
    [filters, sort, search],
  );

  useEffect(() => {
    clearFilesPrefill();
  }, [clearFilesPrefill]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (filters.view !== 'folders' || scanId === null) {
      setFirstLevelFolders([]);
      setFoldersLoading(false);
      return;
    }
    let active = true;
    setFoldersLoading(true);
    window.api
      .listFileFolders({
        parentDir: null,
        drive: filters.drive,
        search: search || undefined,
        minSize: filters.minSize,
        maxSize: filters.maxSize,
        mtimeFrom: filters.mtimeFrom,
        mtimeTo: filters.mtimeTo,
      })
      .then((result) => {
        if (active) setFirstLevelFolders(result);
      })
      .catch((error: unknown) => {
        if (active) pushNotice('error', `读取文件夹列表失败：${describeError(error)}`);
      })
      .finally(() => {
        if (active) setFoldersLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    filters.view,
    filters.drive,
    filters.minSize,
    filters.maxSize,
    filters.mtimeFrom,
    filters.mtimeTo,
    search,
    scanId,
    dataVersion,
    pushNotice,
  ]);

  useEffect(() => {
    if (scanId === null || filters.view === 'folders') {
      requestRef.current += 1;
      setItems([]);
      setTotal(0);
      setTotalBytes(0);
      setLoadedPage(0);
      setLoading(false);
      setSelection(clearSelection());
      return;
    }
    const sequence = ++requestRef.current;
    const controller = { active: true };
    loadingRef.current = true;
    loadingMoreRef.current = false;
    setLoading(true);
    setLoadingMore(false);
    setItems([]);
    setTotal(0);
    setTotalBytes(0);
    setLoadedPage(0);
    setSelection(clearSelection());
    window.api
      .queryFiles(baseQuery)
      .then((result: PagedResult<FileRecord>) => {
        if (!controller.active || sequence !== requestRef.current) return;
        setItems(result.items);
        setTotal(result.total);
        setTotalBytes(result.totalBytes);
        setLoadedPage(result.page);
        setSelection(clearSelection());
      })
      .catch((error: unknown) => {
        if (!controller.active || sequence !== requestRef.current) return;
        pushNotice('error', `读取文件索引失败：${describeError(error)}`);
      })
      .finally(() => {
        if (!controller.active || sequence !== requestRef.current) return;
        loadingRef.current = false;
        setLoading(false);
      });
    return () => {
      controller.active = false;
      requestRef.current += 1;
    };
  }, [baseQuery, scanId, dataVersion, pushNotice, filters.view]);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || loadingMoreRef.current) return;
    if (total === 0 || items.length >= total) return;
    const sequence = requestRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await window.api.queryFiles({
        ...baseQuery,
        page: loadedPage + 1,
      });
      if (sequence !== requestRef.current) return;
      const existing = new Set(items.map((item) => item.id));
      const additions = result.items.filter((item) => !existing.has(item.id));
      setItems((prev) => [...prev, ...additions]);
      setTotal(result.total);
      setTotalBytes(result.totalBytes);
      setLoadedPage(result.page);
      setSelection((prev) =>
        appendLoadedKeys(
          prev,
          additions.map((item) => item.id),
        ),
      );
    } catch (error) {
      if (sequence === requestRef.current) {
        pushNotice('error', `加载更多文件失败：${describeError(error)}`);
      }
    } finally {
      loadingMoreRef.current = false;
      if (sequence === requestRef.current) setLoadingMore(false);
    }
  }, [baseQuery, total, items, loadedPage, pushNotice]);

  const scannedDrives = useMemo(() => {
    if (!overview) return [];
    const letters = overview.scan?.drives ?? [];
    const scanned = overview.drives.filter((drive) => letters.includes(drive.drive));
    return scanned.length > 0 ? scanned : overview.drives;
  }, [overview]);

  const updateFilters = (patch: Partial<FilesFilters>): void => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setSelection(clearSelection());
  };

  const handleRemoveTag = (key: FilterTag['key']): void => {
    if (key === 'search') {
      setSearchInput('');
      setSearch('');
      return;
    }
    setFilters((prev) => withoutFilter(prev, key));
    setSelection(clearSelection());
  };

  const handleClear = (): void => {
    setFilters(DEFAULT_FILES_FILTERS);
    setSearchInput('');
    setSearch('');
    setSelection(clearSelection());
  };

  const handleSortChange = (next: FileSort): void => {
    setSort(next);
    setSelection(clearSelection());
  };

  const handleFilterFolder = (path: string): void => {
    const folder = folderFromDirectory(path);
    if (!folder) return;
    setFilters((prev) => ({ ...prev, folder }));
    setSelection(clearSelection());
  };

  const enterFolder = (folder: FolderFacet): void => {
    setFilters({
      ...DEFAULT_FILES_FILTERS,
      drive: folder.drive,
      folder: folderFromSubtree(folder.path),
    });
    setSearchInput('');
    setSearch('');
    setSort(DEFAULT_FILE_SORT);
    setSelection(clearSelection());
  };

  const loadFolderContents = useCallback(
    (parentDir: string) =>
      window.api.listFolderContents({
        parentDir,
        drive: null,
        search: search || undefined,
        minSize: filters.minSize,
        maxSize: filters.maxSize,
        mtimeFrom: filters.mtimeFrom,
        mtimeTo: filters.mtimeTo,
      }),
    [search, filters.minSize, filters.maxSize, filters.mtimeFrom, filters.mtimeTo],
  );

  const clearFolderSelection = useCallback((): void => {
    setFolderSelection(emptyFolderSelection());
  }, []);

  const toggleFolder = (folder: FolderFacet, checked: boolean): void => {
    setFolderSelection((current) => toggleFolderSelection(current, folder, checked));
  };

  const toggleFile = (file: FileRecord, checked: boolean): void => {
    setFolderSelection((current) => toggleFolderFileSelection(current, file, checked));
  };

  useEffect(() => {
    clearFolderSelection();
  }, [
    clearFolderSelection,
    filters.view,
    filters.drive,
    filters.minSize,
    filters.maxSize,
    filters.mtimeFrom,
    filters.mtimeTo,
    search,
    dataVersion,
  ]);

  const filtered = hasActiveFilters(filters, search);
  const selectedTotal = selectedCount(selection, total);
  const selectedSize = selectedBytes(selection, items, totalBytes);
  const showSelectAll = canSelectAllFiltered(selection, total);
  const folderTotals = folderSelectionTotals(folderSelection);
  const folderDeleteDisabled = scanning || deletePhase === 'running';
  const folderDeleteHint = scanning
    ? '扫描完成后可删除'
    : deletePhase === 'running'
      ? '删除进行中，请等待完成'
      : undefined;
  const hasFolderSelection = folderTotals.folderCount > 0 || folderTotals.fileCount > 0;

  const handleDelete = async (): Promise<void> => {
    if (scanning) return;
    try {
      const ids =
        selection.mode === 'all'
          ? await window.api.listFileIds({ ...baseQuery, page: 1, pageSize: 1000 })
          : selection.keys;
      if (ids.length === 0) {
        pushNotice('info', '当前没有可删除的文件');
        return;
      }
      if (ids.length > 200_000) {
        pushNotice('warning', '一次最多删除 200000 个文件，请先收窄筛选条件');
        return;
      }
      await requestDelete(ids);
    } catch (error) {
      pushNotice('error', `读取待删除文件失败：${describeError(error)}`);
    }
  };

  const handleCompress = async (mode: 'video' | 'archive'): Promise<void> => {
    if (scanning || preparing) return;
    setPreparing(true);
    try {
      const ids =
        selection.mode === 'all'
          ? await window.api.listFileIds({ ...baseQuery, page: 1, pageSize: 1000 })
          : selection.keys;
      const limit = mode === 'video' ? 200 : 10000;
      if (ids.length === 0 || ids.length > limit) {
        throw new Error(`请选择 1 至 ${limit} 个文件，必要时先收窄筛选条件`);
      }
      if (mode === 'archive') {
        setArchiveIds(ids);
      } else {
        const files = await Promise.all(ids.map((id) => window.api.getFile(id)));
        if (
          files.some(
            (file) => !file || !VIDEO_EXTENSIONS.some((ext) => ext === file.ext.toLowerCase()),
          )
        ) {
          throw new Error('压缩视频仅支持视频文件，请先按视频类型筛选；其他文件可使用压缩打包');
        }
        const state = await window.api.getVideoState();
        if (state.status === 'running' || state.status === 'cancelling') {
          throw new Error('已有视频任务，请先在视频压缩页面完成或取消');
        }
        useAppStore.setState({ videoPaths: files.map((file) => file!.path) });
        useAppStore.getState().setPage('video');
      }
    } catch (cause) {
      pushNotice('error', describeError(cause));
    } finally {
      setPreparing(false);
    }
  };

  const handleMove = async (): Promise<void> => {
    if (scanning || deletePhase === 'running') return;
    try {
      if (filters.view === 'folders') {
        const fileIds = [...folderSelection.files.keys()];
        const folderPaths = [...folderSelection.folders.keys()];
        if (fileIds.length === 0 && folderPaths.length === 0) return;
        setMoveSelection({ fileIds, folderPaths });
        return;
      }
      const ids =
        selection.mode === 'all'
          ? await window.api.listFileIds({ ...baseQuery, page: 1, pageSize: 1000 })
          : selection.keys;
      if (ids.length === 0) {
        pushNotice('info', '当前没有可移动的文件');
        return;
      }
      if (ids.length > ORGANIZE_MATCH_LIMIT) {
        pushNotice('warning', `一次最多移动 ${ORGANIZE_MATCH_LIMIT} 个文件，请先收窄筛选条件`);
        return;
      }
      setMoveSelection({ fileIds: ids, folderPaths: [] });
    } catch (error) {
      pushNotice('error', `读取待移动文件失败：${describeError(error)}`);
    }
  };

  const handleMoved = useCallback((): void => {
    useAppStore.setState((store) => ({ dataVersion: store.dataVersion + 1 }));
    void useAppStore.getState().refreshOverview(true);
    void useAppStore.getState().refreshDrives();
  }, []);

  const handleRename = async (): Promise<void> => {
    if (scanning || deletePhase === 'running') return;
    const store = useAppStore.getState();
    try {
      if (filters.view === 'folders') {
        const folderItems = [...folderSelection.folders.values()].map((folder) => ({
          fileId: null,
          path: folder.path,
          kind: 'folder' as const,
        }));
        const fileItems = [...folderSelection.files.values()].map((file) => ({
          fileId: file.id,
          path: file.path,
          kind: 'file' as const,
        }));
        const items = [...folderItems, ...fileItems];
        if (items.length === 0) {
          pushNotice('info', '当前没有可重命名的项目');
          return;
        }
        if (items.length > RENAME_ITEM_LIMIT) {
          pushNotice('warning', `一次最多重命名 ${RENAME_ITEM_LIMIT} 个项目，请减少选择`);
          return;
        }
        const added = store.addRenameItems(items);
        store.setPage('rename');
        pushNotice(
          'info',
          added > 0
            ? `已加入批量重命名：${added} 个项目`
            : '所选项目已全部在批量重命名列表中',
        );
        return;
      }
      const ids =
        selection.mode === 'all'
          ? await window.api.listFileIds({ ...baseQuery, page: 1, pageSize: 1000 })
          : selection.keys;
      if (ids.length === 0) {
        pushNotice('info', '当前没有可重命名的文件');
        return;
      }
      if (ids.length > RENAME_ITEM_LIMIT) {
        pushNotice('warning', `一次最多重命名 ${RENAME_ITEM_LIMIT} 个文件，请先收窄筛选条件`);
        return;
      }
      const files = await window.api.getFiles(ids);
      if (files.length === 0) {
        pushNotice('info', '所选文件已不在索引中，请重新选择');
        return;
      }
      const added = store.addRenameItems(
        files.map((file) => ({ fileId: file.id, path: file.path, kind: 'file' as const })),
      );
      store.setPage('rename');
      pushNotice(
        'info',
        added > 0
          ? `已加入批量重命名：${added} 个文件`
          : '所选文件已全部在批量重命名列表中',
      );
    } catch (error) {
      pushNotice('error', `读取待重命名文件失败：${describeError(error)}`);
    }
  };

  if (!overview?.scan) {
    return (
      <div className="files-page">
        <PageHeader title={COPY.navFiles} />
        <Card className="guide-card">
          <Empty description={COPY.noScanYet}>
            <Button type="primary" onClick={openScanModal}>
              {COPY.firstScanAction}
            </Button>
          </Empty>
        </Card>
      </div>
    );
  }

  return (
    <div className="files-page">
      <PageHeader
        title={COPY.navFiles}
        subtitle={
          <span>
            索引包含 {formatCount(overview.scan.totalFiles)} 个文件 · 上次扫描{' '}
            {formatDateTime(overview.scan.finishedAt)}
          </span>
        }
      />

      <div className="panel files-panel">
        <FilesToolbar
          filters={filters}
          searchInput={searchInput}
          drives={scannedDrives}
          onFiltersChange={updateFilters}
          onSearchChange={setSearchInput}
          onClear={handleClear}
          onRemoveTag={handleRemoveTag}
        />
        {filters.view === 'folders' ? (
          <>
            <div className="files-summary">
              <Typography.Text>
                一级文件夹 <strong>{formatCount(firstLevelFolders.length)}</strong> 个
              </Typography.Text>
              <Typography.Text type="secondary">
                点击箭头展开子文件夹，点击文件夹行进入其中的文件
              </Typography.Text>
            </div>
            <FolderTable
              folders={firstLevelFolders}
              loading={foldersLoading}
              selectedFolders={new Set(folderSelection.folders.keys())}
              selectedFiles={new Set(folderSelection.files.keys())}
              onToggleFolder={toggleFolder}
              onToggleFile={toggleFile}
              onEnter={enterFolder}
              onOpenFile={openDetail}
              loadContents={loadFolderContents}
            />
          </>
        ) : (
          <>
            <div className="files-summary">
              <Typography.Text>
                共 <strong>{formatCount(total)}</strong> 个文件，合计{' '}
                <strong>{formatBytes(totalBytes)}</strong>
              </Typography.Text>
              <Typography.Text type="secondary">
                {loading
                  ? '正在读取索引…'
                  : items.length < total
                    ? `已加载 ${formatCount(items.length)} 个，滚动继续加载`
                    : '已按当前条件全部加载'}
              </Typography.Text>
            </div>
            <FileTable
              items={items}
              total={total}
              loading={loading}
              loadingMore={loadingMore}
              sort={sort}
              selection={selection}
              hasActiveFilters={filtered}
              onSortChange={handleSortChange}
              onSelectionChange={setSelection}
              onLoadMore={loadMore}
              onOpenDetail={openDetail}
              onOpenExplorer={(path) => void openInExplorer(path)}
              onFilterFolder={handleFilterFolder}
              onClearFilters={handleClear}
            />
          </>
        )}
      </div>

      {filters.view === 'files' && selectedTotal > 0 ? (
        <BulkActionBar
          count={selectedTotal}
          bytes={selectedSize}
          allFiltered={selection.mode === 'all'}
          total={total}
          canSelectAll={showSelectAll}
          onSelectAll={() => setSelection(selectAllFiltered(items.map((item) => item.id)))}
          onClear={() => setSelection(clearSelection())}
          onDelete={() => void handleDelete()}
          onMove={() => void handleMove()}
          moveDisabled={scanning || deletePhase === 'running'}
          moveHint={scanning ? '扫描完成后可移动文件' : '删除进行中，请等待完成'}
          onRename={() => void handleRename()}
          renameDisabled={scanning || deletePhase === 'running'}
          renameHint={scanning ? '扫描完成后可批量重命名' : '删除进行中，请等待完成'}
          onVideo={() => void handleCompress('video')}
          onArchive={() => void handleCompress('archive')}
          compressDisabled={scanning || preparing}
          deleteDisabled={scanning || deletePhase === 'running'}
          deleteHint={scanning ? '扫描完成后可删除文件' : '删除进行中，请等待完成'}
        />
      ) : null}
      {filters.view === 'folders' && hasFolderSelection ? (
        <BulkActionBar
          folderView
          showCompress={false}
          folderCount={folderTotals.folderCount}
          folderFileCount={folderTotals.folderFileCount}
          count={folderTotals.fileCount}
          bytes={folderTotals.totalBytes}
          allFiltered={false}
          total={0}
          canSelectAll={false}
          deleteDisabled={folderDeleteDisabled}
          deleteHint={folderDeleteHint}
          onSelectAll={() => undefined}
          onClear={clearFolderSelection}
          onMove={() => void handleMove()}
          moveDisabled={folderDeleteDisabled}
          moveHint={folderDeleteHint}
          onRename={() => void handleRename()}
          renameDisabled={folderDeleteDisabled}
          renameHint={folderDeleteHint}
          onDelete={() =>
            void requestDelete(
              [...folderSelection.files.keys()],
              [...folderSelection.folders.keys()],
            )
          }
        />
      ) : null}
      {archiveIds ? (
        <ArchiveModal fileIds={archiveIds} onClose={() => setArchiveIds(null)} />
      ) : null}
      {moveSelection ? (
        <MoveModal
          selection={moveSelection}
          onClose={() => setMoveSelection(null)}
          onMoved={handleMoved}
        />
      ) : null}
    </div>
  );
}
