import { useState } from "react";
import { Play, RotateCcw, Terminal } from "lucide-react";
import type { View } from "../lib/api";
import { useStream, type StageView } from "../hooks/useStream";
import { FollowLanes } from "../components/FollowLanes";
import { Badge, Button, KV, Panel, SectionHead } from "../components/ui";
import { cn } from "../lib/cn";

const stageTone: Record<StageView["status"], string> = {
  pending: "border-white/10 bg-white/5",
  running: "border-teal-500/40 bg-teal-500/10",
  done: "border-emerald-500/30 bg-emerald-500/10",
  error: "border-rose-500/40 bg-rose-500/10",
};

function ServiceCard({
  name,
  tone,
  icon,
  backend,
  ready,
  notReadyLabel = "embedded",
  rows,
}: {
  name: string;
  tone: "teal" | "copper" | "violet";
  icon: React.ReactNode;
  backend: string;
  ready: boolean;
  /** Shown when `ready` is false. CLI runtimes are missing, not embedded. */
  notReadyLabel?: string;
  rows: [string, React.ReactNode][];
}) {
  const iconTone = {
    teal: "bg-teal-500/15 text-teal-300",
    copper: "bg-orange-500/15 text-orange-300",
    violet: "bg-violet-500/15 text-violet-300",
  }[tone];
  return (
    <Panel className="p-4">
      <div className="flex items-center gap-3">
        <span className={cn("grid h-10 w-10 place-items-center rounded-xl", iconTone)}>{icon}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-100">{name}</h3>
            <Badge tone={backend === "live" ? "ok" : "muted"}>{backend}</Badge>
            <Badge tone={ready ? "ok" : "warn"}>{ready ? "ready" : notReadyLabel}</Badge>
          </div>
        </div>
      </div>
      <div className="mt-3 divide-y divide-white/5">
        {rows.map(([k, v]) => (
          <KV key={k} k={k} v={v} />
        ))}
      </div>
    </Panel>
  );
}

const SIMPLE_PROMPT = "Say what this control plane does in one sentence, then review that sentence.";

function Console({ view }: { view: View }) {
  const container = view.placement?.executor === "container";
  const { state, run, reset } = useStream();
  const [prompt, setPrompt] = useState(SIMPLE_PROMPT);
  const busy = state.status === "planning" || state.status === "running";

  return (
    <Panel>
      <SectionHead
        title="Run a plan"
        sub="Hermes writes the plan. DeepSeek runs each step. Hermes keeps what is worth remembering."
        icon={<Terminal size={16} />}
        right={
          <Button size="sm" variant="subtle" onClick={reset} title="Clear">
            <RotateCcw size={14} /> Reset
          </Button>
        }
      />
      <div className="px-5 pb-5">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && prompt.trim() && !busy) run(prompt.trim());
            }}
            placeholder="Ask the fleet to do something…"
            className="flex-1 rounded-lg border border-white/10 bg-ink-900/70 px-3.5 py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-teal-500/50 focus:ring-2 focus:ring-teal-500/20"
          />
          <Button variant="primary" onClick={() => run(SIMPLE_PROMPT, { simple: true })} disabled={busy}>
            <Play size={15} /> {busy ? "Running…" : "Simple pipeline"}
          </Button>
          <Button variant="ghost" onClick={() => prompt.trim() && run(prompt.trim())} disabled={busy || !prompt.trim()}>
            Run prompt
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Badge tone={view.hermesLive.backend === "live" ? "ok" : "muted"}>Hermes {view.hermesLive.backend}</Badge>
          <Badge tone={view.dsh.backend === "live" ? "ok" : "copper"}>DeepSeek {view.dsh.backend}</Badge>
          {view.hermes.map((h) => (
            <Badge key={h.agent} tone="teal">{h.agent}</Badge>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Simple pipeline is two stages: triage writes one sentence, reviewer marks it PASS or FAIL. The same prompt reuses the pinned agents.
        </p>
        <FollowLanes state={state} />

        {state.status === "idle" ? (
          <div className="mt-4 rounded-xl border border-dashed border-white/10 px-5 py-8 text-center text-sm text-slate-500">
            {container
              ? "This plan opens one session container. Triage and reviewer share it, then the session image is deleted. Hermes memory stays on the control plane."
              : "This plan runs inside the control plane. Turn on ROPEX_EXECUTOR=container to put the same steps in one session container."}
          </div>
        ) : (
          <div className="mt-4 grid gap-4 lg:grid-cols-5">
            <div className="space-y-3 lg:col-span-3">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Badge tone={state.status === "done" ? "ok" : state.status === "error" ? "err" : "teal"}>{state.status}</Badge>
                {state.pipelineId ? <span className="font-mono">{state.pipelineId.slice(0, 8)}</span> : null}
              </div>
              {state.stages.length === 0 ? (
                <div className="rounded-lg bg-white/5 px-3 py-4 text-sm text-slate-500">Planning…</div>
              ) : (
                state.stages.map((s) => (
                  <div key={s.id} className={cn("rounded-xl border px-3.5 py-3 transition", stageTone[s.status])}>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-slate-100">{s.role}</span>
                      <div className="flex items-center gap-2">
                        {s.agent ? <Badge tone="muted">{s.agent}</Badge> : null}
                        <Badge tone={s.status === "done" ? "ok" : s.status === "error" ? "err" : s.status === "running" ? "teal" : "muted"}>{s.status}</Badge>
                      </div>
                    </div>
                    {s.logs.length ? (
                      <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-950/60 p-2 font-mono text-[11px] leading-relaxed text-slate-400">
                        {s.logs.slice(-8).join("\n")}
                      </pre>
                    ) : null}
                    {s.output ? (
                      <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded-lg bg-emerald-500/5 p-2 font-mono text-[11px] text-emerald-200/80">{s.output.slice(0, 400)}</pre>
                    ) : null}
                  </div>
                ))
              )}
            </div>
            <div className="space-y-3 lg:col-span-2">
              <div className="rounded-xl bg-ink-900/60 p-3">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-teal-300">Hermes plan</div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-400">{state.planText || "—"}</pre>
              </div>
              <div className="rounded-xl bg-ink-900/60 p-3">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Event stream</div>
                <div className="max-h-40 space-y-1 overflow-auto">
                  {state.events.map((e, i) => (
                    <div key={i} className="font-mono text-[11px] text-slate-500">
                      <span className="text-slate-600">{new Date(e.at).toLocaleTimeString()}</span> {e.text}
                    </div>
                  ))}
                </div>
              </div>
              {state.result ? (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-300">Result</div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-emerald-200/80">{state.result.slice(0, 600)}</pre>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

export function Services({ view }: { view: View }) {
  const extra = (view.runtimes ?? []).filter((r) => r.kind !== "dsh" && r.ready);
  return (
    <div className="space-y-5">
      <Console view={view} />

      {extra.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {extra.map((r) => (
            <ServiceCard
              key={r.kind}
              name={r.label}
              tone="violet"
              icon={<Terminal size={20} />}
              backend={r.ready ? "live" : r.kind}
              ready={r.ready}
              notReadyLabel="not ready"
              rows={[
                ["binary", r.binPresent ? r.bin ?? "on PATH" : "not found"],
                ["credentials", r.credentialSource ?? "none"],
                ["role", "execute (autonomous)"],
              ]}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
