import { useLayoutEffect, useMemo } from 'react';
import { App as AntApp, ConfigProvider, theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { getTheme } from '@shared/themes';
import App from '../App';
import { useAppStore } from '../store/useAppStore';
import { antdThemeComponents, antdThemeTokens, applyTheme, readCachedTheme } from '../lib/theme';

export default function ThemeRoot(): React.JSX.Element {
  const themeId = useAppStore((state) => state.settings?.theme ?? readCachedTheme());
  const skin = getTheme(themeId);

  useLayoutEffect(() => {
    applyTheme(skin);
  }, [skin]);

  const config = useMemo<ThemeConfig>(
    () => ({
      algorithm: skin.mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: antdThemeTokens(skin),
      components: antdThemeComponents(skin),
    }),
    [skin],
  );

  return (
    <ConfigProvider locale={zhCN} theme={config}>
      <AntApp message={{ maxCount: 3 }}>
        <App />
      </AntApp>
    </ConfigProvider>
  );
}
