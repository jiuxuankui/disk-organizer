import {
  DEFAULT_THEME,
  isThemeId,
  themeCssVariables,
  type ThemeId,
  type ThemeSkin,
} from '@shared/themes';

const THEME_CACHE_KEY = 'disk-organizer-theme';

export function readCachedTheme(): ThemeId {
  try {
    const value = window.localStorage.getItem(THEME_CACHE_KEY);
    return isThemeId(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(skin: ThemeSkin): void {
  const root = document.documentElement;
  root.dataset.theme = skin.id;
  root.style.colorScheme = skin.mode;
  for (const [name, value] of Object.entries(themeCssVariables(skin))) {
    root.style.setProperty(name, value);
  }
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, skin.id);
  } catch {
    // Theme still applies for this session when storage is unavailable.
  }
}

export function antdThemeTokens(skin: ThemeSkin): Record<string, string | number> {
  const palette = skin.palette;
  return {
    colorPrimary: palette.accent,
    colorInfo: palette.accent,
    colorSuccess: palette.success,
    colorWarning: palette.warning,
    colorError: palette.danger,
    colorBgBase: palette.appBg,
    colorBgLayout: palette.appBg,
    colorBgContainer: palette.surfaceBg,
    colorBgElevated: palette.surfaceBg,
    colorText: palette.textPrimary,
    colorTextSecondary: palette.textSecondary,
    colorTextTertiary: palette.textTertiary,
    colorBorder: palette.borderColor,
    colorBorderSecondary: palette.borderColor,
    borderRadius: skin.radius.control,
    borderRadiusLG: skin.radius.card,
    fontFamily: skin.fontFamily,
    boxShadow: skin.shadow.soft,
    boxShadowSecondary: skin.shadow.medium,
  };
}

export function antdThemeComponents(skin: ThemeSkin): Record<string, Record<string, string>> {
  const palette = skin.palette;
  return {
    Layout: {
      siderBg: palette.sidebarBg,
      bodyBg: palette.appBg,
      headerBg: palette.appBg,
    },
    Menu: {
      itemBg: 'transparent',
      subMenuItemBg: 'transparent',
      itemColor: palette.textPrimary,
      itemSelectedColor: palette.accent,
      itemSelectedBg: palette.accentSoft,
      itemHoverBg: palette.surfaceHover,
      itemHoverColor: palette.textPrimary,
    },
    Table: {
      headerBg: palette.surfaceMuted,
      headerColor: palette.textSecondary,
      rowHoverBg: palette.surfaceSubtle,
      borderColor: palette.borderColor,
    },
    Card: {
      colorBgContainer: palette.surfaceBg,
    },
    Modal: {
      contentBg: palette.surfaceBg,
      headerBg: palette.surfaceBg,
    },
    Select: {
      optionSelectedBg: palette.accentSoft,
    },
    Dropdown: {
      colorBgElevated: palette.surfaceBg,
    },
  };
}
