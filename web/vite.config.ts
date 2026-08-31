import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Build the SPA straight into dist/ui so the Ropex control-plane server
// (resolveUiDir) serves it in both dev (`ropex ui`) and prod.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (/node_modules[\\/](recharts|d3-|d3|victory-vendor|internmap)/.test(id)) return "charts";
          if (/node_modules[\\/]@tanstack[\\/]/.test(id)) return "query";
          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:7780",
    },
  },
});
