const $ = (sel) => document.querySelector(sel);

const REFRESH_MS = 5000;

/** Latest view snapshot for agent drill-down without extra fetch. */
let cachedView = null;
/** Active SSE subscription while a pipeline drawer is open. */
let activeEventSource = null;

function showToast(message, kind = "ok") {
  const stack = $("#toast-stack");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function initDetailDrawer() {
  $("#detail-close")?.addEventListener("click", () => closeDetailDrawer());
  document.querySelectorAll("[data-close-drawer]").forEach((el) => {
    el.addEventListener("click", () => closeDetailDrawer());
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeDetailDrawer();
  });
}

function closeDetailDrawer() {
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  const drawer = $("#detail-drawer");
  const log = $("#detail-log");
  if (log) {
    log.hidden = true;
    log.innerHTML = "";
  }
  if (drawer) {
    drawer.hidden = true;
    drawer.setAttribute("aria-hidden", "true");
  }
}

function openDetailDrawer({ kicker, title, bodyHtml, live = false }) {
  const drawer = $("#detail-drawer");
  const kickerEl = $("#detail-kicker");
  const titleEl = $("#detail-title");
  const bodyEl = $("#detail-body");
  const logEl = $("#detail-log");
  if (!drawer || !titleEl || !bodyEl) return;
  if (kickerEl) kickerEl.textContent = kicker ?? "Deep dive";
  titleEl.textContent = title ?? "Detail";
  bodyEl.innerHTML = bodyHtml ?? "";
  if (logEl) {
    logEl.hidden = !live;
    logEl.innerHTML = live ? `<p class="section-lede">Live stage events…</p>` : "";
  }
  drawer.hidden = false;
  drawer.setAttribute("aria-hidden", "false");
}

function subscribePipelineEvents(pipelineId) {
  if (!pipelineId) return;
  if (activeEventSource) activeEventSource.close();
  const logEl = $("#detail-log");
  if (!logEl) return;
  logEl.hidden = false;
  activeEventSource = new EventSource(
    `/api/v1/events?pipelineId=${encodeURIComponent(pipelineId)}&format=ui`,
  );
  activeEventSource.onmessage = (ev) => {
    const line = document.createElement("div");
    line.className = "log-line";
    try {
      const parsed = JSON.parse(ev.data);
      const msg =
        parsed.data?.message ??
        parsed.data?.output ??
        parsed.data?.description ??
        JSON.stringify(parsed.data);
      line.textContent = `[${parsed.type}] ${String(msg).slice(0, 500)}`;
      if (parsed.type === "error") line.classList.add("is-error");
      if (parsed.type === "complete" || parsed.type === "stream_end") line.classList.add("is-complete");
      if (parsed.type === "stream_end") {
        activeEventSource?.close();
        activeEventSource = null;
        void refresh();
      }
    } catch {
      line.textContent = ev.data;
    }
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  };
  activeEventSource.onerror = () => {
    activeEventSource?.close();
    activeEventSource = null;
  };
}

function renderPipelineDetailBody(pipeline) {
  const stages = (pipeline.stages ?? [])
    .map(
      (s) => `
      <div class="detail-row">
        <div>
          <strong>${escapeHtml(s.id)}</strong> · ${escapeHtml(s.agent)}
          <p>${escapeHtml((s.output || s.prompt || "").slice(0, 600))}</p>
          ${s.error ? `<p>${escapeHtml(s.error)}</p>` : ""}
        </div>
        <span class="status status-${s.status === "done" ? "idle" : s.status === "failed" ? "failed" : "running"}">${escapeHtml(s.status)}</span>
      </div>`,
    )
    .join("");
  const events = (pipeline.events ?? [])
    .slice(-40)
    .map(
      (e) =>
        `<div class="log-line">${escapeHtml(e.at?.slice(11, 19) ?? "")} [${escapeHtml(e.kind)}] ${escapeHtml((e.message ?? e.artifact ?? "").slice(0, 200))}</div>`,
    )
    .join("");
  return `
    <div class="detail-meta">
      <span>status ${escapeHtml(pipeline.status)}</span>
      <span>${pipeline.stages?.length ?? 0} stages</span>
      <span>${formatTime(pipeline.updatedAt || pipeline.createdAt)}</span>
    </div>
    <div class="detail-block">
      <h3>Prompt</h3>
      <p>${escapeHtml(pipeline.prompt ?? "")}</p>
    </div>
    <div class="detail-block">
      <h3>Stages</h3>
      ${stages || `<p class="empty">No stages.</p>`}
    </div>
    ${
      pipeline.output
        ? `<div class="detail-block"><h3>Output</h3><pre>${escapeHtml(pipeline.output.slice(0, 4000))}</pre></div>`
        : ""
    }
    ${
      events
        ? `<div class="detail-block"><h3>Recent events</h3>${events}</div>`
        : ""
    }`;
}

async function showPipelineDetail(pipelineId, { live = false } = {}) {
  if (!pipelineId) return;
  const res = await fetch(`/api/v1/pipeline?id=${encodeURIComponent(pipelineId)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(body.error || `pipeline ${res.status}`, "err");
    return;
  }
  const shouldLive =
    live || body.status === "running" || body.status === "pending";
  openDetailDrawer({
    kicker: "Pipeline",
    title: `${body.id?.slice(0, 12) ?? "run"}…`,
    bodyHtml: renderPipelineDetailBody(body),
    live: shouldLive,
  });
  if (shouldLive) subscribePipelineEvents(pipelineId);
}

function renderTrajectoryDetailBody(traj) {
  const steps = (traj.steps ?? [])
    .map(
      (s, i) => `
      <div class="detail-row">
        <div>
          <strong>step ${i + 1}</strong>
          <p>${escapeHtml(s.thought || "")}</p>
          ${
            s.calls?.length
              ? `<p>tools: ${s.calls.map((c) => escapeHtml(`${c.plugin}.${c.name}`)).join(", ")}</p>`
              : ""
          }
          <p>${escapeHtml((s.observation || "").slice(0, 800))}</p>
        </div>
      </div>`,
    )
    .join("");
  return `
    <div class="detail-meta">
      <span>${escapeHtml(traj.agent)}</span>
      <span>${escapeHtml(traj.taskId)}</span>
      <span>${formatTime(traj.at)}</span>
      <span>${escapeHtml((traj.stages ?? []).join(" → ") || "workflow")}</span>
    </div>
    <div class="detail-block">
      <h3>Plan</h3>
      <p>${escapeHtml((traj.plan ?? []).join(" · ") || "—")}</p>
    </div>
    <div class="detail-block">
      <h3>Hermes → DeepSeek steps</h3>
      ${steps || `<p class="empty">No steps recorded.</p>`}
    </div>
    <div class="detail-block">
      <h3>Output</h3>
      <pre>${escapeHtml((traj.output ?? "").slice(0, 4000))}</pre>
    </div>`;
}

async function showTrajectoryDetail(trajectoryId) {
  if (!trajectoryId) return;
  const res = await fetch(`/api/v1/trajectories?id=${encodeURIComponent(trajectoryId)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(body.error || `trajectory ${res.status}`, "err");
    return;
  }
  openDetailDrawer({
    kicker: "Trajectory",
    title: trajectoryId,
    bodyHtml: renderTrajectoryDetailBody(body),
  });
}

function showAgentDetail(agentName) {
  if (!cachedView || !agentName) return;
  const hermes = cachedView.hermes?.find((h) => h.agent === agentName);
  const harness = cachedView.harness?.find((h) => h.agent === agentName);
  const worker = cachedView.workers?.find((w) => w.agent === agentName);
  if (!hermes && !harness) {
    showToast(`agent not found: ${agentName}`, "err");
    return;
  }
  const body = `
    <div class="detail-meta">
      <span>agent ${escapeHtml(agentName)}</span>
      ${worker ? `<span>worker ${escapeHtml(worker.id)}</span>` : ""}
      ${worker ? `<span>${escapeHtml(worker.harness)} · ${escapeHtml(worker.model)}</span>` : ""}
    </div>
    ${
      hermes
        ? `<div class="detail-block">
      <h3>Hermes brain</h3>
      <p>soul ${escapeHtml(hermes.soul)}</p>
      <p>memory ${escapeHtml(hermes.memoryBackend)} · learning ${hermes.learning ? "on" : "off"}</p>
      <p>share read=[${hermes.share.read.map(escapeHtml).join(", ")}] write=${escapeHtml(hermes.share.write)}</p>
      <p>skills: ${hermes.skills.map(escapeHtml).join(", ") || "none"}</p>
    </div>`
        : ""
    }
    ${
      harness
        ? `<div class="detail-block">
      <h3>DeepSeek harness</h3>
      <p>profile ${escapeHtml(harness.profile)} · loop ${escapeHtml(harness.loop)}</p>
      <p>model ${escapeHtml(harness.model)}</p>
      <p>plugins: ${harness.plugins.map(escapeHtml).join(", ")}</p>
      <p>tools: ${harness.tools.map(escapeHtml).join(", ")}</p>
    </div>`
        : ""
    }
    <div class="detail-block">
      <h3>Workflow</h3>
      <p>${(cachedView.workflow ?? []).map((s) => `${s.id} (${s.owner})`).join(" → ")}</p>
    </div>`;
  openDetailDrawer({
    kicker: "Agent surface",
    title: agentName,
    bodyHtml: body,
  });
}

/** Expanded agent groups (persists across refresh). */
const expandedAgents = new Set(
  JSON.parse(localStorage.getItem("ropex-expanded-agents") || "[]"),
);

function persistExpandedAgents() {
  localStorage.setItem("ropex-expanded-agents", JSON.stringify([...expandedAgents]));
}

function initTheme() {
  const root = document.documentElement;
  const saved = localStorage.getItem("ropex-theme");
  if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  $("#theme-toggle")?.addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    localStorage.setItem("ropex-theme", next);
    showToast(`Theme: ${next}`);
  });
}

