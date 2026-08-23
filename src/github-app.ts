/**
 * GitHub App registration scaffold — env contract for production webhook ingress.
 * Live App install is out of band; Ropex consumes webhooks once secrets are set.
 */

export type GithubAppScaffold = {
  ready: boolean;
  appIdPresent: boolean;
  privateKeyPresent: boolean;
  webhookSecretPresent: boolean;
  summary: string;
  steps: string[];
  env: string[];
};

export function githubAppEnv(): {
  appId?: string;
  privateKeyPath?: string;
  webhookSecret?: string;
} {
  return {
    appId: process.env.GITHUB_APP_ID?.trim() || undefined,
    privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim() || undefined,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET?.trim() || process.env.ROPEX_GITHUB_WEBHOOK_SECRET?.trim() || undefined,
  };
}

/** Describe GitHub App wiring without network or live registration. */
export function githubAppScaffold(): GithubAppScaffold {
  const env = githubAppEnv();
  const appIdPresent = Boolean(env.appId);
  const privateKeyPresent = Boolean(env.privateKeyPath);
  const webhookSecretPresent = Boolean(env.webhookSecret);
  const ready = appIdPresent && privateKeyPresent && webhookSecretPresent;
  return {
    ready,
    appIdPresent,
    privateKeyPresent,
    webhookSecretPresent,
    summary: ready
      ? "GitHub App env present — webhook HMAC verify + enqueue ready for production."
      : "Register a GitHub App, set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH + webhook secret.",
    steps: [
      "Create GitHub App with issues + pull_request permissions.",
      "Set webhook URL to your Ropex ingress (or ropex webhook simulate locally).",
      "Export GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH for installation tokens (future slice).",
      "Set GITHUB_WEBHOOK_SECRET (or ROPEX_GITHUB_WEBHOOK_SECRET) for HMAC verify.",
      "Map Agent.spec.github.events + label selectors to enqueue tasks on ingest.",
      "Delivery still flows through harness github plugin (comment / check / PR).",
    ],
    env: [
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY_PATH",
      "GITHUB_WEBHOOK_SECRET | ROPEX_GITHUB_WEBHOOK_SECRET",
    ],
  };
}
