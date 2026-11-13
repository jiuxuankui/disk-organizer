import { Popover, Typography } from 'antd';
import type { SkippedSummary, SkipReason } from '@shared/types';

const REASON_LABELS: Record<SkipReason, string> = {
  permission: '权限不足',
  excluded: '已排除的目录',
  hidden: '隐藏文件',
  system: '系统文件',
  special: '链接或特殊文件',
  error: '读取失败',
};

interface SkippedDetailsProps {
  skipped: SkippedSummary[];
  total: number;
}

export default function SkippedDetails({
  skipped,
  total,
}: SkippedDetailsProps): React.JSX.Element {
  const content = (
    <div className="skipped-details">
      {skipped.map((item) => (
        <div key={item.reason} className="skipped-reason">
          <div className="skipped-reason-head">
            <strong>{REASON_LABELS[item.reason] ?? item.reason}</strong>
            <span>{item.count.toLocaleString('zh-CN')} 个</span>
          </div>
          {item.samples.slice(0, 3).map((sample) => (
            <Typography.Text
              key={sample}
              type="secondary"
              className="skipped-sample selectable-text"
              ellipsis={{ tooltip: sample }}
            >
              {sample}
            </Typography.Text>
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <Popover content={content} title="未统计文件的原因" placement="bottomRight" trigger="click">
      <Typography.Link>查看原因（共 {total.toLocaleString('zh-CN')} 个）</Typography.Link>
    </Popover>
  );
}
