import { ArrowRight, BrainCircuit, Cpu } from "lucide-react";
import type { FollowBeat, StreamState } from "../hooks/useStream";
import { cn } from "../lib/cn";

const phases = ["plan", "execute", "deliver", "learn"] as const;

function laneBeats(beats: FollowBeat[], owner: FollowBeat["owner"]) {
  return beats.filter((b) => b.owner === owner).slice(-4);
}

function Lane({
  title,
  owner,
  active,
  beats,
  tone,
}: {
  title: string;
  owner: FollowBeat["owner"];
  active: boolean;
  beats: FollowBeat[];
  tone: "teal" | "copper";
}) {
  const rows = laneBeats(beats, owner);
  return (
    <div
      className={cn(
        "min-w-0 flex-1 rounded-2xl border p-3 transition",
        active
          ? tone === "teal"
            ? "border-teal-400/50 bg-teal-500/10 shadow-[0_0_0_1px_rgba(45,212,191,0.2)]"
            : "border-orange-400/50 bg-orange-500/10 shadow-[0_0_0_1px_rgba(251,146,60,0.2)]"
          : "border-white/8 bg-ink-900/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("grid h-7 w-7 place-items-center rounded-lg", tone === "teal" ? "bg-teal-500/20 text-teal-200" : "bg-orange-500/20 text-orange-200")}>
          {tone === "teal" ? <BrainCircuit size={15} /> : <Cpu size={15} />}
        </span>
        <div>
          <div className="text-sm font-semibold text-slate-100">{title}</div>
          <div className={cn("text-[10px] uppercase tracking-wider", active ? (tone === "teal" ? "text-teal-300" : "text-orange-300") : "text-slate-600")}>
            {active ? "working" : "waiting"}
          </div>
        </div>
      </div>
      <div className="mt-3 space-y-1.5">
        {rows.length === 0 ? (
          <p className="text-[11px] text-slate-600">{tone === "teal" ? "Plan and memory land here." : "The step runs here."}</p>
        ) : (
          rows.map((b, i) => {
            const repeated = b.text.toLowerCase().startsWith(`${b.phase} `);
            const body = repeated ? b.text.slice(b.phase.length + 1) : b.text;
            return (
              <p key={`${b.stageId}-${i}`} className={cn("truncate text-[11px] leading-snug", i === rows.length - 1 && active ? "text-slate-100" : "text-slate-500")}>
                <span className="mr-1 font-mono text-slate-600">{b.phase}</span>
                {body}
              </p>
            );
          })
        )}
      </div>
    </div>
  );
}

export function FollowLanes({ state }: { state: StreamState }) {
  const cursor = state.cursor;
  const hermesOn = cursor?.owner === "hermes";
  const deepseekOn = cursor?.owner === "deepseek";
  const phaseIndex = cursor ? phases.indexOf(cursor.phase) : -1;

  return (
    <div className="mt-4 rounded-2xl border border-white/8 bg-ink-950/40 p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <span className="font-semibold uppercase tracking-wider text-slate-400">Follow</span>
        {phases.map((p, i) => (
          <span key={p} className="flex items-center gap-2">
            <span className={cn("rounded-full px-2 py-0.5", i === phaseIndex ? "bg-white/10 text-slate-100" : "text-slate-600")}>{p}</span>
            {i < phases.length - 1 ? <ArrowRight size={12} className={cn(i < phaseIndex ? "text-teal-500" : "text-slate-700")} /> : null}
          </span>
        ))}
        <span className="ml-auto truncate text-slate-400">
          {cursor ? `${cursor.agent || cursor.stageId} · ${cursor.phase}` : state.status === "idle" ? "waiting for a plan" : "starting"}
        </span>
      </div>
      <div className="flex flex-col gap-3 md:flex-row md:items-stretch">
        <Lane title="Hermes" owner="hermes" active={hermesOn} beats={state.beats} tone="teal" />
        <div className="hidden items-center md:flex">
          <ArrowRight size={18} className={cn("transition", deepseekOn ? "text-orange-300" : hermesOn ? "text-teal-300" : "text-slate-700")} />
        </div>
        <Lane title="DeepSeek harness" owner="deepseek" active={deepseekOn} beats={state.beats} tone="copper" />
      </div>
      {cursor ? (
        <p className="mt-3 truncate font-mono text-[11px] text-slate-300">
          {cursor.text.toLowerCase().startsWith(`${cursor.phase} `) ? cursor.text.slice(cursor.phase.length + 1) : cursor.text}
        </p>
      ) : null}
    </div>
  );
}
