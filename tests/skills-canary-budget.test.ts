import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildControlPlaneView, startControlPlaneServer } from "../src/api.ts";
import { budgetAlerts, budgetAlertLevel } from "../src/budget.ts";
import { canaryProgress } from "../src/canary.ts";
import { API_ROUTES } from "../src/contracts.ts";
import { emptyState, planReconcile, saveState, loadState } from "../src/controller.ts";
import { buildAgentImage } from "../src/image.ts";
import { promoteSkill, registerSkill, skillsCatalog } from "../src/skills.ts";
import { parseManifests } from "../src/spec.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: a
spec:
  replicas: 2
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: b
spec:
  replicas: 1
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
---
apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: cost
spec:
  maxReplicas: 20
  permissions:
    deny: []
    requireApproval: []
  budget:
    maxUnits: 10
    windowMs: 3600000
    scope: cluster
`;

describe("skills promote + canary + budget alerts", () => {
  it("skillsCatalog coverage and promote via API", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-sk-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    registerSkill(next, {
      name: "triage-label",
      agent: "a",
      fromTask: "t1",
      at: "2026-01-01T00:00:00.000Z",
    });
    const catalog = skillsCatalog(next);
    expect(catalog[0].coverage).toBe(0);
    promoteSkill(next, "triage-label");
    expect(skillsCatalog(next)[0].coverage).toBe(100);
    saveState(root, next);

    const server = await startControlPlaneServer({
      root,
      port: 0,
      loadState,
      saveState,
    });
    try {
      // reset share
      const st = loadState(root);
      st.skillRegistry[0].sharedWith = [];
      saveState(root, st);
      const res = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.skills}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "promote", name: "triage-label" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { skill: { sharedWith: string[] } };
      expect(body.skill.sharedWith).toContain("b");
    } finally {
      await server.close();
    }
  });

  it("canaryProgress reports digest mismatches", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    const want = buildAgentImage(next.desired[0]).digest;
    expect(canaryProgress(next).ok).toBe(true);
    next.workers[0].imageDigest = "stale-digest";
    const prog = canaryProgress(next);
    expect(prog.ok).toBe(false);
    expect(prog.mismatched).toBeGreaterThan(0);
    expect(prog.agents.find((a) => a.agent === "a")?.desiredDigest).toBe(want);
    const view = buildControlPlaneView(next);
    expect(view.canary.mismatched).toBeGreaterThan(0);
    expect(view.skillCatalog).toBeDefined();
  });

  it("budgetAlerts warn below 20%", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    next.budgets = [{ key: "cluster", windowStartedAt: new Date().toISOString(), units: 9 }];
    const alerts = budgetAlerts(next);
    expect(alerts[0].level).toBe("warn");
    expect(budgetAlertLevel({ remaining: 0, limit: 10, exhausted: true })).toBe("exhausted");
    expect(budgetAlertLevel({ remaining: 5, limit: 10, exhausted: false })).toBe("ok");
    const view = buildControlPlaneView(next);
    expect(view.budget.alerts).toBeGreaterThan(0);
    expect(view.budget.rows[0].level).toBe("warn");
  });

  it("UI wires canary and skills promote", () => {
    const html = readFileSync(join(process.cwd(), "src/ui/index.html"), "utf8");
    const js = readFileSync(join(process.cwd(), "src/ui/app.js"), "utf8");
    expect(html).toContain('id="canary"');
    expect(html).toContain('id="skills"');
    expect(js).toContain("renderCanary");
    expect(js).toContain("promoteSkillUi");
    expect(API_ROUTES.canary).toBe("/api/v1/canary");
  });
});
