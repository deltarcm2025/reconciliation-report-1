import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite' // Add Tailwind v4 plugin

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(), // Run Tailwind v4
  ],
  base: '/reconciliation-report-1/',
})
