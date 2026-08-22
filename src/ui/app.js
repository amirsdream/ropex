const $ = (sel) => document.querySelector(sel);

const REFRESH_MS = 5000;

function showToast(message, kind = "ok") {
  const stack = $("#toast-stack");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3200);
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

function initNav() {
  const links = [...document.querySelectorAll(".nav-link")];
  const sections = links
    .map((a) => document.querySelector(a.getAttribute("href")))
    .filter(Boolean);
  const sync = () => {
    const y = window.scrollY + 120;
    let current = sections[0];
    for (const s of sections) {
      if (s.offsetTop <= y) current = s;
    }
    links.forEach((a) => {
      a.classList.toggle("is-active", a.getAttribute("href") === `#${current?.id}`);
    });
  };
  window.addEventListener("scroll", sync, { passive: true });
  sync();
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
    ["queue", view.counts.queuePending],
    ["done", view.counts.tasksCompleted],
    ["unhealthy", view.metrics?.workersUnhealthy ?? 0],
    ["slo", view.metrics?.backlogSloBreached ? "breach" : "ok"],
    ["drift", view.drift?.ok === false ? "yes" : "ok"],
    ["state", view.queuePaused ? "paused" : "run"],
    ["traj", view.trajectories?.total ?? 0],
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
      <div class="digest">steps ${h.steps?.length ?? 0}</div>
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
      <div class="digest">backend ${escapeHtml(d.backend)}</div>
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
        <div class="digest">${escapeHtml((p.plugins ?? []).join(", "))}</div>
        <div class="digest"></div>
      </div>`,
    )
    .join("");
  el.innerHTML = hermesRow + head + rows;
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
      <div class="worker-row" style="animation-delay:${Math.min(i, 12) * 0.03}s">
        <div>
          <div class="worker-id">${escapeHtml(r.id)}</div>
          <div class="digest">${escapeHtml(r.agent)} · ${escapeHtml(r.taskId)}</div>
        </div>
        <div class="status status-running">${r.steps} steps</div>
        <div class="digest">${escapeHtml((r.stages ?? []).join(" → ") || "—")}</div>
        <div class="digest">${formatTime(r.at)}</div>
      </div>`,
    )
    .join("");
  el.innerHTML =
    head + (rows || `<p class="empty">No trajectories yet. Drain a task to record one.</p>`);
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

async function refresh() {
  await main();
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
$("#refresh-btn")?.addEventListener("click", () => refresh());
main();
setInterval(refresh, REFRESH_MS);
