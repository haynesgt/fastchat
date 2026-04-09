import pLimit from "p-limit";
import {
  createBranch,
  createMessage,
  createRun,
  DbMessage,
  finishBranch,
  getRun,
  listMessages,
  nowIso,
  updateRun
} from "./db.js";
import { ChatMessage, completeChat, streamChat } from "./openai.js";

type AppSettings = {
  apiKey: string;
  customInstructions: string;
  model: string;
  preset: "balanced" | "concise" | "expansive";
};

type StreamWriter = {
  send: (event: Record<string, unknown>) => void;
  close: () => void;
};

type RunInput = {
  threadId: string;
  prompt: string;
  mode: "chat" | "staged";
  settings: AppSettings;
  signal: AbortSignal;
};

const sectionLimiter = pLimit(3);

export async function runConversation(input: RunInput, writer: StreamWriter) {
  if (!input.settings.apiKey.trim()) {
    throw new Error("Add an OpenAI API key in settings before chatting.");
  }

  const userMessage = createMessage({
    threadId: input.threadId,
    role: "user",
    messageType: "user",
    content: input.prompt
  });

  const runId = createRun({ threadId: input.threadId, mode: input.mode, userMessageId: userMessage.id });
  writer.send({ type: "run_started", runId, threadId: input.threadId, mode: input.mode });

  try {
    if (input.mode === "chat") {
      await runChatMode({ ...input, runId, writer });
    } else {
      await runStagedMode({ ...input, runId, writer });
    }
  } catch (error) {
    if (input.signal.aborted) {
      updateRun(runId, { status: "cancelled", stage: "cancelled" });
      createMessage({
        threadId: input.threadId,
        runId,
        role: "assistant",
        messageType: "run_event",
        content: JSON.stringify({ type: "run_cancelled", at: nowIso() })
      });
      writer.send({ type: "run_cancelled", runId });
      writer.close();
      return;
    }

    updateRun(runId, { status: "failed", error: (error as Error).message });
    createMessage({
      threadId: input.threadId,
      runId,
      role: "assistant",
      messageType: "run_event",
      content: JSON.stringify({ type: "run_failed", error: (error as Error).message })
    });
    writer.send({ type: "run_failed", runId, error: (error as Error).message });
    writer.close();
  }
}

export async function retryRun(runId: string, settings: AppSettings, signal: AbortSignal, writer: StreamWriter) {
  const run = getRun(runId);
  if (!run) {
    throw new Error("Run not found.");
  }

  const messages = listMessages(run.thread_id).filter((message) => message.message_type === "user");
  const latestUser =
    [...messages].reverse().find((message) => message.run_id === runId) ?? messages[messages.length - 1];
  if (!latestUser) {
    throw new Error("No user message found for retry.");
  }

  await runConversation(
    {
      threadId: run.thread_id,
      prompt: latestUser.content,
      mode: run.mode,
      settings,
      signal
    },
    writer
  );
}

async function runChatMode(input: RunInput & { runId: string; writer: StreamWriter }) {
  updateRun(input.runId, { stage: "chat" });
  emitLifecycle(input, "stage_started", { stage: "chat", label: "Answering" });

  const assistantText = await streamChat({
    apiKey: input.settings.apiKey,
    model: input.settings.model,
    messages: buildConversationMessages(input.threadId, input.settings),
    signal: input.signal,
    onDelta(delta) {
      input.writer.send({ type: "text_delta", runId: input.runId, target: "chat", delta });
    }
  });

  const assistantMessage = createMessage({
    threadId: input.threadId,
    runId: input.runId,
    role: "assistant",
    messageType: "assistant",
    content: assistantText
  });

  updateRun(input.runId, {
    status: "completed",
    stage: "completed",
    assembledOutput: assistantText,
    assistantMessageId: assistantMessage.id
  });

  emitLifecycle(input, "stage_completed", { stage: "chat" });
  input.writer.send({
    type: "run_completed",
    runId: input.runId,
    threadId: input.threadId,
    messageId: assistantMessage.id,
    content: assistantText
  });
  input.writer.close();
}

