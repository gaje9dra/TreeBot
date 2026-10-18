import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: { reporter: ["text", "json-summary"], include: ["src/lib/**/*.ts"] }
  },
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } }
});
