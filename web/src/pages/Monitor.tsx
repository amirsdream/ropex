import { Gauge as GaugeIcon } from "lucide-react";
import type { View } from "../lib/api";
import type { Sample } from "../hooks/useView";
import { Gauge, TimeSeries } from "../components/charts";
import { Badge, Empty, Panel, SectionHead } from "../components/ui";
import { ms } from "../lib/format";

function ChartPanel({
  title,
  sub,
  children,
  right,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <Panel>
      <SectionHead title={title} sub={sub} right={right} />
      <div className="px-2 pb-3">{children}</div>
    </Panel>
  );
}

export function Monitor({ view, history }: { view: View; history: Sample[] }) {
  const healthyPct = view.health.workers.length
    ? (view.health.workers.filter((w) => w.healthy).length / view.health.workers.length) * 100
    : 100;

  if (history.length < 2) {
    return (
      <Panel>
        <SectionHead title="Live monitoring" sub="Grafana-style time-series" icon={<GaugeIcon size={16} />} />
        <Empty>Collecting samples… charts populate as the control plane is polled.</Empty>
      </Panel>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Panel className="p-2">
          <Gauge value={view.health.ok ? 100 : 40} label="SLO" color={view.health.ok ? "emerald" : "rose"} />
        </Panel>
        <Panel className="p-2">
          <Gauge value={healthyPct} label="Healthy" color={healthyPct > 90 ? "teal" : "amber"} />
        </Panel>
        <Panel className="p-2">
          <Gauge value={view.canary.pctMatched} label="Canary" color="violet" />
        </Panel>
        <Panel className="p-2">
          <Gauge value={view.drift.ok ? 100 : 50} label="Drift OK" color={view.drift.ok ? "sky" : "amber"} />
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartPanel title="Queue depth" sub="pending vs claimed" right={<Badge tone="amber">pending {view.drain.pending}</Badge>}>
          <TimeSeries
            data={history}
            series={[
              { key: "queuePending", label: "pending", color: "amber" },
              { key: "claimed", label: "claimed", color: "sky" },
            ]}
          />
        </ChartPanel>

        <ChartPanel title="Worker pool" sub="running vs idle" right={<Badge tone="teal">live {view.counts.workersLive}</Badge>}>
          <TimeSeries
            data={history}
            stack
            series={[
              { key: "running", label: "running", color: "teal" },
              { key: "idle", label: "idle", color: "violet" },
            ]}
          />
        </ChartPanel>

        <ChartPanel title="Throughput" sub="tasks completed / min">
          <TimeSeries data={history} series={[{ key: "throughput", label: "tasks/min", color: "emerald" }]} />
        </ChartPanel>

        <ChartPanel title="Delivery & pipeline volume" sub="cumulative">
          <TimeSeries
            data={history}
            series={[
              { key: "deliveries", label: "deliveries", color: "copper" },
              { key: "pipelines", label: "pipelines", color: "violet" },
            ]}
          />
        </ChartPanel>

        <ChartPanel title="Backlog age" sub="oldest pending" right={<Badge tone={view.health.backlogBreached ? "err" : "ok"}>{ms(view.health.oldestPendingAgeMs)}</Badge>}>
          <TimeSeries data={history} series={[{ key: "backlogAge", label: "age (ms)", color: "rose" }]} />
        </ChartPanel>

        <ChartPanel title="Unhealthy workers" sub="probe failures" right={<Badge tone={view.metrics.workersUnhealthy ? "err" : "ok"}>{view.metrics.workersUnhealthy}</Badge>}>
          <TimeSeries data={history} series={[{ key: "unhealthy", label: "unhealthy", color: "rose" }]} />
        </ChartPanel>
      </div>

      <Panel>
        <SectionHead title="Fairness & latency" sub="claim-wait and run-duration percentiles" />
        <div className="grid grid-cols-2 gap-3 px-5 pb-5 md:grid-cols-4">
          {[
            { k: "claim p50", v: ms(view.fairness.claimWaitP50Ms) },
            { k: "claim p95", v: ms(view.fairness.claimWaitP95Ms) },
            { k: "run p50", v: ms(view.fairness.runDurationP50Ms) },
            { k: "run p95", v: ms(view.fairness.runDurationP95Ms) },
          ].map((x) => (
            <div key={x.k} className="rounded-xl bg-ink-900/60 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-slate-500">{x.k}</div>
              <div className="mt-1 font-mono text-lg text-slate-100">{x.v}</div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
