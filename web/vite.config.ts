import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendPort = process.env.PORT ?? "8787";
const backendTarget = `http://localhost:${backendPort}`;

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
  },
  server: {
    proxy: {
      // ws: the dashboard's live channel (/api/ws) is a WebSocket upgrade.
      "/api": { target: backendTarget, ws: true },
      "/mcp": backendTarget,
      "/health": backendTarget,
    },
  },
});
