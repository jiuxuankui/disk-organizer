import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Pagination,
  Progress,
  Radio,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, FolderAddOutlined } from '@ant-design/icons';
import type { DuplicateGroup, DuplicateMode, DuplicatesState } from '@shared/types';
import { MAX_DUPLICATE_FOLDERS } from '@shared/constants';
import { COPY } from '@shared/copy';
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatDuration,
} from '@shared/format';
import PageHeader from '../components/PageHeader';
import DuplicatesToolbar from '../components/DuplicatesToolbar';
import DuplicateGroupCard from '../components/DuplicateGroupCard';
import DuplicatesBulkBar from '../components/DuplicatesBulkBar';
import {
  buildDuplicateQuery,
  collectMemberSizes,
  DUPLICATE_MODE_NOTES,
  DUPLICATE_MODE_OPTIONS,
  DUPLICATE_PAGE_SIZE,
  duplicateModeLabel,
  selectedGroupCount,
  selectionSummary,
  suggestedMemberIds,
  type DuplicateFilters,
} from '../lib/duplicates';
import { describeError, isScanActive, useAppStore } from '../store/useAppStore';

type ScopeKind = 'folders' | 'drives';

function scopeKey(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function sameOrSubPath(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}\\`);
}

function addFolders(current: string[], added: string[], cap: number): string[] {
  const next = [...current];
  for (const folder of added) {
    const key = scopeKey(folder);
    if (!key || next.some((item) => sameOrSubPath(key, scopeKey(item)))) continue;
    for (let index = next.length - 1; index >= 0; index -= 1) {
      if (sameOrSubPath(scopeKey(next[index]), key)) next.splice(index, 1);
    }
    if (next.length >= cap) break;
    next.push(folder);
  }
  return next;
}

function idleFilters(minSize: number): DuplicateFilters {
  return {
    minSize,
    drive: null,
    type: null,
    sortBy: 'reclaimable',
    sortOrder: 'desc',
  };
}

function scopeText(state: DuplicatesState): string {
  if (state.folders.length > 0) {
    return state.folders.length === 1
      ? state.folders[0]
      : `${state.folders.length} 个文件夹`;
  }
  return state.drives.length > 0 ? state.drives.join('、') : '全部已扫描硬盘';
}

export default function DuplicatesPage(): React.JSX.Element {
  const overview = useAppStore((state) => state.overview);
  const settings = useAppStore((state) => state.settings);
  const scanState = useAppStore((state) => state.scanState);
  const openScanModal = useAppStore((state) => state.openScanModal);
  const pushNotice = useAppStore((state) => state.pushNotice);
  const openInExplorer = useAppStore((state) => state.openInExplorer);
  const requestDelete = useAppStore((state) => state.requestDelete);
  const dataVersion = useAppStore((state) => state.dataVersion);
  const recycleUnavailable = useAppStore(
    (state) => state.recycleStatus?.available === false,
  );

  const scanId = overview?.scan?.id ?? null;
  const scanning = isScanActive(scanState);
  const defaultMin = settings?.minDuplicateSize ?? 1024 * 1024;

  const [dupState, setDupState] = useState<DuplicatesState | null>(null);
  const [stateLoading, setStateLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [filters, setFilters] = useState<DuplicateFilters>(() => idleFilters(defaultMin));
  const [page, setPage] = useState(1);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [filteredFiles, setFilteredFiles] = useState(0);
  const [filteredBytes, setFilteredBytes] = useState(0);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [sizes, setSizes] = useState<Map<number, number>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [scopeOverride, setScopeOverride] = useState<string[] | null>(null);
  const [scopeKind, setScopeKind] = useState<ScopeKind>('folders');
  const [folders, setFolders] = useState<string[]>([]);
  const [mode, setMode] = useState<DuplicateMode>('full');
  const [folderBusy, setFolderBusy] = useState(false);
  const groupsRequest = useRef(0);

  useEffect(() => {
    setScopeOverride(null);
    setFolders([]);
  }, [scanId]);

  useEffect(() => {
    let active = true;
    setStateLoading(true);
    window.api
      .getDuplicatesState()
      .then((state) => {
        if (!active) return;
        setDupState(state);
      })
      .catch((error: unknown) => {
        if (!active) return;
        pushNotice('error', `读取重复文件状态失败：${describeError(error)}`);
      })
      .finally(() => {
        if (active) setStateLoading(false);
      });
    return () => {
      active = false;
    };
  }, [scanId, dataVersion, pushNotice]);

  useEffect(() => {
    setSelected(new Set());
    setSizes(new Map());
    setExpanded(new Set());
    setPage(1);
  }, [dupState?.runId]);

  useEffect(() => {
    setSelected(new Set());
    setSizes(new Map());
  }, [dataVersion]);

  useEffect(() => {
    if (dupState?.status === 'completed') {
      setFilters((prev) =>
        prev.minSize === dupState.minSize ? prev : { ...prev, minSize: dupState.minSize },
      );
    }
  }, [dupState?.runId, dupState?.status, dupState?.minSize]);

  useEffect(() => {
    if (dupState?.status !== 'completed') return;
    const effective =
      dupState.mode === 'name' ? 0 : Math.max(dupState.minSize, defaultMin);
    setFilters((prev) =>
      prev.minSize < effective ? { ...prev, minSize: effective } : prev,
    );
  }, [defaultMin, dupState?.status, dupState?.minSize, dupState?.mode]);

  useEffect(() => {
    if (dupState?.status !== 'running') return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const next = await window.api.getDuplicatesState();
        if (!active) return;
        setDupState(next);
      } catch {
        // Polling retries on the next tick.
      }
    }, 600);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [dupState?.status]);

  const query = useMemo(() => buildDuplicateQuery(filters, page), [filters, page]);

  useEffect(() => {
    if (dupState?.status !== 'completed') {
      setGroups([]);
      setTotal(0);
      setFilteredFiles(0);
      setFilteredBytes(0);
      setGroupsLoading(false);
      return;
    }
    const sequence = ++groupsRequest.current;
    let active = true;
    setGroupsLoading(true);
    window.api
      .queryDuplicateGroups(query)
      .then((result) => {
        if (!active || sequence !== groupsRequest.current) return;
        setGroups(result.items);
        setTotal(result.total);
        setFilteredFiles(result.totalFiles);
        setFilteredBytes(result.reclaimableBytes);
        setSizes((prev) => collectMemberSizes(result.items, prev));
      })
      .catch((error: unknown) => {
        if (!active || sequence !== groupsRequest.current) return;
        pushNotice('error', `读取重复文件组失败：${describeError(error)}`);
      })
      .finally(() => {
        if (!active || sequence !== groupsRequest.current) return;
        setGroupsLoading(false);
      });
    return () => {
      active = false;
      groupsRequest.current += 1;
    };
  }, [query, dupState?.status, dupState?.runId, dataVersion, pushNotice]);

  const scannedDrives = useMemo(() => {
    if (!overview) return [];
    const known = new Map(overview.drives.map((drive) => [drive.drive, drive]));
    const letters = new Set<string>();
    for (const root of overview.scan?.drives ?? []) {
      const match = /^([A-Za-z]):(?:[\\/].*)?$/.exec(root);
      if (match) letters.add(`${match[1].toUpperCase()}:`);
    }
    if (letters.size === 0) {
      for (const drive of overview.drives) letters.add(drive.drive);
    }
    return [...letters].sort().map((letter) => {
      const drive = known.get(letter);
      return {
        drive: letter,
        label: drive?.label ?? '',
        online: drive?.online ?? false,
      };
    });
  }, [overview]);

  const allDriveLetters = useMemo(
    () => scannedDrives.map((drive) => drive.drive),
    [scannedDrives],
  );
  const scopeDrives = scopeOverride ?? allDriveLetters;

  const refreshState = useCallback(async (): Promise<void> => {
    try {
      setDupState(await window.api.getDuplicatesState());
    } catch (error) {
      pushNotice('error', `刷新重复文件状态失败：${describeError(error)}`);
    }
  }, [pushNotice]);

  const handleAddFolders = async (): Promise<void> => {
    setFolderBusy(true);
    try {
      const picked = await window.api.selectDuplicateDirectory();
      if (!picked) return;
      setFolders((prev) => {
        const next = addFolders(prev, [picked], MAX_DUPLICATE_FOLDERS);
        if (next.length === prev.length && !next.includes(picked)) {
          pushNotice(
            'info',
            prev.length >= MAX_DUPLICATE_FOLDERS
              ? `最多添加 ${MAX_DUPLICATE_FOLDERS} 个文件夹`
              : '该文件夹已在查找范围内',
          );
        }
        return next;
      });
    } catch (error) {
      pushNotice('error', `选择文件夹失败：${describeError(error)}`);
    } finally {
      setFolderBusy(false);
    }
  };

  const handleRemoveFolder = (folder: string): void => {
    setFolders((prev) => prev.filter((item) => item !== folder));
  };

  const handleStart = async (): Promise<void> => {
    const input =
      scopeKind === 'folders'
        ? { folders, mode }
        : { drives: scopeDrives, mode };
    if (scopeKind === 'folders' && folders.length === 0) {
      pushNotice('warning', '请先添加要查找的文件夹');
      return;
    }
    if (scopeKind === 'drives' && scopeDrives.length === 0) {
      pushNotice('warning', '请至少选择一块要查找的硬盘');
      return;
    }
    setStarting(true);
    try {
      const state = await window.api.startDuplicates(input);
      setDupState(state);
      setSelected(new Set());
      setSizes(new Map());
      setExpanded(new Set());
      setPage(1);
      setGroups([]);
    } catch (error) {
      pushNotice('error', describeError(error));
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async (): Promise<void> => {
    setCancelling(true);
    try {
      setDupState(await window.api.cancelDuplicates());
    } catch (error) {
      pushNotice('error', describeError(error));
    } finally {
      setCancelling(false);
      void refreshState();
    }
  };

  const handleFiltersChange = (patch: Partial<DuplicateFilters>): void => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
    setSelected(new Set());
  };

  const handleSuggest = async (): Promise<void> => {
    if (dupState?.status !== 'completed') return;
    setSuggesting(true);
    try {
      const base = buildDuplicateQuery(filters, 1);
      const collected: DuplicateGroup[] = [];
      let pageNo = 1;
      let groupTotal = 0;
      do {
        const result = await window.api.queryDuplicateGroups({
          ...base,
          page: pageNo,
          pageSize: 100,
        });
        groupTotal = result.total;
        collected.push(...result.items);
        pageNo += 1;
        if (result.items.length === 0) break;
      } while (collected.length < groupTotal && pageNo <= 100);

      const ids = suggestedMemberIds(collected);
      setSelected(new Set(ids));
      setSizes((prev) => collectMemberSizes(collected, prev));
      pushNotice(
        'info',
        ids.length > 0
          ? `已按建议勾选 ${formatCount(ids.length)} 个文件，点击“移到回收站”后确认删除`
          : '当前筛选结果中没有多余副本',
      );
    } catch (error) {
      pushNotice('error', `按建议勾选失败：${describeError(error)}`);
    } finally {
      setSuggesting(false);
    }
  };

  const handleToggleMember = (fileId: number, checked: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(fileId);
      else next.delete(fileId);
      return next;
    });
  };

  const handleDelete = async (): Promise<void> => {
    if (selected.size === 0 || scanning || recycleUnavailable) return;
    await requestDelete([...selected]);
  };

  const selectedSummary = selectionSummary(selected, sizes);
  const wholeGroups = selectedGroupCount(groups, selected);

  if (!overview?.scan) {
    return (
      <div className="duplicates-page">
        <PageHeader title={COPY.navDuplicates} />
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

  const startDisabled =
    starting || (scopeKind === 'folders' ? folders.length === 0 : scopeDrives.length === 0);
  const startLabel =
    dupState?.status === 'completed' || dupState?.status === 'stale'
      ? '重新查找'
      : '开始查找';

  const scopeBox = (
    <div className="dup-scope-box">
      <div className="dup-scope-row">
        <Radio.Group
          value={scopeKind}
          onChange={(event) => setScopeKind(event.target.value as ScopeKind)}
          optionType="button"
          buttonStyle="solid"
          disabled={starting}
        >
          <Radio.Button value="folders">按文件夹查找</Radio.Button>
          <Radio.Button value="drives">按硬盘查找</Radio.Button>
        </Radio.Group>
        <Space size={8} wrap>
          <Typography.Text type="secondary">对比方式</Typography.Text>
          <Select
            className="dup-mode-select"
            value={mode}
            onChange={(value: DuplicateMode) => setMode(value)}
            options={DUPLICATE_MODE_OPTIONS.map((item) => ({
              value: item.value,
              label: item.label,
            }))}
            disabled={starting}
          />
        </Space>
      </div>

      {scopeKind === 'folders' ? (
        <>
          <div className="dup-scope-row">
            <Button
              icon={<FolderAddOutlined />}
              loading={folderBusy}
              disabled={starting || folders.length >= MAX_DUPLICATE_FOLDERS}
              onClick={() => void handleAddFolders()}
            >
              添加文件夹
            </Button>
            <Typography.Text type="secondary">
              包含子文件夹，最多 {MAX_DUPLICATE_FOLDERS} 个；重复或相互包含的文件夹会自动合并
            </Typography.Text>
          </div>
          {folders.length === 0 ? (
            <div className="dup-folder-empty">还没有添加文件夹，逐个添加后即可开始查找。</div>
          ) : (
            <div className="dup-folder-list">
              {folders.map((folder) => (
                <div key={folder} className="dup-folder-item">
                  <Typography.Text className="dup-folder-path" title={folder}>
                    {folder}
                  </Typography.Text>
                  <Button
                    size="small"
                    type="text"
                    icon={<DeleteOutlined />}
                    aria-label={`移除 ${folder}`}
                    disabled={starting}
                    onClick={() => handleRemoveFolder(folder)}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="dup-scope-row">
          <Space size={8} wrap>
            <Typography.Text type="secondary">查找范围</Typography.Text>
            <Select
              mode="multiple"
              className="dup-scope-select"
              value={scopeDrives}
              onChange={(values: string[]) => setScopeOverride(values)}
              options={scannedDrives.map((drive) => ({
                value: drive.drive,
                label: `${drive.drive}${drive.label ? ` ${drive.label}` : ''}${drive.online ? '' : '（未连接）'}`,
              }))}
              placeholder="请选择要查找的硬盘"
              maxTagCount="responsive"
              disabled={starting}
            />
          </Space>
        </div>
      )}

      <Typography.Text type="secondary" className="panel-note">
        {DUPLICATE_MODE_NOTES[mode]}
      </Typography.Text>
      <div>
        <Button
          type="primary"
          loading={starting}
          disabled={scanning || startDisabled}
          onClick={() => void handleStart()}
        >
          {startLabel}
        </Button>
      </div>
    </div>
  );

  const renderStatePanel = (): React.JSX.Element => {
    if (!dupState || stateLoading) {
      return (
        <Card className="guide-card">
          <div className="dup-loading">
            <Spin />
            <Typography.Text type="secondary">正在读取重复文件状态…</Typography.Text>
          </div>
        </Card>
      );
    }

    if (dupState.status === 'running') {
      const nameMode = dupState.mode === 'name';
      const quick = dupState.stage !== 'full';
      const checked = quick ? dupState.quickChecked : dupState.fullChecked;
      const totalCount = quick ? dupState.quickTotal : dupState.fullTotal;
      const percent =
        totalCount > 0 ? Math.min(100, Math.floor((checked / totalCount) * 100)) : 0;
      return (
        <Card className="guide-card">
          <div className="dup-progress">
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              {nameMode
                ? '正在按文件名归组'
                : quick
                  ? '正在快速比对文件指纹'
                  : '正在完整比对文件内容'}
            </Typography.Title>
            <Progress percent={percent} status="active" />
            <div className="dup-progress-meta">
              <span>
                {nameMode
                  ? '已检查'
                  : quick
                    ? '快速检查'
                    : '完整比对'}{' '}
                {formatCount(checked)} / {formatCount(totalCount)}
              </span>
              <span>
                {dupState.etaMs !== null
                  ? `预计剩余 ${formatDuration(dupState.etaMs)}`
                  : '正在估算剩余时间…'}
              </span>
            </div>
            <Typography.Text type="secondary" className="panel-note">
              {nameMode
                ? '仅按文件名（含扩展名、不区分大小写）归组，不读取文件内容；0 字节文件和硬链接不会计入。'
                : '先按大小和文件名初筛，再比对内容；0 字节文件、符号链接和同一文件的硬链接不会计入。'}
            </Typography.Text>
            <Typography.Text type="secondary" className="panel-note">
              对比方式：{duplicateModeLabel(dupState.mode)} · 查找范围：{scopeText(dupState)}
            </Typography.Text>
            <Button loading={cancelling} onClick={() => void handleCancel()}>
              取消查找
            </Button>
          </div>
        </Card>
      );
    }

    if (dupState.status === 'stale' || dupState.needsRefresh) {
      return (
        <Card className="guide-card">
          <Alert
            type="warning"
            showIcon
            message="索引已更新，需要重新查找重复文件"
            description="上次的重复文件结果基于旧索引，已全部作废，不能直接用于删除。"
          />
          <div className="dup-state-actions">{scopeBox}</div>
        </Card>
      );
    }

    if (dupState.status === 'cancelled') {
      return (
        <Card className="guide-card">
          <Alert
            type="info"
            showIcon
            message="已取消重复查找，未保留中间结果"
            description="可以随时重新查找，已有的扫描索引不受影响。"
          />
          <div className="dup-state-actions">{scopeBox}</div>
        </Card>
      );
    }

    if (dupState.status === 'failed') {
      return (
        <Card className="guide-card">
          <Alert
            type="error"
            showIcon
            message="重复查找失败"
            description={dupState.error ?? '发生未知错误，请重试。'}
          />
          <div className="dup-state-actions">{scopeBox}</div>
        </Card>
      );
    }

    return (
      <Card className="guide-card">
        <Empty description="还没有查找过重复文件">
          <Typography.Paragraph type="secondary" style={{ maxWidth: 520, margin: '0 auto 16px' }}>
            可以按文件夹或硬盘指定查找范围，并选择完整比对、仅文件名或混合对比。
            0 字节文件和硬链接会跳过，查找结果只用于辅助，删除仍会进入回收站。
          </Typography.Paragraph>
          {scopeBox}
        </Empty>
      </Card>
    );
  };

  const hasFilter =
    filters.drive !== null ||
    filters.type !== null ||
    filters.minSize !== (dupState?.mode === 'name' ? 0 : defaultMin);
  const belowRunMin =
    dupState?.status === 'completed' &&
    dupState.mode !== 'name' &&
    defaultMin < dupState.minSize;

  return (
    <div className="duplicates-page">
      <PageHeader
        title={COPY.navDuplicates}
        subtitle={
          <span>
            索引包含 {formatCount(overview.scan.totalFiles)} 个文件 · 上次扫描{' '}
            {formatDateTime(overview.scan.finishedAt)}
          </span>
        }
      />

      {dupState?.status === 'completed' ? (
        <div className="dup-content">
          <div className="panel dup-panel">
            <div className="dup-summary">
              <Space size={8} wrap>
                <Tag color="blue">{duplicateModeLabel(dupState.mode)}</Tag>
                <Typography.Text>
                  共 <strong>{formatCount(dupState.groups)}</strong> 组，{' '}
                  <strong>{formatCount(dupState.files)}</strong> 个重复文件，可释放{' '}
                  <strong>{formatBytes(dupState.reclaimableBytes)}</strong>
                </Typography.Text>
              </Space>
            </div>
            <div className="dup-scope-summary">
              <Typography.Text type="secondary">
                本次查找范围：
                {dupState.folders.length > 0
                  ? dupState.folders.join('、')
                  : dupState.drives.length > 0
                    ? dupState.drives.join('、')
                    : '全部已扫描硬盘'}
              </Typography.Text>
              {dupState.folders.length === 0 &&
              dupState.drives.length > 0 &&
              dupState.drives.length < allDriveLetters.length ? (
                <Typography.Text type="warning">
                  范围外的已扫描硬盘未参与本次比对
                </Typography.Text>
              ) : null}
            </div>
            {scopeBox}
            <DuplicatesToolbar
              filters={filters}
              drives={scannedDrives}
              mode={dupState.mode}
              suggesting={suggesting}
              onFiltersChange={handleFiltersChange}
              onSuggest={() => void handleSuggest()}
            />
            {belowRunMin ? (
              <Alert
                type="warning"
                showIcon
                message="最小体积设置低于上次查找范围，结果可能不完整"
                description={`上次只比对了不小于 ${formatBytes(dupState.minSize)} 的文件。按当前设置重新查找后，才能包含更小的重复文件。`}
                action={
                  <Button size="small" loading={starting} onClick={() => void handleStart()}>
                    重新查找
                  </Button>
                }
              />
            ) : null}
            <div className="dup-filter-summary">
              <Typography.Text type="secondary">
                筛选结果：{formatCount(total)} 组 · {formatCount(filteredFiles)} 个文件 · 可释放{' '}
                {formatBytes(filteredBytes)}
              </Typography.Text>
              {scanning ? (
                <Typography.Text type="warning">扫描进行中，完成前后结果可能变化</Typography.Text>
              ) : null}
            </div>

            <div className="dup-list">
              {groupsLoading ? (
                <div className="dup-loading">
                  <Spin />
                </div>
              ) : groups.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    hasFilter ? '当前筛选条件下没有重复文件' : '没有发现可清理的重复文件'
                  }
                >
                  {hasFilter ? (
                    <Button
                      onClick={() =>
                        handleFiltersChange(
                          idleFilters(dupState.mode === 'name' ? 0 : dupState.minSize),
                        )
                      }
                    >
                      清除筛选
                    </Button>
                  ) : null}
                </Empty>
              ) : (
                groups.map((group) => (
                  <DuplicateGroupCard
                    key={group.id}
                    group={group}
                    selected={selected}
                    expanded={expanded.has(group.id)}
                    onToggleExpand={(groupId) =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(groupId)) next.delete(groupId);
                        else next.add(groupId);
                        return next;
                      })
                    }
                    onSelectionChange={setSelected}
                    onToggleMember={(member, checked) =>
                      handleToggleMember(member.fileId, checked)
                    }
                    onOpenExplorer={(path) => void openInExplorer(path)}
                  />
                ))
              )}
            </div>

            {total > DUPLICATE_PAGE_SIZE ? (
              <div className="dup-pagination">
                <Pagination
                  current={page}
                  pageSize={DUPLICATE_PAGE_SIZE}
                  total={total}
                  showSizeChanger={false}
                  onChange={(next) => setPage(next)}
                />
              </div>
            ) : null}

            <DuplicatesBulkBar
              count={selectedSummary.count}
              bytes={selectedSummary.bytes}
              wholeGroups={wholeGroups}
              suggesting={suggesting}
              deleteDisabled={scanning || recycleUnavailable}
              deleteHint={scanning ? '扫描完成后可删除文件' : COPY.recycleBinUnavailable}
              onSuggest={() => void handleSuggest()}
              onClear={() => setSelected(new Set())}
              onDelete={() => void handleDelete()}
            />
          </div>
        </div>
      ) : (
        renderStatePanel()
      )}
    </div>
  );
}
