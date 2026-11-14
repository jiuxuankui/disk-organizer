import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Input,
  List,
  Progress,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import { FolderOpenOutlined, PlusOutlined } from '@ant-design/icons';
import { VIDEO_QUALITIES, type VideoQuality, type VideoState } from '@shared/video';
import { formatBytes } from '@shared/format';
import PageHeader from '../components/PageHeader';
import { describeError, useAppStore } from '../store/useAppStore';

export default function VideoPage(): React.JSX.Element {
  const [paths, setPaths] = useState<string[]>([]);
  const [outputDir, setOutputDir] = useState('');
  const [quality, setQuality] = useState<VideoQuality>('quality');
  const [state, setState] = useState<VideoState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const openInExplorer = useAppStore((store) => store.openInExplorer);
  const { message } = App.useApp();
  const running = state?.status === 'running' || state?.status === 'cancelling';
  const locked = pending || running || state === null;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.api.getVideoState();
        if (!disposed) setState(next);
      } catch (cause) {
        if (!disposed) setError(describeError(cause));
      } finally {
        if (!disposed)
          timer = setTimeout(() => {
            void refresh();
          }, 500);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);

  async function selectFiles(): Promise<void> {
    try {
      const selected = await window.api.selectVideoFiles();
      setPaths((previous) => [...new Set([...previous, ...selected])]);
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  async function selectOutput(): Promise<void> {
    try {
      const selected = await window.api.selectVideoOutputDir();
      if (selected) setOutputDir(selected);
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  async function start(): Promise<void> {
    setPending(true);
    setError('');
    try {
      setState(await window.api.startVideo({ paths, outputDir, quality }));
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  }

  async function cancel(): Promise<void> {
    try {
      setState(await window.api.cancelVideo());
    } catch (cause) {
      void message.error(describeError(cause));
    }
  }

  return (
    <div className="video-page">
      <PageHeader title="视频压缩" subtitle="离线 H.265 编码 · 质量优先 · 原文件始终保留" />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="压缩的是体积，不是分辨率"
          description="不主动降低分辨率或帧率，音轨、字幕和附件直接保留，输出为 MKV。重编码是有损的，不能保证码率不变或一定缩小；若输出更大则不保留。HDR、杜比视界及旋转视频暂不处理，以避免丢失画质信息。"
        />
        {error ? <Alert type="error" showIcon message={error} /> : null}
        <Card
          title="1. 选择视频"
          extra={
            <Button
              icon={<PlusOutlined aria-hidden />}
              disabled={locked}
              onClick={() => void selectFiles()}
            >
              添加视频
            </Button>
          }
        >
          {paths.length ? (
            <List
              size="small"
              dataSource={paths}
              renderItem={(file) => (
                <List.Item
                  actions={[
                    <Button
                      key="remove"
                      type="text"
                      disabled={locked}
                      onClick={() => setPaths((items) => items.filter((item) => item !== file))}
                    >
                      移出列表
                    </Button>,
                  ]}
                >
                  <Typography.Text className="video-path">{file}</Typography.Text>
                </List.Item>
              )}
            />
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="不需要先扫描，直接添加本地视频"
            />
          )}
        </Card>
        <Card title="2. 输出与画质">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                aria-label="视频输出文件夹"
                value={outputDir}
                readOnly
                placeholder="选择输出文件夹，不覆盖已有文件"
              />
              <Button
                icon={<FolderOpenOutlined aria-hidden />}
                disabled={locked}
                onClick={() => void selectOutput()}
              >
                选择文件夹
              </Button>
            </Space.Compact>
            <Space wrap>
              <Typography.Text>压缩策略</Typography.Text>
              <Select
                aria-label="视频画质"
                value={quality}
                disabled={locked}
                style={{ width: 280 }}
                onChange={setQuality}
                options={Object.entries(VIDEO_QUALITIES).map(([value, item]) => ({
                  value,
                  label: item.label,
                }))}
              />
            </Space>
            <Typography.Text type="secondary">
              慢速编码换取更好的压缩率，逐个处理以减少硬盘争用。同名输出自动编号，取消只清理本次临时文件。
            </Typography.Text>
            <Space>
              <Button
                type="primary"
                aria-label="开始压缩"
                aria-busy={pending}
                loading={pending}
                disabled={locked || paths.length === 0 || !outputDir}
                onClick={() => void start()}
              >
                开始压缩
              </Button>
              {running ? (
                <Button disabled={state?.status === 'cancelling'} onClick={() => void cancel()}>
                  {state?.status === 'cancelling' ? '正在停止' : '停止压缩'}
                </Button>
              ) : null}
            </Space>
          </Space>
        </Card>
        {state && state.status !== 'idle' ? (
          <Card
            title={
              running ? '压缩进度' : state.status === 'cancelled' ? '任务已取消' : '任务已结束'
            }
            className="video-results"
          >
            <Typography.Text>
              已处理 {state.processed} / {state.total} 个视频
            </Typography.Text>
            {running ? (
              <>
                <div className="video-path">{state.currentPath}</div>
                <Progress percent={state.percent} status="active" />
              </>
            ) : null}
            <List
              dataSource={state.results}
              renderItem={(result, index) => (
                <List.Item
                  key={`${result.path}-${index}`}
                  actions={
                    result.outputPath
                      ? [
                          <Button
                            key="open"
                            onClick={() => void openInExplorer(result.outputPath!)}
                          >
                            打开位置
                          </Button>,
                        ]
                      : []
                  }
                >
                  <List.Item.Meta
                    title={
                      <>
                        <Tag
                          color={
                            result.status === 'completed'
                              ? 'green'
                              : result.status === 'failed'
                                ? 'red'
                                : 'default'
                          }
                        >
                          {result.status === 'completed'
                            ? '已压缩'
                            : result.status === 'failed'
                              ? '失败'
                              : result.status === 'cancelled'
                                ? '已取消'
                                : '未缩小'}
                        </Tag>
                        <span className="video-path">{result.path}</span>
                      </>
                    }
                    description={
                      <>
                        <div className="video-path">{result.message}</div>
                        {result.outputPath ? (
                          <>
                            <div>
                              {formatBytes(result.inputBytes)} → {formatBytes(result.outputBytes)}
                              ，减少 {formatBytes(result.inputBytes - result.outputBytes)}
                              （原文件仍占空间）
                            </div>
                            <div className="video-path">{result.outputPath}</div>
                          </>
                        ) : null}
                      </>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        ) : null}
      </Space>
    </div>
  );
}
