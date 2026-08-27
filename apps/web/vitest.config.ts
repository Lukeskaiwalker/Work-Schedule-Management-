import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pages touch the DOM the moment they mount, so there is no useful
    // "node" mode here.
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    globals: true,
    setupFiles: ["src/test/setup.ts"],
  },
});
