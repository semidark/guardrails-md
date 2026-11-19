/**
 * guardrails-md for opencode — gates every shell command through core.ts
 * before it runs, and deterministically refuses edits and writes to protected
 * paths: no model call, no threshold, no cooldown. A block throws, and
 * opencode hands the message to the agent.
 *
 * One default export serves both plugin APIs: opencode 1.x calls `server()`,
 * opencode 2.x calls `setup()`. The two name their tools and arguments
 * differently (bash/shell, apply_patch/patch, filePath/path).
 *
 * Config warnings (bad threshold, truncated GUARDRAILS.md) are a toast at load
 * on 1.x; 2.x has no toast API, so there they only reach the block reasons.
 *
 * Endpoint: SYSTEMONE_BASE_URL / SYSTEMONE_API_KEY / SYSTEMONE_MODEL — your
 * self-hosted System One model. No vendor fallback: unset means blocked.
 * Guardrails: GUARDRAILS.md or .opencode/GUARDRAILS.md (legacy lowercase names
 * are still read), frozen at plugin load.
 * Log: ~/.cache/opencode/systemone-gate.log (SYSTEMONE_LOG=1).
 *
 * Runtime switch (2.x only): the TUI part toggles model judging per project
 * location over the GateRpc contract. It starts on and resets to on whenever
 * the plugin loads; protected paths stay enforced while it is off.
 */
import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import type { Plugin as V2 } from "@opencode/plugin"
import { createGate, type Block, type Harness } from "../core.ts"
import { GATE_RPC_ID, GateRpc } from "./opencode-rpc.ts"

type Gate = ReturnType<typeof createGate>
type Args = { command?: unknown; filePath?: unknown; path?: unknown; patchText?: unknown } | undefined

function opencode(): Harness {
  const home = process.env.HOME
  return {
    name: "opencode",
    guardrailPaths: ["GUARDRAILS.md", ".opencode/GUARDRAILS.md", "guardrails.md", ".opencode/guardrails.md"],
    logPath: `${home}/.cache/opencode/systemone-gate.log`,
  }
}

// *** Begin Patch / @@ patch text: every marker line names a file.
function patchPaths(patchText: string): string[] {
  const paths: string[] = []
  for (const line of patchText.split("\n")) {
    const match = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): +(.+?)\s*$/)
    if (match) paths.push(match[1])
  }
  return paths
}

// The switch is reachable over the server's HTTP API, which an agent's shell
// can call too. A command naming it is refused before any model call. Quotes,
// backslashes, whitespace and %XX escapes are folded first so the obvious
// spellings of the id cannot slip past; anything cleverer is left to the model.
export function touchesGateSwitch(command: string): boolean {
  const flat = command
    .replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/["'`\\\s]/g, "")
    .toLowerCase()
  return flat.includes(GATE_RPC_ID) || /api\/rpc\/[^/]*guardrails/.test(flat)
}

function switchBlock(command: string): Block {
  return {
    reason:
      `SystemOne-gate: blocked command — it targets the gate's on/off switch.\n` +
      `  The switch belongs to your human, at the opencode TUI. Ask them if\n` +
      `  the gate should be paused.\n` +
      `  ${command.slice(0, 200)}`,
  }
}

async function guard(gate: Gate, tool: string, args: Args): Promise<void> {
  if (tool === "bash" || tool === "shell") {
    const command = String(args?.command ?? "").trim()
    const tampering = process.env.SYSTEMONE_GATE !== "off" && gate.isEnabled() && touchesGateSwitch(command)
    const block = tampering ? switchBlock(command) : await gate.check(command)
    if (block) throw new Error(block.reason)
    return
  }
  // Both spellings are checked: a call carrying both must not pass on the one
  // the tool ignores.
  if (tool === "edit" || tool === "write") {
    for (const path of [args?.filePath, args?.path]) {
      const block = gate.checkPath(String(path ?? ""))
      if (block) throw new Error(block.reason)
    }
    return
  }
  if (tool === "apply_patch" || tool === "patch") {
    for (const path of patchPaths(String(args?.patchText ?? ""))) {
      const block = gate.checkPath(path)
      if (block) throw new Error(block.reason)
    }
  }
}

const server = (async ({ directory, client }) => {
  const gate = createGate(opencode(), directory)
  // Best effort: the TUI may not be up yet, and every block reason repeats
  // these warnings anyway.
  for (const message of gate.warnings) {
    Promise.resolve(client?.tui?.showToast?.({ body: { message, variant: "warning" } })).catch(() => {})
  }
  return {
    "tool.execute.before": (input, output) => guard(gate, input.tool, output.args),
  }
}) satisfies V1Plugin

export default {
  id: "guardrails-md",
  async setup(ctx) {
    const gate = createGate(opencode(), ctx.location.directory)
    await ctx.tool.hook("execute.before", (event) => guard(gate, event.tool, event.input as Args))
    if (!ctx.rpc?.register) return
    // Handlers must return promises: opencode 2.3.2 calls .then on the result.
    const registration = await ctx.rpc.register(GateRpc, {
      status: async () => ({ enabled: gate.isEnabled() }),
      setEnabled: async (input) => {
        gate.setEnabled((input as { enabled: boolean }).enabled === true)
        const state = { enabled: gate.isEnabled() }
        await registration.events.emit("changed", state)
        return state
      },
    })
  },
  server,
} satisfies V2.Plugin & { server: V1Plugin }
