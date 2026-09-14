import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Aspire injects the API's address via service discovery. Fall back to the
// local dev port when running Vite on its own.
const apiTarget = process.env.services__api__http__0 ?? "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
    host: true,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
});
