import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Boxes, Brush, GitCompareArrows, Send, Sparkles } from "lucide-react";
import type { View } from "../lib/api";
import { api } from "../lib/api";
import { Badge, Button, Empty, Panel, SectionHead } from "../components/ui";
import { cn } from "../lib/cn";
import { timeAgo } from "../lib/format";

function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["view"] });
}

function TaskSubmit({ agents, onDone }: { agents: string[]; onDone: () => void }) {
  const [agent, setAgent] = useState(agents[0] ?? "");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState("ui");
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!agent || !prompt.trim()) return;
    setBusy(true);
    try {
      await api.submitTask(agent, prompt.trim(), mode, true);
      setPrompt("");
      onDone();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2 px-5 pb-4 sm:flex-row">
      <select value={agent} onChange={(e) => setAgent(e.target.value)} className="rounded-lg border border-white/10 bg-ink-900/70 px-3 py-2 text-sm text-slate-200 outline-none">
        {agents.map((a) => (
          <option key={a} value={a}>{a}</option>
        ))}
      </select>
      <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Native task prompt…" className="flex-1 rounded-lg border border-white/10 bg-ink-900/70 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-teal-500/50" />
      <select value={mode} onChange={(e) => setMode(e.target.value)} className="rounded-lg border border-white/10 bg-ink-900/70 px-3 py-2 text-sm text-slate-200 outline-none">
        {["ui", "git", "github", "webhook"].map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      <Button variant="primary" onClick={submit} disabled={busy || !prompt.trim()}>
        <Send size={14} /> Submit
      </Button>
    </div>
  );
}

export function Fleet({ view }: { view: View }) {
  const refresh = useRefresh();
  const agents = view.hermes.map((h) => h.agent);
  const groups = new Map<string, typeof view.workers>();
  for (const w of view.workers) {
    if (!groups.has(w.agent)) groups.set(w.agent, []);
    groups.get(w.agent)!.push(w);
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel>
          <SectionHead title="Workers" sub="on-demand spawns — grouped by agent" icon={<Boxes size={16} />} right={<Badge tone="teal">{view.counts.workersLive} live</Badge>} />
          <div className="space-y-2 px-5 pb-5">
            {view.fleets.map((f) => (
              <div key={f.name} className="rounded-xl bg-ink-900/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-100">{f.name}</span>
                  <div className="flex items-center gap-1.5">
                    <Badge tone={f.scale === "onDemand" ? "teal" : "violet"}>{f.scale}</Badge>
                    <Badge tone="muted">{f.live}/{f.maxConcurrent ?? f.replicas}</Badge>
                  </div>
                </div>
                <div className="mt-1 text-[11px] text-slate-500">profile {f.profile} · {f.memoryFacts} facts</div>
              </div>
            ))}
            {[...groups.entries()].map(([agent, ws]) => (
              <div key={agent} className="rounded-xl border border-white/5 bg-white/5 p-3">
                <div className="mb-1.5 text-xs font-semibold text-slate-300">{agent} · {ws.length}</div>
                <div className="space-y-1">
                  {ws.map((w) => (
                    <div key={w.id + w.status} className="flex items-center justify-between text-sm">
                      <span className="font-mono text-slate-400">{w.id}</span>
                      <Badge tone={w.status === "running" ? "teal" : w.status === "retired" ? "muted" : w.status === "failed" ? "err" : "info"}>{w.status}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <SectionHead title="Tasks" sub="native inbox — submit directly to an agent" icon={<Send size={16} />} />
          <TaskSubmit agents={agents} onDone={refresh} />
          <div className="max-h-56 space-y-1.5 overflow-auto px-5 pb-5">
            {view.queue.length === 0 ? (
              <Empty>Queue empty.</Empty>
            ) : (
              view.queue.slice().reverse().slice(0, 12).map((q) => (
                <div key={q.id} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm">
                  <span className="truncate text-slate-300">{q.prompt}</span>
                  <Badge tone={q.status === "done" ? "ok" : q.status === "dead" ? "err" : "info"}>{q.status}</Badge>
                </div>
              ))
            )}
          </div>
        </Panel>
      </div>

      <Panel>
        <SectionHead title="Hygiene & pool" sub="heatmap of idle / running / failed / cordoned" icon={<Brush size={16} />} right={
          <div className="flex gap-1.5">
            {["reclaim", "gc", "age", "all"].map((a) => (
              <Button key={a} size="sm" variant="ghost" onClick={async () => { await api.hygiene(a); refresh(); }}>{a}</Button>
            ))}
          </div>
        } />
        <div className="grid gap-2 px-5 pb-5 sm:grid-cols-2 xl:grid-cols-3">
          {view.hygiene.pool.length === 0 ? <Empty>No pool activity.</Empty> : view.hygiene.pool.map((p) => (
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

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel>
          <SectionHead title="Skills" sub="registry versions — promote to share" icon={<Sparkles size={16} />} />
          <div className="space-y-2 px-5 pb-5">
            {view.skillCatalog.length === 0 ? <Empty>No learned skills yet.</Empty> : view.skillCatalog.map((s) => (
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

        <Panel>
          <SectionHead title="Canary & drift" sub="digest coverage vs desired" icon={<GitCompareArrows size={16} />} right={<Badge tone={view.canary.ok ? "ok" : "warn"}>{Math.round(view.canary.pctMatched)}%</Badge>} />
          <div className="space-y-2 px-5 pb-5">
            <div className="rounded-lg bg-white/5 px-3 py-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">drift</span><Badge tone={view.drift.ok ? "ok" : "warn"}>{view.drift.ok ? "in sync" : `${view.drift.findings.length} findings`}</Badge></div>
              <div className="mt-1 flex justify-between text-xs text-slate-500"><span>live {view.drift.liveWorkers}</span><span>desired {view.drift.desiredWorkers}</span></div>
            </div>
            {view.canary.agents.map((a) => (
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

      <Panel>
        <SectionHead title="Memory rope" sub="scoped facts across worker / agent / fleet / cluster" right={<Button size="sm" variant="ghost" onClick={async () => { await api.memory("sync"); refresh(); }}>sync</Button>} />
        <div className="max-h-64 space-y-1.5 overflow-auto px-5 pb-5">
          {view.memory.length === 0 ? <Empty>No facts on the bus.</Empty> : view.memory.slice(0, 30).map((f) => (
            <div key={f.id} className="rounded-lg bg-white/5 px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <Badge tone={f.scope === "cluster" ? "violet" : f.scope === "fleet" ? "sky" : "teal"}>{f.scope}</Badge>
                <span className="text-slate-300">{f.agent}</span>
                <span className="ml-auto text-[11px] text-slate-600">{timeAgo(f.at)}</span>
              </div>
              <p className="mt-1 truncate text-[12px] text-slate-400">{f.text}</p>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