function initTabs() {
  const buttons = [...document.querySelectorAll(".tab-btn")];
  const panels = [...document.querySelectorAll(".tab-panel")];
  const activate = (name) => {
    buttons.forEach((btn) => {
      const on = btn.getAttribute("data-tab") === name;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    panels.forEach((panel) => {
      const on = panel.id === `tab-${name}`;
      panel.classList.toggle("is-active", on);
      panel.hidden = !on;
    });
    localStorage.setItem("ropex-tab", name);
  };
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => activate(btn.getAttribute("data-tab")));
  });
  const saved = localStorage.getItem("ropex-tab") || "overview";
  activate(saved);

  $("#workers-expand-all")?.addEventListener("click", () => {
    document.querySelectorAll(".agent-group").forEach((g) => {
      const agent = g.getAttribute("data-agent");
      if (agent) expandedAgents.add(agent);
      g.classList.add("is-open");
    });
    persistExpandedAgents();
  });
  $("#workers-collapse-all")?.addEventListener("click", () => {
    expandedAgents.clear();
    persistExpandedAgents();
    document.querySelectorAll(".agent-group").forEach((g) => g.classList.remove("is-open"));
  });
}

/** @deprecated scroll-spy nav replaced by tabs */
function initNav() {
  initTabs();
}

async function loadView() {
  const res = await fetch("/api/v1/view");
  if (!res.ok) throw new Error(`view ${res.status}`);
  return res.json();
}

function renderPulse(view) {
  const el = $("#pulse");
  const tone = (k, v) => {
    if (k === "slo" && v === "breach") return "bad";
    if (k === "drift" && v === "yes") return "bad";
    if (k === "unhealthy" && Number(v) > 0) return "warn";
    if (k === "canary" && v !== "ok") return "warn";
    if (k === "queue" && v === "paused") return "warn";
    return "ok";
  };
  const items = [
    ["live", view.counts.workersLive],
    ["memory", view.counts.memoryFacts],
    ["tasks", view.taskGit?.pending ?? 0],
    ["queue", view.counts.queuePending],
    ["done", view.counts.tasksCompleted],
    ["unhealthy", view.metrics?.workersUnhealthy ?? 0],
    ["slo", view.metrics?.backlogSloBreached ? "breach" : "ok"],
    ["drift", view.drift?.ok === false ? "yes" : "ok"],
    ["state", view.queuePaused ? "paused" : "run"],
    ["traj", view.trajectories?.total ?? 0],
    ["pipes", view.pipelines?.total ?? 0],
    ["rl", view.rateLimits?.nearLimit ?? 0],
    ["dup", view.webhookDuplicates ?? 0],
    ["canary", view.canary?.ok === false ? `${view.canary.pctMatched}%` : "ok"],
  ];
  el.innerHTML = items
    .map(
      ([k, v]) =>
        `<div><dt>${k}</dt><dd data-tone="${tone(k, v)}">${escapeHtml(String(v))}</dd></div>`,
    )
    .join("");
}

function donutSvg(parts) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = parts
    .map((p) => {
      const len = (p.value / total) * c;
      const arc = `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${p.color}" stroke-width="12"
        stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}" />`;
      offset += len;
      return arc;
    })
    .join("");
  return `<svg viewBox="0 0 100 100" aria-hidden="true">${arcs}</svg>`;
}

