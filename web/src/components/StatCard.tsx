import type { ReactNode } from "react";
import { Panel } from "./ui";
import { Spark } from "./charts";
import { cn } from "../lib/cn";

export function StatCard({
  label,
  value,
  spark,
  color = "teal",
  icon,
  hint,
  delta,
}: {
  label: string;
  value: ReactNode;
  spark?: number[];
  color?: "teal" | "copper" | "violet" | "sky" | "rose" | "amber" | "emerald";
  icon?: ReactNode;
  hint?: string;
  delta?: number;
}) {
  return (
    <Panel className="relative overflow-hidden p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</span>
        {icon ? <span className="text-slate-500">{icon}</span> : null}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <span className="font-mono text-3xl font-semibold leading-none text-slate-50">{value}</span>
        {delta != null && delta !== 0 ? (
          <span className={cn("mb-1 text-xs font-medium", delta > 0 ? "text-emerald-400" : "text-slate-500")}>
            {delta > 0 ? "▲" : "▼"} {Math.abs(delta)}
          </span>
        ) : null}
      </div>
      {hint ? <div className="mt-1 text-[11px] text-slate-500">{hint}</div> : null}
      {spark && spark.length > 1 ? (
        <div className="mt-3 -mx-1">
          <Spark data={spark} color={color} height={34} />
        </div>
      ) : null}
    </Panel>
  );
}
