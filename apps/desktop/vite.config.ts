import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // /api is the local backend (apps/server); /hosted, the organisation it hosts (hosting.ts).
  server: { port: 5174, strictPort: true, proxy: { '/api': 'http://localhost:5175', '/hosted': 'http://localhost:5175' } },
});
