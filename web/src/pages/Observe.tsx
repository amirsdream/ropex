import { GitCommitVertical, Radio, ScrollText } from "lucide-react";
import type { View } from "../lib/api";
import { Badge, Empty, Panel, SectionHead } from "../components/ui";
import { timeAgo } from "../lib/format";

export function Observe({ view }: { view: View }) {
  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-sm leading-relaxed text-slate-400">
        This is what a finished plan left behind: the steps the agents took, and anything they delivered.
      </p>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel>
          <SectionHead title="Trajectories" sub="The steps Hermes handed to DeepSeek." icon={<GitCommitVertical size={16} />} right={<Badge tone="teal">{view.trajectories.total}</Badge>} />
          <div className="max-h-80 space-y-1.5 overflow-auto px-5 pb-5">
            {view.trajectories.recent.length === 0 ? <Empty>No trajectories recorded yet.</Empty> : view.trajectories.recent.map((t) => (
              <div key={t.id} className="rounded-lg bg-white/5 px-3 py-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-200">{t.agent}</span>
                  <span className="text-[11px] text-slate-500">{t.steps} steps · {timeAgo(t.at)}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {t.stages.map((s, i) => (
                    <Badge key={i} tone="muted">{s}</Badge>
                  ))}
                </div>
                {t.output ? <p className="mt-1.5 truncate font-mono text-[11px] text-slate-500">{t.output}</p> : null}
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <SectionHead title="Deliveries" sub="Comments, checks, and pull requests a plan actually sent." icon={<ScrollText size={16} />} />
          <div className="max-h-80 space-y-1.5 overflow-auto px-5 pb-5">
            {view.deliveries.length === 0 ? <Empty>No deliveries yet.</Empty> : view.deliveries.slice().reverse().slice(0, 20).map((d) => (
              <div key={d.id} className="rounded-lg bg-white/5 px-3 py-2">
                <div className="flex items-center justify-between text-sm">
                  <Badge tone={d.kind === "pull_request" ? "violet" : d.kind === "check" ? "sky" : "teal"}>{d.kind}</Badge>
                  <span className="text-[11px] text-slate-500">{d.agent} · {timeAgo(d.at)}</span>
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-slate-400">{d.body}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {view.rateLimits.rows.length > 0 ? (
        <Panel>
          <SectionHead title="Rate limits" sub="A webhook key is close to being denied." icon={<Radio size={16} />} right={<Badge tone={view.rateLimits.nearLimit ? "warn" : "ok"}>{view.rateLimits.buckets} buckets</Badge>} />
          <div className="space-y-1.5 px-5 pb-5">
            {view.rateLimits.rows.map((r) => (
              <div key={r.key} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm">
                <span className="font-mono text-slate-400">{r.key}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">{r.count} used · {r.remaining} left</span>
                  <Badge tone={r.saturated ? "err" : "ok"}>{r.saturated ? "saturated" : "ok"}</Badge>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
