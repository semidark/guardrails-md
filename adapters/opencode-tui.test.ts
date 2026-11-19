import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import plugin, { parseSwitchArgument } from "./opencode-tui.ts"
import { GateRpc } from "./opencode-rpc.ts"

type Command = { id: string; title: string; palette: boolean; slash: { name: string }; run: (input?: string) => Promise<void> }
type Layer = () => { commands: Command[] }

const LOCATION = { directory: "/work/project" }

function fakeContext(serverEnabled = true) {
  let server = serverEnabled
  let changed: ((event: unknown) => void) | undefined
  const store = { enabled: true }
  const status = vi.fn(async () => ({ enabled: server }))
  const setEnabled = vi.fn(async (input: { enabled: boolean }) => {
    server = input.enabled
    return { enabled: server }
  })
  const rpc = vi.fn(() => ({
    status,
    setEnabled,
    events: {
      on: vi.fn((_name: string, handler: (event: unknown) => void) => {
        changed = handler
        return () => {}
      }),
    },
  }))
  const layers: Layer[] = []
  const slot = vi.fn(() => () => {})
  const context = {
    theme: { text: { feedback: { warning: { base: "yellow" } } } },
    location: LOCATION,
    data: { location: { default: () => LOCATION } },
    client: { rpc },
    storage: {
      memory: () => [store, (fn: (draft: typeof store) => void) => fn(store)],
    },
    keymap: { layer: (factory: Layer) => layers.push(factory) },
    ui: {
      dialog: { confirm: vi.fn(async () => true) },
      toast: { show: vi.fn() },
      slot,
    },
  }
  return {
    context,
    store,
    status,
    setEnabled,
    rpc,
    command: () => layers[0]().commands[0],
    emitChanged: (event: unknown) => changed?.(event),
  }
}

let cleanup: (() => void) | void

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.useRealTimers()
})

async function load(fake: ReturnType<typeof fakeContext>) {
  cleanup = (await plugin.setup(fake.context as never)) as () => void
  await vi.runOnlyPendingTimersAsync()
}

describe("parseSwitchArgument", () => {
  it.each([
    ["", "toggle"],
    [undefined, "toggle"],
    ["on", true],
    [" Enable ", true],
    ["off", false],
    ["disable", false],
    ["maybe", undefined],
  ])("Given %j, When parsed, Then it is %j", (input, expected) => {
    expect(parseSwitchArgument(input as string | undefined)).toBe(expected)
  })
})

describe("opencode TUI switch", () => {
  it("Given the TUI loads, When the command layer is read, Then /guardrails is a palette and slash command", async () => {
    const fake = fakeContext()
    await load(fake)
    const command = fake.command()
    expect(command.id).toBe("guardrails-md.toggle")
    expect(command.palette).toBe(true)
    expect(command.slash.name).toBe("guardrails")
    expect(fake.rpc).toHaveBeenCalledWith(GateRpc)
    expect(fake.status).toHaveBeenCalledWith({}, { location: LOCATION })
    expect(fake.context.ui.slot).toHaveBeenCalledWith(expect.objectContaining({ append: "prompt.footer.status" }))
  })

  it("Given the gate is on, When the user toggles and confirms, Then it is turned off for the current location", async () => {
    const fake = fakeContext()
    await load(fake)
    await fake.command().run()
    expect(fake.context.ui.dialog.confirm).toHaveBeenCalledTimes(1)
    expect(fake.setEnabled).toHaveBeenCalledWith({ enabled: false }, { location: LOCATION })
    expect(fake.store.enabled).toBe(false)
    expect(fake.command().title).toMatch(/currently OFF/)
  })

  it("Given the gate is on, When the user declines the confirmation, Then nothing changes", async () => {
    const fake = fakeContext()
    fake.context.ui.dialog.confirm.mockResolvedValueOnce(false)
    await load(fake)
    await fake.command().run("off")
    expect(fake.setEnabled).not.toHaveBeenCalled()
    expect(fake.store.enabled).toBe(true)
  })

  it("Given the gate is off on the server, When the user runs /guardrails on, Then it turns on without a confirmation", async () => {
    const fake = fakeContext(false)
    await load(fake)
    expect(fake.store.enabled).toBe(false)
    await fake.command().run("on")
    expect(fake.context.ui.dialog.confirm).not.toHaveBeenCalled()
    expect(fake.setEnabled).toHaveBeenCalledWith({ enabled: true }, { location: LOCATION })
    expect(fake.store.enabled).toBe(true)
  })

  it("Given an unknown argument, When the command runs, Then usage is shown and nothing changes", async () => {
    const fake = fakeContext()
    await load(fake)
    await fake.command().run("maybe")
    expect(fake.setEnabled).not.toHaveBeenCalled()
    expect(fake.context.ui.toast.show).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Usage/) }))
  })

  it("Given an unreachable server, When the user toggles, Then an error toast is shown", async () => {
    const fake = fakeContext()
    fake.setEnabled.mockRejectedValueOnce(new Error("connection refused"))
    await load(fake)
    await fake.command().run("off")
    expect(fake.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "error", message: expect.stringMatching(/connection refused/) }),
    )
    expect(fake.store.enabled).toBe(true)
  })

  it("Given changed events, When they arrive, Then only the current location's state is mirrored", async () => {
    const fake = fakeContext()
    await load(fake)
    fake.emitChanged({ location: { directory: "/other" }, data: { enabled: false } })
    expect(fake.store.enabled).toBe(true)
    fake.emitChanged({ location: LOCATION, data: { enabled: false } })
    expect(fake.store.enabled).toBe(false)
  })

  it("Given a server restart reset the gate to on, When the refresh interval passes, Then the TUI shows it on", async () => {
    const fake = fakeContext(false)
    await load(fake)
    expect(fake.store.enabled).toBe(false)
    fake.status.mockResolvedValue({ enabled: true })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fake.store.enabled).toBe(true)
  })
})
