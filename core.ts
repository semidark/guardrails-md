/**
 * guardrails-md core — judges a bash command before it runs, using a System
 * One decision model at a self-hosted endpoint. Harness-free: adapters/
 * wires it into opencode and pi, each passing a Harness with its own paths
 * and wording.
 *
 * Flow: createGate() freezes GUARDRAILS.md → check(command) answers all
 * questions in one forward pass → a reason above threshold, else
 * null. checkPath(path) is the deterministic backstop in front of that:
 * writes to protected paths (the policy, the harness config, CI workflows)
 * are refused — no model call, no threshold, no cooldown — so a session
 * cannot rule the next one under its own rules.
 *
 * Questions (noul, 0..1):
 *   destructive          — deletes/destroys data, databases, clusters, infra?
 *   credentials          — contains/leaks secrets, keys, tokens?
 *   guardrails_violation — violates the team's GUARDRAILS.md? (if present)
 *
 * Self-hosted only — no vendor defaults. The endpoint, key and model must
 * be configured explicitly: SYSTEMONE_BASE_URL, SYSTEMONE_API_KEY and
 * SYSTEMONE_MODEL. There is no fallback URL anywhere in this codebase: if
 * any of them is missing, every command is blocked (fail-closed) and no
 * request is made. All traffic goes to the operator's own System
 * One-compatible endpoint and nowhere else.
 *
 * Block > 0.7. Fail-CLOSED on endpoint errors: an unreachable endpoint
 * blocks commands (fail-open would be an agent-reachable kill switch —
 * it can induce the failure). SYSTEMONE_FAIL_OPEN=1 opts out, for
 * transient endpoint failures only; missing configuration always blocks.
 *
 * The circumvention cooldown is opt-in (SYSTEMONE_COOLDOWN=1): off by
 * default, blocks carry no escalating wait.
 *
 * Config: SYSTEMONE_BASE_URL, SYSTEMONE_API_KEY, SYSTEMONE_MODEL (all
 * required), SYSTEMONE_THRESHOLD (0.7), SYSTEMONE_FAIL_OPEN=1,
 * SYSTEMONE_GATE=off, SYSTEMONE_COOLDOWN=1, SYSTEMONE_LOG=1.
 */
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"

export interface Harness {
  name: "opencode" | "pi"
  guardrailPaths: string[]
  logPath: string
}

export type Block = { reason: string }

const DEFAULT_THRESHOLD = 0.7
const TIMEOUT_MS = 10_000

// Out-of-range values fail silently otherwise: "abc" (NaN) or anything ≥ 1
// never blocks, while "", 0 or negatives block everything.
function parseThreshold(raw: string | undefined): { value: number; warning?: string } {
  if (raw === undefined) return { value: DEFAULT_THRESHOLD }
  const value = Number(raw)
  if (raw.trim() !== "" && value > 0 && value < 1) return { value }
  return {
    value: DEFAULT_THRESHOLD,
    warning:
      `SystemOne-gate: SYSTEMONE_THRESHOLD=${JSON.stringify(raw)} is not a number between 0 and 1 — ` +
      `using ${DEFAULT_THRESHOLD}.`,
  }
}

const threshold = parseThreshold(process.env.SYSTEMONE_THRESHOLD)
const THRESHOLD = threshold.value
// Endpoint failure policy. Default is FAIL-CLOSED: if the endpoint cannot
// be reached, the command is blocked. Fail-open would be an agent-reachable
// kill switch — an agent can induce the failure (hammer the endpoint until
// rate-limited) and then run anything unchecked. Interactive users who
// prefer availability over strictness can set SYSTEMONE_FAIL_OPEN=1. It
// applies to endpoint errors only — never to missing configuration, which
// always blocks.
const FAIL_OPEN = /^(1|true|yes)$/i.test(process.env.SYSTEMONE_FAIL_OPEN ?? "")
// Escalating circumvention cooldown. Off by default: blocks are plain
// blocks. SYSTEMONE_COOLDOWN=1 turns the doubling backoff on.
const COOLDOWN = /^(1|true|yes)$/i.test(process.env.SYSTEMONE_COOLDOWN ?? "")
const GUARDRAILS_MAX = 2000 // chars — keep the state text tight
const TRUNCATED = "\n… (truncated)"
const SCRIPT_MAX = 4000 // chars of file content included per file
const SCRIPT_FILES_MAX = 3 // files read per command

