import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "."),
      // See test/stubs/server-only.ts for why.
      "server-only": resolve(import.meta.dirname, "test/stubs/server-only.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    // These share one database; running them at once would have them
    // truncating each other's fixtures.
    fileParallelism: false,
  },
});
