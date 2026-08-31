import { ChevronRight } from "lucide-react";
import type { View, WorkflowStage } from "../lib/api";
import { cn } from "../lib/cn";

const PHASES: { id: string; label: string; ring: string; text: string; band: string }[] = [
  { id: "intake", label: "Start", ring: "ring-teal-500/25", text: "text-teal-300", band: "from-teal-500/10" },
  { id: "execute", label: "Transform", ring: "ring-orange-500/25", text: "text-orange-300", band: "from-orange-500/10" },
  { id: "result", label: "Result", ring: "ring-emerald-500/25", text: "text-emerald-300", band: "from-emerald-500/10" },
];

const ownerStyle: Record<string, { dot: string; text: string }> = {
  hermes: { dot: "bg-teal-400", text: "text-teal-300" },
  deepseek: { dot: "bg-orange-400", text: "text-orange-300" },
  ropex: { dot: "bg-slate-400", text: "text-slate-300" },
};

function StageNode({ stage, runs, active }: { stage: WorkflowStage; runs: number; active: boolean }) {
  const o = ownerStyle[stage.owner] ?? ownerStyle.ropex;
  return (
    <div
      className={cn(
        "relative min-w-[8.5rem] flex-1 rounded-xl border bg-ink-900/60 px-3 py-2.5 transition",
        active ? "border-teal-400/50 shadow-[0_0_0_1px_rgba(45,212,191,0.25),0_10px_30px_-18px_rgba(45,212,191,0.6)]" : "border-white/8",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-100">
          <span className={cn("h-1.5 w-1.5 rounded-full", o.dot, active && "animate-pulse-dot")} />
          {stage.id}
        </span>
        {runs > 0 ? (
          <span className="rounded-full bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-400" title={`${runs} recent run(s) passed this stage`}>
            {runs}×
          </span>
        ) : null}
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-slate-500">{stage.purpose}</p>
      <span className={cn("mt-1.5 inline-block text-[10px] font-medium uppercase tracking-wide", o.text)}>{stage.owner}</span>
    </div>
  );
}

export function WorkflowFlow({ view }: { view: View }) {
  // Live per-stage activity from real trajectories (each records the stages it ran).
  const runs = new Map<string, number>();
  for (const t of view.trajectories.recent) for (const s of t.stages) runs.set(s, (runs.get(s) ?? 0) + 1);

  // Highlight the phase of any pipeline currently mid-run.
  const activePhase = view.pipelines.recent.find((p) => p.phase === "execute" || p.status === "running")?.phase ?? null;

  const phases = PHASES.map((p) => ({
    ...p,
    stages: view.workflow.filter((w) => (w.phase ?? "intake") === p.id),
  })).filter((p) => p.stages.length > 0);

  const order = view.workflow.map((w) => w.id).join(" → ");

  return (
    <div className="px-5 pb-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
        <span className="font-mono text-slate-400">{order}</span>
        <span className="ml-auto">
          live from <span className="text-slate-300">{view.trajectories.recent.length}</span> recent run(s)
        </span>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
        {phases.map((p, pi) => (
          <div key={p.id} className="flex flex-1 items-stretch gap-3">
            <div className={cn("relative flex-1 rounded-2xl bg-gradient-to-b to-transparent p-3 ring-1 ring-inset", p.band, p.ring)}>
              <div className={cn("mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider", p.text)}>
                {p.label}
                {activePhase === p.id ? <span className="rounded-full bg-teal-500/20 px-1.5 py-0.5 text-[9px] text-teal-200">running</span> : null}
              </div>
              <div className="flex flex-col gap-2 sm:flex-row lg:flex-col xl:flex-row">
                {p.stages.map((s, si) => (
                  <div key={s.id} className="flex flex-1 items-center gap-2">
                    <StageNode stage={s} runs={runs.get(s.id) ?? 0} active={activePhase === p.id} />
                    {si < p.stages.length - 1 ? <ChevronRight size={16} className="hidden shrink-0 text-slate-600 xl:block" /> : null}
                  </div>
                ))}
              </div>
            </div>
            {pi < phases.length - 1 ? (
              <div className="hidden items-center lg:flex">
                <ChevronRight size={20} className="text-slate-600" />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
