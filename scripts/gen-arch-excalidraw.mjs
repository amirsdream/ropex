// Generates docs/architecture.excalidraw (openable in Excalidraw) and a matching
// SVG preview (/tmp/arch.html) from one shared node/edge model so both stay in sync.
import { writeFileSync } from "node:fs";

const W = 1520;
const H = 1020;

/** Shared model: bands (labels), nodes (boxes), edges (arrows). */
const bandLabels = [
  { x: 40, y: 70, t: "Git — source of truth" },
  { x: 40, y: 196, t: "Work ingress" },
  { x: 40, y: 322, t: "Ropex control plane   ·   :7780   ·   .ropex/state.json" },
  { x: 40, y: 486, t: "Ephemeral workers   ·   admit → spawn → run → destroy" },
  { x: 40, y: 604, t: "Per-task workflow — ONE spine: Start → Transform → Result" },
  { x: 40, y: 884, t: "Delivery" },
];

const C = {
  git: { bg: "#e7f5ff", bd: "#1971c2" },
  ing: { bg: "#fff9db", bd: "#f08c00" },
  ctlBox: { bg: "#f8f0fc", bd: "#9c36b5" },
  ctl: { bg: "#ffffff", bd: "#9c36b5" },
  wrk: { bg: "#ebfbee", bd: "#2f9e44" },
  spineBox: { bg: "#f1f3f5", bd: "#495057" },
  start: { bg: "#c3fae8", bd: "#0ca678" },
  xform: { bg: "#ffe8cc", bd: "#e8590c" },
  result: { bg: "#d3f9d8", bd: "#2f9e44" },
  deliver: { bg: "#e7f5ff", bd: "#1971c2" },
};

const nodes = [
  // Git band
  { id: "git1", x: 40, y: 92, w: 460, h: 82, title: "fleets/**/*.yaml", sub: "Agent · Fleet · Policy · GitRepo", ...C.git },
  { id: "git2", x: 530, y: 92, w: 440, h: 82, title: "tasks/*.yaml", sub: "forge-neutral inbox", ...C.git },
  { id: "git3", x: 1000, y: 92, w: 480, h: 82, title: "memory/*.yaml", sub: "shared facts · worker→cluster", ...C.git },
  // Ingress band
  { id: "in1", x: 40, y: 218, w: 460, h: 82, title: "GitHub webhooks", sub: "HMAC + rate limit", ...C.ing },
  { id: "in2", x: 530, y: 218, w: 440, h: 82, title: "CLI", sub: "ropex enqueue · tasks sync", ...C.ing },
  { id: "in3", x: 1000, y: 218, w: 480, h: 82, title: "Executor API", sub: "POST /api/v1/pipeline", ...C.ing },
  // Control plane container + inner
  { id: "ctlbox", x: 40, y: 344, w: 1440, h: 128, title: "", sub: "", ...C.ctlBox, container: true },
  { id: "c1", x: 60, y: 384, w: 330, h: 72, title: "Controller", sub: "reconcile · digests · canary", ...C.ctl },
  { id: "c2", x: 410, y: 384, w: 330, h: 72, title: "Queue", sub: "leases · retry/DLQ · affinity", ...C.ctl },
  { id: "c3", x: 760, y: 384, w: 330, h: 72, title: "Executor", sub: "pipelines · SSE · scoped drain", ...C.ctl },
  { id: "c4", x: 1110, y: 384, w: 350, h: 72, title: "Tick", sub: "reclaim · drain · sync · GC", ...C.ctl },
  // Workers band (one wide box)
  { id: "wrk", x: 40, y: 508, w: 1440, h: 80, title: "Worker  (agent:replica + image digest)", sub: "≤ maxConcurrent ∩ Policy.maxReplicas   ·   isolated worktree   ·   immutable roll on digest change", ...C.wrk },
  // Spine container + three phases
  { id: "spinebox", x: 40, y: 626, w: 1440, h: 232, title: "", sub: "", ...C.spineBox, container: true },
  { id: "s1", x: 70, y: 682, w: 430, h: 150, title: "START · intake", sub: "compose · plan\n(Hermes: soul · memory · skills)\n\npipeline field:  input", ...C.start },
  { id: "s2", x: 545, y: 682, w: 430, h: 150, title: "TRANSFORM · execute", sub: "execute\n(DeepSeek Cordis loop · tools)\n\npipeline field:  stages", ...C.xform },
  { id: "s3", x: 1020, y: 682, w: 430, h: 150, title: "RESULT · result", sub: "deliver · learn\n(DeepSeek + Hermes)\n\npipeline field:  result", ...C.result },
  // Delivery band
  { id: "dlv", x: 40, y: 906, w: 1440, h: 80, title: "comment  ·  check  ·  pull request  ·  git writeback", sub: "src/journal.ts   ·   loop back to GitHub / Task YAML", ...C.deliver },
];

