import react from '@vitejs/plugin-react'
import { defineConfig, searchForWorkspaceRoot } from 'vite'

// Dev: Vite on :5173 proxies the API to uvicorn on :8000.
// Build: served by api-server at /studio.
const api = 'http://localhost:8000'

export default defineConfig({
  base: '/studio/',
  plugins: [react()],
  server: {
    proxy: { '/api': api, '/health': api, '/predict': api },
    // The plan-import tool (plan-import.html, dev only) reads the D block's floor plans from the site pack
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), '../sites/bits-main/plans'] },
  },
})
