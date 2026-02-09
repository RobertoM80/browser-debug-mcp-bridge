import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import path from 'path';

export default defineConfig({
  root: __dirname,
  build: {
    outDir: '../../dist/apps/chrome-extension',
    emptyOutDir: true,
    copyPublicDir: true,
    manifest: false,
    rollupOptions: {
      input: {
        'content-script': path.resolve(__dirname, 'src/content-script.ts'),
        'injected-script': path.resolve(__dirname, 'src/injected-script.ts'),
        'background': path.resolve(__dirname, 'src/background.ts'),
        'popup': path.resolve(__dirname, 'src/popup.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'popup.css') {
            return 'popup.css';
          }
          return '[name][extname]';
        },
      },
    },
  },
  plugins: [nxViteTsPaths()],
  publicDir: 'public',
});