async function runStagedMode(input: RunInput & { runId: string; writer: StreamWriter }) {
  const context = buildConversationMessages(input.threadId, input.settings);
  let introText = "";
  let summaryText = "";

  updateRun(input.runId, { stage: "stage_1" });
  emitLifecycle(input, "stage_started", { stage: "stage_1", label: "Stage 1: Intro + plan" });

  const introPrompt = `${presetGuidance(input.settings.preset)}
Write only the introduction for the requested piece. Keep it engaging, purposeful, and ready to flow into planned sections.

User request:
${input.prompt}`;
  const introBranchId = announceBranch(input, "stage_1", "intro", introPrompt, "Intro draft");

  const planVariantA =
    "Create a concise JSON array of 3 to 5 sections. Each item must contain title and brief. Focus on clarity and logical flow.";
  const planVariantB =
    "Create a concise JSON array of 3 to 5 sections. Each item must contain title and brief. Focus on momentum, contrast, and strong reader progression.";

  const planBranchAId = announceBranch(input, "stage_1", "plan_a", planVariantA, "Plan branch A");
  const planBranchBId = announceBranch(input, "stage_1", "plan_b", planVariantB, "Plan branch B");

  const introPromise = streamChat({
    apiKey: input.settings.apiKey,
    model: input.settings.model,
    signal: input.signal,
    messages: [...context, { role: "user", content: introPrompt }],
    onDelta(delta) {
      introText += delta;
      input.writer.send({ type: "text_delta", runId: input.runId, target: "intro", delta });
    }
  }).then((output) => {
    finishBranch(introBranchId, output, "completed");
    return output;
  });

  const planPromises = [planVariantA, planVariantB].map((variantPrompt, index) =>
    completeChat({
      apiKey: input.settings.apiKey,
      model: input.settings.model,
      signal: input.signal,
      messages: [
        ...context,
        {
          role: "user",
          content: `${presetGuidance(input.settings.preset)}
Return JSON only. ${variantPrompt}

User request:
${input.prompt}`
        }
      ]
    }).then((output) => {
      finishBranch(index === 0 ? planBranchAId : planBranchBId, output, "completed");
      return output;
    })
  );

  const [introResult, ...planResults] = await Promise.all([introPromise, ...planPromises]);
  introText = introResult;
  const sections = consolidateSections(planResults.flatMap((plan) => parseSections(plan)));
  input.writer.send({ type: "section_plan", runId: input.runId, sections });
  emitLifecycle(input, "stage_completed", { stage: "stage_1" });

  updateRun(input.runId, { stage: "stage_2", assembledOutput: introText });
  emitLifecycle(input, "stage_started", { stage: "stage_2", label: "Stage 2: Parallel sections" });

  const sectionOutputs: string[] = new Array(sections.length).fill("");

  await Promise.all(
    sections.map((section, index) =>
      sectionLimiter(async () => {
        const sectionPrompt = `${presetGuidance(input.settings.preset)}
Write section ${index + 1} titled "${section.title}".
Follow this section brief: ${section.brief}
Keep the section self-contained and do not write the introduction or conclusion.

Full section plan:
${sections.map((entry, itemIndex) => `${itemIndex + 1}. ${entry.title}: ${entry.brief}`).join("\n")}

User request:
${input.prompt}`;

        const branchId = announceBranch(input, "stage_2", `section_${index}`, sectionPrompt, section.title, index);
        let output = "";
        output = await streamChat({
          apiKey: input.settings.apiKey,
          model: input.settings.model,
          signal: input.signal,
          messages: [...context, { role: "user", content: sectionPrompt }],
          onDelta(delta) {
            output += delta;
            input.writer.send({
              type: "section_delta",
              runId: input.runId,
              index,
              title: section.title,
              delta
            });
          }
        });

        sectionOutputs[index] = output;
        finishBranch(branchId, output, "completed");
        input.writer.send({
          type: "section_completed",
          runId: input.runId,
          index,
          title: section.title,
          content: output
        });
      })
    )
  );

  emitLifecycle(input, "stage_completed", { stage: "stage_2" });

  updateRun(input.runId, {
    stage: "stage_3",
    assembledOutput: [introText, ...sections.map((section, index) => `## ${section.title}\n\n${sectionOutputs[index]}`)].join(
      "\n\n"
    )
  });
  emitLifecycle(input, "stage_started", { stage: "stage_3", label: "Stage 3: Summary" });

  const summaryPrompt = `${presetGuidance(input.settings.preset)}
Write a closing summary or conclusion for the piece below. Keep it crisp and satisfying.

Introduction:
${introText}

Sections:
${sections.map((section, index) => `${section.title}\n${sectionOutputs[index]}`).join("\n\n")}`;
  const summaryBranchId = announceBranch(input, "stage_3", "summary", summaryPrompt, "Summary");
  summaryText = await streamChat({
    apiKey: input.settings.apiKey,
    model: input.settings.model,
    signal: input.signal,
    messages: [...context, { role: "user", content: summaryPrompt }],
    onDelta(delta) {
      summaryText += delta;
      input.writer.send({ type: "text_delta", runId: input.runId, target: "summary", delta });
    }
  });
  finishBranch(summaryBranchId, summaryText, "completed");
  emitLifecycle(input, "stage_completed", { stage: "stage_3" });

  const finalContent = [introText, ...sections.map((section, index) => `## ${section.title}\n\n${sectionOutputs[index]}`), summaryText]
    .filter(Boolean)
    .join("\n\n");

  const assistantMessage = createMessage({
    threadId: input.threadId,
    runId: input.runId,
    role: "assistant",
    messageType: "assistant",
    content: finalContent
  });

  updateRun(input.runId, {
    status: "completed",
    stage: "completed",
    assembledOutput: finalContent,
    assistantMessageId: assistantMessage.id
  });

  input.writer.send({
    type: "run_completed",
    runId: input.runId,
    threadId: input.threadId,
    messageId: assistantMessage.id,
    content: finalContent
  });
  input.writer.close();
}

