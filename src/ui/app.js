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
    renderQueue(view);
    renderJournal(view);
    renderApprovals(view);
    renderSurfaces(view);
  } catch (err) {
    $("#tagline").textContent = "Control plane unreachable";
    $("#meta").textContent = String(err);
  }
}

main();
