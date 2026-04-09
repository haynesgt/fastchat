export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type BaseCompletionInput = {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  useWebSearch?: boolean;
};

export async function completeChat(input: BaseCompletionInput) {
  const [instructions, conversation] = splitInstructions(input.messages);
  const tools =
    input.useWebSearch === false
      ? []
      : [
          {
            type: "web_search",
            user_location: {
              type: "approximate",
              country: "US",
              timezone: "America/Vancouver"
            }
          }
        ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`
    },
    body: JSON.stringify({
      model: input.model,
      instructions,
      input: conversation.map((message) => ({
        role: message.role,
        content: message.content
      })),
      tool_choice: "auto",
      parallel_tool_calls: true,
      tools,
      include: input.useWebSearch === false ? [] : ["web_search_call.action.sources"]
    }),
    signal: input.signal
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = (await response.json()) as ResponsePayload;
  return extractOutputText(payload);
}

export async function streamChat(
  input: BaseCompletionInput & {
    onDelta: (delta: string) => void;
  }
) {
  const [instructions, conversation] = splitInstructions(input.messages);
  const tools =
    input.useWebSearch === false
      ? []
      : [
          {
            type: "web_search",
            user_location: {
              type: "approximate",
              country: "US",
              timezone: "America/Vancouver"
            }
          }
        ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`
    },
    body: JSON.stringify({
      model: input.model,
      instructions,
      input: conversation.map((message) => ({
        role: message.role,
        content: message.content
      })),
      tool_choice: "auto",
      parallel_tool_calls: true,
      tools,
      include: input.useWebSearch === false ? [] : ["web_search_call.action.sources"],
      stream: true
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

      const payload = JSON.parse(data) as
        | { type?: string; delta?: string }
        | { type?: string; error?: { message?: string } };

      if (payload.type === "response.output_text.delta" && "delta" in payload && payload.delta) {
        fullText += payload.delta;
        input.onDelta(payload.delta);
      }

      if (payload.type === "error") {
        throw new Error(("error" in payload && payload.error?.message) || "Streaming response failed.");
      }
    }
  }

  return fullText;
}

type ResponsePayload = {
  output?: Array<{
    type?: string;
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

function splitInstructions(messages: ChatMessage[]) {
  const [first, ...rest] = messages;
  if (first?.role === "system") {
    return [first.content, rest] as const;
  }

  return ["", messages] as const;
}

function extractOutputText(payload: ResponsePayload) {
  return (
    payload.output
      ?.filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === "output_text")
      .map((part) => part.text ?? "")
      .join("") ?? ""
  );
}
