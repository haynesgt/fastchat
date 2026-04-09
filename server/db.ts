import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type DbThread = {
  id: string;
  title: string;
  archived: number;
  created_at: string;
  updated_at: string;
  last_preview: string;
};

export type DbMessage = {
  id: string;
  thread_id: string;
  run_id: string | null;
  role: "user" | "assistant";
  message_type: "user" | "assistant" | "run_event";
  content: string;
  created_at: string;
};

export type DbRun = {
  id: string;
  thread_id: string;
  mode: "chat" | "staged";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage: string | null;
  assembled_output: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const dataDir = path.resolve(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, "fastchat.db");

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_preview TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    run_id TEXT,
    role TEXT NOT NULL,
    message_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(thread_id) REFERENCES threads(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    api_key TEXT NOT NULL DEFAULT '',
    custom_instructions TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT 'gpt-4.1-mini',
    preset TEXT NOT NULL DEFAULT 'balanced'
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT,
    assembled_output TEXT NOT NULL DEFAULT '',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    user_message_id TEXT,
    assistant_message_id TEXT,
    FOREIGN KEY(thread_id) REFERENCES threads(id)
  );

  CREATE TABLE IF NOT EXISTS run_branches (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    branch_key TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT,
    section_index INTEGER,
    prompt TEXT NOT NULL,
    output TEXT NOT NULL DEFAULT '',
    meta_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT,
    FOREIGN KEY(run_id) REFERENCES runs(id)
  );
`);

db.prepare(
  `INSERT INTO settings (id, api_key, custom_instructions, model, preset)
   VALUES (1, '', '', 'gpt-4.1-mini', 'balanced')
   ON CONFLICT(id) DO NOTHING`
).run();

export function nowIso() {
  return new Date().toISOString();
}

export function createThread(title = "Untitled thread") {
  const id = randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO threads (id, title, archived, created_at, updated_at, last_preview)
     VALUES (?, ?, 0, ?, ?, '')`
  ).run(id, title, now, now);
  return getThread(id)!;
}

export function getThread(threadId: string) {
  return db.prepare<unknown[], DbThread>(`SELECT * FROM threads WHERE id = ?`).get(threadId);
}

export function listThreads() {
  return db
    .prepare<unknown[], DbThread>(
      `SELECT * FROM threads WHERE archived = 0 ORDER BY updated_at DESC, created_at DESC`
    )
    .all();
}

export function updateThreadTitle(threadId: string, title: string) {
  db.prepare(`UPDATE threads SET title = ?, updated_at = ? WHERE id = ?`).run(title, nowIso(), threadId);
  return getThread(threadId)!;
}

export function archiveThread(threadId: string) {
  db.prepare(`UPDATE threads SET archived = 1, updated_at = ? WHERE id = ?`).run(nowIso(), threadId);
}

export function listMessages(threadId: string) {
  return db
    .prepare<unknown[], DbMessage>(`SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC`)
    .all(threadId);
}

export function createMessage(input: {
  threadId: string;
  runId?: string | null;
  role: "user" | "assistant";
  messageType: "user" | "assistant" | "run_event";
  content: string;
}) {
  const id = randomUUID();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO messages (id, thread_id, run_id, role, message_type, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.threadId, input.runId ?? null, input.role, input.messageType, input.content, createdAt);
  syncThreadMetadata(input.threadId, input);
  return db.prepare<unknown[], DbMessage>(`SELECT * FROM messages WHERE id = ?`).get(id)!;
}

export function listRuns(threadId: string) {
  return db.prepare<unknown[], DbRun>(`SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at ASC`).all(threadId);
}

