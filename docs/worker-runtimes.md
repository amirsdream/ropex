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

Check what is usable on this machine:

```bash
ropex runtimes          # or: curl -s :7780/api/v1/runtimes | jq
```

## The spine is unchanged

Hermes still owns three of the five stages. Only `execute` moves:

```
compose (hermes)  soul + memory + skills
plan    (hermes)  thoughts + intended actions
execute (runtime) dsh loop  │  or  `claude -p` / `codex exec` / `copilot -p`
deliver (harness) comment · check · pull_request
learn   (hermes)  distil a skill from the trajectory
```

Only `execute` changes owner. Delivery still goes through the harness delivery
plugin, and policy, memory, skills and trajectories are untouched.

The difference is what `execute` is handed. `dsh` receives the Hermes plan as a
tool program. A CLI runtime drives its own agentic loop, so it receives a
**brief** instead (`src/brief.ts`) — the same inputs rendered as a prompt:
identity, prior knowledge, skills, plan, intended actions, task. Claude Code and
Codex take that brief on **stdin** so a large soul cannot blow `ARG_MAX`. Copilot
still needs `-p <prompt>` for programmatic mode, so its brief stays on argv. The
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

| Ropex deny | claude-code | codex | copilot |
| --- | --- | --- | --- |
| `fs`, `str_replace_editor` | `--disallowedTools Edit Write …` | `--sandbox read-only` | `--deny-tool write` |
| `shell`, `bash` | `--disallowedTools Bash` | `--sandbox read-only` | `--deny-tool shell` |
| `web` | `--disallowedTools WebFetch WebSearch` | **unmappable** | **unmappable** |
| `github` | `--disallowedTools Bash(gh:*)` | **unmappable** | `--deny-tool github` |
| `subagent` | `--disallowedTools Task` | **unmappable** | **unmappable** |
| `inspect` | **unmappable** | **unmappable** | **unmappable** |
| `memory` | already unavailable | already unavailable | already unavailable |

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

Every CLI runtime also refuses to boot without credentials
(`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY` /
`CODEX_API_KEY`, `GITHUB_TOKEN` / `COPILOT_CLI_TOKEN` / `GH_TOKEN`) or a
resolvable binary.

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

The `claude-code` descriptor is verified against a live binary. The `codex` and
`copilot` descriptors follow the published non-interactive flags (`codex exec`,
`copilot -p --allow-all-tools`) but have not been exercised against an installed
binary — check `ropex runtimes` and a single task before trusting them in a fleet.

A CLI that reports failure in its payload while exiting 0 (Claude Code's
`is_error`) is treated as a failed run, not a successful one with odd output.

## Adding another CLI

Each CLI is one declarative record in `src/cli-runtimes.ts` — `argv`,
`permissions`, `parse` — plus one member of `WorkerRuntimeKind` in
`src/types.ts`. No new machinery. Flags move between CLI releases; keeping them
in one table is what makes that a one-line fix.

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

Set `spec.sandbox.git.commit: true` to commit whatever the CLI changed in that
workspace onto `ropex/{taskId}` after a successful execute. `git.push: true`
pushes the branch to `origin` before a docker sandbox is removed. See
[sandboxes.md](./sandboxes.md).

Without a sandbox the CLI runs on the host, in the worker worktree. Inside a
sandbox the binary is resolved in the container, so `spec.runtime.command` must
name a path inside the image and `ROPEX_RUNTIME_BIN_<KIND>` is not consulted.
