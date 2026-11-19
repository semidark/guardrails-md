import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fetchMock = vi.fn()

function mockAnswers(body: unknown) {
  // Fresh Response per call: a Response body can only be read once.
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }))
}

function sentRequest(i = 0): { url: string; body: any; headers: Record<string, string> } {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit]
  return { url: String(url), body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> }
}

type Hook = (input: { tool: string }, output: { args: { command?: string; filePath?: string; patchText?: string } }) => Promise<void>
type V2Hook = (event: { tool: string; input: { command?: string; path?: string; filePath?: string; patchText?: string } }) => Promise<void>

const allow = { answers: { destructive: { noul: 0.01 }, credentials: { noul: 0 } } }
const blockDestructive = { answers: { destructive: { noul: 0.98 }, credentials: { noul: 0 } } }

const ENDPOINT = "http://model.lan:8081"

let dir: string
let home: string

const showToast = vi.fn()

async function loadHook(): Promise<Hook> {
  const mod = await import("./opencode.ts")
  const hooks = await mod.default.server({ directory: dir, client: { tui: { showToast } } } as never)
  return hooks["tool.execute.before"] as Hook
}

async function setupV2() {
  const mod = await import("./opencode.ts")
  const hook = vi.fn().mockResolvedValue({ dispose: async () => {} })
  await mod.default.setup({ location: { directory: dir }, tool: { hook } } as never)
  return hook
}

