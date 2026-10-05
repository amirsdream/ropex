import { TriangleAlert } from "lucide-react";
import type { View } from "../lib/api";
import { Badge, Panel, SectionHead } from "../components/ui";
import { RunBoard } from "../components/RunBoard";

export function Overview({ view }: { view: View }) {
  const dead = view.queue.filter((q) => q.status === "dead");
  const waiting = view.approvals.filter((a) => a.status === "pending");
  const trouble = !view.health.ok || view.drain.paused || dead.length > 0 || waiting.length > 0;

  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-sm leading-relaxed text-slate-400">
        A plan reuses a pinned fleet or mints one, runs its steps in one session, then that session is deleted. Hermes memory stays on this control plane.
        {" "}
        <a href="#services" className="text-teal-300 underline-offset-2 hover:underline">Run a plan</a>
        {" "}to watch the handoff.
      </p>

      {trouble ? (
        <Panel>
          <SectionHead
            title="Needs attention"
            sub="Only shown when a worker, the queue, or an approval is stuck."
            icon={<TriangleAlert size={16} />}
          />
          <div className="flex flex-wrap gap-2 px-5 pb-5">
            {!view.health.ok ? <Badge tone="err">{view.health.unhealthy} unhealthy workers</Badge> : null}
            {view.drain.paused ? <Badge tone="warn">queue paused</Badge> : null}
            {dead.length ? <Badge tone="err">{dead.length} dead tasks</Badge> : null}
            {waiting.length ? <Badge tone="warn">{waiting.length} approvals waiting</Badge> : null}
            <a href="#queue" className="text-xs text-teal-300 underline-offset-2 hover:underline">Open plans</a>
          </div>
        </Panel>
      ) : null}

      <RunBoard view={view} />
    </div>
  );
}