function renderCharts(view) {
  const el = $("#chart-grid");
  if (!el) return;
  const workers = view.workers ?? [];
  const byStatus = { idle: 0, running: 0, pending: 0, failed: 0, other: 0 };
  for (const w of workers) {
    if (byStatus[w.status] !== undefined) byStatus[w.status] += 1;
    else byStatus.other += 1;
  }
  const statusParts = [
    { label: "idle", value: byStatus.idle, color: "#4ade80" },
    { label: "running", value: byStatus.running, color: "#fb923c" },
    { label: "pending", value: byStatus.pending, color: "#94a3b8" },
    { label: "failed", value: byStatus.failed, color: "#f87171" },
  ].filter((p) => p.value > 0);

  const byAgent = new Map();
  for (const w of workers) {
    const key = w.fleet ? `${w.fleet}` : w.agent;
    byAgent.set(key, (byAgent.get(key) || 0) + 1);
  }
  const agentBars = [...byAgent.entries()].sort((a, b) => b[1] - a[1]);
  const maxBar = Math.max(1, ...agentBars.map(([, n]) => n));

  const queuePending = view.counts?.queuePending ?? 0;
  const done = view.counts?.tasksCompleted ?? 0;
  const failed = view.metrics?.tasksFailed ?? 0;
  const traj = view.trajectories?.total ?? 0;
  const pipes = view.pipelines?.total ?? 0;
  const backlogParts = [
    { label: "pending", value: queuePending, color: "#fb923c" },
    { label: "done", value: done, color: "#2dd4bf" },
    { label: "failed", value: failed, color: "#f87171" },
    { label: "traj", value: traj, color: "#94a3b8" },
    { label: "pipes", value: pipes, color: "#5eead4" },
  ];
  const backlogMax = Math.max(1, ...backlogParts.map((p) => p.value));

  el.innerHTML = `
    <article class="chart-card">
      <h3>Worker status</h3>
      <div class="chart-body">
        <div class="donut-wrap">
          ${donutSvg(statusParts.length ? statusParts : [{ value: 1, color: "#334155" }])}
          <div class="donut-center"><strong>${workers.length}</strong><span>workers</span></div>
        </div>
        <ul class="chart-legend">
          ${statusParts.map((p) => `<li><span class="swatch" style="background:${p.color}"></span>${p.label} ${p.value}</li>`).join("") || "<li>No workers</li>"}
        </ul>
      </div>
    </article>
    <article class="chart-card">
      <h3>Replicas by agent / fleet</h3>
      <div class="bar-chart">
        ${
          agentBars
            .slice(0, 8)
            .map(
              ([name, n]) => `
          <div class="bar-row">
            <span title="${escapeHtml(name)}">${escapeHtml(name.length > 12 ? name.slice(0, 11) + "…" : name)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${(n / maxBar) * 100}%"></div></div>
            <span>${n}</span>
          </div>`,
            )
            .join("") || `<p class="empty">No workers yet.</p>`
        }
      </div>
    </article>
    <article class="chart-card">
      <h3>Work &amp; learning</h3>
      <div class="bar-chart">
        ${backlogParts
          .map(
            (p) => `
          <div class="bar-row">
            <span>${p.label}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${(p.value / backlogMax) * 100}%;background:${p.color}"></div></div>
            <span>${p.value}</span>
          </div>`,
          )
          .join("")}
      </div>
    </article>`;
}

function renderWorkflow(view) {
  const el = $("#workflow-list");
  if (!el) return;
  const stages = view.workflow ?? [];
  el.innerHTML = stages
    .map((s, i) => {
      const ownerClass = s.owner === "hermes" ? "is-hermes" : s.owner === "deepseek" ? "is-deepseek" : "";
      const arrow = i < stages.length - 1 ? `<span class="wf-arrow" aria-hidden="true">→</span>` : "";
      return `
      <div class="wf-node ${ownerClass}" style="animation-delay:${0.05 * i}s">
        <span class="step-id">${escapeHtml(s.id)}</span>
        <span class="owner">${escapeHtml(s.owner)}</span>
        <p class="purpose">${escapeHtml(s.purpose)}</p>
      </div>${arrow}`;
    })
    .join("");
}

function groupWorkers(workers) {
  const groups = new Map();
  for (const w of workers) {
    const key = w.agent;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderWorkers(view) {
  const el = $("#worker-rail");
  if (!el) return;
  if (!view.workers.length) {
    el.innerHTML = `<p class="empty">No workers. Apply fleets/examples, then refresh.</p>`;
    return;
  }
  const groups = groupWorkers(view.workers);
  el.innerHTML = groups
    .map(([agent, replicas]) => {
      const open = expandedAgents.has(agent);
      const fleet = replicas[0]?.fleet;
      const harness = replicas[0]?.harness ?? "";
      const model = replicas[0]?.model ?? "";
      const statusCounts = {};
      for (const r of replicas) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
      const pills = Object.entries(statusCounts)
        .map(([st, n]) => `<span class="status-pill is-${escapeHtml(st)}">${n} ${escapeHtml(st)}</span>`)
        .join("");
      const rows = replicas
        .map(
          (w) => `
        <div class="worker-row">
          <div>
            <div class="worker-id">${escapeHtml(w.id)}</div>
            <div class="digest">${escapeHtml(w.harness)} · ${escapeHtml(w.model)}</div>
          </div>
          <div class="status status-${w.status}">${w.status}</div>
          <div class="digest" title="${escapeHtml(w.imageDigest)}">${escapeHtml(w.imageDigest.slice(0, 12))}…</div>
          <div class="digest">mem ${w.memoryReadable} · skills ${w.skills.length}</div>
        </div>`,
        )
        .join("");
      return `
      <div class="agent-group ${open ? "is-open" : ""}" data-agent="${escapeHtml(agent)}">
        <button type="button" class="agent-group-head" data-toggle-agent="${escapeHtml(agent)}" aria-expanded="${open}">
          <span class="chev" aria-hidden="true">▸</span>
          <div>
            <div class="agent-name">${escapeHtml(agent)}${fleet ? ` <span class="agent-meta">fleet ${escapeHtml(fleet)}</span>` : ""}</div>
            <div class="agent-meta">${escapeHtml(harness)} · ${escapeHtml(model)}</div>
          </div>
          <span class="replica-count">${replicas.length} replica${replicas.length === 1 ? "" : "s"}</span>
          <div class="status-pills">${pills}</div>
        </button>
        <div class="agent-group-body">${rows}</div>
      </div>`;
    })
    .join("");

  el.querySelectorAll("[data-toggle-agent]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const agent = btn.getAttribute("data-toggle-agent");
      const group = btn.closest(".agent-group");
      if (!agent || !group) return;
      const willOpen = !group.classList.contains("is-open");
      group.classList.toggle("is-open", willOpen);
      btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
      if (willOpen) expandedAgents.add(agent);
      else expandedAgents.delete(agent);
      persistExpandedAgents();
    });
  });
}

function renderMemory(view) {
  const toolbar = $("#memory-toolbar");
  const mg = view.memoryGit ?? { gitBacked: 0, runtimeOnly: 0, defaultDir: "memory" };
  toolbar.innerHTML = `
    <div class="worker-row">
      <div>
        <div class="worker-id">Git memory</div>
        <div class="digest">${mg.gitBacked} in git · ${mg.runtimeOnly} runtime-only · <code>${escapeHtml(mg.defaultDir)}/</code></div>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" data-memory-action="sync">Sync from git</button>
      <button type="button" class="btn btn-primary btn-sm" data-memory-action="export">Export all</button>
    </div>`;
  toolbar.querySelectorAll("[data-memory-action]").forEach((btn) => {
    btn.addEventListener("click", () => memoryAction(btn.getAttribute("data-memory-action")));
  });

  const el = $("#memory-stream");
  if (!view.memory.length) {
    el.innerHTML = `<p class="empty">No shared facts yet. Run a task or <code>ropex memory sync</code>.</p>`;
    return;
  }
  el.innerHTML = view.memory
    .map(
      (m, i) => `
      <article class="mem-item" style="animation-delay:${Math.min(i, 12) * 0.04}s">
        <div class="mem-meta">
          <span class="scope">${m.scope}</span>
          ${m.manifestPath ? `<span class="scope" title="${escapeHtml(m.manifestPath)}">git</span>` : ""}
          <span>${escapeHtml(m.agent)}</span>
          ${m.fleet ? `<span>${escapeHtml(m.fleet)}</span>` : ""}
          <span>${formatTime(m.at)}</span>
        </div>
        <p class="mem-text">${escapeHtml(m.text)}</p>
      </article>`,
    )
    .join("");
}

function renderTasks(view) {
  const toolbar = $("#tasks-toolbar");
  const tg = view.taskGit ?? { pending: 0, done: 0, failed: 0, scanned: 0, defaultDir: "tasks", items: [] };
  toolbar.innerHTML = `
    <div class="worker-row">
      <div>
        <div class="worker-id">Git tasks</div>
        <div class="digest">${tg.pending} pending · ${tg.done} done · ${tg.failed} failed · <code>${escapeHtml(tg.defaultDir)}/</code></div>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" data-task-action="sync">Sync from git</button>
    </div>`;
  toolbar.querySelectorAll("[data-task-action]").forEach((btn) => {
    btn.addEventListener("click", () => taskAction(btn.getAttribute("data-task-action")));
  });

  const el = $("#tasks-stream");
  if (!tg.items?.length) {
    el.innerHTML = `<p class="empty">No Task YAML yet. Add files under <code>tasks/</code> or run <code>ropex tasks sync</code>.</p>`;
    return;
  }
  el.innerHTML = tg.items
    .map(
      (t, i) => `
      <article class="mem-item" style="animation-delay:${Math.min(i, 12) * 0.04}s">
        <div class="mem-meta">
          <span class="scope">${escapeHtml(t.status)}</span>
          ${t.inQueue ? `<span class="scope" title="queue">${escapeHtml(t.queueStatus ?? "queued")}</span>` : ""}
          <span>${escapeHtml(t.agent)}</span>
          ${t.priority != null ? `<span>p${t.priority}</span>` : ""}
        </div>
        <p class="mem-text"><strong>${escapeHtml(t.id)}</strong> — ${escapeHtml(t.prompt)}</p>
      </article>`,
    )
    .join("");
}

async function taskAction(action) {
  const res = await fetch("/api/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    showToast(`Task ${action} failed`, "err");
    return;
  }
  const result = await res.json().catch(() => ({}));
  showToast(
    action === "sync"
      ? `Synced ${result.enqueued?.length ?? 0} tasks (${result.skipped?.length ?? 0} skipped)`
      : `Task ${action} ok`,
  );
  await refresh();
}

