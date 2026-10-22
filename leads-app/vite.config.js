import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  base: "/leads/",
  envDir: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist/leads", import.meta.url)),
    emptyOutDir: true,
  },
  test: {
    root: here,
    include: ["src/**/*.test.{js,jsx}", "tests/**/*.test.js"],
    // Os testes de RLS fazem logins reais no projeto de testes.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
