import { useCallback, useRef, useState } from "react";
import { api, eventsUrl } from "../lib/api";

export type StageView = {
  id: string;
  role: string;
  agent?: string;
  status: "pending" | "running" | "done" | "error";
  logs: string[];
  output?: string;
};

export type FollowBeat = {
  owner: "hermes" | "deepseek";
  phase: "plan" | "execute" | "deliver" | "learn";
  stageId: string;
  agent?: string;
  text: string;
};

export type StreamState = {
  status: "idle" | "planning" | "running" | "done" | "error";
  pipelineId?: string;
  planText?: string;
  stages: StageView[];
  events: { type: string; at: number; text: string }[];
  beats: FollowBeat[];
  cursor?: FollowBeat;
  result?: string;
};

const initial: StreamState = { status: "idle", stages: [], events: [], beats: [] };

function visibleBeat(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…")
    .replace(/OPENAI_API_KEY\s*(\{[^}]*\})?/g, "model call $1")
    .replace(/DEEPSEEK_API_KEY\s*(\{[^}]*\})?/g, "model call $1");
}

function classify(logType: string): Pick<FollowBeat, "owner" | "phase"> | undefined {
  if (logType === "plan") return { owner: "hermes", phase: "plan" };
  if (logType === "learn") return { owner: "hermes", phase: "learn" };
  if (logType === "deliver") return { owner: "deepseek", phase: "deliver" };
  if (logType === "thought" || logType === "tool" || logType === "observation") return { owner: "deepseek", phase: "execute" };
  return undefined;
}

export function useStream() {
  const [state, setState] = useState<StreamState>(initial);
  const esRef = useRef<EventSource | null>(null);
  const queueRef = useRef<FollowBeat[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    queueRef.current = [];
  }, []);

  const play = useCallback((beat: FollowBeat) => {
    queueRef.current.push(beat);
    if (timerRef.current) return;
    const step = () => {
      const nextBeat = queueRef.current.shift();
      if (!nextBeat) {
        timerRef.current = null;
        return;
      }
      setState((s) => ({ ...s, cursor: nextBeat, beats: [...s.beats, nextBeat].slice(-30) }));
      timerRef.current = setTimeout(step, 420);
    };
    step();
  }, []);

  const run = useCallback(async (prompt: string, opts?: { simple?: boolean }) => {
    stop();
    const label = opts?.simple ? "simple pipeline" : prompt;
    setState({ status: "planning", stages: [], events: [{ type: "status", at: Date.now(), text: `Submitting: ${label}` }], beats: [] });
    let pipelineId: string;
    try {
      const res = await api.submitPipeline(prompt, false, { simple: opts?.simple });
      pipelineId = res.pipeline.id;
    } catch (err) {
      setState((s) => ({ ...s, status: "error", events: [...s.events, { type: "error", at: Date.now(), text: String(err) }] }));
      return;
    }
    setState((s) => ({ ...s, pipelineId, status: "running" }));

    const es = new EventSource(eventsUrl(pipelineId));
    esRef.current = es;
    es.onmessage = (ev) => {
      let msg: { type: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const d = msg.data ?? {};
      let beat: FollowBeat | undefined;
      if (msg.type === "agent_start") {
        const id = String(d.stage_id ?? d.role ?? "stage");
        const agent = String(d.agent ?? "");
        beat = { owner: "hermes", phase: "plan", stageId: id, agent, text: visibleBeat(`${agent || id} takes this step`) };
      } else if (msg.type === "agent_log") {
        const lane = classify(String(d.log_type ?? ""));
        if (lane) {
          beat = { ...lane, stageId: String(d.stage_id ?? "stage"), text: visibleBeat(String(d.message ?? "")) };
        }
      }
      setState((s) => {
        const next: StreamState = { ...s, stages: [...s.stages], events: [...s.events] };
        const pushEvent = (text: string) => next.events.push({ type: msg.type, at: Date.now(), text });
        const upsert = (id: string, patch: Partial<StageView>) => {
          const i = next.stages.findIndex((x) => x.id === id);
          if (i === -1) next.stages.push({ id, role: id, status: "pending", logs: [], ...patch });
          else next.stages[i] = { ...next.stages[i], ...patch, logs: patch.logs ?? next.stages[i].logs };
        };
        switch (msg.type) {
          case "plan":
            next.planText = String(d.description ?? d.message ?? "");
            pushEvent(`Planned ${d.stages ?? ""} stage(s)`);
            break;
          case "agent_start": {
            const id = String(d.stage_id ?? d.role ?? "stage");
            const agent = String(d.agent ?? "");
            upsert(id, { role: String(d.role ?? id), agent, status: "running" });
            pushEvent(`▶ ${id} started`);
            break;
          }
          case "agent_log": {
            const id = String(d.stage_id ?? "stage");
            const i = next.stages.findIndex((x) => x.id === id);
            const line = String(d.message ?? "");
            if (i !== -1) next.stages[i] = { ...next.stages[i], logs: [...next.stages[i].logs, line] };
            if (beat && !beat.agent) beat = { ...beat, agent: next.stages.find((x) => x.id === id)?.agent };
            break;
          }
          case "agent_complete": {
            const id = String(d.stage_id ?? d.role ?? "stage");
            const err = d.error === true;
            upsert(id, { status: err ? "error" : "done", output: String(d.output ?? "") });
            pushEvent(`${err ? "✖" : "✔"} ${id} ${err ? "failed" : "complete"}`);
            break;
          }
          case "complete":
            next.status = "done";
            next.result = String(d.output ?? "");
            pushEvent("● pipeline complete");
            break;
          case "error":
            next.status = "error";
            pushEvent(`✖ ${String(d.message ?? "error")}`);
            break;
          case "stream_end":
            es.close();
            break;
          default:
            break;
        }
        return next;
      });
      if (beat) play(beat);
    };
    es.onerror = () => {
      es.close();
      esRef.current = null;
    };

    // Kick the scoped drain so the stages actually execute and stream.
    try {
      await api.drainPipeline(pipelineId);
    } catch {
      /* SSE surfaces failures */
    }
  }, [play, stop]);

  const reset = useCallback(() => {
    stop();
    setState(initial);
  }, [stop]);

  return { state, run, reset };
}
