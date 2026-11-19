# guardrails-md

Stops your coding agent from running the bash command you'd regret.

Every bash command your coding agent ([opencode](https://opencode.ai),
[pi](https://pi.dev) or [Claude Code](https://code.claude.com)) is about to execute is
scored by a small decision model first, in about 100 ms. If the command
destroys data, leaks a secret, or breaks a rule in your repo's
`GUARDRAILS.md`, the call is blocked and the agent is told why, so it can
pick another route.

```
SystemOne-gate: blocked command — destructive=0.98 > 0.7
  rm -rf ./important-data
Judged destructive/leaking on its own merits — named exceptions in
GUARDRAILS.md do not override this. If it is intended, your human
can run it directly, or restart opencode with SYSTEMONE_GATE=off
for a session that needs it. The agent must not edit GUARDRAILS.md
to work around this.
```

## This fork: self-hosted only, no vendor traffic

This is a fork of [berget-ai/guardrails-md](https://github.com/berget-ai/guardrails-md)
hardened for a single operator requirement: **every judgment request goes to
your own self-hosted System One-compatible model and nowhere else.**

What changed compared to upstream:

- **No vendor defaults.** `SYSTEMONE_BASE_URL`, `SYSTEMONE_API_KEY` and
  `SYSTEMONE_MODEL` are required. There is no fallback URL anywhere in the
  codebase — unset means every command is blocked (fail-closed), nothing is
  sent anywhere.
- **No vendor SDK.** The `@typesafe-ai/sdk` dependency is gone; the wire
  contract is a plain `fetch` in `core.ts` (and `$.http.fetch` in the
  Claude Code hooks module). No third-party code can redirect your traffic.
- **No seat tokens.** The Berget OAuth / harness `auth.json` reading is
  removed. One key, one endpoint, configured by you.
- **Missing configuration fails closed.** A half-configured gate blocks
  commands instead of silently going inactive. `SYSTEMONE_FAIL_OPEN=1`
  covers transient endpoint errors only — never missing config.
- **The escalating cooldown is opt-in** (`SYSTEMONE_COOLDOWN=1`); off by
  default.
- A test (`package.test.ts`) fails the build if any production file ever
  references a vendor host, SDK or env var again.

### Endpoint setup

Point the gate at your model and give it a key:

```sh
export SYSTEMONE_BASE_URL=http://llama-cpp.internal:8081   # required
export SYSTEMONE_API_KEY=sk-…                        # required
export SYSTEMONE_MODEL=your-model-name               # required
```

The gate `POST`s to `<SYSTEMONE_BASE_URL>/v1/systemone` with:

```json
{
  "state": { "text": "Command the agent wants to run:\n<command>…" },
  "questions": {
    "destructive": { "type": "noul", "instructions": "…" },
    "credentials": { "type": "noul", "instructions": "…" }
  },
  "model": "<SYSTEMONE_MODEL>"
}
```

and expects back:

```json
{ "answers": { "destructive": { "noul": 0.01 }, "credentials": { "noul": 0.0 } } }
```

When a `GUARDRAILS.md` exists, two more questions
(`guardrails_violation`, `policy_exception`) are added and answered in the
same pass. Test your endpoint with:

```sh
curl -s "$SYSTEMONE_BASE_URL/v1/systemone" \
  -H "Authorization: Bearer $SYSTEMONE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"state":{"text":"Command the agent wants to run:\nrm -rf /backup"},"questions":{"destructive":{"type":"noul","instructions":"Does this command irreversibly destroy data?"}},"model":"'"$SYSTEMONE_MODEL"'"}'
```

## When it helps

Two situations where a pattern list leaves you exposed.

Teams that work close to production. The agent runs `kubectl`, `helm` and
`git push` all day, and the difference between routine and incident is your
team's policy, not a filename pattern. The gate reads that policy from
`GUARDRAILS.md` and applies it to every command.

Background agents that read mail, tickets or forms. Their input is written
by strangers, and a crafted message can talk an agent into running
something harmful. No one is watching when it happens. The gate does not
promise that the agent cannot be persuaded — it promises that the boundary
holds anyway, because the gate judges the command and your rules, not the
conversation that led to it.

## Not the guardrails.md convention

This project is unrelated to the [guardrails.md](https://guardrails.md/)
convention, where the agent appends its own lessons to `GUARDRAILS.md`. Here
the file is written by humans, so if your repo already follows that
convention, the edit tools will refuse the agent's writes to the file once the
gate is installed (bash writes are still judged, not hard-blocked; see
[Protected files](#protected-files)).

## Quickstart

Two steps. First teach the gate your rules, then put it in the harness.

**1. Add `GUARDRAILS.md` to your repo** (root, `.opencode/GUARDRAILS.md`,
`.pi/GUARDRAILS.md` or `.claude/GUARDRAILS.md`; the legacy lowercase
`guardrails.md` spellings are still read).
Write it yourself — the value is in deciding what your team actually allows,
not in shipping a generic file. The example below is a starting point for the
shape:

```markdown
# Guardrails for agents in this repo

## The agent MUST NOT

- Edit this file (GUARDRAILS.md) itself — it is written and changed by humans, through review.
- Change anything in production — production changes reach production only through Git/CD.
- Push directly to the main branch — all changes go through pull request.
- Install software outside the project's declared dependencies.
- Send data to external services outside our approved list (docs/approved-domains.md).
- Run irreversible operations against shared systems — deletions, cleanup, resets.

## The agent MAY

- Inspect any environment read-only.
- Run tests, lint, and builds locally.
- Create branches and push feature branches.
- Read documentation from the approved sources in docs/approved-domains.md.
```

The gate reads the file once at session start, so restart the harness after
editing. Only the first 2000 characters are sent to the model, so keep the
file short and put the MUST NOT rules first. If the file is longer, the gate
warns you in every block message and, except on opencode 2, also at startup.
The rules after the cut are not applied.
See [`guardrails.example.md`](guardrails.example.md) — copy it to `GUARDRAILS.md`.

**2. Install the gate in your harness.** This fork is not published to npm;
install it from a local clone or a git URL.

### opencode

For OpenCode V2, add the fork as a Git package in
`~/.config/opencode/opencode.jsonc` (global) or `opencode.jsonc` (per project).
Pin a full commit hash for reproducible deployment; this is the tested
self-hosted implementation revision:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:semidark/guardrails-md#eb2df00f3ae5e906b35f252a9319fb7e1e513d4f"]
}
```

OpenCode installs the package into its managed cache and loads the adapter
through the fork's `package.json` exports. No npm publication, local clone,
vendored copy, git submodule, or loader shim is needed. Missing packages install
in the background, so verify installation with `opencode plugin list` and the
server log before relying on the gate. Config changes reload automatically.

To update, push the new implementation to the fork and replace the pinned full
commit hash in your config. Exact hashes do not automatically advance.

For local development, V2 also accepts the **clone directory**, whose package
exports point at the adapter (not a path to a single `.ts` file):

```json
{
  "plugins": ["/home/you/src/guardrails-md"]
}
```

Legacy opencode 1.x reads `plugin` and accepts the adapter file path:

```json
{
  "plugin": ["/home/you/src/guardrails-md/adapters/opencode.ts"]
}
```

The plugin has no runtime dependencies, so a plain clone is enough — no
`npm install` needed.

### pi

From the cloned repo:

```sh
pi install /home/you/src/guardrails-md
```

### Claude Code

Load the plugin directory at the prompt of a running session:

```
/plugin install guardrails-md --marketplace /home/you/src/guardrails-md
```

Or for one session: `claude --plugin-dir /home/you/src/guardrails-md`.
It is a hooks module that Claude Code loads in-process from
`hooks/hooks.json`, so there is no build step and no `npm install`.

Hooks modules are an early-access Claude Code API; the engine may change
them between releases.

### Endpoint and key

Set the three required variables (see [Endpoint setup](#endpoint-setup))
and restart the harness/server process so it inherits the new environment
(OpenCode config changes alone do not update an existing process's environment):

```sh
export SYSTEMONE_BASE_URL=http://llama-cpp.internal:8081
export SYSTEMONE_API_KEY=sk-…
export SYSTEMONE_MODEL=your-model-name
```

From now on, every bash command your agent runs has to pass your guardrails
before it is allowed. Above the threshold the command is blocked with an
explanation the agent can read; below it, it runs. With any of the three
variables missing, every command is blocked (fail-closed) and nothing is
sent.

## Git pre-commit hook

The same judgement works as a git pre-commit hook: every commit's staged
diff is scored before it enters the repository. Personal data (GDPR) and
secrets are blocked; the team's own names in bylines and author fields pass.

Install from your clone (uses your global `core.hooksPath` if you have one,
otherwise copy to `.git/hooks/pre-commit` per repo):

```sh
cp /home/you/src/guardrails-md/hooks/pre-commit ~/.git-hooks/guardrails-pre-commit
chmod +x ~/.git-hooks/guardrails-pre-commit
```

Then chain it from your global pre-commit hook (or create one):

```bash
# ~/.git-hooks/pre-commit
python3 ~/.git-hooks/guardrails-pre-commit || exit 1
```

Same env config as the plugin. Fail-closed by default: missing configuration
or an unreachable endpoint blocks the commit — retry, or set
`SYSTEMONE_FAIL_OPEN=1` for endpoint failures.

## Why a model and not a regex

A deny-list of patterns knows `rm -rf`. It does not know that your team
forbids pushing to `main` but allows feature branches, or that `kubectl get`
is fine in prod while `kubectl apply` is not. Asking a second LLM to review
each command does know that, at the price of a full generation per command.

A System One decision model reads the command plus your written rules and
returns scores for a fixed set of questions in a single forward pass. That
makes two things possible.

The gate follows your policy. With the example guardrails below,
`git push origin HEAD:main` is a violation and `git push origin feature/x`
is not, even though both are a `git push`.

It also catches what the driving model shrugs at. An agent that prints a
`.env` file to "check the config" sees a harmless read. The gate sees
credentials leaving the file.

Judgment quality is entirely a property of the model you host — run your
own evals against your own traffic before trusting it.

## What it asks

| Question | Meaning |
|---|---|
| `destructive` | Does the command delete, overwrite, or irreversibly destroy data, databases, clusters, or infrastructure? Version-control-recoverable effects (git rm, checkout, branch operations) and removed build artifacts/caches are not irreversible — but in GitOps repositories a push can trigger irreversible infrastructure changes, so the actual effect is what gets judged. |
| `credentials` | Does the command contain, print, or send credentials, secrets, API keys, or tokens? |
| `guardrails_violation` | Does the command violate the team's `GUARDRAILS.md`? Asked only when the file exists. |
| `policy_exception` | Does the guardrails text explicitly name this command as allowed? Vague permissions do not count. Asked only when the file exists. |

Each answer is a score between 0 and 1. Anything above the threshold
(default `0.7`) blocks the tool call before execution, and the error message
goes back to the agent. The four questions are not interchangeable, and the
difference matters:

- `guardrails_violation` is about your policy, and policy false positives
  are fixable in the policy: a command the guardrails text explicitly names
  as allowed passes. The exception must be precise — "may manage databases"
  does not unlock `rm -rf /var/lib/postgresql`.
- `destructive` and `credentials` are about the command's nature, and named
  exceptions do not override them. Those two are the backstop, and
  `GUARDRAILS.md` is agent-editable between sessions — a file line must not
  be able to switch the backstop off.

## Protected files

Some files are not judged, they are simply out of the agent's reach. The
edit, write and patch tools refuse to touch a list of paths, relative to the
project root (an entry ending in `/` protects everything below it; no
globs):

```
GUARDRAILS.md
.agents/GUARDRAILS.md
.opencode/GUARDRAILS.md
.pi/GUARDRAILS.md
.claude/GUARDRAILS.md
the same five paths in lowercase — legacy aliases, each matched case-insensitively
opencode.json
opencode.jsonc
.opencode/
.pi/
.claude/settings.json
.claude/settings.local.json
.github/workflows/
```

While the gate is on, the refusal is deterministic — no model call, no
threshold, no cooldown, and retrying costs nothing — and the message tells the agent whose file this is:

```
SystemOne-gate: protected file — GUARDRAILS.md
  Policy and harness configuration are edited by your human, not the agent.
  Ask them to make the change and restart opencode.
```

Why this list: the gate freezes `GUARDRAILS.md` at session start, but a
session that could rewrite it with the Edit tool could rule the *next*
session under its own rules — the same self-approval hole as the removed
allow-file. `.opencode/` and `.pi/` hold the gate's own plugin and extension
files; `.claude/settings*.json` can disable the plugin (the rest of
`.claude/` — CLAUDE.md, skills, rules — is content an agent legitimately
edits); `.github/workflows/` is what runs your CI. Symlinks are resolved in
every harness, so a link that lands on a protected file is protected under
its own name too. Matching ignores case on every platform, so
`Guardrails.MD` is protected as well.

The list guards the file-editing tools, not bash: `echo >> GUARDRAILS.md` is
not matched against the list — it goes to the decision model like every
other command, subject to its judgement and your `GUARDRAILS.md`.

## Overriding a block

The agent cannot disable the gate or un-block a command by retrying, and
there is no override file it could write. The agent-reachable influence left
is narrow: the repo's `GUARDRAILS.md` itself is frozen for the running
session, and the edit tools refuse to touch it (and the other protected
paths) at all — see [Protected files](#protected-files). A rewrite can still
be attempted through bash, where it goes to the decision model like every
other command. Treat `GUARDRAILS.md` changes as code review, and
unattended agents should treat the file as untrusted input. Your overrides:

- **Once:** restart the harness with `SYSTEMONE_GATE=off` and redo the step.
- **Tune:** raise `SYSTEMONE_THRESHOLD` (it must stay below 1) if the gate
  is too jumpy for your taste.
- **Fix the policy:** if the block is a false positive against your rules,
  change `GUARDRAILS.md`. That is the durable fix, and since the file lives
  in the repo, the change goes through review like any other edit.

## Disclaimer

The gate is a trained model, not a deterministic rule engine. It will
occasionally judge a command wrong in both directions: blocking something
safe, or letting something risky through. This software is provided as a
tool, not a guarantee, and accepts no liability for decisions it gets wrong
or for damage done by commands it let pass. Keep the override and audit
paths, and treat the gate as one layer among several — scoped credentials,
sandboxes and human review still matter.

## What it doesn't do

- It gates bash commands only. Other tool calls pass through, except that
  the file-editing tools refuse to touch [protected
  paths](#protected-files). Every argument that points to an existing file
  is read and judged together with the command — whatever tool would run it
  (`bash x.sh`, `perl x.pl`, `dotnet x.csx`, `awk -f x.awk`, a data
  file passed to anything). This closes the write-then-run bypass
  where an agent writes logic with the ungated edit tools and executes
  it with an innocuous command line, and it needs no interpreter
  blocklist — those are never complete. Inline code (`perl -e '…'`)
  is already part of the command text. One level deep, 4 kB per file,
  up to three files, binaries skipped: network-fetched payloads
  (`curl … | sh`) remain a gap, and a determined agent with write
  access can still be creative. This is one layer, not a sandbox.
- It fails closed. If the endpoint is unreachable the command is blocked
  until the endpoint responds again. That is deliberate: with fail-open, an
  agent could induce the failure itself and then run anything unchecked.
  Each call gets one attempt with a 5 s timeout; a persistent failure
  blocks, and the agent relays the error. Interactive users who prefer
  availability can set `SYSTEMONE_FAIL_OPEN=1`, knowingly. Missing
  configuration is never fail-open — it always blocks.
- It sends every command to your endpoint to be judged. That is the whole
  mechanism — keep the endpoint on infrastructure you control. In this
  fork there is no other destination: no vendor URL, no vendor SDK, no
  seat-token plumbing.
- It is one layer. The driving model's own refusals are another, and neither
  replaces scoped credentials or a sandbox.
- Earlier versions read an override file at
  `~/.cache/opencode/systemone-gate.allow`. That mechanism is removed — the
  agent could write the file itself — and the file is now ignored.
- It does not decode obfuscated payloads. A command like
  `echo <base64> | base64 -d | sh` is judged on its visible text, and in
  upstream testing an encoded `rm -rf` inside a base64 blob scored as
  harmless. Direct instruction injection aimed at the model — "ignore
  previous instructions", fake JSON answers, authority claims, prompts in
  other languages — did not move the verdict in upstream testing, but
  encoding is a real gap. If your agents run untrusted input, treat encoded
  pipelines as blocked territory in `GUARDRAILS.md`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SYSTEMONE_BASE_URL` | **required** | Your System One gateway root or full `/v1/systemone` URL. No vendor fallback — unset blocks everything |
| `SYSTEMONE_API_KEY` | **required** | Bearer token for your endpoint. Unset blocks everything |
| `SYSTEMONE_MODEL` | **required** | Model id as exposed by your gateway. Unset blocks everything |
| `SYSTEMONE_THRESHOLD` | `0.7` | Block threshold, strictly between 0 and 1. Anything else (`abc`, empty, `0`, `1`, …) falls back to `0.7` with a warning |
| `SYSTEMONE_FAIL_OPEN` | – | Set to `1` to let commands run when the endpoint is unreachable (default is fail-closed; missing config always blocks) |
| `SYSTEMONE_GATE` | – | Set to `off` to disable the gate |
| `SYSTEMONE_COOLDOWN` | – | Set to `1` to enable the escalating circumvention cooldown (off by default) |
| `SYSTEMONE_LOG` | – | Set to `1` to write the audit log |

With any required variable missing the gate blocks every command with a
`not configured` reason and sends nothing.

## Circumvention slows itself down (opt-in)

With `SYSTEMONE_COOLDOWN=1`, every block doubles the wait before the next
command is judged: 10 ms, 20 ms, 40 ms … with no ceiling. The first nine
blocks are imperceptible — a few false positives cost nothing. The first
noticeable pause arrives around block ten (5 s), by block twenty an attempt
waits 1.5 hours, by block twenty-five almost two days. An agent shopping
for variants past the gate runs out of time long before it runs out of
ideas. Without the flag, blocks are plain blocks and nothing escalates.

On top of that, the counter fades with quiet time — one block of memory
per 30 minutes — so early false positives heal instead of poisoning the
whole session. The fade is wall-clock: an agent cannot launder the
counter by interleaving allowed commands, and one that keeps hammering
refreshes the clock on every block, so escalation continues unchanged.

The wait is a visible cooldown, not a silent hang: the next command gets
an error saying exactly what is happening —

```
SystemOne-gate: cooling down after 3 blocked commands — next attempt in ~5 s.
The wait doubles with every block; restarting opencode resets it.
```

Retrying early returns the same message with the remaining time and does
not extend the cooldown. Restarting the harness resets the counter; the
audit log records the block count and cooldown with every verdict.

## Details

There is no fast path: every command is judged, including `git status` and
`ls`. Prefix allowlists are the classic seam an agent learns to exploit —
`ls` followed by a newline and `rm -rf`, or a harmless `echo` carrying a
destructive tail — so the gate does not have one, and neither does it have
an override file the agent could write to.

Every command costs one `POST /v1/systemone`. All questions are
answered in the same forward pass, so adding a question type costs
milliseconds and no extra round-trip. The questions use the `noul` type from
the System One contract; any endpoint that implements the contract works.

Nothing is written to disk unless you turn on the audit log. With
`SYSTEMONE_LOG=1`, every verdict is appended as JSONL to the harness's log
file (see [Harness differences](#harness-differences)) with the full command and all scores.
Verdicts you disagree with can be reviewed there and fed back as training
data for the next fine-tune. The log holds whatever your commands hold, so
treat it as sensitive.

For OpenCode installation, use the [pinned Git package configuration](#opencode)
above. Keep code changes in the fork rather than copying runtime files into your
dotfiles. If migrating from an older vendored or shim deployment, move the old
`~/.config/opencode/plugins/guardrails-md/` directory outside the discovered
plugins directory after confirming the Git package has loaded, to avoid loading
both versions. Removing a chezmoi source file does not delete an orphaned target.

## Harness differences

The judging is the same in every harness: same questions, threshold,
cooldown and fail-closed default. opencode and pi share [`core.ts`](core.ts);
the Claude Code module carries its own copy of the questions, decision,
block wording and cooldown, because a hooks module runs without Node and
imports only files of the plugin. Keep the two in step when editing
either. What differs is where the gate looks.

| | opencode | pi | Claude Code |
|---|---|---|---|
| Hook | 1.x `tool.execute.before`: bash judged; `edit`, `write` and `apply_patch` checked against the protected paths. 2.x `tool.hook("execute.before")`: the same for `shell`, `edit`, `write` and `patch` | `tool_call`, including calls a codemode script makes: bash judged; `edit` and `write` checked against the protected paths | hooks module: `tool.call` on `Bash` and on `Monitor` when it runs a `command`; `Edit`, `Write` and `NotebookEdit` checked against the protected paths; `session.start` freezes the policy, the root and the environment |
| On block | throws; the agent reads the message | returns `{ block, reason }` to the agent and shows a warning to you (on stderr in `pi -p`) | answers `{ deny }`; Claude reads the reason |
| Without configuration | every command blocked (fail-closed), nothing sent | every command blocked (fail-closed), nothing sent | every command denied (fail-closed); a toast warns you at session start |
| Policy file | `GUARDRAILS.md`, then `.opencode/GUARDRAILS.md` (lowercase legacy names after) | `GUARDRAILS.md`, then `.pi/GUARDRAILS.md` (lowercase legacy names after) | `GUARDRAILS.md`, then `.claude/GUARDRAILS.md` (lowercase legacy names after) |
| Policy read from | the project directory opencode passes the plugin | the directory pi was started in | the session's directory, frozen at `session.start` |
| Audit log | `~/.cache/opencode/systemone-gate.log` | `~/.cache/pi/systemone-gate.log` | not supported (`$.fs` cannot append) |
| Protected files | `edit`, `write`, `apply_patch` (2.x: `patch`) refuse protected paths; a block throws | `edit` and `write` refuse protected paths; a block returns `{ block, reason }` and warns you | `Edit`, `Write` and `NotebookEdit` refuse protected paths; the module answers `{ deny }`. Symlinks are resolved in all three |

In pi, `/reload` counts as a restart: it re-reads `GUARDRAILS.md` and resets
the cooldown. pi's `powershell` tool is not gated; if a repo enables it in
`.pi/settings.json`, commands run through it skip the gate.

In Claude Code, the module lives as long as the session, so the frozen
policy, the environment and the cooldown stay in memory, as in opencode
and pi. `session.start` fires once per session and not on `/compact`, so
compaction neither re-reads `GUARDRAILS.md` nor resets the cooldown;
`/clear` keeps both too. Starting a new session, or a hot reload while
developing the plugin, re-reads `GUARDRAILS.md` and resets the cooldown.

Claude Code skips a hook that throws or overruns and lets the call
through, so the module attaches a `.catch` handler that denies instead:
the gate fails closed. If `session.start` never ran, every command is
denied. The endpoint call goes through Claude Code's own `$.http.fetch`:
when your organization's web-fetch policy refuses your
`SYSTEMONE_BASE_URL`, the call fails and the command is denied like
any unreachable endpoint (or allowed with `SYSTEMONE_FAIL_OPEN=1`).
The call times out after 5 s, as it does in opencode and pi, and a
timeout is treated like an unreachable endpoint. The module makes one
attempt with no retry on 429 or 5xx. The `SYSTEMONE_*` variables are
read once, at `session.start`; changing them takes a new session.

`Bash` is gated, and so is `Monitor` when it runs a shell `command` (a
Monitor watching a WebSocket runs nothing and passes). `PowerShell` is not
gated, mirroring pi's decision: on Windows without Git Bash, where Claude
Code registers only PowerShell, the gate never fires. `Edit`, `Write` and
`NotebookEdit` are not judged, but refuse writes to the [protected
paths](#protected-files).

To test the module, run `npm run test:claude`. It copies the plugin to a
temp folder and runs `claude plugin test` there, because that command
would otherwise pick up the vitest files.

## License

MIT
