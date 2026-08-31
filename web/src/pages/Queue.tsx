import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GitBranch, ListChecks, ShieldCheck, SlidersHorizontal } from "lucide-react";
import type { View } from "../lib/api";
import { api } from "../lib/api";
import { Badge, Button, Empty, Panel, SectionHead } from "../components/ui";

function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["view"] });
}

function DrainControls({ view, refresh }: { view: View; refresh: () => void }) {
  const [c, setC] = useState(view.drain.concurrency);
  return (
    <div className="flex flex-wrap items-center gap-2 px-5 pb-4">
      <label className="flex items-center gap-2 text-sm text-slate-400">
        concurrency
        <input type="number" min={1} max={view.drain.maxConcurrency} value={c} onChange={(e) => setC(Number(e.target.value))} className="w-16 rounded-lg border border-white/10 bg-ink-900/70 px-2 py-1 text-sm text-slate-100 outline-none" />
      </label>
      <Button size="sm" variant="ghost" onClick={async () => { await api.preferDrain(c); refresh(); }}>save</Button>
      <Button size="sm" variant="primary" onClick={async () => { await api.runDrain(c); refresh(); }} disabled={view.drain.paused}>drain now</Button>
      <Button size="sm" variant="ghost" onClick={async () => { await api.queue(view.drain.paused ? "resume" : "pause"); refresh(); }}>
        {view.drain.paused ? "resume" : "pause"}
      </Button>
      <span className="ml-auto text-xs text-slate-500">pending {view.drain.pending} · claimed {view.drain.claimed} · running {view.drain.runningWorkers}</span>
    </div>
  );
}

function PolicySim() {
  const [prompt, setPrompt] = useState("deploy to prod");
  const [rows, setRows] = useState<number | null>(null);
  return (
    <div className="px-5 pb-5">
      <div className="flex gap-2">
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} className="flex-1 rounded-lg border border-white/10 bg-ink-900/70 px-3 py-2 text-sm text-slate-100 outline-none" />
        <Button size="sm" variant="ghost" onClick={async () => { const r = await api.policySim(prompt); setRows((r.rows ?? []).length); }}>simulate</Button>
      </div>
      {rows != null ? <p className="mt-2 text-xs text-slate-500">Evaluated {rows} agent policy row(s).</p> : null}
    </div>
  );
}

export function Queue({ view }: { view: View }) {
  const refresh = useRefresh();
  const dead = view.queue.filter((q) => q.status === "dead");

  return (
    <div className="space-y-5">
      <Panel>
        <SectionHead title="Queue" sub="bounded-concurrency drain with leases, retry & DLQ" icon={<ListChecks size={16} />} right={
          dead.length ? <Button size="sm" variant="danger" onClick={async () => { await api.queue("retry", { all: true }); refresh(); }}>retry all</Button> : undefined
        } />
        <DrainControls view={view} refresh={refresh} />
        <div className="max-h-72 space-y-1.5 overflow-auto px-5 pb-5">
          {view.queue.length === 0 ? <Empty>Queue empty — webhook or submit to enqueue.</Empty> : view.queue.slice().reverse().map((q) => (
            <div key={q.id} className="flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2 text-sm">
              <div className="min-w-0">
                <span className="text-slate-300">{q.agent}</span>
                <span className="ml-2 truncate text-slate-500">{q.prompt}</span>
              </div>
              <div className="flex items-center gap-2">
                {q.status === "dead" ? <Button size="sm" variant="ghost" onClick={async () => { await api.queue("retry", { id: q.id }); refresh(); }}>retry</Button> : null}
                <Badge tone={q.status === "done" ? "ok" : q.status === "dead" || q.status === "failed" ? "err" : q.status === "claimed" ? "teal" : "info"}>{q.status}{q.attempts ? `·a${q.attempts}` : ""}</Badge>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel>
        <SectionHead title="Pipelines" sub="executor runs — start → transform → result" icon={<GitBranch size={16} />} right={<Badge tone="violet">{view.pipelines.total}</Badge>} />
        <div className="max-h-64 space-y-1.5 overflow-auto px-5 pb-5">
          {view.pipelines.recent.length === 0 ? <Empty>No pipelines yet — run one from the Services console.</Empty> : view.pipelines.recent.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2 text-sm">
              <span className="truncate text-slate-300">{p.prompt}</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">{p.doneStages}/{p.stages}</span>
                <Badge tone={p.phase === "result" ? "ok" : p.phase === "execute" ? "teal" : "info"}>{p.phase ?? p.status}</Badge>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel>
          <SectionHead title="Approvals" sub="policy-gated tools awaiting a decision" icon={<ShieldCheck size={16} />} />
          <div className="space-y-2 px-5 pb-5">
            {view.approvals.filter((a) => a.status === "pending").length === 0 ? <Empty>Nothing waiting on approval.</Empty> : view.approvals.filter((a) => a.status === "pending").map((a) => (
              <div key={a.id} className="rounded-lg bg-white/5 px-3 py-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-200">{a.tool} <span className="text-slate-500">· {a.agent}</span></span>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="primary" onClick={() => api.approve(a.id, "approved")}>approve</Button>
                    <Button size="sm" variant="danger" onClick={() => api.approve(a.id, "rejected")}>reject</Button>
                  </div>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">{a.reason}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <SectionHead title="Policy simulate" sub="fleet-wide admission dry-run" icon={<SlidersHorizontal size={16} />} />
          <PolicySim />
        </Panel>
      </div>
    </div>
  );
}
