import { writeFileSync } from "node:fs";

import type { DockerRun, DockerRunOptions } from "../../src/sandbox/client.ts";

export type DockerCall = { args: string[]; env?: NodeJS.ProcessEnv; stdin?: string };

type Reply = { code: number; stdout: string; stderr: string; timedOut: boolean };

const ok = (stdout = ""): Reply => ({ code: 0, stdout, stderr: "", timedOut: false });
const bad = (stderr: string): Reply => ({ code: 1, stdout: "", stderr, timedOut: false });

/**
 * In-memory docker. Tracks images and containers so tests assert on the command
 * sequence without a container runtime. `onExec` can answer specific exec calls.
 */
export function fakeDocker(
  opts: {
    images?: string[];
    onExec?: (args: string[], o: DockerRunOptions | undefined) => Partial<Reply> | undefined;
    failBuild?: boolean;
  } = {},
) {
  const calls: DockerCall[] = [];
  const images = new Set(opts.images ?? []);
  const containers = new Set<string>();
  const removed: string[] = [];

  const run: DockerRun = async (args, o) => {
    calls.push({ args, env: o?.env, stdin: o?.stdin });
    switch (args[0]) {
      case "image":
        return images.has(args[args.length - 1]) ? ok("sha256:abc") : bad("no such image");
      case "build": {
        if (opts.failBuild) return bad("build exploded");
        images.add(args[args.indexOf("-t") + 1]);
        return ok();
      }
      case "run": {
        containers.add(args[args.indexOf("--name") + 1]);
        return ok("container-id");
      }
      case "exec": {
        const custom = opts.onExec?.(args, o);
        const base = args.indexOf("sh") >= 0 && args.join(" ").includes("command -v") ? ok("/usr/local/bin/codex\n") : ok();
        return { ...base, ...custom };
      }
      case "commit":
        images.add(args[2]);
        return ok("sha256:def");
      case "save": {
        writeFileSync(args[2], "fake-tar-bytes");
        return ok();
      }
      case "load":
        // The tarball name carries the key; restore the matching image.
        for (const img of pendingLoads) images.add(img);
        return ok();
      case "rm":
        removed.push(args[args.length - 1]);
        containers.delete(args[args.length - 1]);
        return ok();
      case "rmi":
        images.delete(args[1]);
        return ok();
      default:
        return ok();
    }
  };

  const pendingLoads = new Set<string>();
  return { run, calls, images, containers, removed, pendingLoads, verbs: () => calls.map((c) => c.args[0]) };
}
