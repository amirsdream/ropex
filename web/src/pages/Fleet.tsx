import { useQueryClient } from "@tanstack/react-query";
import { Boxes, Brush, GitCompareArrows, Sparkles } from "lucide-react";
import type { View } from "../lib/api";
import { api } from "../lib/api";
import { Badge, Button, Empty, Panel, SectionHead } from "../components/ui";
import { cn } from "../lib/cn";
import { timeAgo } from "../lib/format";

function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["view"] });
}

export function Fleet({ view }: { view: View }) {
  const refresh = useRefresh();
  const pins = view.fleetPins ?? [];
  const liveByAgent = new Map<string, typeof view.workers>();
  for (const w of view.workers) {
    if (!liveByAgent.has(w.agent)) liveByAgent.set(w.agent, []);
    liveByAgent.get(w.agent)!.push(w);
  }

  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-sm leading-relaxed text-slate-400">
        These agents are the fleet a plan can reuse. A pin is the set the next matching prompt will pick again. Workers only exist while a step is running.
      </p>

      <Panel>
        <SectionHead title="Pinned fleets" sub="Remembered agent sets. The next same ask reuses them." icon={<Boxes size={16} />} right={<Badge tone="teal">{pins.length}</Badge>} />
        <div className="space-y-2 px-5 pb-5">
          {pins.length === 0 ? (
            <Empty>No pin yet. The first simple plan mints triage and reviewer, then remembers that pair.</Empty>
          ) : pins.map((p) => (
            <div key={p.key} className="rounded-xl bg-ink-900/50 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-100">{p.fleet}</span>
                <span className="text-[11px] text-slate-500">{timeAgo(p.at)}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {p.agents.map((a) => <Badge key={a} tone="teal">{a}</Badge>)}
              </div>
              <p className="mt-2 truncate text-[12px] text-slate-500">{p.prompt}</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel>
        <SectionHead title="Agents" sub="Who can take a step, and which model runs it." icon={<Boxes size={16} />} />
        <div className="space-y-2 px-5 pb-5">
          {view.hermes.length === 0 ? <Empty>No agents applied. Start the stack to load the fleet file.</Empty> : view.hermes.map((h) => {
            const harness = view.harness.find((x) => x.agent === h.agent);
            const live = liveByAgent.get(h.agent) ?? [];
            return (
              <div key={h.agent} className="rounded-xl bg-ink-900/50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-100">{h.agent}</span>
                  <div className="flex items-center gap-1.5">
                    <Badge tone="muted">{harness?.model ?? "model"}</Badge>
                    <Badge tone={live.length ? "teal" : "muted"}>{live.length ? `${live.length} running` : "idle"}</Badge>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {h.skills.map((s) => <Badge key={s} tone="muted">{s}</Badge>)}
                  {h.learning ? <Badge tone="violet">learns</Badge> : null}
                  {harness ? <Badge tone="copper">{harness.runtime}</Badge> : null}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel>
          <SectionHead title="Memory" sub="Facts copied back before the session was deleted." right={<Button size="sm" variant="ghost" onClick={async () => { await api.memory("sync"); refresh(); }}>sync</Button>} />
          <div className="max-h-64 space-y-1.5 overflow-auto px-5 pb-5">
            {view.memory.length === 0 ? <Empty>No facts yet. They show up after a plan learns.</Empty> : view.memory.slice(0, 20).map((f) => (
              <div key={f.id} className="rounded-lg bg-white/5 px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <Badge tone={f.scope === "cluster" ? "violet" : f.scope === "fleet" ? "sky" : "teal"}>{f.scope}</Badge>
                  <span className="text-slate-300">{f.agent}</span>
                  <span className="ml-auto text-[11px] text-slate-600">{timeAgo(f.at)}</span>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-slate-400">{f.text}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <SectionHead title="Skills" sub="Learned from a finished plan. Promote shares one with the fleet." icon={<Sparkles size={16} />} />
          <div className="space-y-2 px-5 pb-5">
            {view.skillCatalog.length === 0 ? <Empty>Nothing learned yet.</Empty> : view.skillCatalog.map((s) => (
              <div key={s.name} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
                <div>
                  <div className="text-sm font-medium text-slate-200">{s.name} <span className="text-slate-500">v{s.version}</span></div>
                  <div className="text-[11px] text-slate-500">from {s.originAgent} · {s.sharedWith.length} shared</div>
                </div>
                <Button size="sm" variant="ghost" onClick={async () => { await api.promoteSkill(s.name); refresh(); }}>promote</Button>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <details className="rounded-2xl border border-white/5 bg-ink-850/40 px-5 py-3">
        <summary className="cursor-pointer text-sm text-slate-400">Maintenance — pool hygiene and canary coverage</summary>
        <div className="mt-4 grid gap-5 lg:grid-cols-2">
          <Panel>
            <SectionHead title="Hygiene" sub="Idle, running, failed, and cordoned workers." icon={<Brush size={16} />} right={
              <div className="flex gap-1.5">
                {["reclaim", "gc", "age", "all"].map((a) => (
                  <Button key={a} size="sm" variant="ghost" onClick={async () => { await api.hygiene(a); refresh(); }}>{a}</Button>
                ))}
              </div>
            } />
            <div className="grid gap-2 px-5 pb-5 sm:grid-cols-2">
              {view.hygiene.pool.length === 0 ? <Empty>No pool activity. On-demand workers are destroyed when idle.</Empty> : view.hygiene.pool.map((p) => (
                <div key={p.agent} className="rounded-xl bg-ink-900/50 p-3">
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="font-semibold text-slate-200">{p.agent}</span>
                    <span className="text-xs text-slate-500">{p.total} total</span>
                  </div>
                  <div className="flex h-6 overflow-hidden rounded-md">
                    {([["idle", p.idle, "bg-violet-500/60"], ["running", p.running, "bg-teal-500/70"], ["failed", p.failed, "bg-rose-500/70"], ["cordoned", p.cordoned, "bg-amber-500/60"]] as const).map(([k, n, c]) => (
                      n > 0 ? <div key={k} className={cn("heat-cell grid place-items-center text-[10px] text-ink-950", c)} style={{ flex: n }} title={`${k}: ${n}`}>{n}</div> : null
                    ))}
                    {p.total === 0 ? <div className="grid flex-1 place-items-center bg-white/5 text-[10px] text-slate-600">idle</div> : null}
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel>
            <SectionHead title="Canary" sub="How many live workers match the desired image." icon={<GitCompareArrows size={16} />} right={<Badge tone={view.canary.ok ? "ok" : "warn"}>{Math.round(view.canary.pctMatched)}%</Badge>} />
            <div className="space-y-2 px-5 pb-5">
              {view.canary.agents.length === 0 ? <Empty>No live workers to compare.</Empty> : view.canary.agents.map((a) => (
                <div key={a.agent} className="rounded-lg bg-white/5 px-3 py-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-300">{a.agent}</span>
                    <span className="text-xs text-slate-500">{a.matched}/{a.total}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-900">
                    <div className="h-full rounded-full bg-teal-500" style={{ width: `${a.pctMatched}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </details>
    </div>
  );
}
