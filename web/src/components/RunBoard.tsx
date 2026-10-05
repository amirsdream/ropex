import { ArrowRight, Box, Brain, Layers } from "lucide-react";
import type { View } from "../lib/api";
import { cn } from "../lib/cn";
import { Badge, Panel, SectionHead } from "./ui";

const stepTone: Record<string, string> = {
  done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-100",
  running: "border-teal-400/50 bg-teal-500/15 text-teal-50",
  failed: "border-rose-500/40 bg-rose-500/10 text-rose-100",
  pending: "border-white/10 bg-white/5 text-slate-300",
};

function slots(live: number, max: number) {
  const shown = Math.min(max, 12);
  return Array.from({ length: shown }, (_, i) => i < live);
}

export function RunBoard({ view }: { view: View }) {
  const place = view.placement;
  const container = place?.executor === "container";
  const plans = view.pipelines.recent.slice(0, 4);
  const cap = place?.maxReplicas;

  return (
    <Panel>
      <SectionHead
        title="Where a plan runs"
        sub={
          container
            ? `Each plan is one ${place?.runtime ?? "container"} session on ${place?.workerImage ?? "ropex-worker"}. Steps share it, then the session is deleted. Memory stays here.`
            : "Plans are still running inside this control plane. Set ROPEX_EXECUTOR=container and restart to give each plan its own session."
        }
        icon={<Layers size={16} />}
        right={<Badge tone={container ? "teal" : "warn"}>{container ? "container" : "in process"}</Badge>}
      />
      <div className="grid gap-4 px-5 pb-5 xl:grid-cols-[16rem_minmax(0,1fr)_16rem]">
        <div className="rounded-2xl border border-teal-500/30 bg-teal-500/5 p-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-teal-100">
            <Brain size={15} /> Control plane
          </div>
          <p className="mt-1 text-[11px] leading-snug text-slate-400">The plan, Hermes memory, and learned skills stay on this process.</p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-center">
            <div className="rounded-lg bg-ink-950/50 py-2">
              <div className="font-mono text-lg text-slate-100">{view.counts.memoryFacts}</div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">facts</div>
            </div>
            <div className="rounded-lg bg-ink-950/50 py-2">
              <div className="font-mono text-lg text-slate-100">{view.pipelines.total}</div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">plans</div>
            </div>
          </div>
          <div className="mt-3 text-[11px] text-slate-500">
            Hermes <span className="text-slate-300">{view.hermesLive.backend}</span>
            <span className="mx-1.5 text-slate-600">·</span>
            harness <span className="text-slate-300">{view.dsh.backend}</span>
          </div>
        </div>

        <div className="min-w-0 space-y-2">
          {plans.length === 0 ? (
            <div className="grid h-full min-h-28 place-items-center rounded-2xl border border-dashed border-white/10 px-4 text-center text-sm text-slate-500">
              No plans yet. The next one becomes {container ? "a single session container" : "a run inside this process"}.
            </div>
          ) : (
            plans.map((p) => {
              const steps = p.steps ?? [];
              const active = steps.some((s) => s.status === "running");
              const finished = p.status === "done" || p.status === "failed";
              const label = !container
                ? p.status
                : active
                  ? "session open"
                  : finished
                    ? "session deleted"
                    : "not started";
              return (
                <div
                  key={p.id}
                  className={cn(
                    "rounded-2xl border px-3 py-2.5",
                    active ? "border-teal-400/40 bg-teal-500/5" : "border-white/10 bg-ink-900/40",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-mono text-[11px] text-slate-300">
                      <Box size={13} className={active ? "text-teal-300" : "text-slate-500"} />
                      {container ? `ropex-session:${p.id.slice(0, 8)}` : `plan ${p.id.slice(0, 8)}`}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {p.fleet ? (
                        <Badge tone={p.fleet.mode === "reuse" ? "ok" : "info"}>
                          {p.fleet.mode} {p.fleet.name}
                        </Badge>
                      ) : null}
                      <Badge tone={active ? "teal" : finished ? "muted" : "info"}>{label}</Badge>
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {steps.length === 0 ? (
                      <span className="text-[11px] text-slate-500">{p.doneStages}/{p.stages} stages</span>
                    ) : (
                      steps.map((s, i) => (
                        <span key={s.id} className="flex items-center gap-1.5">
                          <span className={cn("rounded-lg border px-2 py-1 text-[11px]", stepTone[s.status] ?? stepTone.pending)}>
                            <span className="text-slate-500">{s.id}</span> {s.agent}
                          </span>
                          {i < steps.length - 1 ? <ArrowRight size={12} className="text-slate-600" /> : null}
                        </span>
                      ))
                    )}
                  </div>
                  <p className="mt-1.5 truncate text-[11px] text-slate-500">{p.prompt}</p>
                </div>
              );
            })
          )}
        </div>

        <div className="rounded-2xl border border-white/10 bg-ink-900/40 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-100">Scale</span>
            <span className="font-mono text-[11px] text-slate-400">
              {view.counts.workersLive}/{cap ?? "∞"}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-slate-500">Workers appear when a step is claimed and disappear when idle. The cluster cap is the ceiling.</p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5">
            <div
              className="h-full rounded-full bg-teal-400/80"
              style={{ width: `${cap ? Math.min(100, (view.counts.workersLive / cap) * 100) : 0}%` }}
            />
          </div>
          <div className="mt-3 space-y-2">
            {(place?.agents ?? []).map((a) => {
              const cells = slots(a.live, a.maxConcurrent);
              return (
                <div key={a.name}>
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-slate-300">{a.name}</span>
                    <span className="font-mono text-slate-500">{a.live}/{a.maxConcurrent}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {cells.map((on, i) => (
                      <span key={i} className={cn("h-2.5 w-2.5 rounded-[3px]", on ? "bg-teal-400" : "bg-white/10")} />
                    ))}
                    {a.maxConcurrent > cells.length ? (
                      <span className="text-[10px] text-slate-500">+{a.maxConcurrent - cells.length}</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Panel>
  );
}
