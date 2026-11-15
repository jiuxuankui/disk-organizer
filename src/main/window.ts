import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { IPC } from '@shared/ipcChannels';

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f4f6f9',
    title: '硬盘整理',
    icon: app.isPackaged ? undefined : path.join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // 窗口被遮挡或最小化后，Chromium 可能丢失最后一帧；回到前台时强制重绘，避免白屏。
  const repaint = (): void => {
    if (!window.isDestroyed()) window.webContents.invalidate();
  };
  window.on('show', repaint);
  window.on('restore', repaint);
  window.on('focus', repaint);

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  window.webContents.on('will-navigate', (event, url) => {
    const allowedOrigin = process.env.ELECTRON_RENDERER_URL;
    if (allowedOrigin && url.startsWith(allowedOrigin)) return;
    event.preventDefault();
  });

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // Windows mouse side buttons arrive as window app commands; the page decides what "back" means.
  window.on('app-command', (_event, command) => {
    if (command === 'browser-backward') window.webContents.send(IPC.appBack);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  if (process.env.DISK_ORGANIZER_DEVTOOLS === '1') {
    window.webContents.openDevTools({ mode: 'detach' });
  }

  return window;
}
