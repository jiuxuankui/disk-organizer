import { Tooltip } from 'antd';
import type { DriveOverview } from '@shared/types';
import { COPY } from '@shared/copy';
import { formatBytes, formatCount } from '@shared/format';
import { USAGE_COLORS, usageLevel, usagePercent } from '../lib/usage';

interface DriveCardsProps {
  drives: DriveOverview[];
  selected: string | null;
  onSelect: (drive: string) => void;
}

export default function DriveCards({
  drives,
  selected,
  onSelect,
}: DriveCardsProps): React.JSX.Element {
  return (
    <div className="drive-grid">
      {drives.map((drive) => {
        const used = Math.max(0, drive.totalBytes - drive.freeBytes);
        const percent = usagePercent(used, drive.totalBytes);
        const level = usageLevel(percent);
        return (
          <button
            key={drive.drive}
            type="button"
            className={[
              'drive-card',
              selected === drive.drive ? 'drive-card-selected' : '',
              drive.online ? '' : 'drive-card-offline',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-pressed={selected === drive.drive}
            onClick={() => onSelect(drive.drive)}
          >
            <div className="drive-card-head">
              <span className="drive-letter">{drive.drive}</span>
              <span className="drive-label" title={drive.label}>
                {drive.label || '本地磁盘'}
              </span>
              {drive.online ? null : <span className="drive-offline-tag">未连接</span>}
            </div>
            {drive.totalBytes > 0 ? (
              <>
                <div className="drive-usage-line">
                  <strong>{formatBytes(used)}</strong>
                  <span> / {formatBytes(drive.totalBytes)}</span>
                </div>
                <div className="usage-bar" role="presentation">
                  <span
                    className="usage-bar-fill"
                    style={{ width: `${percent}%`, background: USAGE_COLORS[level] }}
                  />
                </div>
                <div className="drive-free-line">
                  <span>可用 {formatBytes(drive.freeBytes)}</span>
                  <span>{Math.round(percent)}% 已用</span>
                </div>
              </>
            ) : (
              <div className="drive-usage-line drive-usage-unknown">容量未知</div>
            )}
            <div className="drive-identified-line">
              <span>已识别 {formatBytes(drive.identifiedBytes)}</span>
              <Tooltip title={COPY.unidentifiedTooltip}>
                <span className="drive-unidentified">
                  未识别 {formatBytes(drive.unidentifiedBytes)}
                </span>
              </Tooltip>
            </div>
            <div className="drive-count-line">{formatCount(drive.fileCount)} 个文件</div>
          </button>
        );
      })}
    </div>
  );
}
