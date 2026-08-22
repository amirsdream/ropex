# Ropex idea log

Nightly capture. Newest first. Each entry should be one shippable idea, not a slogan.

## Outbound delivery stub + worker cordon/evict

Record intended webhook POSTs offline; cordon workers out of the scheduler; evict when idle.

**Shipped (2026-08-22 night):** `deliverOutbound`, `lifecycle` cordon/evict, `docs/api.md`.

## Placement constraints + config drift

`Agent.spec.placement` require/prefer labels and NoSchedule taints; workers inherit metadata labels + taints; claim honors `canPlace` / soft prefer score. `ropex drift` / `/api/v1/drift` report live vs desired without applying.

**Shipped (2026-08-22 night):** `src/placement.ts`, `src/drift.ts`, scheduler wiring.

## Queue latency + fairness

Claim-wait / run-duration percentiles from queue timestamps; idle skew + claim-count CV for LRU fairness. Surfaces on `ropex fairness`, Prometheus gauges, `/api/v1/fairness`.

**Shipped (2026-08-22 night):** `src/fairness.ts`, metrics wiring.

## Drift/fairness UI + skill promote + stage metrics

Control-plane view embeds drift + fairness; UI sections render them. `ropex skills promote|versions`. Trajectories store workflow stage ids; Prometheus `ropex_workflow_*_total`. Example fleet YAML declares placement.

**Shipped (2026-08-22 night):** UI panels, `promoteSkill`, `workflowStageCounts`, fleets/examples placement.

## Chaos hardening + budget/policy UI

Stronger chaos invariants (replica sum, digest/label/placement, drift agreement); canary-aware allow flag. Budget spend and policy simulate projected into `/api/v1/view` + UI.

**Shipped (2026-08-22 night):** `assertChaosInvariants` expansion, budget/policy UI rails.

## Clone progress + outbound UI

Clone attempts emit phase logs (`resolve`→`done`/`failed`) with progress %; remote stays fail-closed; `--dry-run` plans without writes; status on `gitRepoStatus` + `/api/v1/clone`. Outbound stub journal on the control-plane view/UI.

**Shipped (2026-08-22 night):** `planCloneAll`, `cloneStatusReport`, outbound/clone UI rails.

## Worktree GC + webhook idempotency + priority aging

`ropex gc` removes orphan sandbox worktrees. Webhook `x-github-delivery` remembered on `webhookSeen` (duplicate → no re-enqueue). Pending queue priorities age (+1/min, cap +10) via `effectivePriority` / `ropex age`. Example Policy includes `budget`. `ropex memory promote`.

**Shipped (2026-08-22 night):** `gcOrphanWorktrees`, webhook seen set, age boosts, memory promote CLI.

## Queue pause + sticky affinity + tick hooks

`ropex pause`/`resume` gates claims. Sticky worker affinity (agent+repo) with TTL on successful complete. `ropex compact` journal soft-cap. `ropex tick --gc --age --clone --compact N` runs hygiene hooks.

**Shipped (2026-08-22 night):** pause/resume, `src/affinity.ts`, `compactJournal`, tick options.

## Pause/affinity/dsh UI + live scaffold

Control-plane view exposes `queuePaused`, affinity bindings, webhook duplicate count, and dsh profile packs. UI rails for pause banner, affinity, and DeepSeek harness. `liveDshScaffold()` + `docs/dsh.md` document fail-closed live wiring.

**Shipped (2026-08-22 night):** view/UI fields, `/api/v1/affinity`, dsh scaffold docs.

## Snapshot restore + hermes seam + approval UI

`ropex restore <path>` reloads a snapshot into `.ropex/state.json`. `liveHermesScaffold()` + `docs/hermes.md`. UI approve/reject posts to `/api/v1/approvals`. Example fleet notes sticky affinity.

**Shipped (2026-08-22 night):** restoreSnapshot, hermes scaffold, approval POST API.

## Canary digest rolls + state snapshot

Rolling canary strategy limits digest retire/create per agent; scheduler skips holdouts. Snapshot exports cluster checkpoints.

**Shipped (2026-08-22 night):** `selectCanaryRolls`, `apply --canary`, `ropex snapshot`.

## Per-fleet cost/budget accounting

Policy.budget rolling windows charge profile-weighted task units; exhaust → deny enqueue.

