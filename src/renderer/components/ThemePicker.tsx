import { CheckOutlined } from '@ant-design/icons';
import { THEMES, type ThemeId } from '@shared/themes';

export interface ThemePickerProps {
  value: ThemeId;
  disabled?: boolean;
  onChange(theme: ThemeId): void;
}

export default function ThemePicker({
  value,
  disabled = false,
  onChange,
}: ThemePickerProps): React.JSX.Element {
  return (
    <div className="theme-grid" role="radiogroup" aria-label="界面风格">
      {THEMES.map((skin) => {
        const palette = skin.palette;
        const selected = skin.id === value;
        return (
          <button
            key={skin.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={skin.name}
            disabled={disabled}
            className={`theme-card${selected ? ' theme-card-selected' : ''}`}
            onClick={() => onChange(skin.id)}
          >
            <span
              className="theme-preview"
              style={{ background: palette.appBg, borderColor: palette.borderColor }}
              aria-hidden
            >
              <span className="theme-preview-sidebar" style={{ background: palette.sidebarBg }}>
                <span className="theme-preview-brand" style={{ background: palette.textPrimary }} />
                <span
                  className="theme-preview-nav theme-preview-nav-active"
                  style={{ background: palette.accentSoft }}
                />
                <span className="theme-preview-nav" style={{ background: palette.surfaceHover }} />
                <span className="theme-preview-nav" style={{ background: palette.surfaceHover }} />
              </span>
              <span className="theme-preview-main">
                <span
                  className="theme-preview-header"
                  style={{ background: palette.surfaceBg, borderColor: palette.borderColor }}
                />
                <span className="theme-preview-body">
                  <span
                    className="theme-preview-panel"
                    style={{ background: palette.surfaceBg, borderColor: palette.borderColor }}
                  >
                    <span className="theme-preview-line" style={{ background: palette.textPrimary }} />
                    <span
                      className="theme-preview-line theme-preview-line-short"
                      style={{ background: palette.textTertiary }}
                    />
                    <span className="theme-preview-rows">
                      <span style={{ background: palette.surfaceMuted }} />
                      <span style={{ background: palette.surfaceMuted }} />
                      <span style={{ background: palette.surfaceMuted }} />
                    </span>
                  </span>
                  <span className="theme-preview-button" style={{ background: palette.accent }}>
                    <span style={{ background: palette.accentContrast }} />
                  </span>
                </span>
              </span>
            </span>
            <span className="theme-card-meta">
              <span className="theme-card-name">
                {skin.name}
                {selected ? <CheckOutlined className="theme-card-check" /> : null}
              </span>
              <span className="theme-card-desc">{skin.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