async function memoryAction(action) {
  const body =
    action === "sync"
      ? { action: "sync" }
      : action === "export"
        ? { action: "export", all: true }
        : null;
  if (!body) return;
  const res = await fetch("/api/v1/memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    showToast(`Memory ${action} failed`, "err");
    return;
  }
  const result = await res.json().catch(() => ({}));
  showToast(
    action === "sync"
      ? `Synced ${result.synced?.length ?? 0} memory facts`
      : `Exported ${result.exported?.length ?? 0} files`,
  );
  await refresh();
}

function renderHealth(view) {
  const el = $("#health-panel");
  const h = view.health;
  if (!h) {
    el.innerHTML = `<p class="empty">Health report unavailable.</p>`;
    return;
  }
  const age =
    h.oldestPendingAgeMs == null ? "—" : `${Math.round(h.oldestPendingAgeMs / 1000)}s`;
  const head = `
    <div class="worker-row">
      <div>
        <div class="worker-id">cluster</div>
        <div class="digest">pending ${h.backlogPending} · oldest ${age}</div>
      </div>
      <div class="status status-${h.ok ? "idle" : "failed"}">${h.ok ? "healthy" : "degraded"}</div>
      <div class="digest">unhealthy ${h.unhealthy}</div>
      <div class="digest">slo ${h.backlogBreached ? "breach" : "ok"}</div>
    </div>`;
  const repos = (view.gitRepos ?? [])
    .map(
      (r) => `
      <div class="worker-row">
        <div>
          <div class="worker-id">${escapeHtml(r.name)}</div>
          <div class="digest">${escapeHtml(r.path)}</div>
        </div>
        <div class="status status-${r.ok ? "idle" : "failed"}">${r.ok ? "synced" : "missing"}</div>
        <div class="digest">${r.lastSyncedAt ? formatTime(r.lastSyncedAt) : "never"}</div>
        <div class="digest">${escapeHtml(r.reason ?? "")}</div>
      </div>`,
    )
    .join("");
  const workers = (h.workers ?? [])
    .map(
      (w, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(w.id)}</div>
          <div class="digest">${escapeHtml(w.detail)}</div>
        </div>
        <div class="status status-${w.healthy ? "idle" : "failed"}">${w.healthy ? "ok" : "unhealthy"}</div>
        <div class="digest">${escapeHtml(w.status)}</div>
        <div class="digest"></div>
      </div>`,
    )
    .join("");
  el.innerHTML = head + repos + (workers || `<p class="empty">No live workers to probe.</p>`);
}

function renderHygiene(view) {
  const rail = $("#hygiene-rail");
  const heat = $("#pool-heatmap");
  const depth = $("#queue-depth");
  const h = view.hygiene;
  if (!h) {
    if (rail) rail.innerHTML = `<p class="empty">Hygiene report unavailable.</p>`;
    return;
  }
  const wh = h.webhook ?? {};
  if (rail) {
    rail.innerHTML = `
      <div class="worker-row">
        <div>
          <div class="worker-id">webhook idempotency</div>
          <div class="digest">seen ${wh.seen ?? 0}/${wh.cap ?? 0} · duplicates ${wh.duplicates ?? 0}</div>
        </div>
        <div class="status status-${(wh.duplicates ?? 0) > 0 ? "failed" : "idle"}">ingress</div>
        <div class="digest">leases reclaimed ${h.leasesReclaimedTotal ?? 0}</div>
        <div class="digest">dead ${h.summary?.dead ?? 0}</div>
      </div>
      <div class="worker-row">
        <div>
          <div class="worker-id">hooks</div>
          <div class="digest">reclaim expired leases · GC orphan worktrees · age priorities</div>
        </div>
        <div class="status status-idle">hygiene</div>
        <div class="digest"></div>
        <div class="digest">
          <button type="button" data-hygiene="reclaim">reclaim</button>
          <button type="button" data-hygiene="age">age</button>
          <button type="button" data-hygiene="gc">gc</button>
          <button type="button" data-hygiene="all">all</button>
        </div>
      </div>`;
    rail.querySelectorAll("[data-hygiene]").forEach((btn) => {
      btn.addEventListener("click", () => runHygieneAction(btn.getAttribute("data-hygiene")));
    });
  }
  if (heat) {
    const cells = h.pool ?? [];
    heat.innerHTML = cells.length
      ? cells
          .map((c, i) => {
            const t = Math.max(1, c.total);
            return `
        <div class="heat-cell" style="animation-delay:${Math.min(i, 12) * 0.04}s">
          <div class="agent">${escapeHtml(c.agent)}</div>
          <div class="digest">${c.idle} idle · ${c.running} run · ${c.failed} fail</div>
          <div class="mix" title="idle/running/failed/cordoned">
            <span class="heat-idle" style="width:${(100 * c.idle) / t}%"></span>
            <span class="heat-running" style="width:${(100 * c.running) / t}%"></span>
            <span class="heat-failed" style="width:${(100 * c.failed) / t}%"></span>
            <span class="heat-cordoned" style="width:${(100 * c.cordoned) / t}%"></span>
          </div>
        </div>`;
          })
          .join("")
      : `<p class="empty">No live workers for heatmap.</p>`;
  }
  if (depth) {
    const bars = h.queueDepth ?? [];
    const max = Math.max(1, ...bars.map((b) => b.count));
    depth.innerHTML = bars.length
      ? bars
          .map(
            (b) => `
      <div class="depth-row">
        <span>${escapeHtml(b.key)}</span>
        <div class="depth-track"><div class="depth-fill" style="width:${(100 * b.count) / max}%"></div></div>
        <strong>${b.count}</strong>
      </div>`,
          )
          .join("")
      : `<p class="empty">Queue depth empty.</p>`;
  }
}

async function runHygieneAction(action) {
  const res = await fetch("/api/v1/hygiene", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("#meta").textContent = `hygiene failed: ${body.error || res.status}`;
    return;
  }
  $("#meta").textContent = `hygiene ${body.action}: reclaim ${body.reclaimed} age ${body.aged} gc ${body.gcRemoved}`;
  location.reload();
}

function renderDrift(view) {
  const el = $("#drift-rail");
  const d = view.drift;
  if (!d) {
    el.innerHTML = `<p class="empty">Drift report unavailable.</p>`;
    return;
  }
  const s = d.summary ?? {};
  const head = `
    <div class="worker-row">
      <div>
        <div class="worker-id">cluster</div>
        <div class="digest">live ${d.liveWorkers} · desired ${d.desiredWorkers}</div>
      </div>
      <div class="status status-${d.ok ? "idle" : "failed"}">${d.ok ? "in sync" : "drift"}</div>
      <div class="digest">digest ${s.digest ?? 0} · replica ${s.replica ?? 0}</div>
      <div class="digest">missing ${s.missing ?? 0} · extra ${s.extra ?? 0}</div>
    </div>`;
  const rows = (d.findings ?? [])
    .slice(0, 16)
    .map(
      (f, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(f.kind)}</div>
          <div class="digest">${escapeHtml(f.detail)}</div>
        </div>
        <div class="status status-failed">${escapeHtml(f.agent ?? "—")}</div>
        <div class="digest">${escapeHtml(f.workerId ?? "")}</div>
        <div class="digest"></div>
      </div>`,
    )
    .join("");
  el.innerHTML =
    head +
    (rows ||
      `<p class="empty">${d.ok ? "Desired and live workers match." : "No finding details."}</p>`);
}

