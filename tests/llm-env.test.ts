import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/env.ts";
import { chatEndpoint, completeChat } from "../src/llm.ts";

const saved: Record<string, string | undefined> = {};

function remember(name: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
}

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("dotenv", () => {
  it("loads a key and does not override one already set", () => {
    remember("OPENAI_API_KEY");
    remember("OPENAI_MODEL");
    process.env.OPENAI_API_KEY = "from-shell";
    delete process.env.OPENAI_MODEL;
    const dir = mkdtempSync(join(tmpdir(), "ropex-env-"));
    const path = join(dir, ".env");
    writeFileSync(path, "OPENAI_API_KEY=from-file\nOPENAI_MODEL=gpt-test\n# comment\n\n");
    loadDotEnv(path);
    expect(process.env.OPENAI_API_KEY).toBe("from-shell");
    expect(process.env.OPENAI_MODEL).toBe("gpt-test");
  });
});

describe("chat endpoint", () => {
  it("uses OpenAI by default and DeepSeek when that key is the source", () => {
    expect(chatEndpoint("OPENAI_API_KEY", {})).toEqual({
      url: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o-mini",
    });
    expect(chatEndpoint("DEEPSEEK_API_KEY", {})).toEqual({
      url: "https://api.deepseek.com/chat/completions",
      model: "deepseek-chat",
    });
  });

  it("returns the model text", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "  Ropex runs agents from git.  " } }] }), {
        status: 200,
      })) as typeof fetch;
    try {
      const text = await completeChat({
        apiKey: "sk-secret",
        url: "https://example.test/v1/chat/completions",
        model: "gpt-4o-mini",
        prompt: "one sentence",
      });
      expect(text).toBe("Ropex runs agents from git.");
    } finally {
      globalThis.fetch = original;
    }
  });
});
