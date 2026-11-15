import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  List,
  Modal,
  Progress,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { AppstoreAddOutlined, FolderOpenOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { FILE_TYPES } from '@shared/fileTypes';
import { formatBytes } from '@shared/format';
import {
  createPresetRule,
  DEFAULT_SMART_CATEGORIES,
  MAX_ORGANIZE_SOURCES,
  ORGANIZE_MATCH_LIMIT,
  ORGANIZE_PRESETS,
  SMART_CATEGORIES,
  SMART_CATEGORY_LABELS,
  type OrganizePreview,
  type OrganizePriority,
  type OrganizeRule,
  type OrganizeState,
  type SmartCategory,
} from '@shared/organize';
import PageHeader from '../components/PageHeader';
import { useBackClose } from '../lib/back';
import { hasMoreItems, nextVisibleCount, ORGANIZE_PREVIEW_BATCH } from '../lib/organizePreview';
import { describeError, useAppStore } from '../store/useAppStore';

const MB = 1024 * 1024;

export default function OrganizePage(): React.JSX.Element {
  const settings = useAppStore((store) => store.settings);
  const savedRules = settings?.organizeRules ?? null;
  const savedRulesKey = JSON.stringify(savedRules ?? []);
  const [rules, setRules] = useState<OrganizeRule[]>(() =>
    structuredClone(settings?.organizeRules ?? []),
  );
  const [sourceDirs, setSourceDirs] = useState<string[]>([]);
  const [mode, setMode] = useState<'rules' | 'smart'>('rules');
  const [smartTargetRoot, setSmartTargetRoot] = useState('');
  const [smartCategories, setSmartCategories] = useState<SmartCategory[]>(DEFAULT_SMART_CATEGORIES);
  const [preview, setPreview] = useState<OrganizePreview | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [visibleCount, setVisibleCount] = useState(ORGANIZE_PREVIEW_BATCH);
  const previewBodyRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<OrganizePreview | null>(null);
  const [state, setState] = useState<OrganizeState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [crossConfirmed, setCrossConfirmed] = useState(false);
  const closeConfirm = useCallback(() => setConfirmOpen(false), []);
  useBackClose(confirmOpen, closeConfirm);
  const { message } = App.useApp();
  const running = state?.status === 'running' || state?.status === 'cancelling';
  const locked = pending || running || state === null;
  const priority: OrganizePriority = settings?.organizePriority ?? 'order';
  const crossCount =
    preview?.items.filter((item) => selected.includes(item.id) && item.crossDrive).length ?? 0;

  useEffect(() => {
    if (savedRules) setRules(structuredClone(savedRules));
    // 仅当已保存规则内容变化时才重置草稿，避免切换优先级等其它设置改动覆盖未保存的规则。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedRulesKey]);

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  const loadMore = useCallback((): void => {
    setVisibleCount((current) =>
      previewRef.current ? nextVisibleCount(current, previewRef.current.items.length) : current,
    );
  }, []);

  useEffect(() => {
    if (!preview) return;
    const body = previewBodyRef.current?.querySelector('.ant-table-body') as HTMLElement | null;
    if (!body) return;
    const onScroll = (): void => {
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) loadMore();
    };
    body.addEventListener('scroll', onScroll, { passive: true });
    return () => body.removeEventListener('scroll', onScroll);
  }, [preview, loadMore]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let refreshed = false;
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.api.getOrganizeState();
        if (disposed) return;
        setState(next);
        const active = next.status === 'running' || next.status === 'cancelling';
        if (!active && next.status !== 'idle' && !refreshed) {
          useAppStore.setState((store) => ({ dataVersion: store.dataVersion + 1 }));
          void useAppStore.getState().refreshOverview(true);
          void useAppStore.getState().refreshDrives();
          refreshed = true;
        }
        if (active) refreshed = false;
      } catch (cause) {
        if (!disposed) setError(describeError(cause));
      } finally {
        if (!disposed)
          timer = setTimeout(() => {
            void refresh();
          }, 300);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);

  function invalidate(): void {
    setPreview(null);
    setSelected([]);
    setVisibleCount(ORGANIZE_PREVIEW_BATCH);
  }
  function changeRule(id: string, patch: Partial<OrganizeRule>): void {
    setRules((current) => current.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
    invalidate();
  }
  function addPreset(key: string): void {
    const preset = ORGANIZE_PRESETS.find((item) => item.key === key);
    if (!preset || rules.length >= 50) return;
    setRules([...rules, createPresetRule(preset)]);
    invalidate();
  }
  async function chooseDirectory(ruleId?: string): Promise<void> {
    try {
      const directory = await window.api.selectOrganizeDirectory();
      if (!directory) return;
      if (ruleId) changeRule(ruleId, { targetDir: directory });
      else {
        const key = directory.replace(/\\+$/, '').toLowerCase();
        setSourceDirs((current) =>
          current.some((dir) => dir.replace(/\\+$/, '').toLowerCase() === key)
            ? current
            : [...current, directory],
        );
        invalidate();
      }
    } catch (cause) {
      setError(describeError(cause));
    }
  }
  function removeSource(target: string): void {
    setSourceDirs((current) => current.filter((dir) => dir !== target));
    invalidate();
  }
  async function chooseSmartTarget(): Promise<void> {
    try {
      const directory = await window.api.selectOrganizeDirectory();
      if (!directory) return;
      setSmartTargetRoot(directory);
      invalidate();
    } catch (cause) {
      setError(describeError(cause));
    }
  }
  async function saveRules(): Promise<void> {
    setPending(true);
    setError('');
    try {
      const saved = await window.api.updateSettings({ organizeRules: rules });
      useAppStore.setState({ settings: saved });
      setRules(saved.organizeRules);
      invalidate();
      void message.success('归类规则已保存，下次启动仍可使用');
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  }
  async function changePriority(next: OrganizePriority): Promise<void> {
    if (next === priority) return;
    setPending(true);
    setError('');
    try {
      const saved = await window.api.updateSettings({ organizePriority: next });
      useAppStore.setState({ settings: saved });
      invalidate();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  }
  async function plan(): Promise<void> {
    setPending(true);
    setError('');
    invalidate();
    try {
      setPreview(await window.api.previewOrganize({ sourceDirs, rules, priority }));
      setVisibleCount(ORGANIZE_PREVIEW_BATCH);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  }
  async function planSmart(): Promise<void> {
    setPending(true);
    setError('');
    invalidate();
    try {
      setPreview(
        await window.api.previewSmartOrganize({
          sourceDirs,
          targetRoot: smartTargetRoot,
          categories: smartCategories,
        }),
      );
      setVisibleCount(ORGANIZE_PREVIEW_BATCH);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  }
  async function start(): Promise<void> {
    if (!preview) return;
    setPending(true);
    setError('');
    try {
      setState(
        await window.api.startOrganize({
          token: preview.token,
          fileIds: selected,
          confirmCrossDrive: crossConfirmed,
        }),
      );
      invalidate();
      setConfirmOpen(false);
    } catch (cause) {
      setError(describeError(cause));
      setConfirmOpen(false);
    } finally {
      setPending(false);
    }
  }
  async function stop(): Promise<void> {
    try {
      setState(await window.api.cancelOrganize());
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  return (
    <div className="organize-page">
      <PageHeader title="归类整理" subtitle="自定义规则 · 先预览再移动 · 不覆盖已有文件" />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Segmented
          aria-label="整理方式"
          value={mode}
          disabled={running}
          options={[
            { label: '自定义规则', value: 'rules' },
            { label: '一键智能归类', value: 'smart' },
          ]}
          onChange={(value) => {
            setMode(value as 'rules' | 'smart');
            invalidate();
          }}
        />
        <Alert
          type="info"
          showIcon
          message={
            mode === 'smart' ? '一键智能归类，跨盘须确认' : '按所选优先级匹配规则，跨盘须确认'
          }
          description={
            mode === 'smart'
              ? '按文件类型分到目标根目录下的“视频、图片、文档、音乐、压缩包、安装包、其他”子文件夹；子文件夹只在真正有文件移入时才创建。跨盘串行复制并校验 SHA-256，成功后原件进入 Windows 回收站或长路径回收区；回收不可用时停止。只处理已扫描的文件，不移动文件夹。'
              : '命中多条规则时，可按规则顺序（取第一条）或同盘优先。“文件夹”规则会整目录同盘移动（内部文件跟随、索引同步），跨盘不支持；其它规则逐个移动已扫描文件。跨盘文件串行复制并校验 SHA-256，成功后原件进入 Windows 回收站或长路径回收区；回收不可用时停止。'
          }
        />
        {error ? <Alert type="error" showIcon message={error} /> : null}
        <Card title="1. 整理范围">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Button
              disabled={locked || sourceDirs.length >= MAX_ORGANIZE_SOURCES}
              icon={<FolderOpenOutlined aria-hidden />}
              onClick={() => void chooseDirectory()}
            >
              选择来源文件夹
            </Button>
            {sourceDirs.length === 0 ? (
              <Input
                readOnly
                aria-label="整理来源"
                value=""
                placeholder="可多次选择，添加多个本地盘上的文件夹，包含各自子目录"
              />
            ) : (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {sourceDirs.map((dir) => (
                  <Space.Compact key={dir} style={{ width: '100%' }}>
                    <Input readOnly aria-label="整理来源" value={dir} />
                    <Button
                      aria-label="移除来源"
                      disabled={locked}
                      onClick={() => removeSource(dir)}
                    >
                      移除
                    </Button>
                  </Space.Compact>
                ))}
              </Space>
            )}
            <Typography.Text type="secondary">
              已添加 {sourceDirs.length} 个来源（最多 {MAX_ORGANIZE_SOURCES}
              个），嵌套目录只算一次；整盘会分批匹配，最多预览 {ORGANIZE_MATCH_LIMIT}
              个命中规则的文件，超过时请缩小来源或规则范围。
            </Typography.Text>
          </Space>
        </Card>
        {mode === 'rules' ? (
          <Card
            title="2. 自定义归类规则"
            extra={
              <Space>
                <Dropdown
                  disabled={locked || rules.length >= 50}
                  menu={{
                    items: ORGANIZE_PRESETS.map((preset) => ({
                      key: preset.key,
                      label: preset.ruleName,
                    })),
                    onClick: ({ key }) => addPreset(key),
                  }}
                >
                  <Button
                    disabled={locked || rules.length >= 50}
                    icon={<AppstoreAddOutlined aria-hidden />}
                  >
                    添加预设
                  </Button>
                </Dropdown>
                <Button
                  disabled={locked || rules.length >= 50}
                  icon={<PlusOutlined aria-hidden />}
                  onClick={() => {
                    setRules([
                      ...rules,
                      {
                        id: crypto.randomUUID(),
                        name: `规则 ${rules.length + 1}`,
                        enabled: true,
                        type: 'all',
                        extensions: [],
                        nameContains: '',
                        namePattern: '',
                        namePatternMode: 'exact',
                        targetDir: '',
                        minSize: null,
                        maxSize: null,
                        mtimeFrom: null,
                        mtimeTo: null,
                        pathContains: '',
                        matchMode: 'all',
                      },
                    ]);
                    invalidate();
                  }}
                >
                  添加规则
                </Button>
                <Button disabled={locked} onClick={() => void saveRules()}>
                  保存规则
                </Button>
              </Space>
            }
          >
            <Typography.Paragraph type="secondary">
              类型、扩展名、文件名包含、文件名格式、大小、时间和路径等条件可按“全部满足 /
              任一满足”组合；留空的条件不参与匹配，全部留空时匹配全部文件。文件名格式用 X
              表示任意一个字符，其余字符按字面匹配，例如 XX-XXX（2 个字 + 横线 + 3
              个字）；匹配方式可选完整匹配（整段名字必须对上）或包含匹配（名字任意位置出现即可），
              不区分大小写、全角半角和横线写法。类型选“文件夹”时按文件夹名和路径匹配，整目录同盘移动，
              扩展名、大小、时间不参与，跨盘不支持；文件夹内部已由父文件夹覆盖时只列最外层。
              命中多条规则时按上方“规则优先级”选择：按规则顺序取第一条，或同盘优先。所有规则指向同一个目标即可集中归档。“添加预设”可一键加入视频、图片、文档、音乐、压缩包、安装包规则，添加后只需选择目标文件夹。
            </Typography.Paragraph>
            <Space align="center" wrap>
              <Typography.Text>命中多条规则时：</Typography.Text>
              <Segmented
                aria-label="规则优先级"
                value={priority}
                disabled={running}
                options={[
                  { label: '按规则顺序', value: 'order' },
                  { label: '同盘优先', value: 'sameDrive' },
                ]}
                onChange={(value) => void changePriority(value as OrganizePriority)}
              />
            </Space>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {rules.length === 0 ? (
                <Empty description="尚无归类规则，可用“添加预设”快速开始" />
              ) : (
                rules.map((rule, index) => (
                  <Card
                    key={rule.id}
                    size="small"
                    className="organize-rule"
                    title={
                      <Space>
                        <Switch
                          aria-label={`启用规则 ${index + 1}`}
                          disabled={locked}
                          checked={rule.enabled}
                          onChange={(enabled) => changeRule(rule.id, { enabled })}
                        />
                        <Typography.Text>规则 {index + 1}</Typography.Text>
                      </Space>
                    }
                    extra={
                      <Space>
                        <Button
                          disabled={locked || index === 0}
                          onClick={() => {
                            const next = [...rules];
                            [next[index - 1], next[index]] = [next[index], next[index - 1]];
                            setRules(next);
                            invalidate();
                          }}
                        >
                          上移
                        </Button>
                        <Button
                          disabled={locked || index === rules.length - 1}
                          onClick={() => {
                            const next = [...rules];
                            [next[index], next[index + 1]] = [next[index + 1], next[index]];
                            setRules(next);
                            invalidate();
                          }}
                        >
                          下移
                        </Button>
                        <Button
                          disabled={locked}
                          onClick={() => {
                            setRules(rules.filter((item) => item.id !== rule.id));
                            invalidate();
                          }}
                        >
                          移除规则
                        </Button>
                      </Space>
                    }
                  >
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <Space wrap>
                        <Input
                          aria-label="规则名称"
                          value={rule.name}
                          disabled={locked}
                          style={{ width: 160 }}
                          onChange={(event) => changeRule(rule.id, { name: event.target.value })}
                        />
                        <Select
                          aria-label="规则文件类型"
                          value={rule.type}
                          disabled={locked}
                          style={{ width: 130 }}
                          options={[
                            { value: 'all', label: '全部类型' },
                            { value: 'folder', label: '文件夹' },
                            ...FILE_TYPES.map((type) => ({ value: type.key, label: type.label })),
                          ]}
                          onChange={(type) => changeRule(rule.id, { type })}
                        />
                        <Input
                          aria-label="扩展名条件"
                          placeholder="扩展名：txt,pdf（可留空）"
                          value={rule.extensions.join(',')}
                          disabled={locked || rule.type === 'folder'}
                          style={{ width: 230 }}
                          onChange={(event) =>
                            changeRule(rule.id, {
                              extensions: event.target.value
                                ? event.target.value.split(/[,，]/)
                                : [],
                            })
                          }
                        />
                        <Input
                          aria-label="文件名包含"
                          placeholder="文件名包含（可留空）"
                          value={rule.nameContains}
                          disabled={locked}
                          style={{ width: 200 }}
                          onChange={(event) =>
                            changeRule(rule.id, { nameContains: event.target.value })
                          }
                        />
                        <Input
                          aria-label="文件名格式"
                          placeholder="文件名格式：XX-XXX（可留空）"
                          value={rule.namePattern}
                          disabled={locked}
                          style={{ width: 240 }}
                          onChange={(event) =>
                            changeRule(rule.id, { namePattern: event.target.value })
                          }
                        />
                        <Select
                          aria-label="文件名格式匹配方式"
                          value={rule.namePatternMode}
                          disabled={locked}
                          style={{ width: 110 }}
                          options={[
                            { value: 'exact', label: '完整匹配' },
                            { value: 'contains', label: '包含匹配' },
                          ]}
                          onChange={(namePatternMode) => changeRule(rule.id, { namePatternMode })}
                        />
                        <Typography.Text type="secondary">
                          X = 任意一个字符（含汉字）；全角半角、横线写法不区分
                        </Typography.Text>
                      </Space>
                      {rule.type === 'folder' ? (
                        <Typography.Text type="secondary">
                          文件夹规则按文件夹名和路径匹配；整目录同盘移动，跨盘不支持。
                          文件夹来自已扫描索引，空文件夹不会出现。
                        </Typography.Text>
                      ) : null}
                      <Space.Compact style={{ width: '100%' }}>
                        <Input
                          readOnly
                          aria-label="规则目标文件夹"
                          placeholder="选择归类后的目标文件夹"
                          value={rule.targetDir}
                        />
                        <Button disabled={locked} onClick={() => void chooseDirectory(rule.id)}>
                          选择目标文件夹
                        </Button>
                      </Space.Compact>
                      <Space wrap>
                        <Select
                          aria-label="匹配方式"
                          value={rule.matchMode}
                          disabled={locked}
                          style={{ width: 120 }}
                          options={[
                            { value: 'all', label: '全部满足' },
                            { value: 'any', label: '任一满足' },
                          ]}
                          onChange={(matchMode) => changeRule(rule.id, { matchMode })}
                        />
                        <Space size={6}>
                          <Typography.Text>最小大小</Typography.Text>
                          <InputNumber
                            aria-label="最小大小"
                            min={0}
                            disabled={locked || rule.type === 'folder'}
                            value={rule.minSize === null ? null : rule.minSize / MB}
                            placeholder="不限"
                            addonAfter="MB"
                            style={{ width: 120 }}
                            onChange={(value) =>
                              changeRule(rule.id, {
                                minSize: value === null ? null : Math.round(value * MB),
                              })
                            }
                          />
                        </Space>
                        <Space size={6}>
                          <Typography.Text>最大大小</Typography.Text>
                          <InputNumber
                            aria-label="最大大小"
                            min={0}
                            disabled={locked || rule.type === 'folder'}
                            value={rule.maxSize === null ? null : rule.maxSize / MB}
                            placeholder="不限"
                            addonAfter="MB"
                            style={{ width: 120 }}
                            onChange={(value) =>
                              changeRule(rule.id, {
                                maxSize: value === null ? null : Math.round(value * MB),
                              })
                            }
                          />
                        </Space>
                        <DatePicker.RangePicker
                          aria-label="修改时间起止"
                          disabled={locked || rule.type === 'folder'}
                          value={[
                            rule.mtimeFrom !== null ? dayjs(rule.mtimeFrom) : null,
                            rule.mtimeTo !== null ? dayjs(rule.mtimeTo) : null,
                          ]}
                          onChange={(dates) =>
                            changeRule(rule.id, {
                              mtimeFrom: dates?.[0] ? dates[0].startOf('day').valueOf() : null,
                              mtimeTo: dates?.[1] ? dates[1].endOf('day').valueOf() : null,
                            })
                          }
                        />
                        <Input
                          aria-label="路径包含"
                          placeholder="路径包含（可留空）"
                          value={rule.pathContains}
                          disabled={locked}
                          style={{ width: 200 }}
                          onChange={(event) =>
                            changeRule(rule.id, { pathContains: event.target.value })
                          }
                        />
                      </Space>
                    </Space>
                  </Card>
                ))
              )}
            </Space>
          </Card>
        ) : (
          <Card title="2. 一键智能归类">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  readOnly
                  aria-label="智能归类目标根目录"
                  placeholder="选择目标根目录，将按类型分到其子文件夹"
                  value={smartTargetRoot}
                />
                <Button disabled={locked} onClick={() => void chooseSmartTarget()}>
                  选择目标根目录
                </Button>
              </Space.Compact>
              <Space direction="vertical" size={4}>
                <Typography.Text>要归入的类别（“其他”默认不勾选）：</Typography.Text>
                <Checkbox.Group
                  aria-label="归类类别"
                  value={smartCategories}
                  disabled={locked}
                  options={SMART_CATEGORIES.map((category) => ({
                    label: SMART_CATEGORY_LABELS[category],
                    value: category,
                  }))}
                  onChange={(values) => setSmartCategories(values as SmartCategory[])}
                />
              </Space>
            </Space>
          </Card>
        )}
        <Card
          title="3. 预览与勾选"
          className="organize-preview"
          extra={
            <Button
              type="primary"
              aria-label="生成整理预览"
              disabled={
                locked ||
                sourceDirs.length === 0 ||
                (mode === 'smart'
                  ? !smartTargetRoot || smartCategories.length === 0
                  : rules.length === 0)
              }
              loading={pending}
              onClick={() => void (mode === 'smart' ? planSmart() : plan())}
            >
              生成整理预览
            </Button>
          }
        >
          {!preview ? (
            <Empty description="生成预览不会移动文件" />
          ) : (
            <>
              <div ref={previewBodyRef}>
                <Table
                  size="small"
                  rowKey="id"
                  dataSource={preview.items.slice(0, visibleCount)}
                  pagination={false}
                  scroll={{ x: 850, y: 480 }}
                  rowSelection={{
                    selectedRowKeys: selected,
                    onChange: (keys) => setSelected(keys as number[]),
                    getCheckboxProps: (item) => ({ disabled: locked || !item.allowed }),
                    preserveSelectedRowKeys: true,
                  }}
                  columns={[
                    {
                      title: '原位置',
                      dataIndex: 'source',
                      width: 260,
                      render: (value: string) => (
                        <Typography.Text style={{ overflowWrap: 'anywhere' }}>
                          {value}
                        </Typography.Text>
                      ),
                    },
                    {
                      title: '目标位置',
                      dataIndex: 'target',
                      width: 260,
                      render: (value: string) => (
                        <Typography.Text style={{ overflowWrap: 'anywhere' }}>
                          {value}
                        </Typography.Text>
                      ),
                    },
                    {
                      title: '规则 / 大小',
                      width: 120,
                      render: (_, item) => (
                        <>
                          {item.rule}
                          <br />
                          {item.kind === 'folder' ? '文件夹' : formatBytes(item.size)}
                        </>
                      ),
                    },
                    {
                      title: '处理方式',
                      width: 210,
                      render: (_, item) => (
                        <>
                          <Tag
                            color={!item.allowed ? 'default' : item.crossDrive ? 'orange' : 'blue'}
                          >
                            {!item.allowed ? '跳过' : item.crossDrive ? '跨盘' : '同盘'}
                          </Tag>
                          {item.message}
                        </>
                      ),
                    },
                  ]}
                />
              </div>
              <Space wrap>
                <Typography.Text>
                  已显示 {Math.min(visibleCount, preview.items.length)} / {preview.items.length}{' '}
                  个， 已选择 {selected.length} 个项目，其中跨盘 {crossCount} 个
                </Typography.Text>
                {hasMoreItems(visibleCount, preview.items.length) ? (
                  <Button size="small" onClick={loadMore}>
                    加载更多
                  </Button>
                ) : null}
                <Button
                  disabled={locked}
                  onClick={() =>
                    setSelected(preview.items.filter((item) => item.allowed).map((item) => item.id))
                  }
                >
                  勾选全部可移动项目
                </Button>
                <Button
                  type="primary"
                  disabled={locked || selected.length === 0}
                  onClick={() => {
                    setCrossConfirmed(false);
                    setConfirmOpen(true);
                  }}
                >
                  移动所选项目
                </Button>
              </Space>
            </>
          )}
        </Card>
        {state && state.status !== 'idle' ? (
          <Card
            title="整理进度与结果"
            className="organize-results"
            extra={
              running ? (
                <Button disabled={state.status === 'cancelling'} onClick={() => void stop()}>
                  停止整理
                </Button>
              ) : null
            }
          >
            <Alert
              type={state.results.some((item) => item.status === 'failed') ? 'warning' : 'info'}
              message={
                running
                  ? state.status === 'cancelling'
                    ? '正在停止，等待当前操作安全结束'
                    : '正在整理'
                  : state.status === 'cancelled'
                    ? '已停止整理，已完成的移动保留'
                    : '整理任务结束'
              }
            />
            <Progress
              percent={state.total ? Math.floor((state.processed / state.total) * 100) : 0}
            />
            <Typography.Paragraph>
              已处理 {state.processed} / {state.total} · 成功{' '}
              {state.results.filter((item) => item.status === 'moved').length}
            </Typography.Paragraph>
            <Typography.Paragraph style={{ overflowWrap: 'anywhere' }}>
              {state.currentPath}
            </Typography.Paragraph>
            <List
              dataSource={state.results}
              pagination={{ pageSize: 20 }}
              renderItem={(item) => (
                <List.Item>
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Typography.Text style={{ overflowWrap: 'anywhere' }}>
                      {item.source}
                    </Typography.Text>
                    <Typography.Text type={item.status === 'moved' ? 'success' : 'warning'}>
                      {item.message}
                    </Typography.Text>
                    {item.target ? (
                      <Button
                        type="link"
                        style={{ height: 'auto', whiteSpace: 'normal', overflowWrap: 'anywhere' }}
                        onClick={() => void useAppStore.getState().openInExplorer(item.target)}
                      >
                        {item.target}
                      </Button>
                    ) : null}
                  </Space>
                </List.Item>
              )}
            />
          </Card>
        ) : null}
      </Space>
      <Modal
        title="确认移动项目"
        open={confirmOpen}
        closable={!pending}
        maskClosable={false}
        onCancel={() => setConfirmOpen(false)}
        footer={
          <Space>
            <Button autoFocus disabled={pending} onClick={() => setConfirmOpen(false)}>
              暂不移动
            </Button>
            <Button
              type="primary"
              aria-label="确认开始移动"
              disabled={pending || (crossCount > 0 && !crossConfirmed)}
              loading={pending}
              onClick={() => void start()}
            >
              确认开始移动
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph>
          将移动所选 {selected.length}{' '}
          个项目（文件或文件夹）。请确认预览中的目标位置；同名目标不会覆盖。已完成的移动不会因停止任务而撤销。
        </Typography.Paragraph>
        {crossCount > 0 ? (
          <>
            <Alert
              type="warning"
              message={`含 ${crossCount} 个跨盘文件`}
              description="跨盘复制需要额外空间和时间；校验后原件进入可恢复位置，原盘空间可能需要之后手动清理回收站才能释放。副本使用目标目录权限，跨盘不保证保留全部 NTFS 扩展属性。"
            />
            <Checkbox
              checked={crossConfirmed}
              onChange={(event) => setCrossConfirmed(event.target.checked)}
            >
              我确认跨盘移动，并保留可恢复原件
            </Checkbox>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