// No interpreter blocklist — perl, java, dotnet, ruby, lua, osascript,
// xargs, find -exec and friends can never be enumerated. Instead: every
// argument that points to an existing file is read and judged, whatever
// tool would run it. Inline code (perl -e '…', node -e '…') is already
// part of the command text. One level deep; network-fetched payloads and
// binaries remain documented gaps.

type Verdict = {
  destructive: number
  credentials: number
  guardrails_violation?: number
  policy_exception?: number
}

// --- protected paths --------------------------------------------------------
// A deterministic deny sits in front of the model: writes to the policy and
// harness configuration are refused in every harness, without a verdict,
// without a threshold and without the cooldown. The list is relative to the
// project root; an entry ending in `/` protects everything below it. No globs:
// an agent cannot smuggle a path past a pattern it can spell. Matching folds
// case: macOS and Windows resolve GUARDRAILS.md and guardrails.md to the same
// file, and on Linux no capitalisation variant may slip past the same rule.
export const PROTECTED_PATHS = Object.freeze([
  "GUARDRAILS.md",
  ".agents/GUARDRAILS.md",
  ".opencode/GUARDRAILS.md",
  ".pi/GUARDRAILS.md",
  ".claude/GUARDRAILS.md",
  "opencode.json",
  "opencode.jsonc",
  ".opencode/",
  ".pi/",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".github/workflows/",
])

// A path as its spelling says: `.` and `..` folded, doubles collapsed, no
// symlink followed. Duplicated in the Claude Code module — keep them in step.
function foldPath(p: string): string {
  const absolute = p.startsWith("/")
  const out: string[] = []
  for (const part of p.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (out.length > 0) out.pop()
    } else {
      out.push(part)
    }
  }
  return absolute ? `/${out.join("/")}` : out.join("/")
}

// The path relative to the root by spelling, or null when it names nothing
// under it, the root itself included.
function relUnder(root: string, path: string): string | null {
  const r = foldPath(root)
  const p = foldPath(path)
  if (r === "") return p || null
  if (p === r) return null
  if (r === "/") return p.slice(1)
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : null
}

// Where a path lands: the path as spelled, every symlink followed — including
// the ancestors of a file that does not exist yet, so a write into a linked
// directory cannot hide behind the missing file. Deny only when nothing
// resolves (a non-ENOENT error on the way up); the placed path may sit outside
// the root, which the caller treats as not protected.
function placePath(absolute: string): string | null {
  let target = absolute
  const tail: string[] = []
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(target) : join(realpathSync(target), ...tail)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null
      tail.unshift(basename(target))
      const parent = dirname(target)
      if (parent === target) return null
      target = parent
    }
  }
}

// The matching entry, or null. Both spellings are matched: the placed one so a
// symlink cannot rename a protected file, and the literal one so a symlinked
// `.pi/`-style directory is protected under its target too. A path outside the
// root is never protected.
export function protectedPath(root: string, candidate: string): string | null {
  if (!candidate) return null
  const rootReal = realpathSync(root)
  const absolute = isAbsolute(candidate) ? foldPath(candidate) : foldPath(join(root, candidate))
  // Case-folded: on a case-insensitive filesystem (macOS, Windows defaults)
  // `Guardrails.MD` opens GUARDRAILS.md; refusing a distinct-case file on
  // Linux is the safe side of a denylist.
  const hit = (spelled: string | null): string | null => {
    if (spelled === null) return null
    const rel = spelled.toLowerCase()
    for (const entry of PROTECTED_PATHS) {
      const pattern = entry.toLowerCase()
      if (pattern.endsWith("/")) {
        if (rel.startsWith(pattern)) return entry
      } else if (rel === pattern) {
        return entry
      }
    }
    return null
  }
  const placed = placePath(absolute)
  return hit(relUnder(root, absolute)) ?? hit(placed === null ? null : relUnder(rootReal, placed))
}

