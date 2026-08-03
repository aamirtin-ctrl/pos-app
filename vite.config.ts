import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Renderer only. Electron main/preload are bundled by esbuild (see package.json).
export default defineConfig({
  root: "renderer",
  base: "./", // relative asset paths so file:// loading works in the packaged app
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist-renderer", emptyOutDir: true },
  server: { port: 5183, strictPort: true },
});
