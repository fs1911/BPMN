/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("./src/core", import.meta.url)),
      "@state": fileURLToPath(new URL("./src/state", import.meta.url)),
      "@ui": fileURLToPath(new URL("./src/ui", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environmentMatchGlobs: [["test/**/*.dom.test.*", "jsdom"]],
  },
});
