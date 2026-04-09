import Fastify, { FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  archiveThread,
  createThread,
  getSettings,
  getThreadDetail,
  getRun,
  listThreads,
  listRunBranches,
  saveSettings,
  updateThreadTitle,
  updateRun
} from "./db.js";
import { listModels } from "./openai.js";
import { retryRun, runConversation } from "./orchestrator.js";

const app = Fastify({ logger: false });
const activeControllers = new Map<string, AbortController>();
const modelCache = new Map<string, { models: string[]; cachedAt: number }>();
const modelCacheTtlMs = 1000 * 60 * 10;

const threadPatchSchema = z.object({
  title: z.string().trim().min(1).max(160)
});

const settingsSchema = z.object({
  apiKey: z.string(),
  customInstructions: z.string(),
  model: z.string().min(1),
  preset: z.enum(["balanced", "concise", "expansive"]),
  theme: z.enum(["system", "light", "dark"])
});

const runSchema = z.object({
  threadId: z.string().uuid(),
  prompt: z.string().trim().min(1),
  mode: z.enum(["chat", "staged"])
});

const modelsRequestSchema = z.object({
  apiKey: z.string().trim().min(1),
  refresh: z.boolean().optional()
});

app.get("/api/health", async () => ({ ok: true }));

app.get("/api/bootstrap", async () => {
  const activeThreads = listThreads(false).map(mapThread);
  const archivedThreads = listThreads(true).map(mapThread);
  return {
    activeThreads,
    archivedThreads,
    settings: mapSettings(getSettings()),
    selectedThreadId: activeThreads[0]?.id ?? null
  };
});

app.get("/api/threads/:threadId", async (request, reply) => {
  const params = z.object({ threadId: z.string().uuid() }).parse(request.params);
  const detail = getThreadDetail(params.threadId);
  if (!detail) {
    reply.code(404);
    return { error: "Thread not found" };
  }

  return {
    thread: mapThread(detail.thread),
    messages: detail.messages.map(mapMessage),
    runs: detail.runs.map(mapRun)
  };
});

app.post("/api/threads", async () => mapThread(createThread()));

app.patch("/api/threads/:threadId", async (request) => {
  const params = z.object({ threadId: z.string().uuid() }).parse(request.params);
  const body = threadPatchSchema.parse(request.body);
  return mapThread(updateThreadTitle(params.threadId, body.title));
});

app.delete("/api/threads/:threadId", async (request) => {
  const params = z.object({ threadId: z.string().uuid() }).parse(request.params);
  archiveThread(params.threadId);
  return { ok: true };
});

app.put("/api/settings", async (request) => {
  const body = settingsSchema.parse(request.body);
  return mapSettings(saveSettings(body));
});

app.post("/api/models", async (request, reply) => {
  const body = modelsRequestSchema.parse(request.body);

  try {
    const models = await getCachedModels(body.apiKey, Boolean(body.refresh));
    return {
      models,
      cachedAt: modelCache.get(cacheKeyForApiKey(body.apiKey))?.cachedAt ?? Date.now()
    };
  } catch (error) {
    reply.code(400);
    return {
      error: error instanceof Error ? error.message : "Unable to load models."
    };
  }
});

app.post("/api/runs", async (request, reply) => {
  const body = runSchema.parse(request.body);
  return streamRun(reply, async (writer, controller) => {
    await runConversation(
      {
        ...body,
        settings: mapSettings(getSettings()),
        signal: controller.signal
      },
      writer
    );
  });
});

app.post("/api/runs/:runId/retry", async (request, reply) => {
  const params = z.object({ runId: z.string().uuid() }).parse(request.params);
  return streamRun(reply, async (writer, controller) => {
    await retryRun(params.runId, mapSettings(getSettings()), controller.signal, writer);
  });
});

app.post("/api/runs/:runId/cancel", async (request) => {
  const params = z.object({ runId: z.string().uuid() }).parse(request.params);
  const controller = activeControllers.get(params.runId);
  if (controller) {
    controller.abort();
    activeControllers.delete(params.runId);
  }
  updateRun(params.runId, { status: "cancelled", stage: "cancelled" });
  return { ok: true };
});

app.get("/api/runs/:runId/plan", async (request, reply) => {
  const params = z.object({ runId: z.string().uuid() }).parse(request.params);
  const run = getRun(params.runId);
  if (!run) {
    reply.code(404);
    return { error: "Run not found" };
  }

  return {
    run: mapRun(run),
    branches: listRunBranches(params.runId).map((branch) => ({
      id: branch.id,
      runId: branch.run_id,
      stage: branch.stage,
      branchKey: branch.branch_key,
      status: branch.status,
      title: branch.title,
      sectionIndex: branch.section_index,
      prompt: branch.prompt,
      output: branch.output,
      startedAt: branch.started_at,
      completedAt: branch.completed_at,
      error: branch.error
    }))
  };
});

