/**
 * Snapshot store — where sandbox snapshots are kept between runs.
 *
 * `catalog.json` is the index (key, image ref, tarball, size, last use). Each snapshot is
 * also exported as a gzip tarball so it survives `docker image prune` or a fresh host:
 * `restoreSnapshot` `docker load`s the tarball when the image is gone.
 */

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { expectOk, type DockerRun } from "./client.js";

export type SnapshotKind = "warm" | "task";

export type SnapshotRecord = {
  key: string;
  kind: SnapshotKind;
  imageRef: string;
  /** Environment image this snapshot descends from. Groups `keep` retention. */
  envDigest: string;
  tarPath?: string;
  bytes: number;
  createdAt: string;
  lastUsedAt: string;
  labels: Record<string, string>;
};

export type SnapshotCatalog = { version: 1; snapshots: SnapshotRecord[] };

export const SNAPSHOT_IMAGE_REPO = "ropex-snap";

export function sandboxStoreDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.ROPEX_SANDBOX_DIR?.trim() || join(root, ".ropex", "sandboxes");
}

const catalogPath = (dir: string): string => join(dir, "catalog.json");

export function loadCatalog(dir: string): SnapshotCatalog {
  try {
    const parsed = JSON.parse(readFileSync(catalogPath(dir), "utf8")) as SnapshotCatalog;
    if (parsed?.version === 1 && Array.isArray(parsed.snapshots)) return parsed;
  } catch {
    // missing or unreadable: start empty
  }
  return { version: 1, snapshots: [] };
}

function saveCatalog(dir: string, catalog: SnapshotCatalog): void {
  mkdirSync(dir, { recursive: true });
  const tmp = `${catalogPath(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(catalog, null, 2)}\n`);
  renameSync(tmp, catalogPath(dir));
}

/** Key for "env image + this repo at this ref". */
export function warmSnapshotKey(envDigest: string, url: string, ref: string | undefined, depth?: number): string {
  const h = createHash("sha256")
    .update([envDigest, url, ref ?? "HEAD", String(depth ?? 0)].join("\n"))
    .digest("hex")
    .slice(0, 16);
  return `warm-${h}`;
}

export function taskSnapshotKey(label: string, envDigest: string): string {
  const slug = label.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 48) || "task";
  return `task-${slug}-${envDigest.slice(0, 8)}`;
}

export function snapshotImageRef(key: string): string {
  return `${SNAPSHOT_IMAGE_REPO}:${key}`;
}

export function findSnapshot(dir: string, key: string): SnapshotRecord | undefined {
  return loadCatalog(dir).snapshots.find((s) => s.key === key);
}

export function registerSnapshot(dir: string, record: SnapshotRecord): void {
  const catalog = loadCatalog(dir);
  catalog.snapshots = [...catalog.snapshots.filter((s) => s.key !== record.key), record];
  saveCatalog(dir, catalog);
}

export function touchSnapshot(dir: string, key: string, now = Date.now()): void {
  const catalog = loadCatalog(dir);
  const rec = catalog.snapshots.find((s) => s.key === key);
  if (!rec) return;
  rec.lastUsedAt = new Date(now).toISOString();
  saveCatalog(dir, catalog);
}

function dropFromCatalog(dir: string, keys: string[]): void {
  if (!keys.length) return;
  const catalog = loadCatalog(dir);
  catalog.snapshots = catalog.snapshots.filter((s) => !keys.includes(s.key));
  saveCatalog(dir, catalog);
}

export type EvictionRules = {
  /** Newest snapshots kept per environment digest. */
  keep?: number;
  /** Drop snapshots not used for this long. */
  ttlMs?: number;
  /** Total tarball bytes allowed; least recently used go first. */
  maxBytes?: number;
  now?: number;
};

/** Pure: which snapshot keys should be evicted. */
export function planEviction(records: SnapshotRecord[], rules: EvictionRules): string[] {
  const now = rules.now ?? Date.now();
  const used = (r: SnapshotRecord) => Date.parse(r.lastUsedAt) || 0;
  const evict = new Set<string>();

  if (rules.ttlMs !== undefined && rules.ttlMs > 0) {
    for (const r of records) if (now - used(r) > rules.ttlMs) evict.add(r.key);
  }
  if (rules.keep !== undefined) {
    const byEnv = new Map<string, SnapshotRecord[]>();
    for (const r of records) byEnv.set(r.envDigest, [...(byEnv.get(r.envDigest) ?? []), r]);
    for (const group of byEnv.values()) {
      group.sort((a, b) => used(b) - used(a));
      for (const r of group.slice(Math.max(0, rules.keep))) evict.add(r.key);
    }
  }
  if (rules.maxBytes !== undefined) {
    const live = records.filter((r) => !evict.has(r.key)).sort((a, b) => used(a) - used(b));
    let total = live.reduce((n, r) => n + r.bytes, 0);
    for (const r of live) {
      if (total <= rules.maxBytes) break;
      evict.add(r.key);
      total -= r.bytes;
    }
  }
  return [...evict];
}

/** Evict per the rules: remove the tarball, best-effort `rmi`, and drop the catalog entry. */
export async function evictSnapshots(
  docker: DockerRun,
  dir: string,
  rules: EvictionRules,
): Promise<SnapshotRecord[]> {
  const catalog = loadCatalog(dir);
  const keys = new Set(planEviction(catalog.snapshots, rules));
  const evicted = catalog.snapshots.filter((s) => keys.has(s.key));
  for (const rec of evicted) {
    if (rec.tarPath) rmSync(rec.tarPath, { force: true });
    await docker(["rmi", rec.imageRef]).catch(() => undefined);
  }
  dropFromCatalog(dir, evicted.map((s) => s.key));
  return evicted;
}

/** `docker save` the image to `<dir>/<key>.tar.gz` and return its path and size. */
export async function exportSnapshotTar(
  docker: DockerRun,
  imageRef: string,
  dir: string,
  key: string,
): Promise<{ tarPath: string; bytes: number }> {
  mkdirSync(dir, { recursive: true });
  const raw = join(dir, `${key}.tar`);
  const tarPath = `${raw}.gz`;
  expectOk(await docker(["save", "-o", raw, imageRef], { timeoutMs: 1_800_000 }), `docker save ${imageRef}`);
  try {
    await pipeline(createReadStream(raw), createGzip(), createWriteStream(tarPath));
  } finally {
    rmSync(raw, { force: true });
  }
  return { tarPath, bytes: statSync(tarPath).size };
}

/**
 * Make sure a catalogued snapshot's image exists locally, loading it from its tarball when
 * needed. Returns false (and drops the entry) when neither the image nor the tarball is left.
 */
export async function restoreSnapshot(docker: DockerRun, dir: string, rec: SnapshotRecord): Promise<boolean> {
  const present = await docker(["image", "inspect", "--format", "{{.Id}}", rec.imageRef]);
  if (present.code === 0) return true;
  if (rec.tarPath && existsSync(rec.tarPath)) {
    const loaded = await docker(["load", "-i", rec.tarPath], { timeoutMs: 1_800_000 });
    if (loaded.code === 0) return true;
  }
  dropFromCatalog(dir, [rec.key]);
  return false;
}

export function catalogSummary(dir: string): { dir: string; snapshots: SnapshotRecord[]; bytes: number } {
  const { snapshots } = loadCatalog(dir);
  return { dir, snapshots, bytes: snapshots.reduce((n, s) => n + s.bytes, 0) };
}
