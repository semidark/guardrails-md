/**
 * guardrails-md TUI part (opencode 2): the human's switch for the gate.
 *
 * `/guardrails` (also in the command palette) toggles model judging for the
 * current project location; `/guardrails on` and `/guardrails off` set it.
 * Turning it off asks for confirmation, and the prompt footer shows a warning
 * while it is off. The server part owns the state, starts enabled and resets
 * to enabled when opencode restarts — this file only asks it over the GateRpc
 * contract and mirrors the answer.
 *
 * A plain object of the shape Plugin.define returns, so the package keeps no
 * runtime dependency on @opencode/plugin. opencode compiles the JSX for the
 * TUI itself; a slot render must return an element, not a bare string.
 */
import type { Plugin } from "@opencode/plugin/tui"
import { GateRpc } from "./opencode-rpc.ts"

type Context = Plugin.Context
type Location = NonNullable<Context["location"]>

const REFRESH_MS = 15_000

export function parseSwitchArgument(input: string | undefined): boolean | "toggle" | undefined {
  const word = (input ?? "").trim().toLowerCase()
  if (word === "") return "toggle"
  if (["on", "enable", "enabled"].includes(word)) return true
  if (["off", "disable", "disabled"].includes(word)) return false
  return undefined
}

export default {
  id: "guardrails-md.tui",
  async setup(context: Context) {
    const [state, update] = context.storage.memory("gate", { initial: { enabled: true } })
    const location = (): Location => context.location ?? context.data.location.default()
    // Read the client at call time: it is replaced when the server restarts.
    const gate = () => context.client.rpc(GateRpc)
    const mirror = (enabled: boolean) =>
      update((draft) => {
        draft.enabled = enabled
      })

    async function refresh(): Promise<void> {
      try {
        mirror((await gate().status({}, { location: location() })).enabled)
      } catch {
        // Server unreachable or the gate not loaded there: keep the last answer.
      }
    }

    async function set(enabled: boolean): Promise<void> {
      if (!enabled) {
        const confirmed = await context.ui.dialog.confirm({
          title: "Disable the guardrails gate?",
          message:
            "Shell commands in this project will run without the decision model until you " +
            "turn it back on or opencode restarts. Protected files stay protected.",
          label: { confirm: "Disable", cancel: "Keep on" },
        })
        if (!confirmed) return
      }
      try {
        const result = await gate().setEnabled({ enabled }, { location: location() })
        mirror(result.enabled)
        context.ui.toast.show({
          title: "Guardrails gate",
          message: result.enabled ? "On — shell commands are judged again." : "Off — shell commands run unjudged.",
          variant: result.enabled ? "success" : "warning",
        })
      } catch (error) {
        context.ui.toast.show({
          title: "Guardrails gate",
          message: `Could not reach the gate: ${String((error as { message?: unknown })?.message ?? error)}`,
          variant: "error",
        })
      }
    }

    async function run(input?: string): Promise<void> {
      const wanted = parseSwitchArgument(input)
      if (wanted === undefined) {
        context.ui.toast.show({ title: "Guardrails gate", message: "Usage: /guardrails [on|off]", variant: "info" })
        return
      }
      await refresh()
      await set(wanted === "toggle" ? !state.enabled : wanted)
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "guardrails-md.toggle",
          title: state.enabled ? "Guardrails gate: turn off" : "Guardrails gate: turn on (currently OFF)",
          group: "Guardrails",
          palette: true,
          slash: { name: "guardrails", arguments: true },
          run,
        },
      ],
    }))

    const stopSlot = context.ui.slot({
      append: "prompt.footer.status",
      // Solid/OpenTUI element factory without JSX so this file needs no JSX
      // transform or React runtime at test time. opencode accepts { type, props }.
      render: () => ({
        type: "text",
        props: {
          fg: context.theme.text.feedback.warning.base,
          children: state.enabled ? "" : "⚠ gate off",
        },
      }),
    })

    const stopEvents = gate().events.on("changed", (event) => {
      if (event.location.directory === location().directory) mirror(event.data.enabled)
    })
    // The server resets to on after a restart; events sent meanwhile are missed.
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    void refresh()

    return () => {
      stopSlot()
      stopEvents()
      clearInterval(timer)
    }
  },
}
