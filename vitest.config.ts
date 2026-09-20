import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    exclude: [...configDefaults.exclude, ".worktrees/**"],
  },
});
