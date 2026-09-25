/**
 * One chat completion against an OpenAI-compatible endpoint.
 * Used when a key is present so a worker answers in plain text
 * instead of the embedded tool simulator.
 */

export type LlmSource = "OPENAI_API_KEY" | "DEEPSEEK_API_KEY";

export type ChatEndpoint = {
  url: string;
  model: string;
};

export function chatEndpoint(source: LlmSource, env: NodeJS.ProcessEnv = process.env): ChatEndpoint {
  const openai = source === "OPENAI_API_KEY";
  const url =
    env.OPENAI_BASE_URL?.trim() ||
    (openai ? "https://api.openai.com/v1/chat/completions" : "https://api.deepseek.com/chat/completions");
  const model = env.OPENAI_MODEL?.trim() || (openai ? "gpt-4o-mini" : "deepseek-chat");
  return { url, model };
}

export async function completeChat(opts: {
  apiKey: string;
  url: string;
  model: string;
  prompt: string;
}): Promise<string> {
  const res = await fetch(opts.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "You are a Ropex worker. Answer the task in plain text. Be brief. Do not invent tool calls.",
        },
        { role: "user", content: opts.prompt },
      ],
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`LLM request failed (${res.status}): ${raw.slice(0, 300)}`);
  }
  let body: { choices?: Array<{ message?: { content?: string } }> };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    throw new Error(`LLM response was not JSON: ${raw.slice(0, 200)}`);
  }
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM response had no message content");
  return text;
}