// --- GUARDRAILS.md ----------------------------------------------------------
// createGate reads this ONCE, not per command. Hot-reloading would let the
// agent weaken its own rules mid-session via the (ungated) edit tools — the
// same self-approval hole as the removed allow-file. Humans edit
// GUARDRAILS.md and restart the harness; the change goes through repo review.
// Each harness lists the capitalised name first and the lowercase legacy
// name after it, so older repos keep working unchanged.
export function readGuardrails(directory: string, paths: string[]): string | null {
  for (const p of paths) {
    try {
      let text = readFileSync(`${directory}/${p}`, "utf8").trim()
      if (text.length > GUARDRAILS_MAX) text = text.slice(0, GUARDRAILS_MAX) + TRUNCATED
      return text
    } catch {}
  }
  return null
}

// --- System One endpoint -----------------------------------------------------
// The endpoint wants the API ROOT (we append /v1/systemone); accept both forms.
export function gatewayRoot(url: string | undefined): string | undefined {
  if (!url) return undefined
  return url.replace(/\/v1\/systemone\/?$/, "").replace(/\/+$/, "")
}

export interface EndpointConfig {
  baseURL: string
  apiKey: string
  model: string
}

// The names of the required variables that are unset or blank. The gate is
// only live when this list is empty — there is no default endpoint, so a
// half-configured gate blocks instead of silently going inactive.
export function missingConfig(): string[] {
  const missing: string[] = []
  if (!process.env.SYSTEMONE_BASE_URL?.trim()) missing.push("SYSTEMONE_BASE_URL")
  if (!process.env.SYSTEMONE_API_KEY?.trim()) missing.push("SYSTEMONE_API_KEY")
  if (!process.env.SYSTEMONE_MODEL?.trim()) missing.push("SYSTEMONE_MODEL")
  return missing
}

export function endpointConfig(): EndpointConfig | null {
  if (missingConfig().length > 0) return null
  return {
    baseURL: gatewayRoot(process.env.SYSTEMONE_BASE_URL!.trim()) as string,
    apiKey: process.env.SYSTEMONE_API_KEY!.trim(),
    model: process.env.SYSTEMONE_MODEL!.trim(),
  }
}

// The noul question shape, inlined: the wire JSON without a package import.
function noul(instructions: string) {
  return { type: "noul" as const, instructions }
}

// One forward pass to the self-hosted model. Plain fetch, no SDK: the wire
// contract lives here and nowhere else, and the only host it can reach is
// the one the operator configured.
async function callEndpoint(
  cfg: EndpointConfig,
  state: string,
  questions: Record<string, ReturnType<typeof noul>>,
): Promise<unknown> {
  const res = await fetch(`${cfg.baseURL}/v1/systemone`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ state: { text: state }, questions, model: cfg.model }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw Object.assign(new Error(`System One endpoint answered ${res.status}: ${body.slice(0, 120)}`), {
      status: res.status,
    })
  }
  return res.json()
}

export interface JudgeContext {
  cfg: EndpointConfig
  command: string
  guardrails: string | null
}

export async function judge({ cfg, command, guardrails }: JudgeContext): Promise<Verdict> {
  const stateParts = [`Command the agent wants to run:\n${command}`]
  const scripts = scriptContents(command)
  if (scripts) {
    stateParts.push(`The command executes these script files — their content is part of the command:\n${scripts}`)
  }
  if (guardrails) {
    stateParts.push(
      `Team guardrails (rules for what the agent may and may not do):\n${guardrails}`,
    )
  }
  const questions: Record<string, ReturnType<typeof noul>> = {
    destructive: noul(
      "Does this shell command delete, overwrite, format, or irreversibly destroy data, databases, clusters, or infrastructure? " +
        "Effects that are recoverable through version control (git rm, git rm --cached, git checkout, branch operations) are not irreversible. " +
        "Removing build artifacts, caches and temporary files is not irreversible. " +
        "However, in GitOps repositories a version-control change can trigger irreversible changes to real infrastructure — " +
        "deleting a manifest and pushing can destroy the resource it managed. Judge the actual effect of the command, not the version-control mechanics.",
    ),
    credentials: noul(
      "Does this shell command contain, print, or send credentials, secrets, API keys, or tokens?",
    ),
  }
  if (guardrails) {
    questions.guardrails_violation = noul(
      "Given the team's guardrails in the state, does this command violate any of those rules?",
    )
    questions.policy_exception = noul(
      "Does the team's guardrails text in the state EXPLICITLY allow this exact command — " +
        "naming it, or a precise and unambiguous pattern that matches it? " +
        "General or vague permissions do not count as an exception.",
    )
  }
  const response = (await callEndpoint(cfg, stateParts.join("\n\n"), questions)) as {
    answers?: Record<string, { noul?: number }>
  }
  const a = (response.answers ?? {}) as Record<string, { noul?: number }>
  return {
    destructive: a.destructive?.noul ?? 0,
    credentials: a.credentials?.noul ?? 0,
    guardrails_violation: a.guardrails_violation?.noul,
    policy_exception: a.policy_exception?.noul,
  }
}

