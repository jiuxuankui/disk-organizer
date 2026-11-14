export const THEME_IDS = [
  'classic',
  'macos-light',
  'macos-dark',
  'ios-light',
  'ios-dark',
  'glass',
  'graphite',
  'midnight',
  'sand',
  'vibrant',
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeId = 'classic';

export interface ThemePalette {
  appBg: string;
  appBgImage?: string;
  sidebarBg: string;
  surfaceBg: string;
  surfaceMuted: string;
  surfaceSubtle: string;
  surfaceHover: string;
  surfaceInset: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  borderColor: string;
  borderStrong: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
  accentBorder: string;
  accentContrast: string;
  danger: string;
  dangerSoft: string;
  dangerBorder: string;
  success: string;
  successSoft: string;
  warning: string;
}

export interface ThemeSkin {
  id: ThemeId;
  name: string;
  description: string;
  mode: 'light' | 'dark';
  palette: ThemePalette;
  radius: { card: number; control: number };
  fontFamily: string;
  shadow: { soft: string; medium: string };
  blur?: { sidebar?: string; panel?: string };
}

const APPLE_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const DEFAULT_FONT =
  '"Microsoft YaHei UI", "Microsoft YaHei", -apple-system, "Segoe UI", sans-serif';

const CLASSIC: ThemeSkin = {
  id: 'classic',
  name: '经典蓝',
  description: '保持现有的清爽蓝色界面',
  mode: 'light',
  fontFamily: DEFAULT_FONT,
  radius: { card: 12, control: 8 },
  shadow: {
    soft: '0 8px 20px rgba(15, 23, 42, 0.08)',
    medium: '0 16px 40px rgba(15, 23, 42, 0.18)',
  },
  palette: {
    appBg: '#f4f6f9',
    sidebarBg: '#ffffff',
    surfaceBg: '#ffffff',
    surfaceMuted: '#fafbfc',
    surfaceSubtle: '#f6f8fb',
    surfaceHover: '#f0f7ff',
    surfaceInset: '#eef1f5',
    textPrimary: '#1f2329',
    textSecondary: '#6b7280',
    textTertiary: '#98a2b3',
    borderColor: '#e5e7eb',
    borderStrong: '#b8bfc9',
    accent: '#1677ff',
    accentHover: '#4096ff',
    accentSoft: '#e6f4ff',
    accentBorder: '#91caff',
    accentContrast: '#ffffff',
    danger: '#cf1322',
    dangerSoft: '#fff1f0',
    dangerBorder: '#ffa39e',
    success: '#52c41a',
    successSoft: '#f6ffed',
    warning: '#faad14',
  },
};

const MACOS_LIGHT: ThemeSkin = {
  id: 'macos-light',
  name: 'macOS 浅色',
  description: '系统灰底、半透明侧边栏与系统蓝',
  mode: 'light',
  fontFamily: APPLE_FONT,
  radius: { card: 14, control: 10 },
  shadow: {
    soft: '0 1px 2px rgba(0, 0, 0, 0.04), 0 8px 24px rgba(0, 0, 0, 0.06)',
    medium: '0 16px 40px rgba(0, 0, 0, 0.12)',
  },
  blur: { sidebar: 'saturate(180%) blur(20px)' },
  palette: {
    appBg: '#f5f5f7',
    sidebarBg: 'rgba(255, 255, 255, 0.78)',
    surfaceBg: '#ffffff',
    surfaceMuted: '#f2f2f7',
    surfaceSubtle: '#f7f7fa',
    surfaceHover: '#eef5ff',
    surfaceInset: '#e9e9ee',
    textPrimary: '#1d1d1f',
    textSecondary: '#6e6e73',
    textTertiary: '#8e8e93',
    borderColor: 'rgba(60, 60, 67, 0.14)',
    borderStrong: 'rgba(60, 60, 67, 0.28)',
    accent: '#007aff',
    accentHover: '#3395ff',
    accentSoft: 'rgba(0, 122, 255, 0.12)',
    accentBorder: 'rgba(0, 122, 255, 0.35)',
    accentContrast: '#ffffff',
    danger: '#ff3b30',
    dangerSoft: 'rgba(255, 59, 48, 0.12)',
    dangerBorder: 'rgba(255, 59, 48, 0.35)',
    success: '#34c759',
    successSoft: 'rgba(52, 199, 89, 0.12)',
    warning: '#ff9500',
  },
};

const MACOS_DARK: ThemeSkin = {
  id: 'macos-dark',
  name: 'macOS 深色',
  description: '深灰半透明侧边栏与夜间蓝',
  mode: 'dark',
  fontFamily: APPLE_FONT,
  radius: { card: 14, control: 10 },
  shadow: {
    soft: '0 1px 2px rgba(0, 0, 0, 0.4), 0 10px 30px rgba(0, 0, 0, 0.35)',
    medium: '0 20px 50px rgba(0, 0, 0, 0.5)',
  },
  blur: { sidebar: 'saturate(180%) blur(20px)' },
  palette: {
    appBg: '#1c1c1e',
    sidebarBg: 'rgba(28, 28, 30, 0.72)',
    surfaceBg: '#2c2c2e',
    surfaceMuted: '#232325',
    surfaceSubtle: '#2a2a2c',
    surfaceHover: '#3a3a3c',
    surfaceInset: '#3a3a3c',
    textPrimary: '#f5f5f7',
    textSecondary: '#a1a1a6',
    textTertiary: '#8e8e93',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderStrong: 'rgba(255, 255, 255, 0.24)',
    accent: '#0a84ff',
    accentHover: '#409cff',
    accentSoft: 'rgba(10, 132, 255, 0.2)',
    accentBorder: 'rgba(10, 132, 255, 0.45)',
    accentContrast: '#ffffff',
    danger: '#ff453a',
    dangerSoft: 'rgba(255, 69, 58, 0.18)',
    dangerBorder: 'rgba(255, 69, 58, 0.45)',
    success: '#30d158',
    successSoft: 'rgba(48, 209, 88, 0.18)',
    warning: '#ff9f0a',
  },
};

const IOS_LIGHT: ThemeSkin = {
  id: 'ios-light',
  name: 'iOS 浅色',
  description: '浅灰分组背景与更大的圆角白卡片',
  mode: 'light',
  fontFamily: APPLE_FONT,
  radius: { card: 16, control: 12 },
  shadow: {
    soft: '0 1px 2px rgba(0, 0, 0, 0.04), 0 10px 28px rgba(0, 0, 0, 0.05)',
    medium: '0 18px 44px rgba(0, 0, 0, 0.12)',
  },
  palette: {
    appBg: '#f2f2f7',
    sidebarBg: '#ffffff',
    surfaceBg: '#ffffff',
    surfaceMuted: '#f2f2f7',
    surfaceSubtle: '#f7f7fa',
    surfaceHover: '#eef5ff',
    surfaceInset: '#e5e5ea',
    textPrimary: '#000000',
    textSecondary: '#6e6e73',
    textTertiary: '#8e8e93',
    borderColor: 'rgba(60, 60, 67, 0.18)',
    borderStrong: 'rgba(60, 60, 67, 0.3)',
    accent: '#007aff',
    accentHover: '#3395ff',
    accentSoft: 'rgba(0, 122, 255, 0.12)',
    accentBorder: 'rgba(0, 122, 255, 0.35)',
    accentContrast: '#ffffff',
    danger: '#ff3b30',
    dangerSoft: 'rgba(255, 59, 48, 0.12)',
    dangerBorder: 'rgba(255, 59, 48, 0.35)',
    success: '#34c759',
    successSoft: 'rgba(52, 199, 89, 0.12)',
    warning: '#ff9500',
  },
};

const IOS_DARK: ThemeSkin = {
  id: 'ios-dark',
  name: 'iOS 深色',
  description: '纯黑背景与深灰卡片，夜间更柔和',
  mode: 'dark',
  fontFamily: APPLE_FONT,
  radius: { card: 16, control: 12 },
  shadow: {
    soft: '0 1px 2px rgba(0, 0, 0, 0.5), 0 10px 30px rgba(0, 0, 0, 0.4)',
    medium: '0 20px 50px rgba(0, 0, 0, 0.55)',
  },
  palette: {
    appBg: '#000000',
    sidebarBg: '#1c1c1e',
    surfaceBg: '#1c1c1e',
    surfaceMuted: '#2c2c2e',
    surfaceSubtle: '#242426',
    surfaceHover: '#2c2c2e',
    surfaceInset: '#3a3a3c',
    textPrimary: '#ffffff',
    textSecondary: 'rgba(235, 235, 245, 0.6)',
    textTertiary: 'rgba(235, 235, 245, 0.4)',
    borderColor: 'rgba(84, 84, 88, 0.55)',
    borderStrong: 'rgba(84, 84, 88, 0.8)',
    accent: '#0a84ff',
    accentHover: '#409cff',
    accentSoft: 'rgba(10, 132, 255, 0.2)',
    accentBorder: 'rgba(10, 132, 255, 0.45)',
    accentContrast: '#ffffff',
    danger: '#ff453a',
    dangerSoft: 'rgba(255, 69, 58, 0.18)',
    dangerBorder: 'rgba(255, 69, 58, 0.45)',
    success: '#30d158',
    successSoft: 'rgba(48, 209, 88, 0.18)',
    warning: '#ff9f0a',
  },
};

const GLASS: ThemeSkin = {
  id: 'glass',
  name: '磨砂玻璃',
  description: '半透明毛玻璃面板与柔和渐变背景',
  mode: 'light',
  fontFamily: APPLE_FONT,
  radius: { card: 18, control: 12 },
  shadow: {
    soft: '0 8px 30px rgba(30, 60, 120, 0.1)',
    medium: '0 20px 60px rgba(30, 60, 120, 0.18)',
  },
  blur: {
    sidebar: 'saturate(180%) blur(24px)',
    panel: 'saturate(160%) blur(18px)',
  },
  palette: {
    appBg: '#eef3fb',
    appBgImage: 'linear-gradient(135deg, #e8f0ff 0%, #f7ecff 45%, #e9fbf5 100%)',
    sidebarBg: 'rgba(255, 255, 255, 0.55)',
    surfaceBg: 'rgba(255, 255, 255, 0.68)',
    surfaceMuted: 'rgba(255, 255, 255, 0.5)',
    surfaceSubtle: 'rgba(255, 255, 255, 0.6)',
    surfaceHover: 'rgba(0, 122, 255, 0.1)',
    surfaceInset: 'rgba(120, 130, 150, 0.14)',
    textPrimary: '#1d1d1f',
    textSecondary: '#5f6368',
    textTertiary: '#8a8f98',
    borderColor: 'rgba(60, 60, 67, 0.16)',
    borderStrong: 'rgba(60, 60, 67, 0.3)',
    accent: '#007aff',
    accentHover: '#3395ff',
    accentSoft: 'rgba(0, 122, 255, 0.14)',
    accentBorder: 'rgba(0, 122, 255, 0.35)',
    accentContrast: '#ffffff',
    danger: '#ff3b30',
    dangerSoft: 'rgba(255, 59, 48, 0.14)',
    dangerBorder: 'rgba(255, 59, 48, 0.35)',
    success: '#34c759',
    successSoft: 'rgba(52, 199, 89, 0.16)',
    warning: '#ff9500',
  },
};

const GRAPHITE: ThemeSkin = {
  id: 'graphite',
  name: '石墨灰',
  description: '低饱和黑白灰，专注办公',
  mode: 'light',
  fontFamily: APPLE_FONT,
  radius: { card: 10, control: 8 },
  shadow: {
    soft: '0 1px 2px rgba(0, 0, 0, 0.05), 0 6px 18px rgba(0, 0, 0, 0.05)',
    medium: '0 14px 36px rgba(0, 0, 0, 0.14)',
  },
  palette: {
    appBg: '#f2f2f4',
    sidebarBg: '#e9e9ec',
    surfaceBg: '#ffffff',
    surfaceMuted: '#f7f7f8',
    surfaceSubtle: '#f0f0f2',
    surfaceHover: '#e8e8ec',
    surfaceInset: '#dedee3',
    textPrimary: '#1d1d1f',
    textSecondary: '#636366',
    textTertiary: '#8e8e93',
    borderColor: '#d6d6db',
    borderStrong: '#b0b0b8',
    accent: '#48484a',
    accentHover: '#5c5c5f',
    accentSoft: 'rgba(72, 72, 74, 0.12)',
    accentBorder: 'rgba(72, 72, 74, 0.35)',
    accentContrast: '#ffffff',
    danger: '#ff3b30',
    dangerSoft: 'rgba(255, 59, 48, 0.12)',
    dangerBorder: 'rgba(255, 59, 48, 0.35)',
    success: '#34c759',
    successSoft: 'rgba(52, 199, 89, 0.12)',
    warning: '#ff9500',
  },
};

const MIDNIGHT: ThemeSkin = {
  id: 'midnight',
  name: '午夜蓝',
  description: '深海军蓝背景与冷色高亮',
  mode: 'dark',
  fontFamily: APPLE_FONT,
  radius: { card: 12, control: 8 },
  shadow: {
    soft: '0 8px 24px rgba(0, 0, 0, 0.35)',
    medium: '0 18px 48px rgba(0, 0, 0, 0.5)',
  },
  palette: {
    appBg: '#0b1220',
    sidebarBg: '#101a2e',
    surfaceBg: '#16233b',
    surfaceMuted: '#121d31',
    surfaceSubtle: '#182742',
    surfaceHover: '#1c2d4d',
    surfaceInset: '#1e2f4d',
    textPrimary: '#e8eefc',
    textSecondary: '#9fb0c9',
    textTertiary: '#6f819d',
    borderColor: 'rgba(148, 163, 184, 0.22)',
    borderStrong: 'rgba(148, 163, 184, 0.4)',
    accent: '#5b8cff',
    accentHover: '#7aa2ff',
    accentSoft: 'rgba(91, 140, 255, 0.18)',
    accentBorder: 'rgba(91, 140, 255, 0.5)',
    accentContrast: '#ffffff',
    danger: '#ff6b6b',
    dangerSoft: 'rgba(255, 107, 107, 0.16)',
    dangerBorder: 'rgba(255, 107, 107, 0.45)',
    success: '#34d399',
    successSoft: 'rgba(52, 211, 153, 0.16)',
    warning: '#fbbf24',
  },
};

const SAND: ThemeSkin = {
  id: 'sand',
  name: '暖沙金',
  description: '米色与香槟金的温暖浅色界面',
  mode: 'light',
  fontFamily: APPLE_FONT,
  radius: { card: 14, control: 10 },
  shadow: {
    soft: '0 1px 2px rgba(80, 60, 30, 0.05), 0 8px 24px rgba(80, 60, 30, 0.06)',
    medium: '0 16px 40px rgba(80, 60, 30, 0.14)',
  },
  palette: {
    appBg: '#f7f1e7',
    sidebarBg: '#fffaf1',
    surfaceBg: '#fffdf8',
    surfaceMuted: '#f4ebdc',
    surfaceSubtle: '#f9f3e9',
    surfaceHover: '#f6ead6',
    surfaceInset: '#eadfcd',
    textPrimary: '#3b3328',
    textSecondary: '#7a6e5d',
    textTertiary: '#a2957e',
    borderColor: '#e4d8c3',
    borderStrong: '#c9b89b',
    accent: '#b07b32',
    accentHover: '#c08a3e',
    accentSoft: 'rgba(176, 123, 50, 0.14)',
    accentBorder: 'rgba(176, 123, 50, 0.4)',
    accentContrast: '#ffffff',
    danger: '#b3402f',
    dangerSoft: 'rgba(179, 64, 47, 0.12)',
    dangerBorder: 'rgba(179, 64, 47, 0.35)',
    success: '#5b8c3e',
    successSoft: 'rgba(91, 140, 62, 0.14)',
    warning: '#c98a1b',
  },
};

const VIBRANT: ThemeSkin = {
  id: 'vibrant',
  name: '活力渐变',
  description: '浅色底配多彩渐变高亮',
  mode: 'light',
  fontFamily: APPLE_FONT,
  radius: { card: 16, control: 10 },
  shadow: {
    soft: '0 1px 2px rgba(0, 0, 0, 0.03), 0 8px 24px rgba(80, 40, 120, 0.08)',
    medium: '0 18px 44px rgba(80, 40, 120, 0.16)',
  },
  palette: {
    appBg: '#f7f7fb',
    sidebarBg: '#ffffff',
    surfaceBg: '#ffffff',
    surfaceMuted: '#f2f2f7',
    surfaceSubtle: '#f7f7fb',
    surfaceHover: '#fff0f4',
    surfaceInset: '#ececf2',
    textPrimary: '#1d1d1f',
    textSecondary: '#6e6e73',
    textTertiary: '#8e8e93',
    borderColor: 'rgba(60, 60, 67, 0.14)',
    borderStrong: 'rgba(60, 60, 67, 0.28)',
    accent: '#ff2d55',
    accentHover: '#ff4d6d',
    accentSoft: 'rgba(255, 45, 85, 0.12)',
    accentBorder: 'rgba(255, 45, 85, 0.35)',
    accentContrast: '#ffffff',
    danger: '#ff3b30',
    dangerSoft: 'rgba(255, 59, 48, 0.12)',
    dangerBorder: 'rgba(255, 59, 48, 0.35)',
    success: '#34c759',
    successSoft: 'rgba(52, 199, 89, 0.12)',
    warning: '#ff9500',
  },
};

export const THEMES: readonly ThemeSkin[] = [
  CLASSIC,
  MACOS_LIGHT,
  MACOS_DARK,
  IOS_LIGHT,
  IOS_DARK,
  GLASS,
  GRAPHITE,
  MIDNIGHT,
  SAND,
  VIBRANT,
];

const THEME_BY_ID = new Map<ThemeId, ThemeSkin>(THEMES.map((skin) => [skin.id, skin]));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEME_BY_ID.has(value as ThemeId);
}

