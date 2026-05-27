import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const managerPort = process.env.MANAGER_PORT || process.env.PORT || "4180";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": `http://localhost:${managerPort}`
    }
  }
});
