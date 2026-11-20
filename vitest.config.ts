import { join } from "node:path"
import { configDefaults, defineConfig } from "vitest/config"

const jsxRuntime = join(import.meta.dirname, "test", "jsx-runtime.ts")

// test/claude/ runs under `claude plugin test` (npm run test:claude), not vitest.
// OpenCode compiles .tsx TUI plugins at runtime with its own Solid/OpenTUI JSX
// transform; vitest aliases the automatic JSX runtime to a tiny test stub so the
// package needs no JSX runtime dependency.
export default defineConfig({
  resolve: {
    alias: {
      "react/jsx-runtime": jsxRuntime,
      "react/jsx-dev-runtime": jsxRuntime,
    },
  },
  test: { exclude: [...configDefaults.exclude, "test/claude/**"] },
})
