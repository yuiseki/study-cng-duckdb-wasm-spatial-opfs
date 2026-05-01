import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: "/study-cng-duckdb-wasm-spatial-opfs/",
  resolve: {
    // Force a single React instance even after optimized-deps reloads,
    // to avoid the "Invalid hook call / useContext is null" failure mode
    // we hit when react-map-gl was newly pre-bundled.
    dedupe: ["react", "react-dom"],
  },
})
