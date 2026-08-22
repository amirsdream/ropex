const $ = (sel) => document.querySelector(sel);

async function loadView() {
  const res = await fetch("/api/v1/view");
  if (!res.ok) throw new Error(`view ${res.status}`);
  return res.json();
}

function renderPulse(view) {
  const el = $("#pulse");
  const items = [
    ["live", view.counts.workersLive],
    ["memory", view.counts.memoryFacts],
    ["queue", view.counts.queuePending],
    ["done", view.counts.tasksCompleted],
    ["unhealthy", view.metrics?.workersUnhealthy ?? 0],
    ["slo", view.metrics?.backlogSloBreached ? "breach" : "ok"],
    ["drift", view.drift?.ok === false ? "yes" : "ok"],
  ];
  el.innerHTML = items
    .map(
      ([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`,
    )
    .join("");
}

function renderWorkflow(view) {
  const el = $("#workflow-list");
  el.innerHTML = view.workflow
    .map(
      (s, i) => `
      <li style="animation-delay:${0.05 * i}s">
        <span class="step-id">${s.id}</span>
        <span>
          <span class="owner">${s.owner}</span><br />
          ${escapeHtml(s.purpose)}
        </span>
      </li>`,
    )
    .join("");
}

function renderMemory(view) {
  const el = $("#memory-stream");
  if (!view.memory.length) {
    el.innerHTML = `<p class="empty">No shared facts yet. Run a task to write the rope.</p>`;
    return;
  }
  el.innerHTML = view.memory
    .map(
      (m, i) => `
      <article class="mem-item" style="animation-delay:${Math.min(i, 12) * 0.04}s">
        <div class="mem-meta">
          <span class="scope">${m.scope}</span>
          <span>${escapeHtml(m.agent)}</span>
          ${m.fleet ? `<span>${escapeHtml(m.fleet)}</span>` : ""}
          <span>${formatTime(m.at)}</span>
        </div>
        <p class="mem-text">${escapeHtml(m.text)}</p>
      </article>`,
    )
    .join("");
}

function renderWorkers(view) {
  const el = $("#worker-rail");
  if (!view.workers.length) {
    el.innerHTML = `<p class="empty">No workers. Apply fleets/examples, then refresh.</p>`;
    return;
  }
  el.innerHTML = view.workers
    .map(
      (w, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 16) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(w.id)}</div>
          <div class="digest">${escapeHtml(w.harness)} · ${escapeHtml(w.model)}</div>
        </div>
        <div class="status status-${w.status}">${w.status}</div>
        <div class="digest" title="${escapeHtml(w.imageDigest)}">${escapeHtml(w.imageDigest)}</div>
        <div class="digest">mem ${w.memoryReadable} · skills ${w.skills.length}</div>
      </div>`,
    )
    .join("");
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
  el.innerHTML = rows
    .map(
      (r, i) => `
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(r.key)}</div>
          <div class="digest">${escapeHtml(r.scope)} · remaining ${r.remaining}</div>
        </div>
        <div class="status status-${r.exhausted ? "failed" : "idle"}">${r.exhausted ? "exhausted" : "ok"}</div>
        <div class="digest">spent ${r.spent}</div>
        <div class="digest">limit ${r.limit}</div>
      </div>`,
    )
    .join("");
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

function renderQueue(view) {
  const el = $("#queue-rail");
  if (!view.queue?.length) {
    el.innerHTML = `<p class="empty">Queue empty. Webhook or simulate to enqueue.</p>`;
    return;
  }
  el.innerHTML = view.queue
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
        <div class="digest">${escapeHtml(q.id)}</div>
      </div>`,
    )
    .join("");
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
        <div class="digest">${escapeHtml(a.id)}</div>
      </div>`,
    )
    .join("");
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
      <article class="surface">
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
      <article class="surface">
        <h3>${escapeHtml(h.agent)}</h3>
        <p>${h.profile} · loop ${h.loop}</p>
        <p>${escapeHtml(h.model)}</p>
        <p>tools: ${h.tools.map(escapeHtml).join(", ")}</p>
      </article>`,
    )
    .join("") || `<p class="empty">No harness surfaces.</p>`;
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

async function main() {
  try {
    const view = await loadView();
    renderMeta(view);
    renderPulse(view);
    renderWorkflow(view);
    renderMemory(view);
    renderWorkers(view);
    renderHealth(view);
    renderDrift(view);
    renderFairness(view);
    renderBudget(view);
    renderPolicy(view);
    renderAutoscale(view);
    renderQueue(view);
    renderJournal(view);
    renderApprovals(view);
    renderAudit(view);
    renderSurfaces(view);
  } catch (err) {
    $("#tagline").textContent = "Control plane unreachable";
    $("#meta").textContent = String(err);
  }
}

main();
