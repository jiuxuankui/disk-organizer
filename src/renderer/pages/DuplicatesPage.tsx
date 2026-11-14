import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Pagination,
  Progress,
  Select,
  Space,
  Spin,
  Typography,
} from 'antd';
import type { DuplicateGroup, DuplicatesState } from '@shared/types';
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
  DUPLICATE_PAGE_SIZE,
  selectedGroupCount,
  selectionSummary,
  suggestedMemberIds,
  type DuplicateFilters,
} from '../lib/duplicates';
import { describeError, isScanActive, useAppStore } from '../store/useAppStore';

function idleFilters(minSize: number): DuplicateFilters {
  return {
    minSize,
    drive: null,
    type: null,
    sortBy: 'reclaimable',
    sortOrder: 'desc',
  };
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
  const groupsRequest = useRef(0);

  useEffect(() => {
    setScopeOverride(null);
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
    const effective = Math.max(dupState.minSize, defaultMin);
    setFilters((prev) =>
      prev.minSize < effective ? { ...prev, minSize: effective } : prev,
    );
  }, [defaultMin, dupState?.status, dupState?.minSize]);

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

  const handleStart = async (): Promise<void> => {
    if (scopeDrives.length === 0) {
      pushNotice('warning', '请至少选择一块要查找的硬盘');
      return;
    }
    setStarting(true);
    try {
      const state = await window.api.startDuplicates(scopeDrives);
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

  const scopeSelect = (
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
  );

  const startControls = (
    <Space size={12} wrap>
      {scopeSelect}
      <Button
        type="primary"
        loading={starting}
        disabled={scanning || scopeDrives.length === 0}
        onClick={() => void handleStart()}
      >
        {dupState?.status === 'completed' || dupState?.status === 'stale'
          ? '重新查找'
          : '开始查找'}
      </Button>
    </Space>
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
      const quick = dupState.stage !== 'full';
      const checked = quick ? dupState.quickChecked : dupState.fullChecked;
      const totalCount = quick ? dupState.quickTotal : dupState.fullTotal;
      const percent =
        totalCount > 0 ? Math.min(100, Math.floor((checked / totalCount) * 100)) : 0;
      return (
        <Card className="guide-card">
          <div className="dup-progress">
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              {quick ? '正在快速比对文件指纹' : '正在完整比对文件内容'}
            </Typography.Title>
            <Progress percent={percent} status="active" />
            <div className="dup-progress-meta">
              <span>
                {quick ? '快速检查' : '完整比对'} {formatCount(checked)} /{' '}
                {formatCount(totalCount)}
              </span>
              <span>
                {dupState.etaMs !== null
                  ? `预计剩余 ${formatDuration(dupState.etaMs)}`
                  : '正在估算剩余时间…'}
              </span>
            </div>
            <Typography.Text type="secondary" className="panel-note">
              先按大小初筛，再比对内容；0 字节文件、符号链接和同一文件的硬链接不会计入。
            </Typography.Text>
            <Typography.Text type="secondary" className="panel-note">
              查找范围：
              {dupState.drives.length > 0 ? dupState.drives.join('、') : '全部已扫描硬盘'}
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
          <div className="dup-state-actions">{startControls}</div>
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
          <div className="dup-state-actions">{startControls}</div>
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
          <div className="dup-state-actions">{startControls}</div>
        </Card>
      );
    }

    return (
      <Card className="guide-card">
        <Empty description="还没有查找过重复文件">
          <Typography.Paragraph type="secondary" style={{ maxWidth: 520, margin: '0 auto 16px' }}>
            将按文件大小初筛，再比对内容指纹；文件名不同不影响归组。0 字节文件和硬链接会跳过。
            当前最小体积为 {formatBytes(dupState.minSize || defaultMin)}。
          </Typography.Paragraph>
          {startControls}
        </Empty>
      </Card>
    );
  };

  const hasFilter =
    filters.drive !== null || filters.type !== null || filters.minSize !== defaultMin;
  const belowRunMin =
    dupState?.status === 'completed' && defaultMin < dupState.minSize;

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
              <Typography.Text>
                共 <strong>{formatCount(dupState.groups)}</strong> 组，{' '}
                <strong>{formatCount(dupState.files)}</strong> 个重复文件，可释放{' '}
                <strong>{formatBytes(dupState.reclaimableBytes)}</strong>
              </Typography.Text>
              {startControls}
            </div>
            <div className="dup-scope-summary">
              <Typography.Text type="secondary">
                本次查找范围：
                {dupState.drives.length > 0 ? dupState.drives.join('、') : '全部已扫描硬盘'}
              </Typography.Text>
              {dupState.drives.length > 0 && dupState.drives.length < allDriveLetters.length ? (
                <Typography.Text type="warning">
                  范围外的已扫描硬盘未参与本次比对
                </Typography.Text>
              ) : null}
            </div>
            <DuplicatesToolbar
              filters={filters}
              drives={scannedDrives}
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
                    <Button onClick={() => handleFiltersChange(idleFilters(dupState.minSize))}>
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