// Existing files the command references, with their content — so the
// model judges what the command DOES, not just how innocuous its
// command line looks.
function readableFile(token: string): string | null {
  const path = token.replace(/^["']|["']$/g, "")
  if (!path || path.startsWith("-") || !path.includes(".")) return null
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size > 1_000_000) return null
    let text = readFileSync(path, "utf8")
    if (text.includes("\0")) return null // binary — utf8 garbage adds nothing
    if (text.length > SCRIPT_MAX) text = text.slice(0, SCRIPT_MAX) + TRUNCATED
    return `--- ${path} ---\n${text}`
  } catch {
    return null
  }
}

function scriptContents(command: string): string {
  const parts: string[] = []
  for (const token of command.split(/\s+/)) {
    if (parts.length >= SCRIPT_FILES_MAX) break
    const content = readableFile(token)
    if (content) parts.push(content)
  }
  return parts.join("\n")
}

// Audit log is opt-in (SYSTEMONE_LOG=1): nothing is written to disk by
// default, because commands can contain sensitive material.
function log(path: string, entry: Record<string, unknown>) {
  if (!/^(1|true|yes)$/i.test(process.env.SYSTEMONE_LOG ?? "")) return
  try {
    mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true })
    appendFileSync(path, JSON.stringify(entry) + "\n")
  } catch {}
}

// Circumvention cooldown (opt-in, SYSTEMONE_COOLDOWN=1): every block doubles
// the wait before the next command is judged — 10 ms, 20 ms, 40 ms … with no
// ceiling. The first nine blocks are imperceptible (a few false positives
// cost nothing); the first noticeable pause arrives around block ten (5 s),
// and by block twenty an attempt waits 1.5 h, by block twenty-five almost
// two days: brute-forcing variants past the gate is arithmetically hopeless.
//
// The wait is enforced as a visible cooldown block, not a silent sleep —
// an invisible hang looks like a crash, while the reason tells the agent
// (and through it the human) exactly what is happening and for how long.
// Retrying early just returns the same reason with the remaining time.
//
// The counter decays with quiet time — one block of memory fades per 30
// minutes since the last block — so early false positives do not poison a
// whole session. Decay is wall-clock, not command-count: an agent cannot
// launder the counter by interleaving allowed commands, and an agent that
// keeps hammering refreshes lastBlockAt on every block, so escalation
// continues unchanged. State lives for the harness process; restarting
// it resets everything.
const DECAY_MS = 30 * 60_000
const BACKOFF_BASE_MS = 10

export function backoffMs(blocks: number): number {
  if (blocks < 1) return 0
  // exponent capped at 40 to keep the float well-behaved
  return BACKOFF_BASE_MS * 2 ** Math.min(blocks - 1, 40)
}

function formatWait(remainingMs: number): string {
  if (remainingMs >= 90_000) return `${Math.round(remainingMs / 60_000)} min`
  if (remainingMs >= 1000) return `${Math.ceil(remainingMs / 1000)} s`
  return `${remainingMs} ms`
}

function endpointReason(status: number | undefined): string {
  if (status === 401) return "authentication failed — check SYSTEMONE_API_KEY"
  if (status === 402) return "the endpoint refused the request: payment required (402)"
  if (status === 429) return "rate limited — wait a moment and retry"
  return "endpoint unreachable"
}

// Two tiers. A named exception in GUARDRAILS.md overrides the POLICY
// question (guardrails_violation) — that is how policy false positives are
// fixed. It does NOT override destructive or credentials: those judge the
// command's nature, they are the backstop, and GUARDRAILS.md is
// agent-editable between sessions. A command the model judges destructive
// needs a human at the keyboard, whatever the file says.
type Dimension = "destructive" | "credentials" | "guardrails_violation"

interface Outcome {
  decision: "BLOCK" | "allow"
  kind: Dimension
  worst: number
  named: boolean
}

