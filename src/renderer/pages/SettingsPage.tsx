import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Empty,
  Input,
  InputNumber,
  List,
  Modal,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, FolderOpenOutlined, PlusOutlined } from '@ant-design/icons';
import { useBackClose } from '../lib/back';
import type {
  BackupFileInfo,
  DataInfo,
  DriveInfo,
  LongTrashStatus,
  RecycleStatus,
} from '@shared/types';
import type { AppSettings } from '@shared/types';
import { COPY } from '@shared/copy';
import { formatBytes, formatCount, formatDateTime } from '@shared/format';
import PageHeader from '../components/PageHeader';
import { describeError, isScanActive, useAppStore } from '../store/useAppStore';

const MB = 1024 * 1024;
const SIZE_PRESETS = [0, 1, 10, 100] as const;

interface SettingsDraft {
  scanDrives: string[];
  excludedPaths: string[];
  skipHiddenSystem: boolean;
  minDuplicateSizeMb: number;
  autoBackup: boolean;
}

function toDraft(settings: AppSettings): SettingsDraft {
  return {
    scanDrives: [...settings.scanDrives],
    excludedPaths: [...settings.excludedPaths],
    skipHiddenSystem: settings.skipHiddenSystem,
    minDuplicateSizeMb: Math.round(settings.minDuplicateSize / MB),
    autoBackup: settings.autoBackup,
  };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function DrivePicker({
  drives,
  selected,
  onChange,
}: {
  drives: DriveInfo[];
  selected: string[];
  onChange(next: string[]): void;
}): React.JSX.Element {
  if (drives.length === 0) {
    return <Typography.Text type="secondary">未检测到本地硬盘</Typography.Text>;
  }
  return (
    <div className="scan-drive-list settings-drive-list">
      {drives.map((drive) => {
        const checked = selected.includes(drive.letter);
        return (
          <label
            key={drive.letter}
            className={`scan-drive-option${drive.ready ? '' : ' scan-drive-option-offline'}`}
          >
            <Checkbox
              checked={checked}
              disabled={!drive.ready}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...new Set([...selected, drive.letter])].sort()
                    : selected.filter((letter) => letter !== drive.letter),
                )
              }
            />
            <span className="scan-drive-letter">{drive.letter}</span>
            <span className="scan-drive-label">{drive.label || '本地磁盘'}</span>
            <span className="scan-drive-capacity">
              {drive.ready
                ? `${formatBytes(drive.freeBytes)} 可用 / ${formatBytes(drive.totalBytes)}`
                : '未连接'}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export default function SettingsPage(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings);
  const appInfo = useAppStore((state) => state.appInfo);
  const drives = useAppStore((state) => state.drives);
  const scanState = useAppStore((state) => state.scanState);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const clearData = useAppStore((state) => state.clearData);
  const pushNotice = useAppStore((state) => state.pushNotice);
  const refreshDrives = useAppStore((state) => state.refreshDrives);
  const scanning = isScanActive(scanState);
  const { modal } = AntApp.useApp();

  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [excludeInput, setExcludeInput] = useState('');
  const [recycle, setRecycle] = useState<RecycleStatus | null>(null);
  const [longTrash, setLongTrash] = useState<LongTrashStatus | null>(null);
  const [restoringLongId, setRestoringLongId] = useState<string | null>(null);
  const [dataInfo, setDataInfo] = useState<DataInfo | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoringPath, setRestoringPath] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const closeClear = useCallback(() => setClearOpen(false), []);
  useBackClose(clearOpen, closeClear);
  const [clearAccepted, setClearAccepted] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (settings) setDraft(toDraft(settings));
  }, [settings]);

  const refreshDataInfo = useCallback(async (): Promise<void> => {
    try {
      setDataInfo(await window.api.getDataInfo());
    } catch (error) {
      pushNotice('error', `读取数据信息失败：${describeError(error)}`);
    }
  }, [pushNotice]);

  const refreshLongTrash = useCallback(async (): Promise<void> => {
    try {
      setLongTrash(await window.api.getLongTrash());
    } catch (error) {
      pushNotice('error', `读取长路径回收区失败：${describeError(error)}`);
    }
  }, [pushNotice]);

  useEffect(() => {
    void refreshDataInfo();
    void refreshLongTrash();
    void refreshDrives();
    let active = true;
    window.api
      .getRecycleStatus()
      .then((status) => {
        if (active) setRecycle(status);
      })
      .catch((error: unknown) => {
        if (active) pushNotice('error', `读取回收站状态失败：${describeError(error)}`);
      });
    return () => {
      active = false;
    };
  }, [refreshDataInfo, refreshLongTrash, refreshDrives, pushNotice]);

  const dirty = useMemo(() => {
    if (!settings || !draft) return false;
    return (
      !sameList([...draft.scanDrives].sort(), [...settings.scanDrives].sort()) ||
      !sameList(draft.excludedPaths, settings.excludedPaths) ||
      draft.skipHiddenSystem !== settings.skipHiddenSystem ||
      Math.round(draft.minDuplicateSizeMb * MB) !== settings.minDuplicateSize ||
      draft.autoBackup !== settings.autoBackup
    );
  }, [settings, draft]);

  const minSizeChanged =
    settings && draft
      ? Math.round(draft.minDuplicateSizeMb * MB) !== settings.minDuplicateSize
      : false;

  const patchDraft = (patch: Partial<SettingsDraft>): void => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const addExcludedPath = (): void => {
    if (!draft) return;
    const value = excludeInput.trim();
    if (!value) return;
    if (draft.excludedPaths.some((item) => item.toLowerCase() === value.toLowerCase())) {
      pushNotice('info', '该目录已在排除列表中');
      return;
    }
    patchDraft({ excludedPaths: [...draft.excludedPaths, value] });
    setExcludeInput('');
  };

  const handleSave = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    const patch: Partial<AppSettings> = {};
    if (!sameList([...draft.scanDrives].sort(), [...(settings?.scanDrives ?? [])].sort())) {
      patch.scanDrives = [...draft.scanDrives].sort();
    }
    if (!sameList(draft.excludedPaths, settings?.excludedPaths ?? [])) {
      patch.excludedPaths = draft.excludedPaths;
    }
    if (draft.skipHiddenSystem !== settings?.skipHiddenSystem) {
      patch.skipHiddenSystem = draft.skipHiddenSystem;
    }
    const minSize = Math.round(draft.minDuplicateSizeMb * MB);
    if (minSize !== settings?.minDuplicateSize) patch.minDuplicateSize = minSize;
    if (draft.autoBackup !== settings?.autoBackup) patch.autoBackup = draft.autoBackup;

    const ok = await updateSettings(patch);
    setSaving(false);
    if (!ok) return;
    pushNotice(
      'success',
      patch.minDuplicateSize !== undefined
        ? '设置已保存，重新查找重复文件后生效'
        : '设置已保存，下次扫描生效',
    );
  };

  const handleCreateBackup = async (): Promise<void> => {
    setBackupBusy(true);
    try {
      const backup = await window.api.createBackup();
      if (!backup) {
        pushNotice('error', '备份失败，请检查磁盘空间和数据目录权限');
        return;
      }
      await refreshDataInfo();
      pushNotice('success', `已创建备份 ${backup.fileName}`);
    } catch (error) {
      pushNotice('error', `备份失败：${describeError(error)}`);
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRestore = (backup: BackupFileInfo): void => {
    modal.confirm({
      title: '从这份备份恢复？',
      content: `将用 ${formatDateTime(backup.createdAt)} 的备份替换当前索引和设置。软件会先自动备份当前数据，恢复完成后自动重新启动。`,
      okText: '恢复并重启',
      cancelText: COPY.cancelAction,
      okButtonProps: { danger: true },
      onOk: async () => {
        setRestoringPath(backup.path);
        try {
          await window.api.restoreBackup(backup.path);
          pushNotice('info', '正在恢复备份，软件即将重新启动…');
        } catch (error) {
          setRestoringPath(null);
          pushNotice('error', `恢复失败：${describeError(error)}`);
        }
      },
    });
  };

  const handleClear = async (): Promise<void> => {
    setClearing(true);
    const ok = await clearData();
    setClearing(false);
    if (!ok) return;
    setClearOpen(false);
    setClearAccepted(false);
    await refreshDataInfo();
  };

  const openFolder = async (path: string | undefined): Promise<void> => {
    if (!path) return;
    try {
      const response = await window.api.openPath(path);
      if (!response.ok) pushNotice('error', response.error ?? '无法打开目录');
    } catch (error) {
      pushNotice('error', describeError(error));
    }
  };

  const handleRestoreLongTrash = (id: string, name: string): void => {
    modal.confirm({
      title: '还原这个文件？',
      content: `将把“${name}”恢复到原路径。如果原位置已有同名文件，不会覆盖。`,
      okText: '还原',
      cancelText: COPY.cancelAction,
      onOk: async () => {
        setRestoringLongId(id);
        try {
          const response = await window.api.restoreLongTrash(id);
          if (!response.ok) {
            pushNotice('error', response.error ?? '还原失败');
            return;
          }
          pushNotice('success', `已还原 ${name}`);
          await refreshLongTrash();
        } catch (error) {
          pushNotice('error', `还原失败：${describeError(error)}`);
        } finally {
          setRestoringLongId(null);
        }
      },
    });
  };

  const backups = dataInfo?.backups ?? [];
  const longEntries = longTrash?.entries ?? [];
  const minSizeLabel =
    (draft?.minDuplicateSizeMb ?? 0) === 0
      ? '不限（0 字节文件也会跳过）'
      : formatBytes((draft?.minDuplicateSizeMb ?? 0) * MB);

  return (
    <div className="settings-page">
      <PageHeader
        title={COPY.navSettings}
        subtitle="所有设置只保存在这台电脑"
        extra={
          <Space>
            {dirty ? <Tag color="orange">有未保存的修改</Tag> : null}
            <Button
              type="primary"
              loading={saving}
              disabled={!dirty || !draft}
              onClick={() => void handleSave()}
            >
              保存设置
            </Button>
          </Space>
        }
      />

      <Space direction="vertical" size={16} style={{ width: '100%', maxWidth: 940 }}>
        <Card title="扫描范围">
          {draft ? (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <div>
                <Typography.Text strong>默认扫描硬盘</Typography.Text>
                <Typography.Paragraph type="secondary" className="panel-note">
                  新扫描默认勾选这些硬盘，开始扫描前仍可临时调整。
                </Typography.Paragraph>
                <DrivePicker
                  drives={drives}
                  selected={draft.scanDrives}
                  onChange={(next) => patchDraft({ scanDrives: next })}
                />
              </div>

              <div>
                <Typography.Text strong>排除目录</Typography.Text>
                <Typography.Paragraph type="secondary" className="panel-note">
                  排除目录中的文件不会进入索引，下次扫描生效。
                </Typography.Paragraph>
                <Space.Compact style={{ width: '100%', maxWidth: 560 }}>
                  <Input
                    value={excludeInput}
                    placeholder="例如 D:\临时下载"
                    onChange={(event) => setExcludeInput(event.target.value)}
                    onPressEnter={addExcludedPath}
                    allowClear
                  />
                  <Button icon={<PlusOutlined />} onClick={addExcludedPath}>
                    添加
                  </Button>
                </Space.Compact>
                <div className="settings-excluded-list">
                  {draft.excludedPaths.length === 0 ? (
                    <Typography.Text type="secondary">没有排除目录</Typography.Text>
                  ) : (
                    draft.excludedPaths.map((item) => (
                      <div key={item} className="settings-excluded-row">
                        <span className="selectable-text break-all">{item}</span>
                        <Button
                          type="text"
                          size="small"
                          danger
                          aria-label={`移除排除目录 ${item}`}
                          icon={<DeleteOutlined />}
                          onClick={() =>
                            patchDraft({
                              excludedPaths: draft.excludedPaths.filter(
                                (value) => value !== item,
                              ),
                            })
                          }
                        />
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="settings-inline-row">
                <Typography.Text strong>{COPY.setupSkipHiddenLabel}</Typography.Text>
                <Switch
                  checked={draft.skipHiddenSystem}
                  onChange={(checked) => patchDraft({ skipHiddenSystem: checked })}
                />
              </div>

              <div className="settings-inline-row">
                <div>
                  <Typography.Text strong>自动备份</Typography.Text>
                  <Typography.Paragraph type="secondary" className="panel-note">
                    清空数据前和恢复备份前会自动备份，保留最近 3 份。
                  </Typography.Paragraph>
                </div>
                <Switch
                  checked={draft.autoBackup}
                  onChange={(checked) => patchDraft({ autoBackup: checked })}
                />
              </div>
            </Space>
          ) : (
            <Typography.Text type="secondary">加载中…</Typography.Text>
          )}
        </Card>

        <Card title="重复文件规则">
          {draft ? (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Space wrap align="center">
                <Typography.Text strong>最小体积</Typography.Text>
                <InputNumber<number>
                  min={0}
                  max={16 * 1024 * 1024}
                  step={1}
                  precision={0}
                  value={draft.minDuplicateSizeMb}
                  onChange={(value) =>
                    patchDraft({ minDuplicateSizeMb: Math.max(0, value ?? 0) })
                  }
                  addonAfter="MB"
                  style={{ width: 160 }}
                />
                <Space size={4} wrap>
                  {SIZE_PRESETS.map((mb) => (
                    <Button
                      key={mb}
                      size="small"
                      type={draft.minDuplicateSizeMb === mb ? 'primary' : 'default'}
                      onClick={() => patchDraft({ minDuplicateSizeMb: mb })}
                    >
                      {mb === 0 ? '不限' : `${mb} MB`}
                    </Button>
                  ))}
                </Space>
              </Space>
              <Typography.Text type="secondary">
                当前规则：{minSizeLabel}。小于该体积的文件不参与重复比对。
              </Typography.Text>
              {minSizeChanged ? (
                <Alert
                  type="info"
                  showIcon
                  message="修改后需要重新查找重复文件"
                  description="已有的重复文件结果基于旧规则，保存后到“重复文件”页重新查找即可（不会重新扫描硬盘）。"
                />
              ) : null}
            </Space>
          ) : null}
        </Card>

        <Card title="回收站状态">
          {recycle ? (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Alert
                type={recycle.available ? 'success' : 'warning'}
                showIcon
                message={recycle.available ? 'Windows 回收站可用' : COPY.recycleBinUnavailable}
                description={recycle.reason ?? '删除的文件会先进入回收站，清空回收站后才会释放空间。'}
              />
              {recycle.drives.length > 0 ? (
                <Descriptions column={1} size="small" bordered>
                  {recycle.drives.map((drive) => (
                    <Descriptions.Item key={drive.drive} label={`${drive.drive} 回收站`}>
                      {drive.available ? (
                        <span>
                          可接收文件
                          {drive.maxCapacityBytes > 0
                            ? `，单文件上限约 ${formatBytes(drive.maxCapacityBytes)}`
                            : ''}
                        </span>
                      ) : (
                        <Typography.Text type="warning">
                          {drive.reason || '不可用'}
                        </Typography.Text>
                      )}
                    </Descriptions.Item>
                  ))}
                </Descriptions>
              ) : null}
            </Space>
          ) : (
            <Typography.Text type="secondary">正在读取回收站状态…</Typography.Text>
          )}
        </Card>

        <Card title="长路径回收区" className="settings-long-trash">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Paragraph type="secondary" className="panel-note">
              Windows 回收站无法接收路径超过 260 字符的文件。这类文件删除时会移动到所在硬盘的软件回收区，
              不会被永久删除。还原后会回到原路径。
            </Typography.Paragraph>
            {longTrash === null ? (
              <Typography.Text type="secondary">正在读取…</Typography.Text>
            ) : longEntries.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="回收区是空的" />
            ) : (
              <>
                <Typography.Text type="secondary">
                  共 {formatCount(longEntries.length)} 个文件，占用{' '}
                  {formatBytes(longTrash.totalBytes)}，仍占用所在硬盘空间。
                </Typography.Text>
                <List
                  size="small"
                  bordered
                  dataSource={longEntries}
                  renderItem={(entry) => (
                    <List.Item
                      className="settings-long-trash-row"
                      actions={[
                        <Button
                          key="locate"
                          size="small"
                          onClick={() => void window.api.showItemInFolder(entry.storedPath)}
                        >
                          打开位置
                        </Button>,
                        <Button
                          key="restore"
                          size="small"
                          type="primary"
                          loading={restoringLongId === entry.id}
                          onClick={() => handleRestoreLongTrash(entry.id, entry.name)}
                        >
                          还原
                        </Button>,
                      ]}
                    >
                      <List.Item.Meta
                        title={entry.name}
                        description={
                          <Space direction="vertical" size={2} style={{ width: '100%' }}>
                            <Typography.Text type="secondary" ellipsis className="selectable-text">
                              {entry.originalPath}
                            </Typography.Text>
                            <Typography.Text type="secondary">
                              {formatDateTime(entry.deletedAt)} · {formatBytes(entry.size)}
                            </Typography.Text>
                          </Space>
                        }
                      />
                    </List.Item>
                  )}
                />
              </>
            )}
          </Space>
        </Card>

        <Card
          title="备份与数据"
          extra={
            <Space>
              <Button onClick={() => void handleCreateBackup()} loading={backupBusy}>
                立即备份
              </Button>
              <Button
                icon={<FolderOpenOutlined />}
                disabled={!appInfo?.backupDir}
                onClick={() => void openFolder(appInfo?.backupDir)}
              >
                打开备份目录
              </Button>
            </Space>
          }
        >
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="数据目录">
                <Space>
                  <Typography.Text copyable={{ text: appInfo?.dataDir }} className="selectable-text">
                    {appInfo?.dataDir ?? '加载中'}
                  </Typography.Text>
                  <Button
                    type="link"
                    size="small"
                    icon={<FolderOpenOutlined />}
                    disabled={!appInfo?.dataDir}
                    onClick={() => void openFolder(appInfo?.dataDir)}
                  >
                    打开
                  </Button>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="索引大小">
                {dataInfo ? formatBytes(dataInfo.dbSizeBytes) : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="数据说明">{COPY.dataLocalNote}</Descriptions.Item>
            </Descriptions>

            <div>
              <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
                <Typography.Text strong>自动备份（最近 {backups.length} 份）</Typography.Text>
                <Typography.Text type="secondary" className="panel-note">
                  恢复备份会重启软件，当前数据会先自动备份
                </Typography.Text>
              </Space>
              {backups.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="还没有备份，可点击“立即备份”创建"
                />
              ) : (
                <List
                  size="small"
                  bordered
                  dataSource={backups}
                  renderItem={(backup) => (
                    <List.Item
                      actions={[
                        <Button
                          key="restore"
                          size="small"
                          danger
                          loading={restoringPath === backup.path}
                          onClick={() => handleRestore(backup)}
                        >
                          恢复
                        </Button>,
                      ]}
                    >
                      <List.Item.Meta
                        title={backup.fileName}
                        description={`${formatDateTime(backup.createdAt)} · ${formatBytes(
                          backup.sizeBytes,
                        )}${backup.settingsPath ? ' · 含设置' : ''}`}
                      />
                    </List.Item>
                  )}
                />
              )}
            </div>

            <Alert
              type="warning"
              showIcon
              message="清空扫描数据"
              description="删除扫描索引、文件列表和重复文件结果。设置、备份以及磁盘上的文件都不会被改动。清空前会自动创建备份。"
              action={
                <Button
                  danger
                  disabled={scanning || !dataInfo}
                  onClick={() => {
                    setClearAccepted(false);
                    setClearOpen(true);
                  }}
                >
                  清空数据
                </Button>
              }
            />
          </Space>
        </Card>

        <Card title="关于">
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="版本">{appInfo?.version ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="运行环境">
              Electron {appInfo?.electron ?? '—'} · Node {appInfo?.node ?? '—'}
            </Descriptions.Item>
            <Descriptions.Item label="平台">{appInfo?.platform ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="联网">不需要，软件在本机离线运行</Descriptions.Item>
          </Descriptions>
          <Space wrap style={{ marginTop: 12 }}>
            {recycle?.available ? <Tag color="green">回收站可用</Tag> : <Tag color="red">回收站不可用</Tag>}
            <Tag color="blue">数据仅保存在本机</Tag>
          </Space>
        </Card>
      </Space>

      <Modal
        open={clearOpen}
        title="清空扫描数据？"
        okText="清空数据"
        cancelText={COPY.cancelAction}
        okButtonProps={{ danger: true, disabled: !clearAccepted, loading: clearing }}
        onOk={() => void handleClear()}
        onCancel={() => setClearOpen(false)}
        maskClosable={false}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message="清空后需要重新扫描才能查看文件"
            description="只会删除软件内的索引数据；设置、备份和磁盘上的文件不受影响。清空前会自动创建一份备份，可通过“自动备份”列表恢复。"
          />
          <Checkbox
            checked={clearAccepted}
            onChange={(event) => setClearAccepted(event.target.checked)}
          >
            我了解清空后需要重新扫描，并已确认保留备份
          </Checkbox>
        </Space>
      </Modal>
    </div>
  );
}
