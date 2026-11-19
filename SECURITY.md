# Security Policy

This repository is a self-hosted fork of
[berget-ai/guardrails-md](https://github.com/berget-ai/guardrails-md).
All judgment traffic goes to your own System One-compatible endpoint and
nowhere else — there is no vendor service behind it.

## Reporting a vulnerability

Email me@semidark.net, or open a GitHub Security Advisory
("Report a vulnerability" under the Security tab). Please do not open a
public issue for anything exploitable.

## Scope

- The gate code in this repository (core.ts, the opencode and pi adapters
  in adapters/, the Claude Code hooks module in hooks/register.ts, and the
  git pre-commit hook in hooks/pre-commit).
- This fork is not published to npm; install from the repository.

## Known limitations (by design, documented in the README)

These are documented design decisions, not vulnerabilities — but if you
find a way to break the stated guarantees, we want to hear about it:

- The gate judges bash commands only; other tool calls pass through, except
  that the file-editing tools refuse writes to protected paths in every
  harness (see the protected list in the README). A bash write such as
  `echo >> GUARDRAILS.md` is not matched against the list — it is judged by
  the model, not by the list. In pi, the
  `powershell` tool is not gated; in Claude Code, `Bash` and `Monitor`'s
  shell `command` are gated and `PowerShell` is not.
- The protected list is relative to the project root. Configuration outside
  it — `~/.claude/settings.json`, `~/.config/opencode/opencode.json`, a
  user-scope plugin install — is not protected, and an agent can edit it.
- Claude Code hooks modules are an early-access API. The module fails
  closed through its `.catch` handler; an engine change that bypassed
  module hooks entirely would leave Bash ungated.
- opencode 2 skips a plugin that fails to load and only writes a warning to
  its log, so bash runs ungated. Releases without opencode 2 support fail
  this way. `opencode plugin list` shows whether the gate is loaded.
- `GUARDRAILS.md` is read once at session start but lives in the repo —
  the edit tools refuse to touch it and the other protected paths, and the
  running session judges under the frozen copy, but a bash write can still
  weaken the rules for the next session, including by padding the file so
  rules fall past the 2000-character limit. The gate warns when the file is
  cut, but does not apply the cut rules.
- The gate does not decode obfuscated payloads (base64 etc.).
- Judgment quality is a property of the model you host. A trained
  classifier errs in both directions — run your own evals against your own
  traffic before trusting it.

## Data handling

Commands are sent to the endpoint you configure via `SYSTEMONE_BASE_URL`
for scoring. That endpoint is entirely under your control: retention,
logging and transport security are yours to decide, so host it on
infrastructure you trust. With any of the three required variables
(`SYSTEMONE_BASE_URL`, `SYSTEMONE_API_KEY`, `SYSTEMONE_MODEL`) missing,
nothing is sent anywhere and every command is blocked (fail-closed).
Audit logging is opt-in (`SYSTEMONE_LOG=1`) and writes to your local
machine only; the Claude Code module has no audit log. In Claude Code the
request goes through Claude Code's own HTTP client, under your
organization's web-fetch policy.
