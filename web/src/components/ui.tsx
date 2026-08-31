import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-white/5 bg-ink-850/70 backdrop-blur-sm shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset,0_20px_40px_-24px_rgba(0,0,0,0.9)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionHead({
  title,
  sub,
  icon,
  right,
}: {
  title: string;
  sub?: string;
  icon?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
      <div className="flex items-start gap-3">
        {icon ? <div className="mt-0.5 text-teal-400">{icon}</div> : null}
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-slate-100">{title}</h3>
          {sub ? <p className="mt-0.5 text-xs text-slate-500">{sub}</p> : null}
        </div>
      </div>
      {right}
    </div>
  );
}

const badgeTones: Record<string, string> = {
  ok: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/25",
  warn: "bg-amber-500/15 text-amber-300 ring-amber-500/25",
  err: "bg-rose-500/15 text-rose-300 ring-rose-500/25",
  info: "bg-sky-500/15 text-sky-300 ring-sky-500/25",
  teal: "bg-teal-500/15 text-teal-300 ring-teal-500/25",
  muted: "bg-white/5 text-slate-400 ring-white/10",
  copper: "bg-orange-500/15 text-orange-300 ring-orange-500/25",
  violet: "bg-violet-500/15 text-violet-300 ring-violet-500/25",
};

export function Badge({ tone = "muted", children }: { tone?: keyof typeof badgeTones; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", badgeTones[tone])}>
      {children}
    </span>
  );
}

export function Dot({ tone = "muted", pulse }: { tone?: keyof typeof badgeTones; pulse?: boolean }) {
  const color: Record<string, string> = {
    ok: "bg-emerald-400",
    warn: "bg-amber-400",
    err: "bg-rose-400",
    info: "bg-sky-400",
    teal: "bg-teal-400",
    muted: "bg-slate-500",
    copper: "bg-orange-400",
    violet: "bg-violet-400",
  };
  return <span className={cn("inline-block h-2 w-2 rounded-full", color[tone], pulse && "animate-pulse-dot")} />;
}

export function Button({
  children,
  onClick,
  variant = "ghost",
  size = "md",
  disabled,
  title,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger" | "subtle";
  size?: "sm" | "md";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
}) {
  const variants: Record<string, string> = {
    primary: "bg-teal-500 text-ink-950 hover:bg-teal-400 shadow-[0_8px_24px_-12px_rgba(20,184,166,0.8)]",
    ghost: "bg-white/5 text-slate-200 hover:bg-white/10 ring-1 ring-inset ring-white/10",
    subtle: "bg-transparent text-slate-400 hover:text-slate-100 hover:bg-white/5",
    danger: "bg-rose-500/90 text-white hover:bg-rose-500",
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:opacity-40 disabled:cursor-not-allowed",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-sm",
        variants[variant],
      )}
    >
      {children}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-5 py-8 text-center text-sm text-slate-500">{children}</div>;
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-slate-500">{k}</span>
      <span className="font-mono text-slate-200">{v}</span>
    </div>
  );
}
