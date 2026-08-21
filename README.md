# Ropex

Git is the control plane. Agents are the workload. GitHub is the queue.

The name is from **RoPE** (rotary position embeddings) — the trick that lets a transformer keep many tokens in one coherent sequence. Ropex does the same for agents: one git sequence, many workers in position.

Ropex treats agents the way Kubernetes treats pods: you declare desired state in git, a controller derives workers, and they reconcile toward it. Each worker is **DeepSeek Harness** (everything is a plugin) plus **Hermes** (soul, memory, skills, a closed learning loop).

GitHub stops being a place humans dump work and starts being the API agents already speak: issues in, pull requests out.

## Why this exists

Coding agents today are single-player. You open a chat, one model loops on one repo, and scale means "buy more seats." That is the opposite of how software already ships.

- **DeepSeek Harness** already made the kernel composable: model, tools, loop, permissions, and even the agent loop are plugins (Cordis).
- **Hermes Agent** already made the brain durable: named bots, memory, skills that improve while they run, scheduled work.
- **GitOps** already showed how to run *huge* numbers of identical workloads from a repo: declare replicas, select targets, cap with policy, reconcile drift.

Ropex is the missing control plane that multiplies those two runtimes across GitHub the way Fleet/Flux multiplied Kubernetes across clusters.

```
git (desired)          GitHub (work)
   │                      │
   │  Agent / Fleet YAML  │  issues, PRs, checks
   ▼                      ▼
        Ropex controller
        derive N workers
                 │
                 ▼
     worker = Hermes brain
            + DeepSeek harness
```

Scale is a git commit: change `spec.replicas` from `20` to `2000`. The controller creates workers. Policy caps blast radius. No dashboard required.

## Quick start

```sh
npm install
npm test
npx tsx src/cli.ts apply fleets/examples
npx tsx src/cli.ts status
npx tsx src/cli.ts github simulate issues.opened --repo acme/app --title "login is broken"
npx tsx src/cli.ts run --agent triage "summarize open bugs"
```

`apply` reads YAML, expands fleets, applies policy, and writes `.ropex/state.json`. That local store is a stand-in for a real cluster; the contract is the same.

## Manifests

```yaml
apiVersion: ropex.dev/v1
kind: Fleet
metadata:
  name: pr-factory
spec:
  replicas: 20
  template:
    spec:
      harness:
        profile: code          # DeepSeek: standard | code | minimal | creator
        model: deepseek-v4-pro
        plugins: [github, fs, shell]
      hermes:
        soul: souls/builder.md
        memory: sqlite
        learning: true
        skills: [implement-issue, open-pr]
      github:
        events: [issues.labeled]
        deliver: pull_request
      selector:
        matchLabels:
          org: acme
```

Kinds:

| Kind | Role |
| --- | --- |
| `GitRepo` | Where the controller pulls desired state |
| `Agent` | One named worker type (Hermes bot + harness profile) |
| `Fleet` | Replica set of agents, selected onto repos |
| `Policy` | Max replicas and permission denylist |

## Runtime split

**Hermes** plans: soul + skills + memory decide *what* to do and learn from the trajectory.

**DeepSeek Harness** executes: a plugin kernel runs the loop (`tool-calls` or Code-mode collapsed program), tools, permissions, session, and GitHub delivery.

Neither is a wrapper slogan. `src/plugins.ts` is a Cordis-shaped kernel. `src/hermes.ts` is the learn-loop. `src/runtime.ts` is the glue. `src/controller.ts` is the GitOps reconciler.

## GitHub as the agent OS

1. Human (or another agent) opens an issue.
2. Controller matches `github.events` + label selectors.
3. An idle worker runs the task.
4. Delivery plugin writes a comment, check, or pull request.
5. If Hermes learning is on, a skill is persisted for the next replica.

GitHub already has auth, review, CI, and blame. Ropex uses that instead of inventing another agent console.

## Status

Immutable workers (agent image digests) + Hermes/DeepSeek workflow stages are in the control plane. Still a local prototype: simulated tools, no live DeepSeek or Hermes process yet.

## License

MIT
