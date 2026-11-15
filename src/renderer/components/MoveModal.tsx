import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Input, List, Modal, Progress, Space, Typography } from 'antd';
import type { MovePreview, OrganizeState } from '@shared/organize';
import { formatBytes, formatCount } from '@shared/format';
import { describeError, useAppStore } from '../store/useAppStore';
import { useBackClose } from '../lib/back';

export interface MoveSelection {
  fileIds: number[];
  folderPaths: string[];
}

export default function MoveModal({
  selection,
  onClose,
  onMoved,
}: {
  selection: MoveSelection;
  onClose(): void;
  onMoved(): void;
}): React.JSX.Element {
  const [targetDir, setTargetDir] = useState('');
  const [preview, setPreview] = useState<MovePreview | null>(null);
  const [state, setState] = useState<OrganizeState | null>(null);
  const [pending, setPending] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [crossConfirmed, setCrossConfirmed] = useState(false);
  const [error, setError] = useState('');
  const openInExplorer = useAppStore((store) => store.openInExplorer);
  const onMovedRef = useRef(onMoved);
  onMovedRef.current = onMoved;
  const settledRef = useRef(false);
  const running = state?.status === 'running' || state?.status === 'cancelling';
  const locked = pending || running;
  useBackClose(!locked, onClose);

  useEffect(() => {
    if (!tracking) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (): Promise<void> => {
      try {
        const next = await window.api.getMoveState();
        if (disposed) return;
        setState(next);
        if (next.status === 'running' || next.status === 'cancelling') {
          timer = setTimeout(() => void tick(), 300);
          return;
        }
        setTracking(false);
        if (!settledRef.current) {
          settledRef.current = true;
          onMovedRef.current();
        }
      } catch (cause) {
        if (!disposed) setError(describeError(cause));
      }
    };
    void tick();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [tracking]);

  async function loadPreview(directory: string): Promise<void> {
    setPending(true);
    setError('');
    setCrossConfirmed(false);
    try {
      setPreview(
        await window.api.previewMove({
          fileIds: selection.fileIds,
          folderPaths: selection.folderPaths,
          targetDir: directory,
        }),
      );
    } catch (cause) {
      setPreview(null);
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  }

  async function chooseTarget(): Promise<void> {
    if (locked) return;
    try {
      const directory = await window.api.selectMoveDirectory();
      if (!directory) return;
      setTargetDir(directory);
      await loadPreview(directory);
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  async function start(): Promise<void> {
    if (!preview || preview.movableCount === 0 || locked) return;
    setPending(true);
    setError('');
    try {
      settledRef.current = false;
      setState(
        await window.api.startMove({
          token: preview.token,
          confirmCrossDrive: crossConfirmed,
        }),
      );
      setTracking(true);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  }

  async function stop(): Promise<void> {
    try {
      setState(await window.api.cancelMove());
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  const blocked = preview?.items.filter((item) => !item.allowed) ?? [];
  const cleaned = state?.cleanup?.cleaned ?? 0;
  const cleanupFailures = state?.cleanup?.failed ?? [];

  return (
    <Modal
      open
      title="移动到文件夹"
      width={720}
      onCancel={locked ? undefined : onClose}
      closable={!locked}
      maskClosable={false}
      keyboard={!locked}
      footer={
        running
          ? [
              <Button key="close" aria-label="关闭移动窗口" onClick={onClose} disabled>
                关闭
              </Button>,
              <Button
                key="stop"
                disabled={state?.status === 'cancelling'}
                onClick={() => void stop()}
              >
                停止移动
              </Button>,
            ]
          : state
            ? [
                <Button key="close" aria-label="关闭移动窗口" onClick={onClose}>
                  关闭
                </Button>,
              ]
            : [
                <Button key="close" aria-label="关闭移动窗口" onClick={onClose}>
                  关闭
                </Button>,
                <Button
                  key="start"
                  type="primary"
                  aria-label="确认开始移动"
                  loading={pending}
                  disabled={
                    pending ||
                    !preview ||
                    preview.movableCount === 0 ||
                    (preview.crossDriveCount > 0 && !crossConfirmed)
                  }
                  onClick={() => void start()}
                >
                  确认开始移动
                </Button>,
              ]
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {!state ? (
          <Alert
            type="info"
            showIcon
            message="移动后不会留下空的来源文件夹"
            description="因此变空的来源文件夹会自动放入回收站，可在回收站还原。跨盘移动文件需要单独勾选确认；文件夹不支持跨盘移动。"
          />
        ) : null}
        {error ? <Alert type="error" showIcon message={error} /> : null}
        {!state ? (
          <>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                aria-label="移动目标文件夹"
                value={targetDir}
                readOnly
                placeholder="选择目标文件夹后生成移动预览"
              />
              <Button disabled={locked} onClick={() => void chooseTarget()}>
                选择目标文件夹
              </Button>
            </Space.Compact>
            {preview ? (
              <>
                <Typography.Text>
                  已选择 {formatCount(preview.fileCount)} 个文件、{formatCount(preview.folderCount)}{' '}
                  个文件夹；可移动 {formatCount(preview.movableCount)} 项，合计{' '}
                  {formatBytes(preview.totalBytes)}
                </Typography.Text>
                {preview.crossDriveCount > 0 ? (
                  <Alert
                    type="warning"
                    showIcon
                    message={`其中 ${formatCount(preview.crossDriveCount)} 个文件需要跨盘移动`}
                    description={
                      <Checkbox
                        checked={crossConfirmed}
                        onChange={(event) => setCrossConfirmed(event.target.checked)}
                      >
                        我确认跨盘移动，并保留可恢复原件
                      </Checkbox>
                    }
                  />
                ) : null}
                {blocked.length > 0 ? (
                  <Alert
                    type="warning"
                    showIcon
                    message={`${formatCount(preview.blockedCount)} 项无法移动，开始后将跳过`}
                    description={
                      <Space direction="vertical" size={4} style={{ width: '100%' }}>
                        {blocked.slice(0, 10).map((item) => (
                          <Typography.Text
                            key={`${item.kind}:${item.id}:${item.source}`}
                            style={{ overflowWrap: 'anywhere' }}
                          >
                            {item.source}：{item.message}
                          </Typography.Text>
                        ))}
                        {blocked.length > 10 ? (
                          <Typography.Text type="secondary">
                            另有 {formatCount(blocked.length - 10)} 项未显示
                          </Typography.Text>
                        ) : null}
                      </Space>
                    }
                  />
                ) : null}
              </>
            ) : null}
          </>
        ) : (
          <>
            <Alert
              type={
                state.status === 'completed'
                  ? 'success'
                  : state.status === 'cancelled'
                    ? 'warning'
                    : 'info'
              }
              message={
                running
                  ? state.status === 'cancelling'
                    ? '正在停止，等待当前操作安全结束'
                    : '正在移动'
                  : state.status === 'cancelled'
                    ? '已停止移动，已完成的移动保留'
                    : '移动任务结束'
              }
            />
            <Progress
              percent={state.total ? Math.floor((state.processed / state.total) * 100) : 0}
            />
            <Typography.Paragraph>
              已处理 {formatCount(state.processed)} / {formatCount(state.total)} · 成功{' '}
              {formatCount(state.results.filter((item) => item.status === 'moved').length)}
            </Typography.Paragraph>
            {cleaned > 0 ? (
              <Alert
                type="success"
                showIcon
                message={`已自动清理 ${formatCount(cleaned)} 个因移动变空的来源文件夹（已放入回收站，可还原）`}
              />
            ) : null}
            {cleanupFailures.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={`有 ${formatCount(cleanupFailures.length)} 个空文件夹未能自动清理`}
                description={
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    {cleanupFailures.map((item) => (
                      <Typography.Text
                        key={`${item.path}:${item.reason}`}
                        style={{ overflowWrap: 'anywhere' }}
                      >
                        {item.path ? `${item.path}：` : ''}
                        {item.reason}
                      </Typography.Text>
                    ))}
                  </Space>
                }
              />
            ) : null}
            <Typography.Paragraph style={{ overflowWrap: 'anywhere' }}>
              {state.currentPath}
            </Typography.Paragraph>
            <List
              dataSource={state.results}
              pagination={{ pageSize: 10 }}
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
                        onClick={() => void openInExplorer(item.target)}
                      >
                        {item.target}
                      </Button>
                    ) : null}
                  </Space>
                </List.Item>
              )}
            />
          </>
        )}
      </Space>
    </Modal>
  );
}