function renderFairness(view) {
  const el = $("#fairness-rail");
  const f = view.fairness;
  if (!f) {
    el.innerHTML = `<p class="empty">Fairness report unavailable.</p>`;
    return;
  }
  const pending = Object.entries(f.pendingByAgent ?? {})
    .map(([a, n]) => `${a}=${n}`)
    .join(" ");
  const head = `
    <div class="worker-row">
      <div>
        <div class="worker-id">claim wait</div>
        <div class="digest">p50 ${f.claimWaitP50Ms}ms · p95 ${f.claimWaitP95Ms}ms · max ${f.claimWaitMaxMs}ms</div>
      </div>
      <div class="status status-idle">latency</div>
      <div class="digest">run p50 ${f.runDurationP50Ms}ms · p95 ${f.runDurationP95Ms}ms</div>
      <div class="digest">skew ${f.maxIdleSkewMs}ms · cv ${f.claimCountCv}</div>
    </div>
    ${
      pending
        ? `<div class="worker-row"><div><div class="worker-id">pending</div><div class="digest">${escapeHtml(pending)}</div></div><div class="status status-running">queue</div><div class="digest"></div><div class="digest"></div></div>`
        : ""
    }`;
  const rows = (f.topWorkers ?? [])
    .map(
      (w, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(w.workerId)}</div>
          <div class="digest">${escapeHtml(w.agent)}</div>
        </div>
        <div class="status status-idle">claims ${w.claims}</div>
        <div class="digest">idleSkew ${w.idleSkewMs}ms</div>
        <div class="digest"></div>
      </div>`,
    )
    .join("");
  el.innerHTML = head + (rows || `<p class="empty">No live workers for fairness.</p>`);
}

function renderBudget(view) {
  const el = $("#budget-rail");
  const rows = view.budget?.rows ?? [];
  if (!rows.length) {
    el.innerHTML = `<p class="empty">No Policy.budget scopes configured.</p>`;
    return;
  }
  const alerts = view.budget?.alerts ?? 0;
  const head = `
    <div class="worker-row">
      <div>
        <div class="worker-id">alerts</div>
        <div class="digest">warn/exhausted scopes (remaining ≤20%)</div>
      </div>
      <div class="status status-${alerts ? "failed" : "idle"}">${alerts ? `${alerts} alert` : "ok"}</div>
      <div class="digest"></div>
      <div class="digest"></div>
    </div>`;
  el.innerHTML =
    head +
    rows
      .map(
        (r, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(r.key)}</div>
          <div class="digest">${escapeHtml(r.scope)} · remaining ${r.remaining} (${r.remainingPct ?? "—"}%)</div>
        </div>
        <div class="status status-${r.level === "ok" || (!r.level && !r.exhausted) ? "idle" : "failed"}">${escapeHtml(r.level ?? (r.exhausted ? "exhausted" : "ok"))}</div>
        <div class="digest">spent ${r.spent}</div>
        <div class="digest">limit ${r.limit}</div>
      </div>`,
      )
      .join("");
}

function renderCanary(view) {
  const el = $("#canary-rail");
  const c = view.canary;
  if (!c) {
    el.innerHTML = `<p class="empty">Canary progress unavailable.</p>`;
    return;
  }
  const head = `
    <div class="worker-row">
      <div>
        <div class="worker-id">digest coverage</div>
        <div class="digest">${c.matched}/${c.total} matched · ${c.pctMatched}%</div>
      </div>
      <div class="status status-${c.ok ? "idle" : "failed"}">${c.ok ? "rolled" : "rolling"}</div>
      <div class="digest">mismatched ${c.mismatched}</div>
      <div class="digest">GET /api/v1/canary</div>
    </div>`;
  const rows = (c.agents ?? [])
    .map(
      (a, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(a.agent)}</div>
          <div class="digest">${escapeHtml((a.desiredDigest || "").slice(0, 12))}…</div>
        </div>
        <div class="status status-${a.mismatched ? "failed" : "idle"}">${a.pctMatched}%</div>
        <div class="digest">ok ${a.matched} · hold ${a.mismatched}</div>
        <div class="digest"></div>
      </div>`,
    )
    .join("");
  el.innerHTML = head + (rows || `<p class="empty">No desired agents.</p>`);
}

function renderSkills(view) {
  const el = $("#skills-rail");
  const rows = view.skillCatalog ?? [];
  if (!rows.length) {
    el.innerHTML = `<p class="empty">No registry skills yet. Learn from a trajectory, then promote.</p>`;
    return;
  }
  el.innerHTML = rows
    .map(
      (s, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(s.name)} v${s.version}</div>
          <div class="digest">${escapeHtml(s.summary || "")}</div>
        </div>
        <div class="status status-${s.coverage >= 100 ? "idle" : "failed"}">${s.coverage}% share</div>
        <div class="digest">origin ${escapeHtml(s.originAgent)} · vers ${s.versions}</div>
        <div class="digest"><button type="button" data-promote="${escapeHtml(s.name)}">promote</button></div>
      </div>`,
    )
    .join("");
  el.querySelectorAll("[data-promote]").forEach((btn) => {
    btn.addEventListener("click", () => promoteSkillUi(btn.getAttribute("data-promote")));
  });
}

async function promoteSkillUi(name) {
  if (!name) return;
  const res = await fetch("/api/v1/skills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "promote", name }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("#meta").textContent = `promote failed: ${body.error || res.status}`;
    return;
  }
  $("#meta").textContent = `promoted ${name} v${body.skill?.version ?? "?"}`;
  location.reload();
}

function renderPolicy(view) {
  const el = $("#policy-rail");
  const p = view.policySim;
  if (!p) {
    el.innerHTML = `<p class="empty">Policy simulation unavailable.</p>`;
    return;
  }
  const head = `
    <div class="worker-row">
      <div>
        <div class="worker-id">simulate</div>
        <div class="digest">denied tasks ${p.deniedTasks} · denied calls ${p.deniedCalls}</div>
      </div>
      <div class="status status-${p.deniedTasks || p.deniedCalls ? "failed" : "idle"}">gates</div>
      <div class="digest">approvals ${p.approvalCalls}</div>
      <div class="digest">rows ${p.rows?.length ?? 0}</div>
    </div>
    <div class="worker-row">
      <div>
        <div class="worker-id">custom prompt</div>
        <div class="digest"><input id="policy-prompt" type="text" placeholder="probe: force-push main" style="width:min(28rem,70vw)" /></div>
      </div>
      <div class="status status-idle">dry-run</div>
      <div class="digest"></div>
      <div class="digest"><button type="button" id="policy-run">simulate</button></div>
    </div>`;
  const rows = (p.rows ?? [])
    .slice(0, 12)
    .map(
      (r, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(r.agent)}</div>
          <div class="digest">${escapeHtml(r.prompt)}</div>
        </div>
        <div class="status status-${r.taskDenied ? "failed" : "idle"}">${r.taskDenied ? "deny" : "allow"}</div>
        <div class="digest">${escapeHtml((r.callsDenied ?? []).join(",") || "—")}</div>
        <div class="digest">${escapeHtml((r.callsNeedApproval ?? []).join(",") || "—")}</div>
      </div>`,
    )
    .join("");
  el.innerHTML = head + rows;
  $("#policy-run")?.addEventListener("click", () => {
    const prompt = $("#policy-prompt")?.value?.trim();
    runPolicySim(prompt || undefined);
  });
}

async function runPolicySim(prompt) {
  const res = await fetch("/api/v1/policy/simulate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(prompt ? { prompt } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("#meta").textContent = `policy sim failed: ${body.error || res.status}`;
    return;
  }
  const el = $("#policy-rail");
  if (!el) return;
  const head = `
    <div class="worker-row">
      <div>
        <div class="worker-id">simulate (live)</div>
        <div class="digest">denied tasks ${body.deniedTasks} · denied calls ${body.deniedCalls}</div>
      </div>
      <div class="status status-${body.deniedTasks || body.deniedCalls ? "failed" : "idle"}">gates</div>
      <div class="digest">approvals ${body.approvalCalls}</div>
      <div class="digest">rows ${body.rows?.length ?? 0}</div>
    </div>`;
  const rows = (body.rows ?? [])
    .slice(0, 20)
    .map(
      (r, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(r.agent)}</div>
          <div class="digest">${escapeHtml(r.prompt)}</div>
        </div>
        <div class="status status-${r.taskDenied ? "failed" : "idle"}">${r.taskDenied ? "deny" : "allow"}</div>
        <div class="digest">${escapeHtml((r.callsDenied ?? []).join(",") || "—")}</div>
        <div class="digest">${escapeHtml((r.callsNeedApproval ?? []).join(",") || "—")}</div>
      </div>`,
    )
    .join("");
  el.innerHTML = head + rows;
  $("#meta").textContent = `policy simulate @ ${formatTime(body.at)}`;
}

