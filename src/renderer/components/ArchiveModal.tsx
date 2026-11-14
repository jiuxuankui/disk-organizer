import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Progress, Select, Space, Typography } from 'antd';
import type { ArchiveFormat, ArchiveState } from '@shared/archive';
import { formatBytes } from '@shared/format';
import { describeError, useAppStore } from '../store/useAppStore';

export default function ArchiveModal({
  fileIds,
  onClose,
}: {
  fileIds: number[];
  onClose(): void;
}): React.JSX.Element {
  const [outputDir, setOutputDir] = useState('');
  const [name, setName] = useState('文件打包');
  const [format, setFormat] = useState<ArchiveFormat>('zip');
  const [state, setState] = useState<ArchiveState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const openInExplorer = useAppStore((store) => store.openInExplorer);
  const running = state?.status === 'running' || state?.status === 'cancelling';
  const locked = pending || running || state === null;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.api.getArchiveState();
        if (!disposed) setState(next);
      } catch (cause) {
        if (!disposed) setError(describeError(cause));
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 500);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);

  async function chooseOutput(): Promise<void> {
    try {
      const directory = await window.api.selectArchiveOutputDir();
      if (directory) setOutputDir(directory);
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  async function start(): Promise<void> {
    setPending(true);
    setError('');
    try {
      setState(await window.api.startArchive({ fileIds, outputDir, name, format }));
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  }

  async function stop(): Promise<void> {
    try {
      setState(await window.api.cancelArchive());
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  return (
    <Modal
      open
      title="压缩打包"
      width={700}
      onCancel={locked ? undefined : onClose}
      closable={!locked}
      maskClosable={false}
      keyboard={!locked}
      footer={[
        <Button key="close" aria-label="关闭压缩打包" onClick={onClose} disabled={locked}>
          关闭
        </Button>,
        running ? (
          <Button key="stop" disabled={state?.status === 'cancelling'} onClick={() => void stop()}>
            停止打包
          </Button>
        ) : (
          <Button
            key="start"
            type="primary"
            aria-label="开始打包"
            loading={pending}
            disabled={locked || !outputDir || !name.trim() || fileIds.length === 0}
            onClick={() => void start()}
          >
            开始打包
          </Button>
        ),
      ]}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message={`已选择 ${fileIds.length} 个文件，原文件始终保留`}
          description="无损打包，解压后按盘符和原目录排列，避免同名文件冲突。同名压缩包自动编号；视频通常已压缩，打包不保证缩小体积。"
        />
        {error ? <Alert type="error" showIcon message={error} /> : null}
        <Space.Compact style={{ width: '100%' }}>
          <Input
            aria-label="压缩包输出文件夹"
            value={outputDir}
            readOnly
            placeholder="选择输出文件夹"
          />
          <Button disabled={locked} onClick={() => void chooseOutput()}>
            选择输出文件夹
          </Button>
        </Space.Compact>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            aria-label="压缩包名称"
            value={name}
            maxLength={120}
            disabled={locked}
            onChange={(event) => setName(event.target.value)}
          />
          <Select
            aria-label="压缩包格式"
            value={format}
            onChange={setFormat}
            disabled={locked}
            style={{ width: 170 }}
            options={[
              { value: 'zip', label: 'ZIP（通用）' },
              { value: 'tar.gz', label: 'TAR.GZ' },
            ]}
          />
        </Space.Compact>
        {state && state.status !== 'idle' ? (
          <div className="archive-result">
            <Alert
              type={
                state.status === 'failed'
                  ? 'error'
                  : state.status === 'completed'
                    ? 'success'
                    : 'info'
              }
              message={state.message}
            />
            <Typography.Text>
              已处理 {state.processed} / {state.total} 个文件
            </Typography.Text>
            <Progress
              percent={state.percent}
              status={state.status === 'failed' ? 'exception' : running ? 'active' : 'normal'}
            />
            {state.outputPath ? (
              <>
                <Typography.Paragraph style={{ overflowWrap: 'anywhere' }}>
                  {state.outputPath}（{formatBytes(state.outputBytes)}）
                </Typography.Paragraph>
                <Button onClick={() => void openInExplorer(state.outputPath!)}>
                  打开压缩包位置
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </Space>
    </Modal>
  );
}