async function loadV2Hook(): Promise<V2Hook> {
  const hook = await setupV2()
  return hook.mock.calls[0][1] as V2Hook
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  home = mkdtempSync(join(tmpdir(), "gate-home-"))
  dir = mkdtempSync(join(tmpdir(), "gate-proj-"))
  vi.stubEnv("HOME", home)
  vi.stubEnv("SYSTEMONE_BASE_URL", ENDPOINT)
  vi.stubEnv("SYSTEMONE_API_KEY", "test-key")
  vi.stubEnv("SYSTEMONE_MODEL", "test-model")
  vi.stubEnv("SYSTEMONE_GATE", undefined)
  vi.stubEnv("SYSTEMONE_THRESHOLD", undefined)
  vi.stubEnv("SYSTEMONE_COOLDOWN", undefined)
  vi.stubGlobal("fetch", fetchMock)
  showToast.mockResolvedValue(undefined)
  mockAnswers(allow)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

describe("opencode adapter", () => {
  it("Given the opencode 1.x and 2.x loaders, When the module loads, Then the default export carries a V1 server and a V2 id and setup", async () => {
    const mod = await import("./opencode.ts")
    expect(mod.default.id).toBe("guardrails-md")
    expect(mod.default.server).toBeTypeOf("function")
    expect(mod.default.setup).toBeTypeOf("function")
  })

  it("Given a non-bash tool, When it is called, Then the model is not asked", async () => {
    const hook = await loadHook()
    await hook({ tool: "edit" }, { args: {} })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Given a safe verdict, When bash runs, Then the hook resolves", async () => {
    const hook = await loadHook()
    await expect(hook({ tool: "bash" }, { args: { command: "ls -la" } })).resolves.toBeUndefined()
  })

  it("Given a configured endpoint, When bash runs, Then the request goes to it with the bearer key", async () => {
    const hook = await loadHook()
    await hook({ tool: "bash" }, { args: { command: "ls" } })
    expect(sentRequest(0).url).toBe(`${ENDPOINT}/v1/systemone`)
    expect(sentRequest(0).headers.Authorization).toBe("Bearer test-key")
    expect(sentRequest(0).body.model).toBe("test-model")
  })

  it("Given a destructive verdict, When bash runs, Then the hook throws with opencode wording", async () => {
    mockAnswers(blockDestructive)
    const hook = await loadHook()
    await expect(hook({ tool: "bash" }, { args: { command: "rm -rf /data" } })).rejects.toThrow(
      /destructive=0\.98[\s\S]*restart opencode/,
    )
  })

  it("Given no endpoint configured, When bash runs, Then the hook throws fail-closed and sends nothing", async () => {
    vi.stubEnv("SYSTEMONE_BASE_URL", undefined)
    const hook = await loadHook()
    await expect(hook({ tool: "bash" }, { args: { command: "ls" } })).rejects.toThrow(
      /not configured — SYSTEMONE_BASE_URL missing[\s\S]*fail-closed/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Given an invalid SYSTEMONE_THRESHOLD, When the plugin loads, Then a warning toast is shown", async () => {
    vi.stubEnv("SYSTEMONE_THRESHOLD", "abc")
    await loadHook()
    expect(showToast).toHaveBeenCalledWith({ body: { message: expect.stringMatching(/SYSTEMONE_THRESHOLD/), variant: "warning" } })
  })

  it("Given a toast that fails, When the plugin loads, Then the plugin still loads", async () => {
    vi.stubEnv("SYSTEMONE_THRESHOLD", "abc")
    showToast.mockRejectedValueOnce(new Error("tui not ready"))
    await expect(loadHook()).resolves.toBeTypeOf("function")
  })

  it("Given GUARDRAILS.md, When bash runs, Then the canonical policy is judged", async () => {
    writeFileSync(join(dir, "GUARDRAILS.md"), "# canonical rules")
    const hook = await loadHook()
    await hook({ tool: "bash" }, { args: { command: "ls" } })
    expect(sentRequest(0).body.state.text).toContain("# canonical rules")
  })

  it("Given .opencode/guardrails.md, When bash runs, Then the policy is judged", async () => {
    mkdirSync(join(dir, ".opencode"), { recursive: true })
    writeFileSync(join(dir, ".opencode", "guardrails.md"), "# opencode rules")
    const hook = await loadHook()
    await hook({ tool: "bash" }, { args: { command: "ls" } })
    expect(sentRequest(0).body.state.text).toContain("# opencode rules")
  })
})

describe("opencode adapter: protected paths", () => {
  it("Given an edit on guardrails.md, When the hook runs, Then it throws with the reason and the model is not asked", async () => {
    const hook = await loadHook()
    await expect(hook({ tool: "edit" }, { args: { filePath: join(dir, "guardrails.md") } })).rejects.toThrow(
      /protected file — GUARDRAILS\.md[\s\S]*restart opencode/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Given a write to .pi/guardrails.md, When the hook runs, Then it throws", async () => {
    const hook = await loadHook()
    await expect(hook({ tool: "write" }, { args: { filePath: join(dir, ".pi", "guardrails.md") } })).rejects.toThrow(
      /protected file/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Given apply_patch touching guardrails.md, When the hook runs, Then it throws and the model is not asked", async () => {
    const hook = await loadHook()
    const patchText = `*** Begin Patch\n*** Update File: ${join(dir, "guardrails.md")}\n@@\n@@\n*** End Patch`
    await expect(hook({ tool: "apply_patch" }, { args: { patchText } })).rejects.toThrow(/protected file — GUARDRAILS\.md/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Given apply_patch that names a protected file first and a plain file second, When the hook runs, Then the first block wins", async () => {
    const hook = await loadHook()
    const patchText =
      `*** Begin Patch\n*** Delete File: ${join(dir, "opencode.json")}\n*** Add File: ${join(dir, "src", "new.ts")}\n+export {}\n*** End Patch`
    await expect(hook({ tool: "apply_patch" }, { args: { patchText } })).rejects.toThrow(/protected file — opencode\.json/)
  })

  it("Given an edit on a capitalisation variant, When the hook runs, Then it is still refused as GUARDRAILS.md", async () => {
    const hook = await loadHook()
    await expect(hook({ tool: "edit" }, { args: { filePath: join(dir, "GuardRails.md") } })).rejects.toThrow(
      /protected file — GUARDRAILS\.md/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Given an edit on a plain source file, When the hook runs, Then it passes and the model is not asked", async () => {
    const hook = await loadHook()
    await expect(hook({ tool: "edit" }, { args: { filePath: join(dir, "src", "a.ts") } })).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Given SYSTEMONE_GATE=off, When an edit on guardrails.md runs, Then it passes", async () => {
    vi.stubEnv("SYSTEMONE_GATE", "off")
    const hook = await loadHook()
    await expect(hook({ tool: "edit" }, { args: { filePath: join(dir, "guardrails.md") } })).resolves.toBeUndefined()
  })
})

describe("opencode 2 adapter", () => {
  it("Given opencode 2, When setup runs, Then one execute.before tool hook is registered", async () => {
    const hook = await setupV2()
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook).toHaveBeenCalledWith("execute.before", expect.any(Function))
  })

  it("Given a safe verdict, When shell runs, Then the hook resolves", async () => {
    const hook = await loadV2Hook()
    await expect(hook({ tool: "shell", input: { command: "ls -la" } })).resolves.toBeUndefined()
    expect(sentRequest(0).body.state.text).toContain("ls -la")
  })

  it("Given a destructive verdict, When shell runs, Then the hook throws with opencode wording", async () => {
    mockAnswers(blockDestructive)
    const hook = await loadV2Hook()
    await expect(hook({ tool: "shell", input: { command: "rm -rf /data" } })).rejects.toThrow(
      /destructive=0\.98[\s\S]*restart opencode/,
    )
  })

  it("Given a read tool, When it is called, Then the model is not asked", async () => {
    const hook = await loadV2Hook()
    await hook({ tool: "read", input: { path: join(dir, "guardrails.md") } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Given GUARDRAILS.md in the plugin location, When shell runs, Then the policy is judged", async () => {
    writeFileSync(join(dir, "GUARDRAILS.md"), "# v2 rules")
    const hook = await loadV2Hook()
    await hook({ tool: "shell", input: { command: "ls" } })
    expect(sentRequest(0).body.state.text).toContain("# v2 rules")
  })

  it("Given an edit on GUARDRAILS.md, When the hook runs, Then it throws and the model is not asked", async () => {
    const hook = await loadV2Hook()
    await expect(hook({ tool: "edit", input: { path: join(dir, "GUARDRAILS.md") } })).rejects.toThrow(
      /protected file — GUARDRAILS\.md[\s\S]*restart opencode/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Given a write to a relative opencode.json, When the hook runs, Then it throws", async () => {
    const hook = await loadV2Hook()
    await expect(hook({ tool: "write", input: { path: "opencode.json" } })).rejects.toThrow(/protected file — opencode\.json/)
  })

  it("Given a patch touching .opencode/plugins, When the hook runs, Then it throws and the model is not asked", async () => {
    const hook = await loadV2Hook()
    const patchText = `*** Begin Patch\n*** Add File: .opencode/plugins/x.ts\n+export {}\n*** End Patch`
    await expect(hook({ tool: "patch", input: { patchText } })).rejects.toThrow(/protected file — \.opencode\//)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Given an edit whose filePath is harmless and whose path is GUARDRAILS.md, When the hook runs, Then it throws", async () => {
    const hook = await loadV2Hook()
    await expect(
      hook({ tool: "edit", input: { filePath: join(dir, "src", "a.ts"), path: join(dir, "GUARDRAILS.md") } }),
    ).rejects.toThrow(/protected file — GUARDRAILS\.md/)
  })

  it("Given a patch that moves a file onto opencode.json, When the hook runs, Then it throws", async () => {
    const hook = await loadV2Hook()
    const patchText = `*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: opencode.json\n@@\n*** End Patch`
    await expect(hook({ tool: "patch", input: { patchText } })).rejects.toThrow(/protected file — opencode\.json/)
  })

  it("Given an edit on a plain source file, When the hook runs, Then it passes", async () => {
    const hook = await loadV2Hook()
    await expect(hook({ tool: "edit", input: { path: join(dir, "src", "a.ts") } })).resolves.toBeUndefined()
  })
})
