import { Activity, CheckCircle2, GitBranch, PackageOpen, Send, TriangleAlert, Users } from "lucide-react";
import type { View } from "../lib/api";
import type { Sample } from "../hooks/useView";
import { StatCard } from "../components/StatCard";
import { Badge, Empty, Panel, SectionHead } from "../components/ui";
import { WorkflowFlow } from "../components/WorkflowFlow";
import { num } from "../lib/format";
import { cn } from "../lib/cn";

const col = (h: Sample[], k: keyof Sample) => h.map((s) => Number(s[k]) || 0);

export function Overview({ view, history }: { view: View; history: Sample[] }) {
  const m = view.metrics;
  const last = history[history.length - 1];

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

      <Panel>
        <SectionHead
          title="Per-task workflow"
          sub="The real run each task takes — compose → plan → execute → deliver → learn."
          icon={<GitBranch size={16} />}
        />
        <WorkflowFlow view={view} />
      </Panel>

      <Panel>
        <SectionHead
          title="Health"
          sub="Probes and backlog SLO"
          icon={<CheckCircle2 size={16} />}
          right={<Badge tone={view.health.ok ? "ok" : "err"}>{view.health.ok ? "healthy" : "degraded"}</Badge>}
        />
        <div className="grid gap-4 px-5 pb-5 md:grid-cols-[minmax(0,20rem)_1fr]">
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { k: "SLO", v: m.backlogSloBreached ? "breach" : "ok", tone: m.backlogSloBreached ? "err" : "ok" },
              { k: "Drift", v: view.drift.ok ? "ok" : "off", tone: view.drift.ok ? "ok" : "warn" },
              { k: "Canary", v: `${Math.round(view.canary.pctMatched)}%`, tone: view.canary.ok ? "ok" : "warn" },
            ].map((x) => (
              <div key={x.k} className="rounded-lg bg-ink-900/60 py-3">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">{x.k}</div>
                <div className={cn("mt-0.5 text-sm font-semibold", x.tone === "ok" ? "text-emerald-300" : x.tone === "warn" ? "text-amber-300" : "text-rose-300")}>{x.v}</div>
              </div>
            ))}
          </div>
          {view.health.workers.length === 0 ? (
            <div className="grid place-items-center rounded-lg bg-ink-900/40 py-6">
              <Empty>No live workers — on-demand agents spawn on claim.</Empty>
            </div>
          ) : (
            <div className="grid max-h-48 gap-1.5 overflow-auto pr-1 sm:grid-cols-2">
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
  );
}