function renderOutbound(view) {
  const el = $("#outbound-rail");
  const o = view.outbound;
  if (!o) {
    el.innerHTML = `<p class="empty">Outbound journal unavailable.</p>`;
    return;
  }
  const head = `
    <div class="worker-row">
      <div>
        <div class="worker-id">webhooks</div>
        <div class="digest">simulated ${o.simulated} · rejected ${o.rejected}</div>
      </div>
      <div class="status status-${o.rejected ? "failed" : "idle"}">outbound</div>
      <div class="digest">recent ${o.recent?.length ?? 0}</div>
      <div class="digest"></div>
    </div>`;
  const rows = (o.recent ?? [])
    .slice(0, 12)
    .map(
      (r, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(r.agent ?? r.id)}</div>
          <div class="digest">${escapeHtml(r.url)}</div>
        </div>
        <div class="status status-${r.status === "simulated" ? "idle" : "failed"}">${escapeHtml(r.status)}</div>
        <div class="digest">${escapeHtml(r.reason ?? r.deliveryId ?? "")}</div>
        <div class="digest">${formatTime(r.at)}</div>
      </div>`,
    )
    .join("");
  el.innerHTML =
    head + (rows || `<p class="empty">No outbound intents. Use ropex deliver --stub.</p>`);
}

function renderClone(view) {
  const el = $("#clone-rail");
  const c = view.clone;
  if (!c) {
    el.innerHTML = `<p class="empty">Clone status unavailable.</p>`;
    return;
  }
  const head = `
    <div class="worker-row">
      <div>
        <div class="worker-id">gitrepos</div>
        <div class="digest">ok ${c.ok} · blocked ${c.blocked} · total ${c.repos}</div>
      </div>
      <div class="status status-${c.blocked ? "failed" : "idle"}">clone</div>
      <div class="digest">ropex clone [--dry-run]</div>
      <div class="digest"></div>
    </div>`;
  const rows = (c.rows ?? [])
    .map(
      (r, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(r.name)}</div>
          <div class="digest">${escapeHtml(r.path)}${r.reason ? ` · ${escapeHtml(r.reason)}` : ""}</div>
        </div>
        <div class="status status-${r.ok ? "idle" : "failed"}">${escapeHtml(r.clonePhase ?? (r.ok ? "ok" : "failed"))}</div>
        <div class="digest">${r.cloneProgressPct ?? "—"}% · ${escapeHtml(r.cloneBackend ?? "—")}</div>
        <div class="digest">${r.lastClonedAt ? formatTime(r.lastClonedAt) : "never"}</div>
      </div>`,
    )
    .join("");
  el.innerHTML =
    head +
    (rows || `<p class="empty">No clone attempts yet. Apply GitRepos then ropex clone.</p>`);
}

function renderAutoscale(view) {
  const el = $("#autoscale-rail");
  const a = view.autoscale;
  if (!a?.recommendations?.length) {
    el.innerHTML = `<p class="empty">No scale changes. Backlog SLO ${a?.backlogBreached ? "breached" : "ok"} · cap ${a?.policyCap ?? "—"}.</p>`;
    return;
  }
  el.innerHTML = a.recommendations
    .map(
      (r, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(r.kind)}/${escapeHtml(r.name)}</div>
          <div class="digest">${escapeHtml(r.reason)}</div>
        </div>
        <div class="status status-${r.delta > 0 ? "running" : "idle"}">${r.currentReplicas}→${r.recommendedReplicas}</div>
        <div class="digest">Δ ${r.delta > 0 ? "+" : ""}${r.delta}</div>
        <div class="digest">commit YAML</div>
      </div>`,
    )
    .join("");
}

function renderPipelines(view) {
  const el = $("#pipelines-rail");
  const controls = $("#pipeline-controls");
  if (!el) return;
  const p = view.pipelines ?? { total: 0, recent: [] };
  if (controls) {
    controls.innerHTML = `
      <div class="worker-row">
        <div>
          <div class="worker-id">executor</div>
          <div class="digest">${p.total} runs · POST /api/v1/pipeline</div>
        </div>
        <div class="status status-idle">api</div>
        <div class="digest" style="flex:1">
          <input id="pipeline-prompt" type="text" placeholder="Prompt for a new pipeline…" style="width:100%;min-width:12rem" />
        </div>
        <div class="digest">
          <button type="button" id="pipeline-run">run</button>
        </div>
      </div>`;
    $("#pipeline-run")?.addEventListener("click", () => {
      const prompt = ($("#pipeline-prompt")?.value ?? "").trim();
      if (prompt) void submitPipelineUi(prompt);
    });
  }
  if (!p.recent?.length) {
    el.innerHTML = `<p class="empty">No pipelines yet. Run from the form above or Magentic.</p>`;
    return;
  }
  el.innerHTML = p.recent
    .map((row) => {
      const st = row.status === "done" ? "idle" : row.status === "failed" ? "failed" : "running";
      const drainBtn =
        row.status === "running" || row.status === "pending"
          ? `<button type="button" data-drain="${row.id}">drain</button>`
          : "";
      return `<div class="worker-row is-clickable" data-pipeline="${escapeHtml(row.id)}">
        <div>
          <div class="worker-id">${escapeHtml(row.id.slice(0, 8))}…</div>
          <div class="digest">${escapeHtml(row.prompt || "")}</div>
        </div>
        <div class="status status-${st}">${escapeHtml(row.status)}</div>
        <div class="digest">${row.doneStages ?? 0}/${row.stages} stages · ${escapeHtml((row.updatedAt || "").slice(11, 19))}</div>
        <div class="digest">${drainBtn}<button type="button" data-view-pipeline="${escapeHtml(row.id)}">view</button></div>
      </div>`;
    })
    .join("");
  el.querySelectorAll("[data-drain]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void drainPipelineUi(btn.getAttribute("data-drain"));
    });
  });
  el.querySelectorAll("[data-view-pipeline]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void showPipelineDetail(btn.getAttribute("data-view-pipeline"));
    });
  });
  el.querySelectorAll("[data-pipeline]").forEach((row) => {
    row.addEventListener("click", () => {
      void showPipelineDetail(row.getAttribute("data-pipeline"));
    });
  });
}

async function submitPipelineUi(prompt) {
  const res = await fetch("/api/v1/pipeline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, drain: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(body.error || `pipeline failed (${res.status})`, "err");
    return;
  }
  showToast(`pipeline ${body.pipeline?.status ?? "ok"}`, "ok");
  if (body.pipeline?.id) {
    await showPipelineDetail(body.pipeline.id, { live: true });
  } else {
    await refresh();
  }
}

async function drainPipelineUi(pipelineId) {
  const res = await fetch("/api/v1/pipeline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "drain", pipelineId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(body.error || `drain failed (${res.status})`, "err");
    return;
  }
  showToast(`drained ${body.drained ?? 0}`, "ok");
  await refresh();
}

function renderQueue(view) {
  const el = $("#queue-rail");
  const drainEl = $("#drain-controls");
  const d = view.drain;
  if (drainEl && d) {
    drainEl.innerHTML = `
      <div class="worker-row">
        <div>
          <div class="worker-id">drain</div>
          <div class="digest">pending ${d.pending} · idle ${d.idleWorkers} · running ${d.runningWorkers}${d.paused ? " · PAUSED" : ""}</div>
        </div>
        <div class="status status-${d.paused ? "failed" : "idle"}">c=${d.concurrency}</div>
        <div class="digest">
          <label>concurrency <input id="drain-concurrency" type="number" min="1" max="${d.maxConcurrency}" value="${d.concurrency}" style="width:3.5rem" /></label>
        </div>
        <div class="digest">
          <button type="button" id="queue-pause">${d.paused ? "resume" : "pause"}</button>
          <button type="button" id="drain-prefer">save</button>
          <button type="button" id="drain-run" ${d.paused ? "disabled" : ""}>drain</button>
        </div>
      </div>`;
    const input = $("#drain-concurrency");
    $("#drain-prefer")?.addEventListener("click", () => preferDrain(Number(input?.value ?? d.concurrency)));
    $("#drain-run")?.addEventListener("click", () => runDrain(Number(input?.value ?? d.concurrency)));
    $("#queue-pause")?.addEventListener("click", () =>
      queueAction(d.paused ? "resume" : "pause"),
    );
  }
  const paused = view.queuePaused
    ? `<div class="worker-row"><div><div class="worker-id">scheduler</div><div class="digest">claims blocked — resume above</div></div><div class="status status-failed">paused</div><div class="digest">dupes ${view.webhookDuplicates ?? 0}</div><div class="digest"></div></div>`
    : "";
  const dead = (view.queue ?? []).filter((q) => q.status === "dead");
  const deadHead = dead.length
    ? `<div class="worker-row"><div><div class="worker-id">dead letters</div><div class="digest">${dead.length} items</div></div><div class="status status-failed">dlq</div><div class="digest"></div><div class="digest"><button type="button" id="retry-all">retry all</button></div></div>`
    : "";
  if (!view.queue?.length) {
    el.innerHTML =
      paused +
      deadHead +
      `<p class="empty">Queue empty. Webhook or simulate to enqueue.</p>`;
    $("#retry-all")?.addEventListener("click", () => queueAction("retry", { all: true }));
    return;
  }
  el.innerHTML =
    paused +
    deadHead +
    view.queue
      .slice()
      .reverse()
      .map(
        (q, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(q.agent)}</div>
          <div class="digest">${escapeHtml(q.prompt)}</div>
        </div>
        <div class="status status-${q.status === "done" ? "idle" : q.status === "dead" ? "failed" : q.status}">${q.status}${q.attempts ? `·a${q.attempts}` : ""}</div>
        <div class="digest">${escapeHtml(q.source)}${q.nextRetryAt ? " · retry" : ""}${q.error ? ` · ${escapeHtml(q.error).slice(0, 40)}` : ""}</div>
        <div class="digest">${
          q.status === "dead"
            ? `<button type="button" data-retry="${escapeHtml(q.id)}">retry</button>`
            : escapeHtml(q.id)
        }</div>
      </div>`,
      )
      .join("");
  $("#retry-all")?.addEventListener("click", () => queueAction("retry", { all: true }));
  el.querySelectorAll("[data-retry]").forEach((btn) => {
    btn.addEventListener("click", () => queueAction("retry", { id: btn.getAttribute("data-retry") }));
  });
}

