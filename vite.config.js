import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    // Browser shims for files that opt into jsdom; no-ops under node.
    setupFiles: ['./src/test/setup.js'],
  },
  // Absolute base so deep client routes (e.g. /customer/site/level) still load
  // /assets/* on refresh. Relative './' resolves assets under the current path
  // and white-screens the SPA on CloudFront/S3.
  base: '/',
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      stream: 'stream-browserify',
      events: 'events',
      util: path.resolve(__dirname, 'src/lib/util-shim.js'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    historyApiFallback: true,
    // Allow Google OAuth popup to communicate with the opener (avoids COOP window.closed warnings)
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    },
  },
  esbuild: {
    target: 'esnext',
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
  build: {
    target: 'esnext',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        // Split large third-party libs into their own chunks so the initial
        // bundle stays small and they only load when needed.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('monaco-editor') || id.includes('@monaco-editor')) return 'monaco';
          if (id.includes('pdfjs-dist')) return 'pdfjs';
          if (id.includes('jspdf')) return 'jspdf';
          if (id.includes('konva') || id.includes('react-konva')) return 'konva';
          if (id.includes('@tanstack/react-query')) return 'react-query';
          if (id.includes('motion')) return 'motion';
          if (id.includes('lucide-react')) return 'lucide';
        },
      },
    },
  },
})