// Vertical spine of the pipeline + horizontal phase arrows + delivery loopback.
const edges = [
  { from: "git2", to: "in2", label: "" },
  { from: "in2", to: "ctlbox", label: "" },
  { from: "ctlbox", to: "wrk", label: "claim / spawn" },
  { from: "wrk", to: "spinebox", label: "run" },
  { from: "spinebox", to: "dlv", label: "" },
  { from: "s1", to: "s2", label: "", horizontal: true },
  { from: "s2", to: "s3", label: "", horizontal: true },
];

const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

// ---------- Excalidraw scene ----------
const rnd = () => Math.floor(Math.random() * 2 ** 31);
const idx = (i) => "a" + String(i).padStart(4, "0");
let order = 0;
const els = [];

function pushText(containerId, x, y, w, h, text, opts = {}) {
  const fontSize = opts.fontSize ?? 16;
  const lines = text.split("\n");
  els.push({
    id: "t_" + containerId + "_" + order,
    type: "text",
    x, y,
    width: w, height: h,
    angle: 0,
    strokeColor: opts.color ?? "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: idx(order++),
    roundness: null,
    seed: rnd(),
    version: 1,
    versionNonce: rnd(),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
    text,
    fontSize,
    fontFamily: opts.family ?? 2,
    textAlign: opts.align ?? "center",
    verticalAlign: opts.valign ?? "middle",
    containerId: containerId ?? null,
    originalText: text,
    autoResize: true,
    lineHeight: 1.25,
    baseline: fontSize,
    ...(containerId ? {} : { width: w, height: lines.length * fontSize * 1.25 }),
  });
}

for (const n of nodes) {
  const rectId = n.id;
  const textId = n.title || n.sub ? "t_" + n.id + "_" + order : null;
  els.push({
    id: rectId,
    type: "rectangle",
    x: n.x, y: n.y, width: n.w, height: n.h,
    angle: 0,
    strokeColor: n.bd,
    backgroundColor: n.bg,
    fillStyle: "solid",
    strokeWidth: n.container ? 1 : 2,
    strokeStyle: n.container ? "dashed" : "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: idx(order++),
    roundness: { type: 3 },
    seed: rnd(),
    version: 1,
    versionNonce: rnd(),
    isDeleted: false,
    boundElements: textId ? [{ type: "text", id: textId }] : [],
    updated: Date.now(),
    link: null,
    locked: false,
  });
  if (textId) {
    const label = n.title && n.sub ? `${n.title}\n${n.sub}` : n.title || n.sub;
    els.push({
      id: textId,
      type: "text",
      x: n.x + 8, y: n.y + 8,
      width: n.w - 16, height: n.h - 16,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: idx(order++),
      roundness: null,
      seed: rnd(),
      version: 1,
      versionNonce: rnd(),
      isDeleted: false,
      boundElements: [],
      updated: Date.now(),
      link: null,
      locked: false,
      text: label,
      fontSize: 16,
      fontFamily: 2,
      textAlign: "center",
      verticalAlign: "middle",
      containerId: rectId,
      originalText: label,
      autoResize: true,
      lineHeight: 1.25,
      baseline: 14,
    });
  }
}

// Band labels + title as free text
els.push({
  id: "title",
  type: "text",
  x: 40, y: 24, width: 1000, height: 34,
  angle: 0, strokeColor: "#0b1721", backgroundColor: "transparent",
  fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 1, opacity: 100,
  groupIds: [], frameId: null, index: idx(order++), roundness: null, seed: rnd(),
  version: 1, versionNonce: rnd(), isDeleted: false, boundElements: [], updated: Date.now(),
  link: null, locked: false,
  text: "Ropex architecture — GitOps control plane for agent fleets",
  fontSize: 26, fontFamily: 2, textAlign: "left", verticalAlign: "top",
  containerId: null, originalText: "Ropex architecture — GitOps control plane for agent fleets",
  autoResize: true, lineHeight: 1.25, baseline: 22,
});
for (const b of bandLabels) {
  els.push({
    id: "band_" + order,
    type: "text",
    x: b.x, y: b.y, width: 1200, height: 22,
    angle: 0, strokeColor: "#495057", backgroundColor: "transparent",
    fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 1, opacity: 100,
    groupIds: [], frameId: null, index: idx(order++), roundness: null, seed: rnd(),
    version: 1, versionNonce: rnd(), isDeleted: false, boundElements: [], updated: Date.now(),
    link: null, locked: false,
    text: b.t, fontSize: 15, fontFamily: 2, textAlign: "left", verticalAlign: "top",
    containerId: null, originalText: b.t, autoResize: true, lineHeight: 1.25, baseline: 12,
  });
}

