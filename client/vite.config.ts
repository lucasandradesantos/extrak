import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        // Análise IA pode levar 1–3 min por bloco; evita "socket hang up" no proxy.
        timeout: 300_000,
        proxyTimeout: 300_000,
      },
    },
  },
});
