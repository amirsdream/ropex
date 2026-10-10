import { loadState } from "./controller.js";
import { prepareWorkspace, type GitRunner } from "./workspace.js";

export function workspaceCheck(
  root: string,
  args: string[],
  io: {
    git?: GitRunner;
    fileExists?: (file: string) => boolean;
    log?: (line: string) => void;
    error?: (line: string) => void;
  } = {},
): number {
  const log = io.log ?? ((line) => console.log(line));
  const error = io.error ?? ((line) => console.error(line));
  if (args[0] !== "check" || !args[1]) {
    error("usage: ropex workspace check <agent>");
    return 1;
  }
  const agent = loadState(root).desired.find((item) => item.metadata.name === args[1]);
  if (!agent) {
    error(`unknown agent: ${args[1]}`);
    return 1;
  }
  if (!agent.spec.workspace) {
    error(`agent ${args[1]} has no spec.workspace`);
    return 1;
  }
  try {
    prepareWorkspace({
      root,
      agent,
      taskId: "check",
      dryRun: true,
      git: io.git,
      fileExists: io.fileExists,
    });
    log(`workspace ok ${agent.spec.workspace.path}`);
    return 0;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