const distPath = path.resolve(process.cwd(), "dist");
app.register(fastifyStatic, {
  root: distPath,
  prefix: "/"
});

app.setNotFoundHandler(async (request, reply) => {
  if (request.raw.url?.startsWith("/api/")) {
    reply.code(404);
    return { error: "Not found" };
  }

  return reply.sendFile("index.html");
});

app.listen({ port: 3001, host: "127.0.0.1" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

async function streamRun(
  reply: FastifyReply,
  execute: (
    writer: { send: (event: Record<string, unknown>) => void; close: () => void },
    controller: AbortController
  ) => Promise<void>
) {
  const controller = new AbortController();

  reply.hijack();
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.flushHeaders();

  const writer = {
    send(event: Record<string, unknown>) {
      if ("runId" in event && typeof event.runId === "string") {
        activeControllers.set(event.runId, controller);
      }

      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    close() {
      const runId = [...activeControllers.entries()].find(([, active]) => active === controller)?.[0];
      if (runId) {
        activeControllers.delete(runId);
      }
      reply.raw.end();
    }
  };

  reply.raw.on("close", () => {
    controller.abort();
  });

  try {
    await execute(writer, controller);
  } catch (error) {
    if (!reply.raw.writableEnded) {
      reply.raw.write(
        `data: ${JSON.stringify({
          type: "run_failed",
          error: error instanceof Error ? error.message : "Unknown streaming failure"
        })}\n\n`
      );
      reply.raw.end();
    }
  }
}

function mapThread(thread: ReturnType<typeof listThreads>[number]) {
  return {
    id: thread.id,
    title: thread.title,
    archived: Boolean(thread.archived),
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    lastPreview: thread.last_preview
  };
}

function mapMessage(message: NonNullable<ReturnType<typeof getThreadDetail>>["messages"][number]) {
  return {
    id: message.id,
    threadId: message.thread_id,
    runId: message.run_id,
    role: message.role,
    messageType: message.message_type,
    content: message.content,
    createdAt: message.created_at
  };
}

function mapRun(run: NonNullable<ReturnType<typeof getThreadDetail>>["runs"][number]) {
  return {
    id: run.id,
    threadId: run.thread_id,
    mode: run.mode,
    status: run.status,
    stage: run.stage,
    assembledOutput: run.assembled_output,
    error: run.error,
    createdAt: run.created_at,
    updatedAt: run.updated_at
  };
}

function mapSettings(settings: ReturnType<typeof getSettings>) {
  return {
    apiKey: settings.api_key,
    customInstructions: settings.custom_instructions,
    model: settings.model,
    preset: settings.preset,
    theme: settings.theme
  };
}

async function getCachedModels(apiKey: string, refresh: boolean) {
  const cacheKey = cacheKeyForApiKey(apiKey);
  const cached = modelCache.get(cacheKey);
  const now = Date.now();
  if (!refresh && cached && now - cached.cachedAt < modelCacheTtlMs) {
    return cached.models;
  }

  const models = (await listModels({ apiKey }))
    .filter((model) => isLikelyTextModel(model.id))
    .map((model) => model.id)
    .sort(compareModelIds);

  modelCache.set(cacheKey, { models, cachedAt: now });
  return models;
}

function cacheKeyForApiKey(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex");
}

function isLikelyTextModel(modelId: string) {
  const id = modelId.toLowerCase();
  const looksLikeTextFamily =
    id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4") || id.startsWith("chatgpt-");
  const excluded =
    id.includes("audio") ||
    id.includes("tts") ||
    id.includes("transcribe") ||
    id.includes("transcription") ||
    id.includes("realtime") ||
    id.includes("embed") ||
    id.includes("image") ||
    id.includes("vision") ||
    id.includes("moderation") ||
    id.includes("whisper") ||
    id.includes("dall-e") ||
    id.includes("sora");

  return looksLikeTextFamily && !excluded;
}

function compareModelIds(a: string, b: string) {
  const scoreA = rankModelId(a);
  const scoreB = rankModelId(b);
  if (scoreA !== scoreB) {
    return scoreA - scoreB;
  }

  return a.localeCompare(b);
}

function rankModelId(modelId: string) {
  const id = modelId.toLowerCase();
  if (id.startsWith("gpt-5")) {
    return 0;
  }
  if (id.startsWith("o4")) {
    return 1;
  }
  if (id.startsWith("o3")) {
    return 2;
  }
  if (id.startsWith("o1")) {
    return 3;
  }
  if (id.startsWith("gpt-4.1")) {
    return 4;
  }
  if (id.startsWith("gpt-4o")) {
    return 5;
  }
  if (id.startsWith("chatgpt-")) {
    return 6;
  }

  return 7;
}