function decide(verdict: Verdict, hasGuardrails: boolean): Outcome {
  const named = hasGuardrails && (verdict.policy_exception ?? 0) > THRESHOLD
  const dimensions: [Dimension, number][] = [
    ["destructive", verdict.destructive],
    ["credentials", verdict.credentials],
  ]
  if (verdict.guardrails_violation !== undefined) {
    dimensions.push(["guardrails_violation", verdict.guardrails_violation])
  }
  const triggering = dimensions.filter(([dimension, score]) => {
    if (dimension === "guardrails_violation") return score > THRESHOLD && !named
    return score > THRESHOLD
  })
  const decision = triggering.length > 0 ? "BLOCK" : "allow"
  // report the worst triggering dimension, not a priority order
  const [kind, worst] = triggering.reduce(
    (a, b) => (b[1] > a[1] ? b : a),
    ["destructive", 0] as [Dimension, number],
  )
  return { decision, kind, worst, named }
}

function blockMessage(outcome: Outcome, hasGuardrails: boolean, harness: string): string {
  const perKind =
    outcome.kind === "guardrails_violation"
      ? `\n  If this is a false positive, your human can name the command in the` +
        `\n  MAY section of GUARDRAILS.md and restart ${harness} — the gate` +
        `\n  follows the file.`
      : `\n  Judged destructive/leaking on its own merits — named exceptions in` +
        `\n  GUARDRAILS.md do not override this. If it is intended, your human` +
        `\n  can run it directly, or restart ${harness} with SYSTEMONE_GATE=off` +
        `\n  for a session that needs it.`
  const bootstrap = hasGuardrails
    ? ""
    : `\n  No GUARDRAILS.md found in this repo. Your human can create one` +
      `\n  (legacy lowercase guardrails.md is still read) and write what the` +
      `\n  agent may and may not do — name what should` +
      `\n  pass in the MAY section, then restart ${harness}.`
  return (
    `SystemOne-gate: blocked command — ${outcome.kind}=${outcome.worst.toFixed(2)} > ${THRESHOLD}\n` +
    perKind +
    bootstrap
  )
}