**Shipped (2026-08-22 night):** `src/budget.ts`, admitTask gate, `ropex budget`, metrics/API.

## Control-plane tick + clone contract + policy simulate

Scheduled heartbeat (`tick`), fail-closed remote clone seam, fleet-wide policy simulation report.

**Shipped (2026-08-22 night):** `controlPlaneTick`, `cloneGitRepo`, `simulatePolicies`, CLI commands.

## Worker-pool autoscaler stub

HPA-style recommendations from backlog SLO + idle/running; capped by Policy.maxReplicas; emits GitOps YAML only.

**Shipped (2026-08-22 night):** `planAutoscale`, `ropex autoscale`, `/api/v1/autoscale`, UI panel.

## Multi-repo GitRepo sync + health UI

Union all declared GitRepo local paths into one reconcile; interval-aware `--due`; UI health panel with probes + repo sync stamps.

**Shipped (2026-08-22 night):** `syncMultiRepo` / `syncDueGitRepos`, `gitRepoStatus`, health panel in `ropex ui`.

## Event-sourced audit log

Append-only `state.audit` for reconcile / queue / lease / webhook / approval / sync. Soft-capped at 5k. CLI + API + UI panel.

**Shipped (2026-08-22 night):** `src/audit.ts`, `ropex audit`, `/api/v1/audit`, UI Audit section.

## Claim leases + reclaim

Claims carry `leaseExpiresAt`; heartbeats extend; expired leases reclaim into retry/DLQ without burning workers.

**Shipped (2026-08-22 night):** `heartbeatClaim`, `reclaimExpiredLeases`, `ropex reclaim`, drain auto-reclaim.

## Dead-letter + retry queue

Failed claims retry with exponential backoff (`nextRetryAt`), then `dead`. Workers release to idle on transient failure. `ropex retry` resurrects DLQ items.

**Shipped (2026-08-22 night):** `completeQueued` retry/DLQ, `requeueDead`, metrics + CLI + API.

## Worker health probes + backlog SLO

Probe live workers (digest, worktree presence, stuck claims via `claimedAt`) and evaluate pending depth/age SLOs. Surface via CLI, `/api/v1/health` (503 on breach), and Prometheus gauges.

**Shipped (2026-08-22 night):** `src/health.ts`, `ropex health`, enriched metrics + API health.

## Concurrent drain + delivery replay + GitRepo sync

Parallel drain with `--concurrency`, replay journal entries, and local GitRepo sync stub.

**Shipped (2026-08-21 night):** `drainQueue` concurrency, `replayDelivery`, `syncGitRepos`, `ropex demo` e2e sandbox.

## Trajectories + webhook rate limit

Persist Hermes→DeepSeek trajectories (JSONL export) and sliding-window rate limits on webhook ingest.

**Shipped (2026-08-21 night):** `recordTrajectory`, `ropex trajectories --jsonl`, `/api/v1/trajectories`, `checkRateLimit` on ingest.

**Shipped (2026-08-22 night):** `rateLimitReport`, view/UI Trajectories + Rate limits panels, `/api/v1/ratelimits`, Prometheus gauges, `ropex ratelimits`.

## Drain concurrency UI + preference

Persist preferred parallel drain concurrency (capped at 32). `GET/PUT/POST /api/v1/drain`, queue UI controls, Prometheus `ropex_drain_concurrency`. CLI `--concurrency` updates the preference.

**Shipped (2026-08-22 night):** `setDrainConcurrency`, drain API, UI controls.

## Operator queue + policy UI actions

Pause/resume and DLQ retry from `POST /api/v1/queue`. Custom-prompt policy dry-run via `POST /api/v1/policy/simulate`. README + architecture diagrams refresh for tick/drain/rate-limit.

**Shipped (2026-08-22 night):** queue operator API, policy simulate API, UI wiring, diagram refresh.

## Hygiene API + worker pool heatmap

`hygieneReport` / `poolHeatmap` / queue-depth bars + webhook idempotency counts. `GET/POST /api/v1/hygiene` runs reclaim, GC, age. UI heatmap + depth bars + hook buttons. `ropex hygiene`.

**Shipped (2026-08-22 night):** `src/hygiene.ts`, hygiene API/CLI/UI.

