import type { ReactNode } from "react";
import {
  Activity,
  Boxes,
  BrainCircuit,
  Gauge as GaugeIcon,
  LayoutDashboard,
  ListChecks,
  Radio,
} from "lucide-react";
import { cn } from "../lib/cn";
import { Button, Dot } from "./ui";
import type { View } from "../lib/api";

export type TabId = "overview" | "monitor" | "services" | "fleet" | "queue" | "observe";

const NAV: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <LayoutDashboard size={17} /> },
  { id: "monitor", label: "Monitor", icon: <GaugeIcon size={17} /> },
  { id: "services", label: "Services", icon: <BrainCircuit size={17} /> },
  { id: "fleet", label: "Fleet", icon: <Boxes size={17} /> },
  { id: "queue", label: "Queue", icon: <ListChecks size={17} /> },
  { id: "observe", label: "Observe", icon: <Activity size={17} /> },
];

export function Sidebar({ tab, onTab }: { tab: TabId; onTab: (t: TabId) => void }) {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-white/5 bg-ink-900/60 px-3 py-4 lg:flex">
      <div className="flex items-center gap-2.5 px-2">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-teal-400 to-teal-600 text-ink-950 shadow-lg">
          <Radio size={18} />
        </span>
        <div>
          <p className="text-sm font-semibold leading-tight text-slate-100">Ropex</p>
          <p className="text-[11px] text-slate-500">control plane</p>
        </div>
      </div>
      <nav className="mt-6 flex flex-col gap-1">
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => onTab(n.id)}
            className={cn(
              "group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition",
              tab === n.id
                ? "bg-teal-500/10 text-teal-200 ring-1 ring-inset ring-teal-500/20"
                : "text-slate-400 hover:bg-white/5 hover:text-slate-200",
            )}
          >
            <span className={cn(tab === n.id ? "text-teal-300" : "text-slate-500 group-hover:text-slate-300")}>{n.icon}</span>
            {n.label}
          </button>
        ))}
      </nav>
      <div className="mt-auto px-2 text-[11px] leading-relaxed text-slate-600">
        Hermes plans · DeepSeek executes · git-backed memory keeps the fleet coherent.
      </div>
    </aside>
  );
}

export function Topbar({
  view,
  live,
  onRefresh,
  onStack,
  busy,
}: {
  view?: View;
  live: boolean;
  onRefresh: () => void;
  onStack: (a: "up" | "down") => void;
  busy?: boolean;
}) {
  const stackStatus = view?.stack?.status ?? (view ? "run" : "…");
  const stackTone = stackStatus === "run" ? "ok" : stackStatus === "paused" ? "warn" : "muted";
  return (
    <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-white/5 bg-ink-950/70 px-5 py-3 backdrop-blur-md">
      <div className="min-w-0">
        <h1 className="truncate text-[15px] font-semibold tracking-tight text-slate-100">
          {view?.tagline ?? "One git sequence. Many workers in position."}
        </h1>
        <p className="truncate text-xs text-slate-500">
          revision {view?.revision ?? "—"} · {view?.source ?? "loading"}
        </p>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <span className="hidden items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-xs text-slate-400 ring-1 ring-inset ring-white/10 sm:inline-flex">
          <Dot tone={stackTone as "ok" | "warn" | "muted"} /> stack {stackStatus}
        </span>
        <Button size="sm" variant="ghost" onClick={() => onStack("up")} title="Apply fleet, resume, drain">
          Start
        </Button>
        <Button size="sm" variant="subtle" onClick={() => onStack("down")} title="Pause and sweep">
          Stop
        </Button>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
          <Dot tone="ok" pulse={live} /> Live
        </span>
        <Button size="sm" variant="primary" onClick={onRefresh} disabled={busy}>
          Refresh
        </Button>
      </div>
    </header>
  );
}
