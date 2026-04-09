import pLimit from "p-limit";
import {
  createBranch,
  createMessage,
  createRun,
  DbMessage,
  finishBranch,
  getRun,
  getThread,
  listMessages,
  nowIso,
  updateThreadTitle,
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

const sectionLimiter = pLimit(20);

export async function runConversation(input: RunInput, writer: StreamWriter) {
  if (!input.settings.apiKey.trim()) {
    throw new Error("Add an OpenAI API key in settings before chatting.");
  }

  const effectiveMode = input.mode === "staged" ? await chooseResponseMode(input) : input.mode;

  const userMessage = createMessage({
    threadId: input.threadId,
    role: "user",
    messageType: "user",
    content: input.prompt
  });

  const runId = createRun({ threadId: input.threadId, mode: effectiveMode, userMessageId: userMessage.id });
  writer.send({ type: "run_started", runId, threadId: input.threadId, mode: effectiveMode });

  try {
    const generatedTitle = await maybeGenerateThreadTitle(input).catch(() => null);
    if (generatedTitle) {
      const updatedThread = updateThreadTitle(input.threadId, generatedTitle);
      writer.send({ type: "thread_title", threadId: updatedThread.id, title: updatedThread.title });
    }

    if (effectiveMode === "chat") {
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
  let plannedSectionCount = 0;

  updateRun(input.runId, { stage: "stage_1" });
  emitLifecycle(input, "stage_started", { stage: "stage_1", label: "Stage 1: Intro + plan" });

  const introPrompt = `${presetGuidance(input.settings.preset)}
Write only a short introduction for the requested piece.
Aim for a brief opening that sets direction quickly and hands off to the planned sections.
Assume the main response will be carried by multiple longer sections written in parallel.
If the response needs substantial framing, background, context, or setup, keep the intro very short and push that material into one of the planned sections instead.
Prefer leaving useful substance for the planned sections so more of the answer can be developed in parallel.
Do not mention stages, sections, or planning.
Longer planned sections will be written in parallel in separate prompts.

User request:
${input.prompt}`;
  const introBranchId = announceBranch(input, "stage_1", "intro", introPrompt, "Intro draft");

  const planVariantA = `${presetGuidance(input.settings.preset)}
Plan 5 to 10 sections for the piece when the request supports a substantial response.
Be eager to break the work into many distinct sections so more of the answer can be written in parallel.
Favor a long, comprehensive response with enough sections to cover the topic from multiple useful angles.
If the request is very simple or conversational, you may return NONE instead of forcing sections.
If the response needs substantial framing, background, or setup, include a dedicated section for that work instead of front-loading it into the introduction.
Output one section per line in this exact format:
TITLE::BRIEF
Do not add numbering, bullets, commentary, markdown fences, or any extra lines.
Make section titles specific.
Keep each brief extremely short so planning finishes quickly: prefer one short sentence or compact phrase, usually under 12 words.
Let the section writer infer most detail from the intro, user request, and full section plan.
Focus on clarity, logical flow, and strong coverage.

User request:
${input.prompt}`;
  const planVariantB = `${presetGuidance(input.settings.preset)}
Return JSON only. Create a JSON array of 5 to 10 sections when the request supports a substantial response.
Each item must contain title and brief.
Be eager to split the work into many distinct sections so more of the answer can be written in parallel.
Favor a long, comprehensive response with enough sections to cover the topic from multiple useful angles.
If the request is very simple or conversational, return [] instead of forcing sections.
If the response needs substantial framing, background, or setup, include a section for that work instead of front-loading it into the introduction.
Keep each brief extremely short so planning finishes quickly: prefer one short sentence or compact phrase, usually under 12 words.
Let the section writer infer most detail from the intro, user request, and full section plan.
Focus on momentum, contrast, strong reader progression, and meaningful scope.

User request:
${input.prompt}`;

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

  let streamedPlanText = "";
  let planLineBuffer = "";
  const streamedPlanPromise = streamChat({
    apiKey: input.settings.apiKey,
    model: input.settings.model,
    signal: input.signal,
    messages: [...context, { role: "user", content: planVariantA }],
    onDelta(delta) {
      streamedPlanText += delta;
      planLineBuffer += delta;
      planLineBuffer = flushPlannedSections(planLineBuffer, input, plannedSectionCount, (count) => {
        plannedSectionCount = count;
      });
    }
  }).then((output) => {
    if (planLineBuffer.trim()) {
      flushPlannedSections(`${planLineBuffer}\n`, input, plannedSectionCount, (count) => {
        plannedSectionCount = count;
      });
      planLineBuffer = "";
    }
    finishBranch(planBranchAId, output, "completed");
    return output;
  });

  const hiddenPlanPromise = completeChat({
    apiKey: input.settings.apiKey,
    model: input.settings.model,
    signal: input.signal,
    messages: [...context, { role: "user", content: planVariantB }]
  }).then((output) => {
    finishBranch(planBranchBId, output, "completed");
    return output;
  });

  const [introResult, streamedPlanResult, hiddenPlanResult] = await Promise.all([
    introPromise,
    streamedPlanPromise,
    hiddenPlanPromise
  ]);
  introText = introResult;
  const sections = consolidateSections([
    ...parseLineSections(streamedPlanResult),
    ...parseSections(hiddenPlanResult)
  ]);
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
Section brief: ${section.brief}
Use this already-written intro for context:
${introText}

Keep the section self-contained and do not write the introduction or conclusion.
Do not repeat the section title, heading, number, or label in the output.
Start immediately with the section body content.
Write a substantial, information-dense section with real depth, examples, explanation, and useful detail.
Assume sibling sections are being written in parallel, so cover this section thoroughly without waiting on the introduction or conclusion to carry important content.
Do not restate the overall assignment before writing the section body.

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
Do not add a heading like "Summary", "Conclusion", or any title line.
Return only the closing body paragraphs.

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
    "If the latest user turn is a brief acknowledgement, greeting, thanks, or short conversational reply, answer that latest turn directly and briefly.",
    "Do not continue drafting or expanding a previous long-form response unless the latest user message explicitly asks you to continue.",
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

function parseLineSections(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const separatorIndex = line.indexOf("::");
      if (separatorIndex === -1) {
        return [];
      }

      const title = line.slice(0, separatorIndex).trim();
      const brief = line.slice(separatorIndex + 2).trim();
      if (!title || !brief) {
        return [];
      }

      return [{ title, brief }];
    });
}

function flushPlannedSections(
  buffer: string,
  input: RunInput & { runId: string; writer: StreamWriter },
  startIndex: number,
  onCountChange: (count: number) => void
) {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  const parsedSections = lines.flatMap((line) => parseLineSections(line));

  for (const [index, section] of parsedSections.entries()) {
    input.writer.send({
      type: "section_planned",
      runId: input.runId,
      index: startIndex + index,
      title: section.title,
      brief: section.brief
    });
  }

  onCountChange(startIndex + parsedSections.length);

  return remainder;
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

  return sections.slice(0, 10);
}

async function chooseResponseMode(input: RunInput) {
  const decision = await completeChat({
    apiKey: input.settings.apiKey,
    model: input.settings.model,
    signal: input.signal,
    messages: [
      {
        role: "system",
        content: `Decide whether the user request should use a multi-stage writing workflow.
Return exactly one token: STAGED or CHAT.

Choose CHAT when the user message is ordinary conversation, acknowledgement, greeting, quick follow-up,
brief clarification, or a short request that does not benefit from an intro, planned sections, and a conclusion.

Choose STAGED whenever the request would benefit from a structured, longer, more comprehensive response,
especially if it can be broken into multiple sections that can be drafted in parallel.
When in doubt for substantive writing requests, prefer STAGED.
Choose CHAT only for clearly conversational or lightweight requests that do not need structured long-form writing.`
      },
      {
        role: "user",
        content: input.prompt
      }
    ]
  });

  return decision.trim().toUpperCase() === "STAGED" ? "staged" : "chat";
}

async function maybeGenerateThreadTitle(input: RunInput) {
  const thread = getThread(input.threadId);
  if (!thread || thread.title !== "Untitled thread") {
    return null;
  }

  const title = await completeChat({
    apiKey: input.settings.apiKey,
    model: input.settings.model,
    signal: input.signal,
    useWebSearch: false,
    messages: [
      {
        role: "system",
        content: `Write a short chat title for this conversation.
Return only the title text.
Aim for 2 to 4 words.
Do not quote it.
Do not add punctuation unless truly necessary.
Do not simply copy the full user message.
Prefer a compact, descriptive title that would look good in a sidebar.`
      },
      {
        role: "user",
        content: input.prompt
      }
    ]
  });

  return sanitizeGeneratedTitle(title);
}

function sanitizeGeneratedTitle(title: string) {
  const cleaned = title
    .replace(/["'`#*_~[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return null;
  }

  const words = cleaned.split(" ").slice(0, 4);
  return words.join(" ").slice(0, 48) || null;
}