async function queueAction(action, extra = {}) {
  const res = await fetch("/api/v1/queue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("#meta").textContent = `queue ${action} failed: ${body.error || res.status}`;
    return;
  }
  $("#meta").textContent =
    action === "retry" ? `retried ${body.retried ?? 0}` : `queue ${action}`;
  location.reload();
}

async function preferDrain(concurrency) {
  const res = await fetch("/api/v1/drain", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ concurrency }),
  });
  if (!res.ok) {
    $("#meta").textContent = `drain prefer failed: ${await res.text()}`;
    return;
  }
  location.reload();
}

async function runDrain(concurrency) {
  const res = await fetch("/api/v1/drain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ concurrency }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("#meta").textContent = `drain failed: ${body.error || res.status}`;
    return;
  }
  $("#meta").textContent = `drained ${body.drained ?? 0} at c=${body.status?.concurrency ?? concurrency}`;
  location.reload();
}

function renderAffinity(view) {
  const el = $("#affinity-rail");
  const a = view.affinity;
  if (!a) {
    el.innerHTML = `<p class="empty">Affinity unavailable.</p>`;
    return;
  }
  const head = `
    <div class="worker-row">
      <div>
        <div class="worker-id">sticky</div>
        <div class="digest">active bindings ${a.active} · TTL prefers last successful worker</div>
      </div>
      <div class="status status-idle">affinity</div>
      <div class="digest">agent:repo → worker</div>
      <div class="digest"></div>
    </div>`;
  const rows = (a.bindings ?? [])
    .map(
      (b, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(b.key)}</div>
          <div class="digest">${escapeHtml(b.agent)}</div>
        </div>
        <div class="status status-running">${escapeHtml(b.workerId)}</div>
        <div class="digest">expires ${formatTime(b.expiresAt)}</div>
        <div class="digest"></div>
      </div>`,
    )
    .join("");
  el.innerHTML =
    head + (rows || `<p class="empty">No sticky bindings yet. Complete a task to pin.</p>`);
}

function renderDsh(view) {
  const el = $("#dsh-rail");
  const d = view.dsh;
  if (!d) {
    el.innerHTML = `<p class="empty">dsh surface unavailable.</p>`;
    return;
  }
  const h = view.hermesLive;
  const hermesRow = h
    ? `<div class="worker-row">
      <div>
        <div class="worker-id">hermes brain</div>
        <div class="digest">${escapeHtml(h.scaffoldHint)}</div>
      </div>
      <div class="status status-${h.liveReady ? "idle" : "failed"}">${h.liveReady ? "live" : "simulated"}</div>
      <div class="digest">backend ${escapeHtml(h.backend ?? "simulated")} · pkg ${h.packageInstalled ? "yes" : "no"}</div>
      <div class="digest"></div>
    </div>`
    : "";
  const head = `
    <div class="worker-row">
      <div>
        <div class="worker-id">deepseek harness</div>
        <div class="digest">${escapeHtml(d.scaffoldHint)}</div>
      </div>
      <div class="status status-${d.liveReady ? "idle" : "failed"}">${d.liveReady ? "live" : "simulated"}</div>
      <div class="digest">backend ${escapeHtml(d.backend)} · pkg ${d.packageInstalled ? "yes" : "no"} · key ${d.apiKeyPresent ? escapeHtml(d.apiKeySource ?? "yes") : "no"}</div>
      <div class="digest">profiles ${d.profiles?.length ?? 0}</div>
    </div>`;
  const rows = (d.profiles ?? [])
    .map(
      (p, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(p.profile)}</div>
          <div class="digest">${escapeHtml(p.description)}</div>
        </div>
        <div class="status status-idle">${escapeHtml(p.loop)}</div>
        <div class="digest">${escapeHtml((p.plugins ?? []).join(", "))} · dsh ${escapeHtml(p.dshProfile ?? "headless")}</div>
        <div class="digest"></div>
      </div>`,
    )
    .join("");
  el.innerHTML = hermesRow + head + rows + renderGithubAppRow(view);
}

function renderGithubAppRow(view) {
  const g = view.githubApp;
  if (!g) return "";
  return `
    <div class="worker-row">
      <div>
        <div class="worker-id">github app</div>
        <div class="digest">${escapeHtml(g.summary)}</div>
      </div>
      <div class="status status-${g.ready ? "idle" : "failed"}">${g.ready ? "ready" : "setup"}</div>
      <div class="digest">id ${g.appIdPresent ? "yes" : "no"} · key ${g.privateKeyPresent ? "yes" : "no"} · wh ${g.webhookSecretPresent ? "yes" : "no"}</div>
      <div class="digest"></div>
    </div>`;
}

function renderJournal(view) {
  const el = $("#journal-stream");
  if (!view.deliveries?.length) {
    el.innerHTML = `<p class="empty">No deliveries yet.</p>`;
    return;
  }
  el.innerHTML = view.deliveries
    .map(
      (d, i) => `
      <article class="mem-item" style="animation-delay:${Math.min(i, 12) * 0.04}s">
        <div class="mem-meta">
          <span class="scope">${escapeHtml(d.kind)}</span>
          <span>${escapeHtml(d.agent)}</span>
          ${d.repo ? `<span>${escapeHtml(d.repo)}</span>` : ""}
          <span>${formatTime(d.at)}</span>
        </div>
        <p class="mem-text">${escapeHtml(d.body)}</p>
      </article>`,
    )
    .join("");
}

