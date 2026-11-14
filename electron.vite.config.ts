import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const sharedAlias = { '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        ...sharedAlias,
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    plugins: [
      react(),
      {
        name: 'external-react-preamble',
        apply: 'serve',
        configureServer(server) {
          server.middlewares.use('/@react-preamble', (_request, response) => {
            response.setHeader('Content-Type', 'text/javascript');
            response.end(react.preambleCode.replace('__BASE__', '/'));
          });
        },
        transformIndexHtml: {
          order: 'post',
          handler(html) {
            return html.replace(
              /<script type="module">([\s\S]*?)<\/script>/g,
              (tag, body: string) =>
                body.includes('injectIntoGlobalHook')
                  ? '<script type="module" src="/@react-preamble"></script>'
                  : tag,
            );
          },
        },
      },
    ],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
