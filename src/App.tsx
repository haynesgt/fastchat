import { FormEvent, useEffect, useMemo, useRef, useState, startTransition } from "react";
import {
  BootstrapState,
  Message,
  PendingRunState,
  Settings,
  StreamEvent,
  ThreadDetail,
  ThreadSummary
} from "./types";

const defaultSettings: Settings = {
  apiKey: "",
  customInstructions: "",
  model: "gpt-4.1-mini",
  preset: "balanced"
};

const pendingMessageId = "__pending__";

export function App() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadDetails, setThreadDetails] = useState<Record<string, ThreadDetail>>({});
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [composer, setComposer] = useState("");
  const [mode, setMode] = useState<"staged" | "chat">("staged");
  const [pending, setPending] = useState<PendingRunState | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadBootstrap();
  }, []);

  useEffect(() => {
    if (!selectedThreadId || threadDetails[selectedThreadId]) {
      return;
    }

    void loadThread(selectedThreadId);
  }, [selectedThreadId, threadDetails]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [selectedThreadId, threadDetails, pending]);

  const selectedThread = selectedThreadId ? threadDetails[selectedThreadId] : null;

  const renderedMessages = useMemo(() => {
    if (!selectedThread) {
      return [];
    }

    const baseMessages = selectedThread.messages.filter((message) => message.messageType !== "run_event");
    if (!pending || pending.threadId !== selectedThread.thread.id) {
      return baseMessages;
    }

    const stagedPreview =
      pending.mode === "chat"
        ? pending.intro
        : [
            pending.intro.trim(),
            ...pending.sections.map((section, index) => {
              const content = pending.sectionContents[index];
              return content
                ? `## ${section.title}\n\n${content.trim()}`
                : `## ${section.title}\n\n_Writing this section..._`;
            }),
            pending.summary.trim()
          ]
            .filter(Boolean)
            .join("\n\n");

    const optimisticAssistant: Message = {
      id: pendingMessageId,
      threadId: pending.threadId,
      runId: pending.runId,
      role: "assistant",
      messageType: "assistant",
      content: stagedPreview,
      createdAt: new Date().toISOString()
    };

    return [...baseMessages, optimisticAssistant];
  }, [pending, selectedThread]);

  async function loadBootstrap() {
    const response = await fetch("/api/bootstrap");
    const data = (await response.json()) as BootstrapState;
    setThreads(data.threads);
    setSettings(data.settings);
    setSelectedThreadId((current) => current ?? data.selectedThreadId ?? data.threads[0]?.id ?? null);
  }

  async function loadThread(threadId: string) {
    const response = await fetch(`/api/threads/${threadId}`);
    const detail = (await response.json()) as ThreadDetail;
    startTransition(() => {
      setThreadDetails((current) => ({ ...current, [threadId]: detail }));
    });
  }

  async function createThread() {
    const response = await fetch("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const thread = (await response.json()) as ThreadSummary;
    setThreads((current) => [thread, ...current]);
    setThreadDetails((current) => ({
      ...current,
      [thread.id]: { thread, messages: [], runs: [] }
    }));
    setSelectedThreadId(thread.id);
    return thread.id;
  }

  async function renameThread(threadId: string) {
    const current = threads.find((thread) => thread.id === threadId);
    const title = window.prompt("Rename thread", current?.title ?? "");
    if (!title) {
      return;
    }

    const response = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title })
    });

    const updated = (await response.json()) as ThreadSummary;
    setThreads((currentThreads) => currentThreads.map((thread) => (thread.id === threadId ? updated : thread)));
    setThreadDetails((currentDetails) => {
      const detail = currentDetails[threadId];
      if (!detail) {
        return currentDetails;
      }

      return { ...currentDetails, [threadId]: { ...detail, thread: updated } };
    });
  }

  async function archiveThread(threadId: string) {
    await fetch(`/api/threads/${threadId}`, { method: "DELETE" });
    setThreads((current) => current.filter((thread) => thread.id !== threadId));
    setThreadDetails((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    if (selectedThreadId === threadId) {
      setSelectedThreadId(null);
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSavingSettings(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings)
      });
      const saved = (await response.json()) as Settings;
      setSettings(saved);
      setShowSettings(false);
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!composer.trim() || isSending) {
      return;
    }

    const prompt = composer.trim();
    const threadId = selectedThreadId ?? (await createThread());
    setComposer("");

    const optimisticUser: Message = {
      id: `local-${crypto.randomUUID()}`,
      threadId,
      runId: null,
      role: "user",
      messageType: "user",
      content: prompt,
      createdAt: new Date().toISOString()
    };

    setThreadDetails((current) => {
      const detail = current[threadId];
      if (!detail) {
        return current;
      }

      return {
        ...current,
        [threadId]: {
          ...detail,
          messages: [...detail.messages, optimisticUser]
        }
      };
    });

    await streamRun("/api/runs", { threadId, prompt, mode });
  }

  async function regenerateLast() {
    if (!selectedThread || isSending) {
      return;
    }

    const lastRun = [...selectedThread.runs].reverse().find((run) => run.status !== "cancelled");
    if (!lastRun) {
      return;
    }

    await streamRun(`/api/runs/${lastRun.id}/retry`, {});
  }

  async function stopRun() {
    if (!pending) {
      return;
    }

    abortRef.current?.abort();
    await fetch(`/api/runs/${pending.runId}/cancel`, { method: "POST" });
  }

  async function streamRun(url: string, body: Record<string, unknown>) {
    setIsSending(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok || !response.body) {
        const failure = await response.text();
        throw new Error(failure || "Streaming request failed.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const dataLine = frame
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (dataLine) {
            applyStreamEvent(JSON.parse(dataLine) as StreamEvent);
          }
        }
      }
    } catch (streamError) {
      if ((streamError as Error).name !== "AbortError") {
        setError((streamError as Error).message);
      }
    } finally {
      abortRef.current = null;
      setIsSending(false);
      await refreshSelectedThread();
    }
  }

  function applyStreamEvent(event: StreamEvent) {
    if (event.type === "run_started") {
      setPending({
        runId: event.runId,
        threadId: event.threadId,
        mode: event.mode,
        intro: "",
        summary: "",
        sections: [],
        sectionContents: {},
        statusLabel: "Starting"
      });
      return;
    }

    if (event.type === "stage_started") {
      setPending((current) => (current ? { ...current, statusLabel: event.label } : current));
      return;
    }

    if (event.type === "text_delta") {
      setPending((current) => {
        if (!current) {
          return current;
        }

        if (event.target === "summary") {
          return { ...current, summary: current.summary + event.delta };
        }

        return { ...current, intro: current.intro + event.delta };
      });
      return;
    }

    if (event.type === "section_plan") {
      setPending((current) => (current ? { ...current, sections: event.sections } : current));
      return;
    }

    if (event.type === "section_completed") {
      setPending((current) =>
        current
          ? {
              ...current,
              sectionContents: { ...current.sectionContents, [event.index]: event.content }
            }
          : current
      );
      return;
    }

    if (event.type === "section_delta") {
      setPending((current) =>
        current
          ? {
              ...current,
              sectionContents: {
                ...current.sectionContents,
                [event.index]: (current.sectionContents[event.index] ?? "") + event.delta
              }
            }
          : current
      );
      return;
    }

    if (event.type === "run_failed") {
      setError(event.error);
      setPending(null);
      return;
    }

    if (event.type === "run_cancelled" || event.type === "run_completed") {
      setPending(null);
    }
  }

  async function refreshSelectedThread() {
    if (!selectedThreadId) {
      await loadBootstrap();
      return;
    }

    await Promise.all([loadBootstrap(), loadThread(selectedThreadId)]);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div>
            <p className="eyebrow">FastChat</p>
            <h1>Staged ChatGPT</h1>
          </div>
          <button className="ghost-button" onClick={() => void createThread()}>
            New thread
          </button>
        </div>

        <div className="thread-list">
          {threads.map((thread) => (
            <button
              key={thread.id}
              className={`thread-card ${thread.id === selectedThreadId ? "active" : ""}`}
              onClick={() => setSelectedThreadId(thread.id)}
            >
              <div className="thread-card-header">
                <strong>{thread.title}</strong>
                <span>{new Date(thread.updatedAt).toLocaleDateString()}</span>
              </div>
              <p>{thread.lastPreview || "Fresh thread"}</p>
              <div className="thread-card-actions">
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    void renameThread(thread.id);
                  }}
                  onKeyDown={() => undefined}
                >
                  Rename
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    void archiveThread(thread.id);
                  }}
                  onKeyDown={() => undefined}
                >
                  Archive
                </span>
              </div>
            </button>
          ))}
        </div>

        <button className="settings-button" onClick={() => setShowSettings((value) => !value)}>
          {showSettings ? "Close settings" : "Open settings"}
        </button>

        {showSettings ? (
          <form className="settings-panel" onSubmit={(event) => void saveSettings(event)}>
            <label>
              OpenAI API key
              <input
                type="password"
                value={settings.apiKey}
                onChange={(event) => setSettings((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder="sk-..."
              />
            </label>
            <label>
              Model
              <select
                value={settings.model}
                onChange={(event) => setSettings((current) => ({ ...current, model: event.target.value }))}
              >
                <option value="gpt-4.1-mini">gpt-4.1-mini</option>
                <option value="gpt-4.1">gpt-4.1</option>
                <option value="gpt-4o-mini">gpt-4o-mini</option>
              </select>
            </label>
            <label>
              Writing preset
              <select
                value={settings.preset}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    preset: event.target.value as Settings["preset"]
                  }))
                }
              >
                <option value="balanced">Balanced</option>
                <option value="concise">Concise</option>
                <option value="expansive">Expansive</option>
              </select>
            </label>
            <label>
              Custom instructions
              <textarea
                value={settings.customInstructions}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, customInstructions: event.target.value }))
                }
                rows={8}
              />
            </label>
            <button className="primary-button" disabled={isSavingSettings} type="submit">
              {isSavingSettings ? "Saving..." : "Save settings"}
            </button>
          </form>
        ) : null}
      </aside>

      <main className="chat-panel">
        <header className="chat-header">
          <div>
            <p className="eyebrow">Signature workflow</p>
            <h2>{selectedThread?.thread.title ?? "Create a thread to start"}</h2>
          </div>
          <div className="header-actions">
            <button className={`mode-pill ${mode === "staged" ? "active" : ""}`} onClick={() => setMode("staged")}>
              Staged writer
            </button>
            <button className={`mode-pill ${mode === "chat" ? "active" : ""}`} onClick={() => setMode("chat")}>
              Normal chat
            </button>
            <button className="ghost-button" disabled={isSending} onClick={() => void regenerateLast()}>
              Regenerate
            </button>
            <button className="ghost-button warn" disabled={!pending} onClick={() => void stopRun()}>
              Stop
            </button>
          </div>
        </header>

        <section className="message-stream">
          {renderedMessages.length === 0 ? (
            <div className="empty-state">
              <p className="eyebrow">Fast by design</p>
              <h3>Ask for an article, memo, strategy note, or a plain answer.</h3>
              <p>
                Staged mode streams an intro first, plans sections in parallel, drafts each section concurrently, and
                closes with a summary.
              </p>
            </div>
          ) : null}

          {renderedMessages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="message-meta">
                <span>{message.role === "assistant" ? "Assistant" : "You"}</span>
                <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
              </div>
              <pre>{message.content}</pre>
            </article>
          ))}

          {pending ? (
            <div className="status-rail">
              <span className="status-dot" />
              <p>{pending.statusLabel}</p>
              {pending.sections.length > 0 ? <p>{pending.sections.length} planned sections</p> : null}
            </div>
          ) : null}

          <div ref={messagesEndRef} />
        </section>

        <form className="composer" onSubmit={(event) => void handleSend(event)}>
          <textarea
            placeholder="Write the thing you want drafted..."
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            rows={5}
          />
          <div className="composer-footer">
            <p>
              {mode === "staged"
                ? "Default mode: intro, section plan, parallel section writing, summary."
                : "Normal chat mode for quick back-and-forth answers."}
            </p>
            <button className="primary-button" disabled={isSending || !composer.trim()} type="submit">
              {isSending ? "Streaming..." : "Send"}
            </button>
          </div>
        </form>

        {error ? <p className="error-banner">{error}</p> : null}
      </main>
    </div>
  );
}