function renderApprovals(view) {
  const el = $("#approvals-rail");
  if (!view.approvals?.length) {
    el.innerHTML = `<p class="empty">No pending approvals.</p>`;
    return;
  }
  el.innerHTML = view.approvals
    .map(
      (a, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(a.tool)}</div>
          <div class="digest">${escapeHtml(a.reason)}</div>
        </div>
        <div class="status status-failed">${escapeHtml(a.status)}</div>
        <div class="digest">${escapeHtml(a.agent)}</div>
        <div class="digest">
          <button type="button" data-approve="${escapeHtml(a.id)}">approve</button>
          <button type="button" data-reject="${escapeHtml(a.id)}">reject</button>
        </div>
      </div>`,
    )
    .join("");
  el.querySelectorAll("[data-approve]").forEach((btn) => {
    btn.addEventListener("click", () => decide(btn.getAttribute("data-approve"), "approved"));
  });
  el.querySelectorAll("[data-reject]").forEach((btn) => {
    btn.addEventListener("click", () => decide(btn.getAttribute("data-reject"), "rejected"));
  });
}

async function decide(id, decision) {
  if (!id) return;
  const res = await fetch("/api/v1/approvals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, decision }),
  });
  if (!res.ok) {
    const err = await res.text();
    $("#meta").textContent = `approval failed: ${err}`;
    return;
  }
  location.reload();
}

function renderTrajectories(view) {
  const el = $("#trajectories-rail");
  const t = view.trajectories;
  if (!t) {
    el.innerHTML = `<p class="empty">Trajectories unavailable.</p>`;
    return;
  }
  const head = `
    <div class="worker-row">
      <div>
        <div class="worker-id">stored</div>
        <div class="digest">${t.total} trajectories · recent ${t.recent?.length ?? 0}</div>
      </div>
      <div class="status status-idle">learn</div>
      <div class="digest">export /api/v1/trajectories?format=jsonl</div>
      <div class="digest"></div>
    </div>`;
  const rows = (t.recent ?? [])
    .map(
      (r, i) => `
      <div class="worker-row is-clickable" data-trajectory="${escapeHtml(r.id)}" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(r.id)}</div>
          <div class="digest">${escapeHtml(r.agent)} · ${escapeHtml(r.taskId)}</div>
        </div>
        <div class="status status-running">${r.steps} steps</div>
        <div class="digest">${escapeHtml((r.stages ?? []).join(" → ") || "—")}</div>
        <div class="digest">${formatTime(r.at)} · view</div>
      </div>`,
    )
    .join("");
  el.innerHTML =
    head + (rows || `<p class="empty">No trajectories yet. Drain a task to record one.</p>`);
  el.querySelectorAll("[data-trajectory]").forEach((row) => {
    row.addEventListener("click", () => {
      void showTrajectoryDetail(row.getAttribute("data-trajectory"));
    });
  });
}

function renderRateLimits(view) {
  const el = $("#ratelimits-rail");
  const r = view.rateLimits;
  if (!r) {
    el.innerHTML = `<p class="empty">Rate-limit data unavailable.</p>`;
    return;
  }
  const head = `
    <div class="worker-row">
      <div>
        <div class="worker-id">windows</div>
        <div class="digest">limit ${r.limit} / ${Math.round(r.windowMs / 1000)}s · buckets ${r.buckets} · near ${r.nearLimit}</div>
      </div>
      <div class="status status-${r.nearLimit > 0 ? "failed" : "idle"}">${r.nearLimit > 0 ? "hot" : "ok"}</div>
      <div class="digest">GET /api/v1/ratelimits</div>
      <div class="digest"></div>
    </div>`;
  const rows = (r.rows ?? [])
    .map(
      (b, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(b.key)}</div>
          <div class="digest">since ${formatTime(b.windowStartedAt)}</div>
        </div>
        <div class="status status-${b.saturated ? "failed" : "idle"}">${b.saturated ? "saturated" : "ok"}</div>
        <div class="digest">count ${b.count}/${b.limit ?? "?"} · rem ${b.remaining}</div>
        <div class="digest"></div>
      </div>`,
    )
    .join("");
  el.innerHTML =
    head + (rows || `<p class="empty">No active webhook buckets in the current window.</p>`);
}

function renderAudit(view) {
  const el = $("#audit-stream");
  if (!view.audit?.length) {
    el.innerHTML = `<p class="empty">No audit events yet. Apply, enqueue, or drain to write the trail.</p>`;
    return;
  }
  el.innerHTML = view.audit
    .map(
      (e, i) => `
      <article class="mem-item" style="animation-delay:${Math.min(i, 12) * 0.04}s">
        <div class="mem-meta">
          <span class="scope">${escapeHtml(e.kind)}</span>
          ${e.agent ? `<span>${escapeHtml(e.agent)}</span>` : ""}
          ${e.taskId ? `<span>${escapeHtml(e.taskId)}</span>` : ""}
          <span>${formatTime(e.at)}</span>
        </div>
        <p class="mem-text">${escapeHtml(e.message)}</p>
      </article>`,
    )
    .join("");
}

function renderSurfaces(view) {
  $("#hermes-list").innerHTML = view.hermes
    .map(
      (h) => `
      <article class="surface is-clickable" data-agent="${escapeHtml(h.agent)}" tabindex="0" role="button">
        <h3>${escapeHtml(h.agent)}</h3>
        <p>soul ${escapeHtml(h.soul)} · ${h.memoryBackend}</p>
        <p>share read=[${h.share.read.join(", ")}] write=${h.share.write}</p>
        <p>skills: ${h.skills.map(escapeHtml).join(", ") || "none"}</p>
      </article>`,
    )
    .join("") || `<p class="empty">No Hermes surfaces.</p>`;

  $("#harness-list").innerHTML = view.harness
    .map(
      (h) => `
      <article class="surface is-clickable" data-agent="${escapeHtml(h.agent)}" tabindex="0" role="button">
        <h3>${escapeHtml(h.agent)}</h3>
        <p>${h.profile} · loop ${h.loop}</p>
        <p>${escapeHtml(h.model)}</p>
        <p>tools: ${h.tools.map(escapeHtml).join(", ")}</p>
      </article>`,
    )
    .join("") || `<p class="empty">No harness surfaces.</p>`;

  document.querySelectorAll(".surface.is-clickable[data-agent]").forEach((el) => {
    const open = () => showAgentDetail(el.getAttribute("data-agent"));
    el.addEventListener("click", open);
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        open();
      }
    });
  });
}

function renderMeta(view) {
  $("#tagline").textContent = view.tagline;
  $("#meta").textContent = [
    `revision ${view.revision}`,
    view.source ? `source ${view.source}` : null,
    view.lastReconcile ? `reconciled ${formatTime(view.lastReconcile)}` : null,
    view.metrics
      ? `idle ${view.metrics.workersIdle} · failed tasks ${view.metrics.tasksFailed} · unhealthy ${view.metrics.workersUnhealthy ?? 0}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function refresh() {
  await main();
}

async function main() {
  try {
    const view = await loadView();
    cachedView = view;
    renderMeta(view);
    renderPulse(view);
    renderCharts(view);
    renderWorkflow(view);
    renderMemory(view);
    renderTasks(view);
    renderWorkers(view);
    renderHealth(view);
    renderHygiene(view);
    renderDrift(view);
    renderFairness(view);
    renderBudget(view);
    renderCanary(view);
    renderSkills(view);
    renderPolicy(view);
    renderOutbound(view);
    renderClone(view);
    renderAutoscale(view);
    renderQueue(view);
    renderPipelines(view);
    renderAffinity(view);
    renderDsh(view);
    renderJournal(view);
    renderApprovals(view);
    renderTrajectories(view);
    renderRateLimits(view);
    renderAudit(view);
    renderSurfaces(view);
  } catch (err) {
    $("#tagline").textContent = "Control plane unreachable";
    $("#meta").textContent = String(err);
    showToast(String(err), "err");
  }
}

initTheme();
initNav();
initDetailDrawer();
$("#refresh-btn")?.addEventListener("click", () => refresh());
main();
setInterval(refresh, REFRESH_MS);
