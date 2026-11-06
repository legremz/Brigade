import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// En dev, l'API et le MCP sont proxifiés vers le serveur Brigade (port 3100).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3100" } },
});
