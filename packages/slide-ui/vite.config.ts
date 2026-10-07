import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained HTML file: served as the MCP Apps ui:// resource and as the web preview.
export default defineConfig({
  root: "app",
  plugins: [react(), viteSingleFile()],
  build: { outDir: "../dist", emptyOutDir: true },
});
