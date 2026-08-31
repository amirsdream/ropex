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

export type StreamState = {
  status: "idle" | "planning" | "running" | "done" | "error";
  pipelineId?: string;
  planText?: string;
  stages: StageView[];
  events: { type: string; at: number; text: string }[];
  result?: string;
};

const initial: StreamState = { status: "idle", stages: [], events: [] };

export function useStream() {
  const [state, setState] = useState<StreamState>(initial);
  const esRef = useRef<EventSource | null>(null);

  const stop = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const run = useCallback(async (prompt: string) => {
    stop();
    setState({ status: "planning", stages: [], events: [{ type: "status", at: Date.now(), text: `Submitting: ${prompt}` }] });
    let pipelineId: string;
    try {
      const res = await api.submitPipeline(prompt, false);
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
            upsert(id, { role: String(d.role ?? id), agent: String(d.agent ?? ""), status: "running" });
            pushEvent(`▶ ${id} started`);
            break;
          }
          case "agent_log": {
            const id = String(d.stage_id ?? "stage");
            const i = next.stages.findIndex((x) => x.id === id);
            const line = String(d.message ?? "");
            if (i !== -1) next.stages[i] = { ...next.stages[i], logs: [...next.stages[i].logs, line] };
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
  }, [stop]);

  const reset = useCallback(() => {
    stop();
    setState(initial);
  }, [stop]);

  return { state, run, reset };
}
