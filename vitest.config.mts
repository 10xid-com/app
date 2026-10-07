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
    // The WorkOS SDK imports `next/cache` without a file extension, which
    // Node's strict ESM resolution refuses; Next's own bundler accepts it.
    // Inlining it lets Vite resolve it the same way.
    server: { deps: { inline: ["@workos-inc/authkit-nextjs"] } },
  },
});
