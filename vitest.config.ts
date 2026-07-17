import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `next` is an optional peer dep, not installed here; src/supabase loads
      // next/server via a literal dynamic import() — resolve it to the stub.
      "next/server": fileURLToPath(new URL("./tests/stubs/next-server.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