// Arrows
function arrow(a, b, horizontal) {
  const A = byId[a], B = byId[b];
  let sx, sy, ex, ey;
  if (horizontal) {
    sx = A.x + A.w; sy = A.y + A.h / 2;
    ex = B.x; ey = B.y + B.h / 2;
  } else {
    sx = A.x + A.w / 2; sy = A.y + A.h;
    ex = B.x + B.w / 2; ey = B.y;
  }
  els.push({
    id: "arw_" + order,
    type: "arrow",
    x: sx, y: sy, width: Math.abs(ex - sx), height: Math.abs(ey - sy),
    angle: 0, strokeColor: "#343a40", backgroundColor: "transparent",
    fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100,
    groupIds: [], frameId: null, index: idx(order++), roundness: { type: 2 }, seed: rnd(),
    version: 1, versionNonce: rnd(), isDeleted: false, boundElements: [], updated: Date.now(),
    link: null, locked: false,
    points: [[0, 0], [ex - sx, ey - sy]],
    lastCommittedPoint: null,
    startBinding: { elementId: a, focus: 0, gap: 6 },
    endBinding: { elementId: b, focus: 0, gap: 6 },
    startArrowhead: null,
    endArrowhead: "arrow",
  });
}
for (const e of edges) arrow(e.from, e.to, e.horizontal);

const scene = {
  type: "excalidraw",
  version: 2,
  source: "https://github.com/amirsdream/ropex",
  elements: els,
  appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
  files: {},
};
writeFileSync("docs/architecture.excalidraw", JSON.stringify(scene, null, 2));

// ---------- SVG preview (same coordinates) ----------
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">
<rect width="${W}" height="${H}" fill="#ffffff"/>
<defs><marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
<path d="M0,0 L8,3 L0,6 Z" fill="#343a40"/></marker></defs>`;

svg += `<text x="40" y="46" font-size="26" font-weight="700" fill="#0b1721">${esc("Ropex architecture — GitOps control plane for agent fleets")}</text>`;
for (const b of bandLabels) svg += `<text x="${b.x}" y="${b.y + 15}" font-size="15" font-weight="600" fill="#495057">${esc(b.t)}</text>`;

function drawArrow(a, b, horizontal, label) {
  const A = byId[a], B = byId[b];
  let sx, sy, ex, ey;
  if (horizontal) { sx = A.x + A.w; sy = A.y + A.h / 2; ex = B.x; ey = B.y + B.h / 2; }
  else { sx = A.x + A.w / 2; sy = A.y + A.h; ex = B.x + B.w / 2; ey = B.y; }
  svg += `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="#343a40" stroke-width="2" marker-end="url(#ah)"/>`;
  if (label) {
    const mx = (sx + ex) / 2, my = (sy + ey) / 2;
    svg += `<text x="${mx + 6}" y="${my - 2}" font-size="12" fill="#868e96">${esc(label)}</text>`;
  }
}
for (const e of edges) drawArrow(e.from, e.to, e.horizontal, e.label);

for (const n of nodes) {
  svg += `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="12" fill="${n.bg}" stroke="${n.bd}" stroke-width="${n.container ? 1.5 : 2}" ${n.container ? 'stroke-dasharray="6 5"' : ""}/>`;
  if (!n.title && !n.sub) continue;
  const cx = n.x + n.w / 2;
  const titleLines = n.title ? [n.title] : [];
  const subLines = n.sub ? n.sub.split("\n") : [];
  const tSize = 17, sSize = 13, gap = 6;
  const block = titleLines.length * (tSize + 4) + (subLines.length ? gap : 0) + subLines.length * (sSize + 3);
  let cy = n.y + n.h / 2 - block / 2 + tSize;
  for (const t of titleLines) {
    svg += `<text x="${cx}" y="${cy}" font-size="${tSize}" font-weight="700" fill="#1e1e1e" text-anchor="middle">${esc(t)}</text>`;
    cy += tSize + 4;
  }
  cy += subLines.length ? gap - 2 : 0;
  for (const s of subLines) {
    if (s.trim() === "") { cy += sSize; continue; }
    svg += `<text x="${cx}" y="${cy}" font-size="${sSize}" fill="#343a40" text-anchor="middle">${esc(s)}</text>`;
    cy += sSize + 3;
  }
}
svg += `</svg>`;
writeFileSync("/tmp/arch.html", `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}</style></head><body>${svg}</body></html>`);
writeFileSync("/tmp/arch.svg", svg);
console.log("wrote docs/architecture.excalidraw (" + els.length + " elements), /tmp/arch.html");
