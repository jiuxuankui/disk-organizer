import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  List,
  Modal,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  FileAddOutlined,
  FolderAddOutlined,
  PlusOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { formatBytes, formatDateTime } from '@shared/format';
import {
  createRenameRule,
  RENAME_CASE_OPTIONS,
  RENAME_DATE_FORMATS,
  RENAME_ITEM_LIMIT,
  RENAME_RULE_LABELS,
  RENAME_RULE_LIMIT,
  RENAME_RULE_NOTES,
  type RenameItemStatus,
  type RenamePickKind,
  type RenamePreview,
  type RenameRule,
  type RenameRuleType,
  type RenameState,
  type RenameUndoInfo,
} from '@shared/rename';
import PageHeader from '../components/PageHeader';
import { useBackClose } from '../lib/back';
import { collectDroppedPaths, hasFileDrag } from '../lib/renameDrop';
import { describeError, isScanActive, useAppStore } from '../store/useAppStore';

const PREVIEW_DEBOUNCE_MS = 500;

const STATUS_META: Record<RenameItemStatus, { label: string; color: string }> = {
  ready: { label: '可重命名', color: 'green' },
  unchanged: { label: '名称不变', color: 'default' },
  skipped: { label: '跳过', color: 'gold' },
  blocked: { label: '有问题', color: 'red' },
};

function splitPath(value: string): { dir: string; name: string } {
  const normalized = value.replace(/[\\/]+$/, '');
  const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  if (index < 0) return { dir: '', name: normalized };
  return { dir: normalized.slice(0, index), name: normalized.slice(index + 1) };
}