## Skills promote UI + canary progress + budget alerts

`skillsCatalog` + `POST /api/v1/skills` promote/share. `canaryProgress` / `GET /api/v1/canary` for digest coverage. Budget warn at ≤20% remaining. UI Skills + Canary panels.

**Shipped (2026-08-22 night):** skills API actions, canary report, budgetAlerts.

## Forge-neutral Task YAML inbox

`kind: Task` manifests under `tasks/` on any git server. `ropex tasks sync`, git hook, drain writes `status` + `result` back to the file. No GitHub required. See [forge-neutral.md](./forge-neutral.md).

**Shipped:** `src/tasks.ts`, CLI, hook script, tests.

## Approval workflow + fleet affinity

`requireApproval` tools create durable `ApprovalRequest`s; `ropex approve` / `reject` decide them. Scheduler prefers fleet-affine idle workers.

**Shipped:** approvals CLI + UI panel, `learnFromTrajectory`, `policy dry-run`.

## Queue priority + reconcile chaos

Higher `priority` claims first; `ropex chaos` stress-tests scale/digest rolls for slot invariants.

Gate tool calls with Policy deny/requireApproval before DeepSeek executes; fan large tasks across idle replicas.

**Shipped (2026-08-21 night):** `admitCalls` / enqueue deny, `fanOutTask` + `ropex fanout`, UI queue + delivery journal panels.

Append-only delivery trail, versioned shareable skills, Prometheus metrics export.

**Shipped (2026-08-21 night):** `deliveries[]`, `skillRegistry` + `shareSkill`, `ropex metrics [--prometheus]`, `/api/v1/metrics|deliveries|skills`.

## GitRepo watch loop

Watch declared `GitRepo` paths on an interval, re-parse manifests, reconcile digests, and write state — Flux-style. First slice: `ropex watch --once` / `--interval 5s` over local paths (no remote clone). Prove drift detection: edit YAML → retire+create.

**Shipped (2026-08-21 night):** `watchOnce` / `watchLoop` / `ropex watch` for local manifest trees; digest roll + scale drift covered in tests. Remote clone still open.

## Map harness profiles to live DeepSeek Harness

`harness.profile` (`minimal` | `code` | `standard` | `creator`) should load a real `@deepseek-ai/dsh` plugin pack instead of the simulated kernel. First slice: one adapter that boots dsh headless with the matching preset, runs a single Hermes-planned tool program, and returns the trajectory. Keep Policy denylist as a permissions plugin in front. No GitHub App required for this slice — prove it in `ropex --root sandbox run`.

**Partial (2026-08-21 night):** `bootDsh` + `DSH_PROFILE_PACKS` offline adapter; `backend: "live"` fails closed until `@deepseek-ai/dsh` is wired. Runtime executes through the adapter seam.

## Worktree per worker

Each replica gets its own sandbox under `sandbox/worktrees/<worker-id>/` (git worktree when possible). The harness `fs` and `shell` plugins are chrooted there so a 20-replica `pr-factory` cannot clobber the same files.

**Shipped (2026-08-21 night):** worktree isolation + cwd-chrooted tools + durable queue + HMAC webhook ingress + fair LRU scheduler (`ropex drain` / `webhook simulate`). Workers boot `idle`; claim → `running` → `idle`.

## GitHub App is the queue

Ship a GitHub App that maps `issues.opened` / `issues.labeled` / `pull_request.*` into Ropex tasks. Match `Agent.spec.github.events` + label selectors, pick an idle worker, run Hermes→harness, deliver via comment / check / PR.

**Partial (2026-08-21 night):** webhook HMAC verify + parse + enqueue + drain. Live GitHub App registration still open.

## Immutable agents + Hermes/DeepSeek workflow

**Shipped:** image digest on workers, digest-mismatch rolls, `composeWorkflow` stages, shared memory scopes, control-plane UI.

## 2026-08-21 — bootstrap

- Git is the control plane; GitHub is the queue; workers = DeepSeek Harness + Hermes.
- Declare `Agent` / `Fleet` / `Policy` / `GitRepo` in YAML. Reconcile replicas like pods.
- Wire live `@deepseek-ai/dsh` and `hermes-agent`.
- Watch a real `GitRepo` and scale with a commit to `spec.replicas`.