function buildConversationMessages(threadId: string, settings: AppSettings): ChatMessage[] {
  const instructions = [
    "You are FastChat, a fast, polished writing and chat assistant.",
    "Write with strong structure, clear momentum, and useful detail.",
    settings.customInstructions.trim() ? `User custom instructions: ${settings.customInstructions.trim()}` : "",
    `Writing preset: ${settings.preset}`
  ]
    .filter(Boolean)
    .join("\n");

  const history = listMessages(threadId)
    .filter((message: DbMessage) => message.message_type !== "run_event")
    .map<ChatMessage>((message) => ({
      role: message.role,
      content: message.content
    }));

  return [{ role: "system", content: instructions }, ...history];
}

function presetGuidance(preset: AppSettings["preset"]) {
  if (preset === "concise") {
    return "Favor tight prose, sharp topic sentences, and minimal padding.";
  }

  if (preset === "expansive") {
    return "Favor richer explanation, vivid transitions, and fuller development.";
  }

  return "Balance clarity, depth, and readability.";
}

function announceBranch(
  input: RunInput & { runId: string; writer: StreamWriter },
  stage: string,
  branchKey: string,
  prompt: string,
  label: string,
  sectionIndex?: number
) {
  input.writer.send({ type: "branch_started", runId: input.runId, stage, branchKey, label });
  return createBranch({
    runId: input.runId,
    stage,
    branchKey,
    prompt,
    title: label,
    sectionIndex: sectionIndex ?? null
  });
}

function emitLifecycle(
  input: RunInput & { runId: string; writer: StreamWriter },
  kind: "stage_started" | "stage_completed",
  payload: { stage: string; label?: string }
) {
  createMessage({
    threadId: input.threadId,
    runId: input.runId,
    role: "assistant",
    messageType: "run_event",
    content: JSON.stringify({ type: kind, ...payload, at: nowIso() })
  });
  input.writer.send({ type: kind, runId: input.runId, ...payload });
}

function parseSections(raw: string) {
  try {
    const normalized = raw.trim().replace(/^```json/, "").replace(/```$/, "");
    const parsed = JSON.parse(normalized) as Array<{ title?: string; brief?: string }>;
    return parsed
      .map((section) => ({
        title: (section.title ?? "").trim(),
        brief: (section.brief ?? "").trim()
      }))
      .filter((section) => section.title && section.brief);
  } catch {
    return [];
  }
}

function consolidateSections(input: Array<{ title: string; brief: string }>) {
  const seen = new Set<string>();
  const sections: Array<{ title: string; brief: string }> = [];

  for (const section of input) {
    const key = section.title.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    sections.push(section);
  }

  if (sections.length === 0) {
    return [
      { title: "Core ideas", brief: "Explain the central argument or concept clearly." },
      { title: "Practical breakdown", brief: "Develop the most useful supporting details and examples." },
      { title: "Closing takeaways", brief: "Land the piece with concrete takeaways and momentum." }
    ];
  }

  return sections.slice(0, 5);
}