export function createRun(input: { threadId: string; mode: "chat" | "staged"; userMessageId?: string | null }) {
  const id = randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO runs (id, thread_id, mode, status, stage, assembled_output, error, created_at, updated_at, user_message_id)
     VALUES (?, ?, ?, 'running', NULL, '', NULL, ?, ?, ?)`
  ).run(id, input.threadId, input.mode, now, now, input.userMessageId ?? null);
  return id;
}

export function updateRun(
  runId: string,
  patch: {
    status?: string;
    stage?: string | null;
    assembledOutput?: string;
    error?: string | null;
    assistantMessageId?: string | null;
  }
) {
  const current = db
    .prepare<unknown[], DbRun & { assistant_message_id?: string | null }>(`SELECT * FROM runs WHERE id = ?`)
    .get(runId);
  if (!current) {
    return;
  }

  db.prepare(
    `UPDATE runs
     SET status = ?,
         stage = ?,
         assembled_output = ?,
         error = ?,
         assistant_message_id = COALESCE(?, assistant_message_id),
         updated_at = ?,
         completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE completed_at END
     WHERE id = ?`
  ).run(
    patch.status ?? current.status,
    patch.stage ?? current.stage,
    patch.assembledOutput ?? current.assembled_output,
    patch.error ?? current.error,
    patch.assistantMessageId ?? null,
    nowIso(),
    patch.status ?? current.status,
    nowIso(),
    runId
  );
}

export function getRun(runId: string) {
  return db
    .prepare<unknown[], DbRun & { user_message_id?: string | null; assistant_message_id?: string | null }>(
      `SELECT * FROM runs WHERE id = ?`
    )
    .get(runId);
}

export function createBranch(input: {
  runId: string;
  stage: string;
  branchKey: string;
  prompt: string;
  title?: string | null;
  sectionIndex?: number | null;
  metaJson?: string;
}) {
  const id = randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO run_branches (
      id, run_id, stage, branch_key, status, title, section_index, prompt, output, meta_json, started_at
    ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, '', ?, ?)`
  ).run(
    id,
    input.runId,
    input.stage,
    input.branchKey,
    input.title ?? null,
    input.sectionIndex ?? null,
    input.prompt,
    input.metaJson ?? "{}",
    now
  );
  return id;
}

export function finishBranch(branchId: string, output: string, status: "completed" | "failed", error?: string) {
  db.prepare(
    `UPDATE run_branches
     SET status = ?, output = ?, error = ?, completed_at = ?
     WHERE id = ?`
  ).run(status, output, error ?? null, nowIso(), branchId);
}

export function getSettings() {
  return db.prepare(`SELECT api_key, custom_instructions, model, preset FROM settings WHERE id = 1`).get() as {
    api_key: string;
    custom_instructions: string;
    model: string;
    preset: "balanced" | "concise" | "expansive";
  };
}

export function saveSettings(input: {
  apiKey: string;
  customInstructions: string;
  model: string;
  preset: "balanced" | "concise" | "expansive";
}) {
  db.prepare(`UPDATE settings SET api_key = ?, custom_instructions = ?, model = ?, preset = ? WHERE id = 1`).run(
    input.apiKey,
    input.customInstructions,
    input.model,
    input.preset
  );
  return getSettings();
}

export function getThreadDetail(threadId: string) {
  const thread = getThread(threadId);
  if (!thread) {
    return null;
  }

  return {
    thread,
    messages: listMessages(threadId),
    runs: listRuns(threadId)
  };
}

function syncThreadMetadata(
  threadId: string,
  message: { role: "user" | "assistant"; messageType: "user" | "assistant" | "run_event"; content: string }
) {
  const timestamp = nowIso();

  if (message.messageType === "run_event") {
    db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(timestamp, threadId);
    return;
  }

  const preview = toSingleLinePreview(message.content);
  const thread = getThread(threadId);
  const nextTitle =
    thread && thread.title === "Untitled thread" && message.role === "user"
      ? preview.slice(0, 60) || thread.title
      : thread?.title ?? "Untitled thread";

  db.prepare(`UPDATE threads SET updated_at = ?, last_preview = ?, title = ? WHERE id = ?`).run(
    timestamp,
    preview,
    nextTitle,
    threadId
  );
}

function toSingleLinePreview(content: string) {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`-]+/g, " ")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
