import { Empty, Tooltip, Typography } from 'antd';
import type { DriveOverview, FileTypeKey } from '@shared/types';
import { COPY } from '@shared/copy';
import { FILE_TYPES } from '@shared/fileTypes';
import { formatBytes } from '@shared/format';
import { distributePercents, formatPercent1 } from '@shared/percent';

interface TypeCompositionProps {
  drive: DriveOverview;
  onDrillType: (type: FileTypeKey) => void;
}

export default function TypeComposition({
  drive,
  onDrillType,
}: TypeCompositionProps): React.JSX.Element {
  const bytes = FILE_TYPES.map(
    (meta) => drive.typeUsage.find((item) => item.type === meta.key)?.bytes ?? 0,
  );
  const percents = distributePercents(bytes);
  const hasData = drive.identifiedBytes > 0;

  return (
    <section className="panel type-panel">
      <div className="panel-head">
        <div>
          <Typography.Title level={5} style={{ margin: 0 }}>
            {drive.drive} {drive.label || '本地磁盘'} · 占用构成
          </Typography.Title>
          <Typography.Text type="secondary" className="panel-note">
            {COPY.typeShareNote}，已识别 {formatBytes(drive.identifiedBytes)}
          </Typography.Text>
        </div>
      </div>

      {hasData ? (
        <div className="type-stack" role="img" aria-label="按文件类型的占用比例">
          {FILE_TYPES.map((meta, index) =>
            percents[index] > 0 ? (
              <Tooltip
                key={meta.key}
                title={`${meta.label} ${formatBytes(bytes[index])} · ${formatPercent1(percents[index])}`}
              >
                <span
                  className="type-stack-segment"
                  style={{ width: `${percents[index]}%`, background: meta.color }}
                />
              </Tooltip>
            ) : null,
          )}
        </div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这张盘还没有可统计的文件" />
      )}

      <div className="type-legend">
        {FILE_TYPES.map((meta, index) => {
          const count = drive.typeUsage.find((item) => item.type === meta.key)?.count ?? 0;
          return (
            <button
              key={meta.key}
              type="button"
              className={`type-chip${bytes[index] > 0 ? '' : ' type-chip-empty'}`}
              disabled={bytes[index] <= 0}
              onClick={() => onDrillType(meta.key)}
              title={`在全部文件中查看${meta.label}`}
            >
              <span className="type-dot" style={{ background: meta.color }} />
              <span className="type-chip-label">{meta.label}</span>
              <span className="type-chip-value">{formatBytes(bytes[index])}</span>
              <span className="type-chip-percent">
                {formatPercent1(percents[index])}
                {count > 0 ? ` · ${count.toLocaleString('zh-CN')} 个` : ''}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
