import { Activity, CheckCircle2, GitBranch, PackageOpen, Send, TriangleAlert, Users } from "lucide-react";
import type { View } from "../lib/api";
import type { Sample } from "../hooks/useView";
import { StatCard } from "../components/StatCard";
import { Badge, Empty, Panel, SectionHead } from "../components/ui";
import { num } from "../lib/format";
import { cn } from "../lib/cn";

const col = (h: Sample[], k: keyof Sample) => h.map((s) => Number(s[k]) || 0);

const phaseMeta: Record<string, { tone: string; label: string }> = {
  intake: { tone: "text-teal-300", label: "Start" },
  execute: { tone: "text-orange-300", label: "Transform" },
  result: { tone: "text-emerald-300", label: "Result" },
};

export function Overview({ view, history }: { view: View; history: Sample[] }) {
  const m = view.metrics;
  const last = history[history.length - 1];
  const groupedPhases = ["intake", "execute", "result"].map((phase) => ({
    phase,
    ...phaseMeta[phase],
    stages: view.workflow.filter((w) => (w.phase ?? "intake") === phase),
  }));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Workers live" value={num(view.counts.workersLive)} spark={col(history, "workersLive")} color="teal" icon={<Users size={15} />} hint={`${view.counts.workersKnown} known`} />
        <StatCard label="Queue pending" value={num(view.drain.pending)} spark={col(history, "queuePending")} color="amber" icon={<PackageOpen size={15} />} hint={`${view.drain.claimed} claimed`} />
        <StatCard label="Throughput" value={last ? Math.round(last.throughput) : 0} spark={col(history, "throughput")} color="sky" icon={<Activity size={15} />} hint="tasks / min" />
        <StatCard label="Deliveries" value={num(m.deliveries)} spark={col(history, "deliveries")} color="violet" icon={<Send size={15} />} hint="comments · checks · PRs" />
        <StatCard label="Pipelines" value={num(view.pipelines.total)} spark={col(history, "pipelines")} color="emerald" icon={<GitBranch size={15} />} hint="executor runs" />
        <StatCard label="Unhealthy" value={num(m.workersUnhealthy)} spark={col(history, "unhealthy")} color="rose" icon={<TriangleAlert size={15} />} hint={view.health.ok ? "all clear" : "attention"} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <SectionHead
            title="Workflow spine"
            sub="One run, three phases — Hermes plans, DeepSeek executes."
            icon={<GitBranch size={16} />}
          />
          <div className="grid gap-3 px-5 pb-5 md:grid-cols-3">
            {groupedPhases.map((g) => (
              <div key={g.phase} className="rounded-xl border border-white/5 bg-ink-900/50 p-3">
                <div className={cn("mb-2 text-xs font-semibold uppercase tracking-wider", g.tone)}>{g.label}</div>
                <div className="space-y-2">
                  {g.stages.map((s) => (
                    <div key={s.id} className="rounded-lg bg-white/5 px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-200">{s.id}</span>
                        <Badge tone={s.owner === "hermes" ? "teal" : s.owner === "deepseek" ? "copper" : "muted"}>{s.owner}</Badge>
                      </div>
                      <p className="mt-1 text-[11px] leading-snug text-slate-500">{s.purpose}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <SectionHead
            title="Health"
            sub="Probes and backlog SLO"
            icon={<CheckCircle2 size={16} />}
            right={<Badge tone={view.health.ok ? "ok" : "err"}>{view.health.ok ? "healthy" : "degraded"}</Badge>}
          />
          <div className="px-5 pb-4">
            <div className="mb-3 grid grid-cols-3 gap-2 text-center">
              {[
                { k: "SLO", v: m.backlogSloBreached ? "breach" : "ok", tone: m.backlogSloBreached ? "err" : "ok" },
                { k: "Drift", v: view.drift.ok ? "ok" : "off", tone: view.drift.ok ? "ok" : "warn" },
                { k: "Canary", v: `${Math.round(view.canary.pctMatched)}%`, tone: view.canary.ok ? "ok" : "warn" },
              ].map((x) => (
                <div key={x.k} className="rounded-lg bg-ink-900/60 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">{x.k}</div>
                  <div className={cn("mt-0.5 text-sm font-semibold", x.tone === "ok" ? "text-emerald-300" : x.tone === "warn" ? "text-amber-300" : "text-rose-300")}>{x.v}</div>
                </div>
              ))}
            </div>
            {view.health.workers.length === 0 ? (
              <Empty>No live workers — on-demand agents spawn on claim.</Empty>
            ) : (
              <div className="max-h-64 space-y-1.5 overflow-auto pr-1">
                {view.health.workers.map((w) => (
                  <div key={w.id} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm">
                    <span className="font-mono text-slate-300">{w.id}</span>
                    <Badge tone={w.healthy ? "ok" : "err"}>{w.healthy ? w.status : w.detail}</Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
