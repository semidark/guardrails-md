import { join } from "node:path"
import { configDefaults, defineConfig } from "vitest/config"

const jsxRuntime = join(import.meta.dirname, "test", "jsx-runtime.ts")

// test/claude/ runs under `claude plugin test` (npm run test:claude), not vitest.
// OpenCode provides @opentui/solid/jsx-runtime at runtime; vitest aliases it to
// a tiny test stub so the package needs no runtime dependencies.
export default defineConfig({
  resolve: {
    alias: {
      "@opentui/solid/jsx-runtime": jsxRuntime,
    },
  },
  test: { exclude: [...configDefaults.exclude, "test/claude/**"] },
})
