export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type BaseCompletionInput = {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
};

export async function completeChat(input: BaseCompletionInput) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0.8,
      messages: input.messages
    }),
    signal: input.signal
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return payload.choices?.[0]?.message?.content ?? "";
}

export async function streamChat(
  input: BaseCompletionInput & {
    onDelta: (delta: string) => void;
  }
) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0.8,
      stream: true,
      messages: input.messages
    }),
    signal: input.signal
  });

  if (!response.ok || !response.body) {
    throw new Error(await response.text());
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) {
        continue;
      }

      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        continue;
      }

      const payload = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };

      const delta = payload.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        fullText += delta;
        input.onDelta(delta);
      }
    }
  }

  return fullText;
}
