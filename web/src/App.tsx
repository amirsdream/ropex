import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sidebar, Topbar, type TabId } from "./components/Shell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useView, useHistory } from "./hooks/useView";
import { api } from "./lib/api";
import { Overview } from "./pages/Overview";
import { Monitor } from "./pages/Monitor";
import { Services } from "./pages/Services";
import { Fleet } from "./pages/Fleet";
import { Queue } from "./pages/Queue";
import { Observe } from "./pages/Observe";
import { cn } from "./lib/cn";

type Toast = { id: number; text: string; tone: "ok" | "err" };

const TABS: TabId[] = ["overview", "monitor", "services", "fleet", "queue", "observe"];

function tabFromHash(): TabId {
  const h = window.location.hash.replace(/^#\/?/, "") as TabId;
  return TABS.includes(h) ? h : "overview";
}

export default function App() {
  const [tab, setTabState] = useState<TabId>(tabFromHash);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const setTab = useCallback((t: TabId) => {
    setTabState(t);
    if (window.location.hash.replace(/^#\/?/, "") !== t) window.location.hash = t;
  }, []);

  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const q = useView();
  const history = useHistory();
  const view = q.data;
  const qc = useQueryClient();

  const toast = useCallback((text: string, tone: "ok" | "err" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const onStack = useCallback(
    async (action: "up" | "down") => {
      try {
        await api.stack(action);
        toast(`stack ${action}`);
        qc.invalidateQueries({ queryKey: ["view"] });
      } catch (e) {
        toast(String(e), "err");
      }
    },
    [qc, toast],
  );

  return (
    <div className="flex min-h-screen">
      <Sidebar tab={tab} onTab={setTab} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar view={view} live={!q.isError} busy={q.isFetching} onRefresh={() => qc.invalidateQueries({ queryKey: ["view"] })} onStack={onStack} />

        {/* Mobile tab bar */}
        <div className="flex gap-1 overflow-x-auto border-b border-white/5 px-3 py-2 lg:hidden">
          {(["overview", "monitor", "services", "fleet", "queue", "observe"] as TabId[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cn("shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium capitalize", tab === t ? "bg-teal-500/15 text-teal-200" : "text-slate-400")}>{t}</button>
          ))}
        </div>

        <main className="animate-rise mx-auto w-full max-w-[1500px] flex-1 px-4 py-5 md:px-6">
          {q.isError ? (
            <div className="grid place-items-center py-24 text-center">
              <div>
                <p className="text-lg font-semibold text-rose-300">Control plane unreachable</p>
                <p className="mt-1 text-sm text-slate-500">{String(q.error)}</p>
              </div>
            </div>
          ) : !view ? (
            <div className="grid place-items-center py-24">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-teal-500/30 border-t-teal-400" />
            </div>
          ) : (
            <ErrorBoundary key={tab}>
              {tab === "overview" && <Overview view={view} history={history} />}
              {tab === "monitor" && <Monitor view={view} history={history} />}
              {tab === "services" && <Services view={view} />}
              {tab === "fleet" && <Fleet view={view} />}
              {tab === "queue" && <Queue view={view} />}
              {tab === "observe" && <Observe view={view} />}
            </ErrorBoundary>
          )}
        </main>
      </div>

      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={cn("animate-rise rounded-xl px-4 py-2.5 text-sm shadow-xl ring-1 ring-inset", t.tone === "ok" ? "bg-emerald-500/15 text-emerald-200 ring-emerald-500/25" : "bg-rose-500/15 text-rose-200 ring-rose-500/25")}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}