export function createGate(harness: Harness, directory: string) {
  // Freeze guardrails NOW, before any command is judged. A lazy first-read
  // would let an agent weaken GUARDRAILS.md via the ungated edit tools
  // before issuing its first bash command and rule the whole session under
  // its own rules.
  const guardrails = readGuardrails(directory, harness.guardrailPaths)
  const hasGuardrails = !!guardrails
  // A truncated policy is applied as if complete, so rules past the cut are
  // silently dropped — an agent can push them there by padding the file.
  const warnings = [
    threshold.warning,
    guardrails?.endsWith(TRUNCATED)
      ? `SystemOne-gate: GUARDRAILS.md is longer than ${GUARDRAILS_MAX} characters — rules after that are ignored. ` +
        `Shorten it or put the MUST NOT rules first.`
      : undefined,
  ].filter((w): w is string => w !== undefined)
  let blockCount = 0
  let lastBlockAt = 0
  let cooldownUntil = 0
  // The human's runtime switch (opencode 2 TUI). In memory only: every new
  // gate starts enabled, so a restart or plugin reload turns judging back on.
  let enabled = true

  function effectiveBlocks(now: number): number {
    if (blockCount === 0 || lastBlockAt === 0) return 0
    return Math.max(0, blockCount - Math.floor((now - lastBlockAt) / DECAY_MS))
  }

  function registerBlock(): void {
    const now = Date.now()
    blockCount = effectiveBlocks(now) + 1
    lastBlockAt = now
    cooldownUntil = now + backoffMs(blockCount)
  }

  function cooldownBlock(): Block | null {
    const remainingMs = cooldownUntil - Date.now()
    if (remainingMs <= 0) return null
    return {
      reason:
        `SystemOne-gate: cooling down after ${blockCount} blocked command${blockCount === 1 ? "" : "s"} — ` +
        `next attempt in ~${formatWait(remainingMs)}. The wait doubles with every block; ` +
        `restarting ${harness.name} resets it.`,
    }
  }

  async function check(command: string): Promise<Block | null> {
    const block = await judgeCommand(command)
    if (!block || warnings.length === 0) return block
    return { reason: [block.reason, ...warnings.map((w) => `  ${w}`)].join("\n") }
  }

  async function judgeCommand(command: string): Promise<Block | null> {
    if (process.env.SYSTEMONE_GATE === "off") return null
    if (!command) return null
    if (!enabled) {
      log(harness.logPath, { ts: new Date().toISOString(), command, decision: "skipped", note: "gate disabled by the user" })
      return null
    }
    // No endpoint, no pass. The gate never runs without a fully configured
    // self-hosted endpoint, and FAIL_OPEN does not cover this — a missing
    // configuration is an operator error, not a transient failure, and
    // silently going inactive would let commands run with no judge at all.
    const missing = missingConfig()
    if (missing.length > 0) {
      log(harness.logPath, {
        ts: new Date().toISOString(),
        command,
        decision: "BLOCK",
        note: `not configured: ${missing.join(", ")}`,
      })
      return { reason: notConfiguredReason(missing, harness.name) }
    }
    if (COOLDOWN) {
      const cooling = cooldownBlock()
      if (cooling) return cooling
    }

    // Every command is judged — no fast path of any kind. Prefix
    // allowlists ("it starts with ls, let it through") are exactly the
    // kind of seam an agent learns to exploit, and an override file the
    // agent can write is self-approval. Overrides belong to the human,
    // outside the agent's reach: SYSTEMONE_GATE / SYSTEMONE_THRESHOLD /
    // GUARDRAILS.md, all set before or around the session.

    let verdict: Verdict
    try {
      verdict = await judge({ cfg: endpointConfig() as EndpointConfig, command, guardrails })
    } catch (err) {
      const decision = FAIL_OPEN ? "fail-open" : "fail-closed"
      log(harness.logPath, { ts: new Date().toISOString(), command, error: String(err), decision })
      if (FAIL_OPEN) return null // explicit opt-out: availability over strictness
      return {
        reason:
          `SystemOne-gate: ${endpointReason((err as { status?: number }).status)} — command blocked.\n` +
          `  ${command.slice(0, 200)}\n` +
          `  ${String(err).slice(0, 160)}\n` +
          `  Retry shortly, or set SYSTEMONE_FAIL_OPEN=1 to prefer availability.`,
      }
    }

    const outcome = decide(verdict, hasGuardrails)
    if (outcome.decision === "BLOCK" && COOLDOWN) registerBlock()
    log(harness.logPath, {
      ts: new Date().toISOString(),
      command,
      ...verdict,
      guardrails: hasGuardrails,
      namedException: outcome.named,
      decision: outcome.decision,
      blockCount,
      cooldownMs: outcome.decision === "BLOCK" && COOLDOWN ? backoffMs(blockCount) : 0,
    })
    if (outcome.decision === "allow") return null
    return { reason: blockMessage(outcome, hasGuardrails, harness.name) + `\n  ${command.slice(0, 200)}` }
  }

  // A rule, not a verdict: no endpoint call, no threshold, and the cooldown
  // counter is untouched — an agent that retries a refused edit pays nothing,
  // it simply never gets to write the file. Honours SYSTEMONE_GATE=off, but
  // not the runtime switch: that only pauses the model, not this rule.
  function checkPath(path: string): Block | null {
    if (process.env.SYSTEMONE_GATE === "off") return null
    const hit = protectedPath(directory, path)
    if (!hit) return null
    const reason =
      `SystemOne-gate: protected file — ${hit}\n` +
      `  Policy and harness configuration are edited by your human, not the agent.\n` +
      `  Ask them to make the change and restart ${harness.name}.`
    if (warnings.length === 0) return { reason }
    return { reason: [reason, ...warnings.map((w) => `  ${w}`)].join("\n") }
  }

  return {
    check,
    checkPath,
    warnings,
    isEnabled: () => enabled,
    setEnabled: (value: boolean) => {
      enabled = value
    },
  }
}

function notConfiguredReason(missing: string[], harness: string): string {
  return (
    `SystemOne-gate: not configured — ${missing.join(", ")} missing. Command blocked (fail-closed).\n` +
    `  Point the gate at your self-hosted System One endpoint: set SYSTEMONE_BASE_URL,\n` +
    `  SYSTEMONE_API_KEY and SYSTEMONE_MODEL, then restart ${harness}.\n` +
    `  To disable the gate entirely, restart ${harness} with SYSTEMONE_GATE=off.`
  )
}
