import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("package metadata", () => {
  it("Given a version bump, When plugin.json is checked, Then it matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8"))
    const plugin = JSON.parse(readFileSync(join(import.meta.dirname, ".claude-plugin", "plugin.json"), "utf8"))
    expect(plugin.version).toBe(pkg.version)
  })

  it("Given one package for every harness, When package.json is checked, Then it has the harness-neutral name and the pi-package keyword", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8"))
    expect(pkg.name).toBe("guardrails-md")
    expect(pkg.keywords).toContain("pi-package")
  })

  it("Given opencode loads npm plugins from exports[\"./server\"] or main, When package.json is checked, Then ./server points at the opencode adapter", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8"))
    expect(pkg.exports["./server"]).toBe("./adapters/opencode.ts")
  })

  it("Given opencode 2 loads a package's TUI part from exports[\"./tui\"], When package.json is checked, Then it points at the TUI switch and ships it", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8"))
    expect(pkg.exports["./tui"]).toBe("./adapters/opencode-tui.tsx")
    expect(pkg.exports["./rpc"]).toBe("./adapters/opencode-rpc.ts")
    expect(pkg.files).toEqual(expect.arrayContaining(["adapters/opencode-tui.tsx", "adapters/opencode-rpc.ts"]))
  })
})

describe("self-hosted fork: no vendor code paths", () => {
  const productionFiles = [
    "core.ts",
    "adapters/opencode.ts",
    "adapters/opencode-rpc.ts",
    "adapters/opencode-tui.tsx",
    "adapters/pi.ts",
    "hooks/hooks.json",
    "hooks/register.ts",
    "hooks/pre-commit",
    "package.json",
    ".claude-plugin/plugin.json",
  ]

  it.each(productionFiles)(
    "Given %s, When scanned, Then it contains no vendor host, SDK or env-var reference",
    (file) => {
      const text = readFileSync(join(import.meta.dirname, file), "utf8")
      expect(text, `${file} must not reference berget`).not.toMatch(/berget/i)
      expect(text, `${file} must not reference typesafe`).not.toMatch(/typesafe/i)
    },
  )

  it("Given package.json, When checked, Then it has no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8"))
    expect(pkg.dependencies ?? {}).toEqual({})
  })
})
