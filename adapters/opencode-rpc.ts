/**
 * RPC contract between the opencode 2 server part (adapters/opencode.ts) and
 * the TUI toggle (adapters/opencode-tui.tsx). A plain object of the shape
 * Rpc.define returns — that function only validates error names — so the
 * package keeps no runtime dependency on @opencode/plugin.
 *
 * Calls go to POST /api/rpc/<id>/<method> on the opencode server, scoped to a
 * project location. The server's shell hook refuses agent commands that name
 * this id (see touchesGateSwitch in adapters/opencode.ts): the switch belongs
 * to the human at the TUI, not to the agent it constrains.
 */
export const GATE_RPC_ID = "guardrails-md-gate"

const state = {
  type: "object",
  properties: { enabled: { type: "boolean" } },
  required: ["enabled"],
  additionalProperties: false,
} as const

// opencode 2.3.2 fails a method without an input schema despite the docs
// marking it optional, so status takes an empty object.
const none = { type: "object", additionalProperties: false } as const

export const GateRpc = {
  id: GATE_RPC_ID,
  methods: {
    status: { input: none, output: state },
    setEnabled: { input: state, output: state },
  },
  events: {
    changed: { schema: state },
  },
} as const
