export type ThreadSummary = {
  id: string;
  title: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastPreview: string;
};

export type Message = {
  id: string;
  threadId: string;
  runId: string | null;
  role: "user" | "assistant";
  messageType: "user" | "assistant" | "run_event";
  content: string;
  createdAt: string;
};

export type Settings = {
  apiKey: string;
  customInstructions: string;
  model: string;
  preset: "balanced" | "concise" | "expansive";
};

export type RunRecord = {
  id: string;
  threadId: string;
  mode: "chat" | "staged";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage: string | null;
  assembledOutput: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ThreadDetail = {
  thread: ThreadSummary;
  messages: Message[];
  runs: RunRecord[];
};

export type BootstrapState = {
  activeThreads: ThreadSummary[];
  archivedThreads: ThreadSummary[];
  settings: Settings;
  selectedThreadId: string | null;
};

export type SectionPlan = {
  title: string;
  brief: string;
};

export type StreamEvent =
  | { type: "run_started"; runId: string; threadId: string; mode: "chat" | "staged" }
  | { type: "stage_started"; runId: string; stage: string; label: string }
  | { type: "branch_started"; runId: string; stage: string; branchKey: string; label: string }
  | { type: "text_delta"; runId: string; target: "chat" | "intro" | "summary"; delta: string }
  | { type: "section_planned"; runId: string; index: number; title: string; brief: string }
  | { type: "section_plan"; runId: string; sections: SectionPlan[] }
  | { type: "section_delta"; runId: string; index: number; title: string; delta: string }
  | { type: "section_completed"; runId: string; index: number; title: string; content: string }
  | { type: "stage_completed"; runId: string; stage: string }
  | { type: "run_completed"; runId: string; threadId: string; messageId: string; content: string }
  | { type: "run_failed"; runId: string; error: string }
  | { type: "run_cancelled"; runId: string };

export type PendingRunState = {
  runId: string;
  threadId: string;
  mode: "chat" | "staged";
  intro: string;
  summary: string;
  sections: SectionPlan[];
  sectionContents: Record<number, string>;
  statusLabel: string;
};
