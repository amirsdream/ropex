import {
  Area,
  AreaChart,
  CartesianGrid,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Sample } from "../hooks/useView";

const palette: Record<string, string> = {
  teal: "#2dd4bf",
  copper: "#fb923c",
  violet: "#a78bfa",
  sky: "#38bdf8",
  rose: "#fb7185",
  amber: "#fbbf24",
  emerald: "#34d399",
};

export function Spark({ data, color = "teal", height = 40 }: { data: number[]; color?: keyof typeof palette; height?: number }) {
  const rows = data.map((v, i) => ({ i, v }));
  const c = palette[color];
  const id = `sp-${color}-${data.length}`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={rows} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c} stopOpacity={0.5} />
            <stop offset="100%" stopColor={c} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={c} strokeWidth={1.75} fill={`url(#${id})`} isAnimationActive={false} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

type SeriesDef = { key: keyof Sample; label: string; color: keyof typeof palette };

function TooltipBox({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-ink-900/95 px-3 py-2 text-xs shadow-xl">
      <div className="mb-1 font-mono text-[10px] text-slate-500">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="text-slate-400">{p.name}</span>
          <span className="ml-auto font-mono text-slate-100">{Math.round(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function TimeSeries({
  data,
  series,
  height = 180,
  stack = false,
}: {
  data: Sample[];
  series: SeriesDef[];
  height?: number;
  stack?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 10, bottom: 0, left: -18 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={String(s.key)} id={`grad-${String(s.key)}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={palette[s.color]} stopOpacity={0.35} />
              <stop offset="100%" stopColor={palette[s.color]} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 6" stroke="rgba(255,255,255,0.05)" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: "#4b5563", fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={40} />
        <YAxis tick={{ fill: "#4b5563", fontSize: 10 }} tickLine={false} axisLine={false} width={34} allowDecimals={false} />
        <Tooltip content={<TooltipBox />} />
        {series.map((s) => (
          <Area
            key={String(s.key)}
            type="monotone"
            name={s.label}
            dataKey={s.key as string}
            stackId={stack ? "1" : undefined}
            stroke={palette[s.color]}
            strokeWidth={2}
            fill={`url(#grad-${String(s.key)})`}
            isAnimationActive={false}
            dot={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function Gauge({ value, label, color = "teal", suffix = "%" }: { value: number; label: string; color?: keyof typeof palette; suffix?: string }) {
  const v = Math.max(0, Math.min(100, value));
  const data = [{ name: label, value: v, fill: palette[color] }];
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={140}>
        <RadialBarChart innerRadius="72%" outerRadius="100%" data={data} startAngle={220} endAngle={-40}>
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar background={{ fill: "rgba(255,255,255,0.05)" }} dataKey="value" cornerRadius={999} isAnimationActive={false} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-2xl font-semibold text-slate-100">
          {Math.round(v)}
          <span className="text-sm text-slate-500">{suffix}</span>
        </span>
        <span className="mt-0.5 text-[11px] uppercase tracking-wider text-slate-500">{label}</span>
      </div>
    </div>
  );
}
