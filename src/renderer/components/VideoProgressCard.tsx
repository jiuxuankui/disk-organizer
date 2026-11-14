import { Card, Progress, Space, Tag, Typography } from 'antd';
import { VIDEO_PHASE_LABELS, overallVideoPercent, type VideoState } from '@shared/video';
import { formatDuration } from '@shared/format';
import { useElapsed } from '../lib/useElapsed';

interface VideoProgressCardProps {
  state: VideoState;
  running: boolean;
}

export default function VideoProgressCard({
  state,
  running,
}: VideoProgressCardProps): React.JSX.Element {
  const elapsed = useElapsed(state.startedAt, running);
  const fileElapsed = useElapsed(state.fileStartedAt, running);
  const current = state.processed + (running ? 1 : 0);
  const overall = overallVideoPercent(state);
  const stats = [
    state.phase !== 'idle' ? VIDEO_PHASE_LABELS[state.phase] : '',
    state.fps ? `${Math.round(state.fps)} 帧/秒` : '',
    state.speed ? `${state.speed.toFixed(2)}× 实时` : '',
  ].filter(Boolean);

  return (
    <Card
      title={
        <Space>
          <span>{running ? '压缩进行中' : '压缩任务'}</span>
          <Tag color={state.status === 'cancelling' ? 'orange' : 'processing'}>
            {state.processed} / {state.total}
          </Tag>
        </Space>
      }
      className="video-progress"
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <div className="video-progress-row">
          <Typography.Text strong>总进度</Typography.Text>
          <Typography.Text aria-live="polite">{overall}%</Typography.Text>
        </div>
        <Progress
          percent={overall}
          status={state.status === 'cancelling' ? 'exception' : 'active'}
          size={{ height: 12 }}
          aria-label="视频压缩总进度"
        />
        <div className="video-progress-row">
          <Typography.Text strong>
            第 {Math.max(1, current)} / {state.total} 个
          </Typography.Text>
          <Typography.Text>{state.percent}%</Typography.Text>
        </div>
        <Progress
          percent={state.percent}
          status={state.status === 'cancelling' ? 'exception' : 'active'}
          showInfo={false}
          aria-label="当前视频压缩进度"
        />
        <div className="video-path">{state.currentPath}</div>
        <Typography.Text type="secondary">
          {stats.join(' · ') || '正在准备编码'}
          {elapsed > 0 ? ` · 已用时 ${formatDuration(elapsed)}` : ''}
          {state.etaSeconds !== null
            ? ` · 预计还需 ${formatDuration(state.etaSeconds * 1000)}`
            : ''}
          {fileElapsed > 60_000 ? ' · 大文件编码较慢，软件未卡死' : ''}
        </Typography.Text>
      </Space>
    </Card>
  );
}