export default function RenamePage(): React.JSX.Element {
  const renameItems = useAppStore((state) => state.renameItems);
  const addRenameItems = useAppStore((state) => state.addRenameItems);
  const removeRenameItem = useAppStore((state) => state.removeRenameItem);
  const clearRenameItems = useAppStore((state) => state.clearRenameItems);
  const rewriteRenameItemPaths = useAppStore((state) => state.rewriteRenameItemPaths);
  const pushNotice = useAppStore((state) => state.pushNotice);
  const scanState = useAppStore((state) => state.scanState);
  const deletePhase = useAppStore((state) => state.deletePhase);
  const scanning = isScanActive(scanState);

  const [rules, setRules] = useState<RenameRule[]>([]);
  const [preview, setPreview] = useState<RenamePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState<RenameState | null>(null);
  const [undoInfo, setUndoInfo] = useState<RenameUndoInfo | null>(null);
  const [pickingKind, setPickingKind] = useState<RenamePickKind | null>(null);
  const [dropping, setDropping] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [acting, setActing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);
  const previewSeq = useRef(0);
  const finalizedKey = useRef('');
  const dragDepth = useRef(0);

  const running = state?.status === 'running' || state?.status === 'cancelling';
  const locked = running || scanning || deletePhase === 'running';
  const folderCount = renameItems.filter((item) => item.kind === 'folder').length;
  const fileCount = renameItems.length - folderCount;
  const activeRuleCount = rules.filter((rule) => rule.enabled).length;
  const closeConfirm = useCallback(() => setConfirmOpen(false), []);
  const closeUndo = useCallback(() => setUndoOpen(false), []);
  useBackClose(confirmOpen, closeConfirm);
  useBackClose(undoOpen, closeUndo);

  useEffect(() => {
    let disposed = false;
    void window.api
      .getRenameState()
      .then((next) => {
        if (!disposed) setState(next.status === 'idle' ? null : next);
      })
      .catch(() => undefined);
    void window.api
      .getRenameUndoInfo()
      .then((info) => {
        if (!disposed) setUndoInfo(info);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const next = await window.api.getRenameState();
        if (active) setState(next);
      } catch {
        // 下一轮继续读取。
      }
    }, 400);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [running]);

  useEffect(() => {
    if (!state || (state.status !== 'completed' && state.status !== 'cancelled')) return;
    const key = `${state.status}:${state.mode}:${state.startedAt}`;
    if (finalizedKey.current === key) return;
    finalizedKey.current = key;
    const pairs = state.results
      .filter((item) => item.status === 'renamed' || item.status === 'restored')
      .filter((item) => item.target.length > 0)
      .map((item) => ({ from: item.source, to: item.target }));
    rewriteRenameItemPaths(pairs);
    useAppStore.setState((store) => ({ dataVersion: store.dataVersion + 1 }));
    void useAppStore.getState().refreshOverview(true);
    void window.api
      .getRenameUndoInfo()
      .then(setUndoInfo)
      .catch(() => undefined);
  }, [state, rewriteRenameItemPaths]);

  useEffect(() => {
    previewSeq.current += 1;
    const sequence = previewSeq.current;
    setPreview(null);
    setError('');
    if (renameItems.length === 0 || locked) {
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    const timer = setTimeout(() => {
      window.api
        .previewRename({ items: renameItems, rules })
        .then((result) => {
          if (sequence !== previewSeq.current) return;
          setPreview(result);
        })
        .catch((cause: unknown) => {
          if (sequence !== previewSeq.current) return;
          setError(describeError(cause));
        })
        .finally(() => {
          if (sequence === previewSeq.current) setPreviewing(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [renameItems, rules, locked]);

  function replaceRule(next: RenameRule): void {
    setRules((current) => current.map((rule) => (rule.id === next.id ? next : rule)));
  }

  function moveRule(index: number, delta: number): void {
    setRules((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function addRule(type: RenameRuleType): void {
    if (rules.length >= RENAME_RULE_LIMIT) return;
    setRules((current) => [...current, createRenameRule(type)]);
  }

  async function pickItems(kind: RenamePickKind): Promise<void> {
    setPickingKind(kind);
    try {
      const picked = await window.api.pickRenameItems(kind);
      if (picked.length === 0) return;
      appendItems(picked);
    } catch (cause) {
      pushNotice('error', `选择项目失败：${describeError(cause)}`);
    } finally {
      setPickingKind(null);
    }
  }

  function appendItems(items: Array<{ path: string; kind: 'file' | 'folder' }>): void {
    if (items.length === 0) return;
    const added = addRenameItems(items);
    if (added === 0) {
      pushNotice(
        'info',
        renameItems.length >= RENAME_ITEM_LIMIT
          ? `列表已满（最多 ${RENAME_ITEM_LIMIT} 个项目）`
          : '所选项目已全部在列表中',
      );
      return;
    }
    if (added < items.length) {
      pushNotice(
        'warning',
        `已添加 ${added} 个项目，其余已在列表中或达到 ${RENAME_ITEM_LIMIT} 个上限`,
      );
    }
  }

  function dragHasFiles(event: DragEvent<HTMLDivElement>): boolean {
    return hasFileDrag(Array.from(event.dataTransfer.types));
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>): void {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (!dragHasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>): Promise<void> {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (locked) {
      pushNotice('warning', '请等待当前扫描、删除或重命名任务结束后再添加项目');
      return;
    }
    const paths = collectDroppedPaths(Array.from(event.dataTransfer.files), (file) =>
      window.api.getPathForFile(file),
    );
    if (paths.length === 0) {
      pushNotice('warning', '无法读取拖入项目的磁盘位置，请改用“添加文件”或“添加文件夹”');
      return;
    }
    setDropping(true);
    try {
      const inspected = await window.api.inspectRenamePaths(paths);
      if (inspected.length === 0) {
        pushNotice('info', '拖入的项目已不存在，或不是普通文件/文件夹');
        return;
      }
      appendItems(inspected);
    } catch (cause) {
      pushNotice('error', `添加拖入项目失败：${describeError(cause)}`);
    } finally {
      setDropping(false);
    }
  }

  async function refreshPreview(): Promise<void> {
    if (renameItems.length === 0 || locked) return;
    previewSeq.current += 1;
    const sequence = previewSeq.current;
    setPreviewing(true);
    setError('');
    try {
      const result = await window.api.previewRename({ items: renameItems, rules });
      if (sequence === previewSeq.current) setPreview(result);
    } catch (cause) {
      if (sequence === previewSeq.current) setError(describeError(cause));
    } finally {
      if (sequence === previewSeq.current) setPreviewing(false);
    }
  }

  async function start(): Promise<void> {
    if (!preview || acting) return;
    setActing(true);
    try {
      const next = await window.api.startRename({ token: preview.token });
      setState(next);
      setPreview(null);
      setConfirmOpen(false);
    } catch (cause) {
      setError(describeError(cause));
      setConfirmOpen(false);
    } finally {
      setActing(false);
    }
  }

  async function stop(): Promise<void> {
    try {
      setState(await window.api.cancelRename());
    } catch (cause) {
      pushNotice('error', describeError(cause));
    }
  }

  async function undo(): Promise<void> {
    if (acting) return;
    setActing(true);
    try {
      setState(await window.api.undoRename());
      setPreview(null);
      setUndoOpen(false);
    } catch (cause) {
      pushNotice('error', describeError(cause));
      setUndoOpen(false);
    } finally {
      setActing(false);
    }
  }

  function renderRuleBody(rule: RenameRule): React.JSX.Element {
    switch (rule.type) {
      case 'findReplace':
        return (
          <Space wrap align="center">
            <Input
              aria-label="查找内容"
              placeholder="查找内容"
              value={rule.find}
              maxLength={512}
              disabled={locked}
              style={{ width: 200 }}
              onChange={(event) => replaceRule({ ...rule, find: event.target.value })}
            />
            <Input
              aria-label="替换为"
              placeholder="替换为（可留空）"
              value={rule.replace}
              maxLength={512}
              disabled={locked}
              style={{ width: 200 }}
              onChange={(event) => replaceRule({ ...rule, replace: event.target.value })}
            />
            <Checkbox
              checked={rule.useRegex}
              disabled={locked}
              onChange={(event) => replaceRule({ ...rule, useRegex: event.target.checked })}
            >
              使用正则表达式
            </Checkbox>
            <Checkbox
              checked={rule.caseSensitive}
              disabled={locked}
              onChange={(event) => replaceRule({ ...rule, caseSensitive: event.target.checked })}
            >
              区分大小写
            </Checkbox>
            <Checkbox
              checked={rule.replaceAll}
              disabled={locked}
              onChange={(event) => replaceRule({ ...rule, replaceAll: event.target.checked })}
            >
              替换全部
            </Checkbox>
          </Space>
        );
      case 'prefixSuffix':
        return (
          <Space wrap align="center">
            <Input
              aria-label="添加前缀"
              placeholder="前缀"
              value={rule.prefix}
              maxLength={120}
              disabled={locked}
              style={{ width: 180 }}
              onChange={(event) => replaceRule({ ...rule, prefix: event.target.value })}
            />
            <Input
              aria-label="添加后缀"
              placeholder="后缀"
              value={rule.suffix}
              maxLength={120}
              disabled={locked}
              style={{ width: 180 }}
              onChange={(event) => replaceRule({ ...rule, suffix: event.target.value })}
            />
          </Space>
        );
      case 'deleteRange':
        return (
          <Space wrap align="center">
            <Typography.Text>从第</Typography.Text>
            <InputNumber
              aria-label="删除起始位置"
              min={1}
              max={32767}
              precision={0}
              value={rule.start}
              disabled={locked}
              onChange={(value) =>
                replaceRule({ ...rule, start: Math.max(1, Math.trunc(value ?? 1)) })
              }
            />
            <Typography.Text>个字起，删除</Typography.Text>
            <InputNumber
              aria-label="删除字符数量"
              min={1}
              max={32767}
              precision={0}
              value={rule.count}
              disabled={locked}
              onChange={(value) =>
                replaceRule({ ...rule, count: Math.max(1, Math.trunc(value ?? 1)) })
              }
            />
            <Typography.Text>个字</Typography.Text>
          </Space>
        );
      case 'insertAt':
        return (
          <Space wrap align="center">
            <Typography.Text>在第</Typography.Text>
            <InputNumber
              aria-label="插入位置"
              min={1}
              max={32768}
              precision={0}
              value={rule.position}
              disabled={locked}
              onChange={(value) =>
                replaceRule({ ...rule, position: Math.max(1, Math.trunc(value ?? 1)) })
              }
            />
            <Typography.Text>个字前插入</Typography.Text>
            <Input
              aria-label="插入文字"
              placeholder="要插入的文字"
              value={rule.text}
              maxLength={120}
              disabled={locked}
              style={{ width: 200 }}
              onChange={(event) => replaceRule({ ...rule, text: event.target.value })}
            />
          </Space>
        );
      case 'numbering':
        return (
          <Space wrap align="center">
            <Typography.Text>起始</Typography.Text>
            <InputNumber
              aria-label="序号起始值"
              min={0}
              max={999_999_999}
              precision={0}
              value={rule.start}
              disabled={locked}
              onChange={(value) =>
                replaceRule({ ...rule, start: Math.max(0, Math.trunc(value ?? 0)) })
              }
            />
            <Typography.Text>步长</Typography.Text>
            <InputNumber
              aria-label="序号步长"
              min={1}
              max={1_000_000}
              precision={0}
              value={rule.step}
              disabled={locked}
              onChange={(value) =>
                replaceRule({ ...rule, step: Math.max(1, Math.trunc(value ?? 1)) })
              }
            />
            <Typography.Text>位数</Typography.Text>
            <InputNumber
              aria-label="序号位数"
              min={0}
              max={12}
              precision={0}
              value={rule.padding}
              disabled={locked}
              onChange={(value) =>
                replaceRule({ ...rule, padding: Math.max(0, Math.trunc(value ?? 0)) })
              }
            />
            <Select
              aria-label="序号位置"
              value={rule.position}
              disabled={locked}
              style={{ width: 110 }}
              options={[
                { value: 'prefix', label: '名称前' },
                { value: 'suffix', label: '名称后' },
                { value: 'replace', label: '仅序号' },
              ]}
              onChange={(position) => replaceRule({ ...rule, position })}
            />
            <Input
              aria-label="序号分隔符"
              placeholder="分隔符"
              value={rule.separator}
              maxLength={20}
              disabled={locked || rule.position === 'replace'}
              style={{ width: 100 }}
              onChange={(event) => replaceRule({ ...rule, separator: event.target.value })}
            />
          </Space>
        );
      case 'case':
        return (
          <Select
            aria-label="大小写转换方式"
            value={rule.mode}
            disabled={locked}
            style={{ width: 200 }}
            options={RENAME_CASE_OPTIONS.map((item) => ({
              value: item.value,
              label: item.label,
            }))}
            onChange={(mode) => replaceRule({ ...rule, mode })}
          />
        );
      case 'extension':
        return (
          <Space wrap align="center">
            <Typography.Text>新扩展名</Typography.Text>
            <Input
              aria-label="新扩展名"
              placeholder="例如 jpg；留空表示去掉扩展名"
              value={rule.extension}
              maxLength={30}
              disabled={locked}
              style={{ width: 260 }}
              onChange={(event) => replaceRule({ ...rule, extension: event.target.value })}
            />
            <Typography.Text type="secondary">只对文件生效，只改名称不转格式</Typography.Text>
          </Space>
        );
      case 'date':
        return (
          <Space wrap align="center">
            <Select
              aria-label="日期来源"
              value={rule.source}
              disabled={locked}
              style={{ width: 150 }}
              options={[
                { value: 'mtime', label: '文件修改时间' },
                { value: 'now', label: '当前日期' },
              ]}
              onChange={(source) => replaceRule({ ...rule, source })}
            />
            <Select
              aria-label="日期格式"
              value={rule.format}
              disabled={locked}
              style={{ width: 210 }}
              options={RENAME_DATE_FORMATS.map((item) => ({
                value: item.value,
                label: item.label,
              }))}
              onChange={(format) => replaceRule({ ...rule, format })}
            />
            <Select
              aria-label="日期插入位置"
              value={rule.position}
              disabled={locked}
              style={{ width: 110 }}
              options={[
                { value: 'prefix', label: '名称前' },
                { value: 'suffix', label: '名称后' },
              ]}
              onChange={(position) => replaceRule({ ...rule, position })}
            />
          </Space>
        );
      case 'deleteMarker':
        return (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Space wrap align="center">
              <Input
                aria-label="标记文字"
                placeholder="标记文字（任意文字、数字或符号）"
                value={rule.marker}
                maxLength={120}
                disabled={locked}
                style={{ width: 280 }}
                onChange={(event) => replaceRule({ ...rule, marker: event.target.value })}
              />
              <Select
                aria-label="删除标记哪一侧"
                value={rule.direction}
                disabled={locked}
                style={{ width: 220 }}
                options={[
                  { value: 'before', label: '删除标记之前的文字' },
                  { value: 'after', label: '删除标记之后的文字' },
                ]}
                onChange={(direction) => replaceRule({ ...rule, direction })}
              />
              <Select
                aria-label="标记匹配位置"
                value={rule.occurrence}
                disabled={locked}
                style={{ width: 130 }}
                options={[
                  { value: 'first', label: '第一个标记' },
                  { value: 'last', label: '最后一个标记' },
                ]}
                onChange={(occurrence) => replaceRule({ ...rule, occurrence })}
              />
            </Space>
            <Space wrap>
              <Checkbox
                checked={rule.includeMarker}
                disabled={locked}
                onChange={(event) =>
                  replaceRule({ ...rule, includeMarker: event.target.checked })
                }
              >
                同时删除标记
              </Checkbox>
              <Checkbox
                checked={rule.caseSensitive}
                disabled={locked}
                onChange={(event) =>
                  replaceRule({ ...rule, caseSensitive: event.target.checked })
                }
              >
                区分大小写
              </Checkbox>
              <Typography.Text type="secondary">
                例如标记“-”并选择“删除标记之后”，同时勾选“同时删除标记”，可把“电影-2024-高清”改成“电影”
              </Typography.Text>
            </Space>
          </Space>
        );
      default:
        return <></>;
    }
  }

  const startDisabled = !preview || preview.readyCount === 0 || locked || acting;

  return (
    <div
      className={dragging ? 'rename-page rename-dragging' : 'rename-page'}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
    >
      <PageHeader
        title="批量重命名"
        subtitle="完整规则 · 顺序叠加 · 实时预览 · 不覆盖已有名称"
      />

      {scanning ? (
        <Alert
          type="warning"
          showIcon
          message="扫描进行中，暂不能生成预览或开始重命名"
          description="扫描与重命名会同时读写索引，请等扫描完成后再操作。"
        />
      ) : null}
      {deletePhase === 'running' ? (
        <Alert type="warning" showIcon message="删除进行中，完成后可继续批量重命名" />
      ) : null}
      {undoInfo ? (
        <Alert
          type="info"
          showIcon
          message={`上次批量重命名：${undoInfo.count} 个项目（${formatDateTime(undoInfo.createdAt)}）`}
          description="撤销会按记录把名称改回原样；原名称被占用或项目已移动的会跳过。"
          action={
            <Button size="small" disabled={locked || acting} onClick={() => setUndoOpen(true)}>
              撤销上次批量
            </Button>
          }
        />
      ) : null}
      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Card
        className="rename-items-card"
        title={`1. 要重命名的项目（${fileCount} 个文件、${folderCount} 个文件夹）`}
        extra={
          <Space wrap>
            {dropping ? <Typography.Text type="secondary">正在识别拖入的项目…</Typography.Text> : null}
            <Button
              icon={<FileAddOutlined />}
              loading={pickingKind === 'file'}
              disabled={
                locked || dropping || renameItems.length >= RENAME_ITEM_LIMIT
              }
              onClick={() => void pickItems('file')}
            >
              添加文件
            </Button>
            <Button
              icon={<FolderAddOutlined />}
              loading={pickingKind === 'folder'}
              disabled={
                locked || dropping || renameItems.length >= RENAME_ITEM_LIMIT
              }
              onClick={() => void pickItems('folder')}
            >
              添加文件夹
            </Button>
            <Button
              danger
              disabled={locked || dropping || renameItems.length === 0}
              onClick={() => {
                clearRenameItems();
                setPreview(null);
              }}
            >
              清空列表
            </Button>
          </Space>
        }
      >
        {renameItems.length === 0 ? (
          <Empty description={dragging ? '松开即可添加' : '还没有添加项目'}>
            <Typography.Paragraph type="secondary" style={{ maxWidth: 600, margin: '0 auto 16px' }}>
              可分别用“添加文件”多选文件、用“添加文件夹”添加文件夹，也可以直接把文件和文件夹从资源管理器
              拖到本页。文件夹只修改文件夹名称，内部文件名称不变，只随文件夹更新路径索引。
              只支持本地固定硬盘上的普通文件和文件夹，项目按添加顺序编号；一次最多{' '}
              {RENAME_ITEM_LIMIT} 个。
            </Typography.Paragraph>
          </Empty>
        ) : (
          <>
            <Typography.Paragraph type="secondary">
              共 {renameItems.length} 个项目，最多 {RENAME_ITEM_LIMIT} 个。文件与文件夹会按顺序应用同一组规则；
              文件夹只修改文件夹名称，内部文件名称不变。也可以继续从资源管理器拖入文件和文件夹。
            </Typography.Paragraph>
            <Table
              size="small"
              rowKey="path"
              dataSource={renameItems}
              pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
              scroll={{ x: 720 }}
              columns={[
                {
                  title: '类型',
                  width: 90,
                  render: (_, item) => (
                    <Tag color={item.kind === 'folder' ? 'gold' : 'blue'}>
                      {item.kind === 'folder' ? '文件夹' : '文件'}
                    </Tag>
                  ),
                },
                {
                  title: '名称',
                  width: 260,
                  render: (_, item) => (
                    <Typography.Text strong style={{ overflowWrap: 'anywhere' }}>
                      {splitPath(item.path).name}
                    </Typography.Text>
                  ),
                },
                {
                  title: '所在位置',
                  render: (_, item) => (
                    <Typography.Text
                      type="secondary"
                      style={{ overflowWrap: 'anywhere', fontSize: 12 }}
                    >
                      {splitPath(item.path).dir}
                    </Typography.Text>
                  ),
                },
                {
                  title: '',
                  width: 64,
                  render: (_, item) => (
                    <Button
                      type="text"
                      size="small"
                      icon={<DeleteOutlined />}
                      aria-label={`移除 ${splitPath(item.path).name}`}
                      disabled={locked}
                      onClick={() => removeRenameItem(item.path)}
                    />
                  ),
                },
              ]}
            />
          </>
        )}
      </Card>

      <Card
        title={`2. 重命名规则（按顺序执行，已启用 ${activeRuleCount} 条）`}
        extra={
          <Dropdown
            disabled={locked || rules.length >= RENAME_RULE_LIMIT}
            menu={{
              items: (Object.keys(RENAME_RULE_LABELS) as RenameRuleType[]).map((type) => ({
                key: type,
                label: RENAME_RULE_LABELS[type],
              })),
              onClick: ({ key }) => addRule(key as RenameRuleType),
            }}
          >
            <Button
              icon={<PlusOutlined />}
              disabled={locked || rules.length >= RENAME_RULE_LIMIT}
            >
              添加规则
            </Button>
          </Dropdown>
        }
      >
        <Typography.Paragraph type="secondary">
          规则按从上到下的顺序叠加，可随时启用、停用或调整顺序；名称扩展名单独处理，文件只改扩展名之前的部分。
          最多 {RENAME_RULE_LIMIT} 条规则。未命中的规则不会改变名称，冲突或非法名称会在预览中标记并跳过。
        </Typography.Paragraph>
        {rules.length === 0 ? (
          <Empty description="还没有添加规则，可先用“添加规则”选择查找替换、序号、标记删除等" />
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {rules.map((rule, index) => (
              <Card
                key={rule.id}
                size="small"
                title={
                  <Space>
                    <Switch
                      aria-label={`启用规则 ${index + 1}`}
                      checked={rule.enabled}
                      disabled={locked}
                      onChange={(enabled) => replaceRule({ ...rule, enabled })}
                    />
                    <Typography.Text strong>
                      {index + 1}. {RENAME_RULE_LABELS[rule.type]}
                    </Typography.Text>
                  </Space>
                }
                extra={
                  <Space>
                    <Button size="small" disabled={locked || index === 0} onClick={() => moveRule(index, -1)}>
                      上移
                    </Button>
                    <Button
                      size="small"
                      disabled={locked || index === rules.length - 1}
                      onClick={() => moveRule(index, 1)}
                    >
                      下移
                    </Button>
                    <Button
                      size="small"
                      disabled={locked}
                      onClick={() => setRules((current) => current.filter((item) => item.id !== rule.id))}
                    >
                      移除
                    </Button>
                  </Space>
                }
              >
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {renderRuleBody(rule)}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {RENAME_RULE_NOTES[rule.type]}
                  </Typography.Text>
                </Space>
              </Card>
            ))}
          </Space>
        )}
      </Card>

      <Card
        title="3. 预览"
        extra={
          <Space>
            {previewing ? <Typography.Text type="secondary">正在生成预览…</Typography.Text> : null}
            <Button
              icon={<ThunderboltOutlined />}
              disabled={locked || previewing || renameItems.length === 0}
              onClick={() => void refreshPreview()}
            >
              刷新预览
            </Button>
          </Space>
        }
      >
        {!preview ? (
          <Empty
            description={
              renameItems.length === 0
                ? '添加项目后会自动生成预览'
                : previewing
                  ? '正在按当前规则生成预览…'
                  : '添加或修改规则后会自动生成预览'
            }
          />
        ) : (
          <>
            <Space wrap size={8} style={{ marginBottom: 12 }}>
              <Tag color="green">可重命名 {preview.readyCount}</Tag>
              <Tag>名称不变 {preview.unchangedCount}</Tag>
              <Tag color="gold">跳过 {preview.skippedCount}</Tag>
              <Tag color="red">有问题 {preview.blockedCount}</Tag>
              <Typography.Text type="secondary">
                文件夹项只修改文件夹名称，内部文件名称不变。预览只读取信息，不会修改任何文件；
                开始后也会再次检查目标名称。
              </Typography.Text>
            </Space>
            <Table
              size="small"
              rowKey="path"
              dataSource={preview.items}
              pagination={{ pageSize: 20, showSizeChanger: false }}
              scroll={{ x: 960 }}
              columns={[
                {
                  title: '类型 / 大小',
                  width: 120,
                  render: (_, item) => (
                    <>
                      <Tag color={item.kind === 'folder' ? 'gold' : 'blue'}>
                        {item.kind === 'folder' ? '文件夹' : '文件'}
                      </Tag>
                      {item.kind === 'file' ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {formatBytes(item.size)}
                        </Typography.Text>
                      ) : null}
                    </>
                  ),
                },
                {
                  title: '原名称',
                  width: 220,
                  render: (_, item) => (
                    <Typography.Text style={{ overflowWrap: 'anywhere' }}>{item.name}</Typography.Text>
                  ),
                },
                {
                  title: '新名称',
                  width: 220,
                  render: (_, item) => (
                    <Typography.Text strong style={{ overflowWrap: 'anywhere' }}>
                      {item.newName}
                    </Typography.Text>
                  ),
                },
                {
                  title: '状态与说明',
                  render: (_, item) => (
                    <div className="rename-preview-status">
                      <Space size={6} wrap>
                        <Tag color={STATUS_META[item.status].color}>
                          {STATUS_META[item.status].label}
                        </Tag>
                        <Typography.Text type="secondary">{item.message}</Typography.Text>
                      </Space>
                      {item.notes.length > 0 ? (
                        <Typography.Text type="warning" style={{ fontSize: 12 }}>
                          {item.notes.join('；')}
                        </Typography.Text>
                      ) : null}
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12, overflowWrap: 'anywhere' }}
                      >
                        {splitPath(item.path).dir}
                      </Typography.Text>
                    </div>
                  ),
                },
              ]}
            />
            <Space wrap style={{ marginTop: 12 }}>
              <Typography.Text>
                将重命名 <strong>{preview.readyCount}</strong> 个项目
                {preview.unchangedCount > 0 ? `，${preview.unchangedCount} 个名称不变` : ''}
                {preview.skippedCount > 0 ? `，跳过 ${preview.skippedCount} 个` : ''}
                {preview.blockedCount > 0 ? `，${preview.blockedCount} 个有问题将跳过` : ''}。
              </Typography.Text>
              <Button
                type="primary"
                disabled={startDisabled}
                loading={acting}
                onClick={() => setConfirmOpen(true)}
              >
                开始重命名
              </Button>
            </Space>
          </>
        )}
      </Card>

      {state ? (
        <Card
          title={state.mode === 'undo' ? '撤销进度与结果' : '重命名进度与结果'}
          extra={
            <Space>
              {undoInfo && !running ? (
                <Button disabled={locked || acting} onClick={() => setUndoOpen(true)}>
                  撤销上次批量
                </Button>
              ) : null}
              {running ? (
                <Button disabled={state.status === 'cancelling'} onClick={() => void stop()}>
                  停止重命名
                </Button>
              ) : null}
            </Space>
          }
        >
          <Alert
            type={
              (state.status === 'completed' || state.status === 'cancelled') &&
              state.results.some((item) => item.status === 'failed')
                ? 'warning'
                : 'info'
            }
            showIcon
            message={
              running
                ? state.status === 'cancelling'
                  ? '正在停止，等待当前项目安全结束'
                  : state.mode === 'undo'
                    ? '正在撤销上次批量重命名'
                    : '正在重命名'
                : state.status === 'cancelled'
                  ? '已停止，已完成的项目保留，可撤销本次整批操作'
                  : state.mode === 'undo'
                    ? '撤销任务结束'
                    : '重命名任务结束'
            }
          />
          <Progress
            style={{ marginTop: 12 }}
            percent={state.total > 0 ? Math.floor((state.processed / state.total) * 100) : 0}
          />
          <Typography.Paragraph style={{ marginBottom: 4 }}>
            已处理 {state.processed} / {state.total} · 成功{' '}
            {state.results.filter((item) => item.status === 'renamed' || item.status === 'restored').length}{' '}
            · 失败 {state.results.filter((item) => item.status === 'failed').length}
          </Typography.Paragraph>
          <Typography.Paragraph
            type="secondary"
            style={{ overflowWrap: 'anywhere', minHeight: 20 }}
          >
            {state.currentPath}
          </Typography.Paragraph>
          {state.results.length > 0 ? (
            <List
              dataSource={state.results}
              pagination={{ pageSize: 20 }}
              renderItem={(item) => (
                <List.Item>
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Typography.Text style={{ overflowWrap: 'anywhere' }}>
                      {item.source}
                    </Typography.Text>
                    <Typography.Text
                      type={
                        item.status === 'renamed' || item.status === 'restored'
                          ? 'success'
                          : 'warning'
                      }
                    >
                      {item.message}
                    </Typography.Text>
                    {item.target ? (
                      <Button
                        type="link"
                        style={{ height: 'auto', whiteSpace: 'normal', overflowWrap: 'anywhere', padding: 0 }}
                        onClick={() => void useAppStore.getState().openInExplorer(item.target)}
                      >
                        {item.target}
                      </Button>
                    ) : null}
                  </Space>
                </List.Item>
              )}
            />
          ) : null}
        </Card>
      ) : null}

      <Modal
        title="确认批量重命名"
        open={confirmOpen}
        closable={!acting}
        maskClosable={false}
        onCancel={() => setConfirmOpen(false)}
        footer={
          <Space>
            <Button autoFocus disabled={acting} onClick={() => setConfirmOpen(false)}>
              暂不重命名
            </Button>
            <Button
              type="primary"
              aria-label="确认开始重命名"
              loading={acting}
              disabled={startDisabled}
              onClick={() => void start()}
            >
              确认开始重命名
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph>
          将按顺序对 {preview?.readyCount ?? 0} 个项目应用 {activeRuleCount} 条已启用规则。
          {preview && preview.unchangedCount > 0
            ? ` ${preview.unchangedCount} 个名称不变的项目会跳过。`
            : ''}
          {preview && preview.skippedCount + preview.blockedCount > 0
            ? ` 另有 ${preview.skippedCount + preview.blockedCount} 个跳过或有问题，不会改名。`
            : ''}
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          不会覆盖已有名称；执行前会再次确认文件状态和目标名称。任务进行中可停止，已完成的部分可在结束后整批撤销。
        </Typography.Paragraph>
      </Modal>

      <Modal
        title="撤销上次批量重命名"
        open={undoOpen}
        closable={!acting}
        maskClosable={false}
        onCancel={() => setUndoOpen(false)}
        footer={
          <Space>
            <Button autoFocus disabled={acting} onClick={() => setUndoOpen(false)}>
              暂不撤销
            </Button>
            <Button
              type="primary"
              aria-label="确认撤销上次批量"
              loading={acting}
              disabled={locked || acting}
              onClick={() => void undo()}
            >
              确认撤销
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph>
          将把上次成功重命名的 {undoInfo?.count ?? 0} 个项目改回原名
          {undoInfo ? `（记录于 ${formatDateTime(undoInfo.createdAt)}）` : ''}。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          只撤销最近一次整批操作；原名称已被其他文件占用、项目已被移动或删除的会跳过，不会覆盖任何已有名称。
        </Typography.Paragraph>
      </Modal>
    </div>
  );
}
