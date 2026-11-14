import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
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
import { FolderOpenOutlined, PlusOutlined } from '@ant-design/icons';
import { FILE_TYPES } from '@shared/fileTypes';
import { formatBytes } from '@shared/format';
import type { OrganizePreview, OrganizeRule, OrganizeState } from '@shared/organize';
import PageHeader from '../components/PageHeader';
import { useBackClose } from '../lib/back';
import { describeError, useAppStore } from '../store/useAppStore';

export default function OrganizePage(): React.JSX.Element {
  const settings = useAppStore((store) => store.settings);
  const [rules, setRules] = useState<OrganizeRule[]>(() =>
    structuredClone(settings?.organizeRules ?? []),
  );
  const [sourceDir, setSourceDir] = useState('');
  const [preview, setPreview] = useState<OrganizePreview | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
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
  const crossCount =
    preview?.items.filter((item) => selected.includes(item.id) && item.crossDrive).length ?? 0;

  useEffect(() => {
    if (settings) setRules(structuredClone(settings.organizeRules));
  }, [settings]);

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
  }
  function changeRule(id: string, patch: Partial<OrganizeRule>): void {
    setRules((current) => current.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
    invalidate();
  }
  async function chooseDirectory(ruleId?: string): Promise<void> {
    try {
      const directory = await window.api.selectOrganizeDirectory();
      if (!directory) return;
      if (ruleId) changeRule(ruleId, { targetDir: directory });
      else {
        setSourceDir(directory);
        invalidate();
      }
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
  async function plan(): Promise<void> {
    setPending(true);
    setError('');
    invalidate();
    try {
      setPreview(await window.api.previewOrganize({ sourceDir, rules }));
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
        <Alert
          type="info"
          showIcon
          message="同盘优先，跨盘须确认"
          description="多条规则匹配时优先选择同盘目标（包括机械硬盘），再按规则顺序选择。跨盘串行复制并校验 SHA-256，成功后原件进入 Windows 回收站或长路径回收区；回收不可用时停止。只处理已扫描的文件，不移动文件夹。"
        />
        {error ? <Alert type="error" showIcon message={error} /> : null}
        <Card title="1. 整理范围">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Button
              disabled={locked}
              icon={<FolderOpenOutlined aria-hidden />}
              onClick={() => void chooseDirectory()}
            >
              选择来源文件夹
            </Button>
            <Input
              readOnly
              aria-label="整理来源"
              value={sourceDir}
              placeholder="选择任一本地盘上的文件夹，包含其子目录"
            />
            <Typography.Text type="secondary">
              每次最多预览 10000 个索引文件；来源过大时请选择更小的子目录。
            </Typography.Text>
          </Space>
        </Card>
        <Card
          title="2. 自定义归类规则"
          extra={
            <Space>
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
                      targetDir: '',
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
            类型、扩展名和名称条件同时满足才匹配；扩展名和名称留空表示不限。同盘规则之间按从上到下的顺序匹配。所有规则指向同一个目标即可集中归档。
          </Typography.Paragraph>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {rules.length === 0 ? (
              <Empty description="尚无归类规则" />
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
                          ...FILE_TYPES.map((type) => ({ value: type.key, label: type.label })),
                        ]}
                        onChange={(type) => changeRule(rule.id, { type })}
                      />
                      <Input
                        aria-label="扩展名条件"
                        placeholder="扩展名：txt,pdf（可留空）"
                        value={rule.extensions.join(',')}
                        disabled={locked}
                        style={{ width: 230 }}
                        onChange={(event) =>
                          changeRule(rule.id, {
                            extensions: event.target.value ? event.target.value.split(/[,，]/) : [],
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
                    </Space>
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
                  </Space>
                </Card>
              ))
            )}
          </Space>
        </Card>
        <Card
          title="3. 预览与勾选"
          className="organize-preview"
          extra={
            <Button
              type="primary"
              aria-label="生成整理预览"
              disabled={locked || !sourceDir || rules.length === 0}
              loading={pending}
              onClick={() => void plan()}
            >
              生成整理预览
            </Button>
          }
        >
          {!preview ? (
            <Empty description="生成预览不会移动文件" />
          ) : (
            <>
              <Table
                size="small"
                rowKey="id"
                dataSource={preview.items}
                pagination={{ pageSize: 50, showSizeChanger: false }}
                scroll={{ x: 850 }}
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
                        {formatBytes(item.size)}
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
              <Space wrap>
                <Typography.Text>
                  已选择 {selected.length} 个文件，其中跨盘 {crossCount} 个
                </Typography.Text>
                <Button
                  disabled={locked}
                  onClick={() =>
                    setSelected(preview.items.filter((item) => item.allowed).map((item) => item.id))
                  }
                >
                  勾选全部可移动文件
                </Button>
                <Button
                  type="primary"
                  disabled={locked || selected.length === 0}
                  onClick={() => {
                    setCrossConfirmed(false);
                    setConfirmOpen(true);
                  }}
                >
                  移动所选文件
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
        title="确认移动文件"
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
          个文件。请确认预览中的目标位置；同名目标不会覆盖。已完成的移动不会因停止任务而撤销。
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