export function getTheme(id: string | null | undefined): ThemeSkin {
  return (id && THEME_BY_ID.get(id as ThemeId)) || CLASSIC;
}

export function themeCssVariables(skin: ThemeSkin): Record<string, string> {
  const palette = skin.palette;
  return {
    '--app-bg': palette.appBg,
    '--app-bg-image': palette.appBgImage ?? 'none',
    '--sidebar-bg': palette.sidebarBg,
    '--surface-bg': palette.surfaceBg,
    '--surface-muted': palette.surfaceMuted,
    '--surface-subtle': palette.surfaceSubtle,
    '--surface-hover': palette.surfaceHover,
    '--surface-inset': palette.surfaceInset,
    '--text-primary': palette.textPrimary,
    '--text-secondary': palette.textSecondary,
    '--text-tertiary': palette.textTertiary,
    '--border-color': palette.borderColor,
    '--border-strong': palette.borderStrong,
    '--accent': palette.accent,
    '--accent-hover': palette.accentHover,
    '--accent-soft': palette.accentSoft,
    '--accent-border': palette.accentBorder,
    '--accent-contrast': palette.accentContrast,
    '--danger': palette.danger,
    '--danger-soft': palette.dangerSoft,
    '--danger-border': palette.dangerBorder,
    '--success': palette.success,
    '--success-soft': palette.successSoft,
    '--warning': palette.warning,
    '--shadow-soft': skin.shadow.soft,
    '--shadow-medium': skin.shadow.medium,
    '--card-radius': `${skin.radius.card}px`,
    '--control-radius': `${skin.radius.control}px`,
    '--font-family': skin.fontFamily,
    '--table-header-bg': palette.surfaceMuted,
    '--table-row-hover': palette.surfaceSubtle,
    '--scrollbar-thumb': palette.borderStrong,
    '--scrollbar-thumb-hover': palette.textTertiary,
    '--sidebar-blur': skin.blur?.sidebar ?? 'none',
    '--panel-blur': skin.blur?.panel ?? 'none',
  };
}
