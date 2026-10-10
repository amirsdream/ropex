# Worker runtimes

Ropex schedules agents; it does not insist on who executes them. `spec.runtime.kind`
picks the executor for an agent's **execute** stage. Everything else — queue, scale,
policy, memory, skills, delivery, trajectories — is unchanged.

| Kind | What runs | Installed how |
| --- | --- | --- |
| `dsh` *(default)* | In-process Cordis kernel (DeepSeek Harness). `ROPEX_DSH_BACKEND=live` swaps in the headless `dsh` CLI. | Built in |
| `claude-code` | `claude -p` — Claude Code CLI, autonomous loop | `npm i -g @anthropic-ai/claude-code` |
| `codex` | `codex exec` — Codex CLI, autonomous loop | `npm i -g @openai/codex` |
| `copilot` | `copilot -p` — GitHub Copilot CLI, autonomous loop | `npm i -g @github/copilot` |
| `cursor` | `agent -p` — Cursor Agent CLI, autonomous loop | [Cursor CLI install](https://cursor.com/docs/cli/overview) (`agent` on `PATH`) |

Manual steps, starting from a clean checkout and a throwaway repo, are in [manual-runtime-checks.md](./manual-runtime-checks.md). Extra Cursor and Codex tasks are in [manual-runtime-tasks.md](./manual-runtime-tasks.md).

Check what is usable on this machine:

```bash
ropex runtimes          # one block per runtime
ropex runtimes --json   # same objects as GET /api/v1/runtimes
```

Each block starts with the runtime kind, then `status: ready` or
`status: not ready`. The following lines name the product, the binary, and
the credential source. A missing credential lists each accepted strategy on
its own line. `dsh` is embedded and always ready.

## The spine is unchanged

Hermes still owns three of the five stages. Only `execute` moves:

```
compose (hermes)  soul + memory + skills
plan    (hermes)  thoughts + intended actions
execute (runtime) dsh loop  │  or  `claude -p` / `codex exec` / `copilot -p` / `agent -p`
deliver (harness) comment · check · pull_request
learn   (hermes)  distil a skill from the trajectory
```

Only `execute` changes owner. Delivery still goes through the harness delivery
plugin, and policy, memory, skills and trajectories are untouched.

The difference is what `execute` is handed. `dsh` receives the Hermes plan as a
tool program and applies each call in the workspace. A CLI runtime is the same
harness with a different loop: `claude -p`, `codex exec`, `copilot -p`, or
`agent -p` receives a **brief** (`src/brief.ts`) — the same inputs rendered as a
prompt — and carries out those intended actions itself. A call is one tool invocation,
`{ name, input }`. The name is the agent's tool. The workspace only applies an
input that asks for a command (`argv`) or a file (`path` and `content`); every
other call stays with the agent, so a new tool does not need a new call shape.
The brief carries
identity, prior knowledge, skills, plan, intended actions, and the task. Claude Code,
Codex, and Cursor take that brief on **stdin** so a large soul cannot blow `ARG_MAX`. Copilot
still needs `-p <prompt>` for programmatic mode, so its brief stays on argv. On the host,
the CLI process gets `GIT_AUTHOR_*` and `GIT_COMMITTER_*` set to `Ropex <ropex@localhost>`,
the same identity every container exec already sets, so a commit is not the operator's.
The
CLI runs in the worker's git worktree and its output becomes the trajectory
observation.

Because one CLI run is an entire session rather than one tool call, it produces a
single `TrajectoryStep` tagged `runtime:<kind>`. Hermes' learning loop recognises
that shape, so skills are still distilled from a one-step CLI trajectory.

## Declaring a runtime

```yaml
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  runtime:
    kind: claude-code
    model: claude-opus-5
    timeoutMs: 900000      # default 600000
    # command: /usr/local/bin/claude       # override the binary
    # commandArgs: [claude]                # prefix args, e.g. for `npx claude`
    # requireEnv: [GH_TOKEN]               # extra env that must be present
    # auth: api-key                        # api-key | oauth | oauth-file
    # baseUrl: https://api.openai.com/v1   # codex api-key only
  harness:
    profile: code
    plugins: [fs, shell, github]
  hermes:
    soul: souls/builder.md
    memory: shared
    learning: true
    skills: []
```

`spec.runtime` is part of the **image digest**, so changing a runtime rolls that
agent's workers the same way changing its soul or profile does. Agents with no
`runtime:` block keep the digest they have today.

Binary resolution, in order: `spec.runtime.command` → `ROPEX_RUNTIME_BIN_<KIND>`
(e.g. `ROPEX_RUNTIME_BIN_CLAUDE_CODE`) → the runtime's default name on `PATH`.

See [`fleets/examples/multi-runtime.yaml`](../fleets/examples/multi-runtime.yaml)
for three agents on three runtimes sharing one queue and one policy.

## Policy translation

An autonomous CLI enforces its own tool permissions, so Ropex policy is pushed
down into the CLI's gate at boot:

| Ropex deny | claude-code | codex | copilot | cursor |
| --- | --- | --- | --- | --- |
| `fs`, `str_replace_editor` | `--disallowedTools Edit Write …` | `--sandbox read-only` | `--deny-tool write` | **unmappable** |
| `shell`, `bash` | `--disallowedTools Bash` | `--sandbox read-only` | `--deny-tool shell` | **unmappable** |
| `web` | `--disallowedTools WebFetch WebSearch` | **unmappable** | **unmappable** | **unmappable** |
| `github` | `--disallowedTools Bash(gh:*)` | **unmappable** | `--deny-tool github` | **unmappable** |
| `subagent` | `--disallowedTools Task` | **unmappable** | **unmappable** | **unmappable** |
| `inspect` | **unmappable** | **unmappable** | **unmappable** | **unmappable** |
| `memory` | already unavailable | already unavailable | already unavailable | already unavailable |

Three rules:

1. **Unmappable fails closed.** If a policy denies a tool the chosen runtime
   cannot gate, `bootWorker` throws and the task does not run. Ropex never
   silently enforces less than the policy declares.
2. **`requireApproval` becomes deny.** A headless CLI cannot pause mid-run for a
   Ropex approval, so approval-gated tools are forbidden outright for CLI
   runtimes. The Hermes-plan approval path in `runTask` is unaffected.
3. **Unknown names are advisory.** Deny entries that are not registered tool
   names (`prod-write`, `exfiltrate`, …) gate nothing in *any* runtime — nothing
   registers a tool under those names — so instead of failing closed they are
   restated in the brief as explicit prohibitions. Treating them as hard failures
   would be stricter than `dsh` and would break policies that ship today.

Every CLI runtime refuses to boot without a resolvable binary and one auth
strategy. The fleet names the method in `spec.runtime.auth`. It never carries
a key, a token, or a host path. When `auth` is omitted and exactly one strategy
has credentials, that strategy is used. When more than one does, boot fails
and asks for `spec.runtime.auth`.

| Runtime | `api-key` | `oauth` | `oauth-file` |
| --- | --- | --- | --- |
| `claude-code` | `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` | — |
| `codex` | `OPENAI_API_KEY` or `CODEX_API_KEY` | — | `~/.codex/auth.json`, or `ROPEX_AUTH_FILE_CODEX` |
| `copilot` | `GITHUB_TOKEN`, `COPILOT_CLI_TOKEN`, or `GH_TOKEN` | — | — |
| `cursor` | `CURSOR_API_KEY` | — | `~/.config/cursor/auth.json`, or `ROPEX_AUTH_FILE_CURSOR` |

Env strategies forward the selected variable by name. Claude and Copilot read
those variables themselves, so auth adds no flags. Codex `api-key` also selects
an HTTPS provider (`env_key` is the variable name, `supports_websockets=false`)
because the default provider reads `~/.codex/auth.json` and opens a websocket
that rejects an API key. `spec.runtime.baseUrl` overrides that provider's base
URL. The default is `https://api.openai.com/v1`. The key stays in the
environment. It is not written into the container, so a snapshot cannot
capture it.

Codex `oauth-file` does not rewrite the provider. On the host, Codex reads its
usual login file. In Docker the credential directory is bind-mounted read-only
at `/run/ropex/auth/codex` and `CODEX_HOME` points there. The file must be named
`auth.json`. A bind mount is not part of `docker commit`.

Cursor is that record. `api-key` forwards `CURSOR_API_KEY` and adds no flags
(the CLI also accepts `--api-key`, which would put the secret on argv, so Ropex
does not). `oauth-file` is the login from `agent login`. On the host the CLI
reads `~/.config/cursor/auth.json`. A file elsewhere must still be named
`auth.json` and sit in a directory named `cursor`; `XDG_CONFIG_HOME` is then
that directory's parent. In Docker the credential directory is bind-mounted
read-only at `/run/ropex/auth/cursor` and `XDG_CONFIG_HOME` is `/run/ropex/auth`.
There is no Cursor env-token `oauth` strategy. A provider URL or an env-var
name stays off the shared boot path.

## Flag accuracy

CLI flags move between releases, which is why they live in one table rather than
in adapter code. Details verified against a live `claude` binary, plus published
interfaces for the others:

- `--disallowedTools <tools...>` is **variadic**. Each pattern is a separate
  argv entry; comma-joining them produces one tool name that matches nothing, so
  the gate would silently disappear. It is therefore emitted last.
- `-p` is `--print` (a boolean). The brief is written to stdin, not placed as a
  positional after `-p` — that would hit `ARG_MAX` for large souls, and a
  positional last would be swallowed by the variadic `--disallowedTools` list.
- Codex `exec` is non-interactive but a sandbox escalation still prompts unless
  `-c approval_policy=never` is set. Copilot `-p` prompts on every tool unless
  `--allow-all-tools` is set; `--deny-tool` still wins over allow-all.
- Inside a Ropex container, Codex uses `--sandbox danger-full-access`. The
  container is created with `no-new-privileges`, so Codex's own `workspace-write`
  namespace cannot be created and both shell and file writes fail. A policy
  that denies `fs` or `shell` still selects `--sandbox read-only`. A host run
  stays on `workspace-write`. Claude and Copilot keep their own permission
  flags; the container hook is per runtime.
- Headless Cursor uses `--force` and `--trust` so a print-mode run can edit
  and run commands without a prompt. It has no per-tool deny flag, so a policy
  that denies `fs`, `shell`, `web`, `github`, `subagent`, or `inspect` refuses
  the run. Inside a Ropex container, Cursor adds `--sandbox disabled`. The
  container is created with `no-new-privileges`, and Cursor's own sandbox is
  the same class of nested sandbox that Codex cannot create there. A host run
  does not pass `--sandbox`, so the CLI keeps its own sandbox. This container
  flag follows the published `--sandbox` option and has not been exercised
  against a live `agent` binary in Docker.

The `claude-code` descriptor is verified against a live binary. Codex `api-key`
inside Docker was exercised against `@openai/codex`. The `copilot` and `cursor`
descriptors follow the published non-interactive flags (`copilot -p
--allow-all-tools`, `agent -p --force --trust --output-format json`) and have
not been exercised against an installed binary — check `ropex runtimes` and a
single task before trusting them in a fleet.

A CLI that reports failure in its payload while exiting 0 (Claude Code's
`is_error`) is treated as a failed run, not a successful one with odd output.

## Adding another CLI

Each CLI is one declarative record in `src/cli-runtimes/index.ts` — `argv`,
`permissions`, `containerArgs`, `auth`, `applyAuth`, `parse` — plus one member
of `WorkerRuntimeKind` in `src/types.ts`. Strategy selection is
`src/cli-runtimes/auth.ts`. A vendor adapter such as Codex is its own file
(`src/cli-runtimes/codex.ts`, `src/cli-runtimes/cursor.ts`). Flags move between CLI releases; keeping them
in the record is what makes that a one-line fix.

## A note on `command`

`spec.runtime.command` names a binary the control plane will execute. Fleet YAML
is desired state and already decides an agent's soul, tools and permissions, so
it carries the same trust level as code in this repo — review changes to it the
way you review a dependency bump, and keep `fleets/**` behind the same approval
as `src/**`.

## Containers

The published Ropex image does **not** bundle these CLIs — they are large npm
trees and most deployments want one. To run a CLI runtime in its own container,
declare `spec.sandbox` with `provider: docker` and list the CLI under
`image.npm`. Ropex builds the image, checks the repo out, forwards the
credentials by name and runs the CLI inside it. See [sandboxes.md](./sandboxes.md).

Without a sandbox the CLI runs on the host, in the worker worktree. Inside a
sandbox the binary is resolved in the container, so `spec.runtime.command` must
name a path inside the image and `ROPEX_RUNTIME_BIN_<KIND>` is not consulted.
