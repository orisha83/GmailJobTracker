import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// `@/...` maps to the web root, matching tsconfig `paths` ("@/*": ["./*"]).
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
