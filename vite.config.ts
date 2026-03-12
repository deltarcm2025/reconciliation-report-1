import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react' // Use this one!

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/reconciliation-report-1/', 
})
