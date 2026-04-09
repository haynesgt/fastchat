import { FormEvent, useEffect, useMemo, useRef, useState, startTransition } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
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
const scrollStorageKey = "fastchat.threadScroll";

export function App() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() => readThreadIdFromLocation());
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
  const messageStreamRef = useRef<HTMLElement | null>(null);
  const activeScrollThreadRef = useRef<string | null>(null);
  const restoredScrollThreadRef = useRef<string | null>(null);

  useEffect(() => {
    void loadBootstrap();
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setSelectedThreadId(readThreadIdFromLocation());
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!selectedThreadId || threadDetails[selectedThreadId]) {
      return;
    }

    void loadThread(selectedThreadId);
  }, [selectedThreadId, threadDetails]);

  const selectedThread = selectedThreadId ? threadDetails[selectedThreadId] : null;

  useEffect(() => {
    restoredScrollThreadRef.current = null;
  }, [selectedThreadId]);

  useEffect(() => {
    if (!selectedThreadId || !selectedThread) {
      return;
    }

    const container = messageStreamRef.current;
    if (!container || restoredScrollThreadRef.current === selectedThreadId) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const savedScroll = readThreadScroll(selectedThreadId);
      container.scrollTop = savedScroll;
      activeScrollThreadRef.current = selectedThreadId;
      restoredScrollThreadRef.current = selectedThreadId;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [selectedThreadId, selectedThread]);

  useEffect(() => {
    return () => {
      persistCurrentScroll(activeScrollThreadRef.current, messageStreamRef.current);
    };
  }, []);

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
    if (!response.ok) {
      if (response.status === 404) {
        setSelectedThreadId(null);
        setThreadUrl(null, false);
      }
      return;
    }
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
    selectThread(thread.id);
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
      selectThread(null);
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

    if (event.type === "section_planned") {
      setPending((current) => {
        if (!current) {
          return current;
        }

        const nextSections = [...current.sections];
        nextSections[event.index] = { title: event.title, brief: event.brief };
        return { ...current, sections: nextSections };
      });
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

    if (event.type === "run_completed") {
      setThreadDetails((current) => {
        const detail = current[event.threadId];
        if (!detail || detail.messages.some((message) => message.id === event.messageId)) {
          return current;
        }

        return {
          ...current,
          [event.threadId]: {
            ...detail,
            messages: [
              ...detail.messages,
              {
                id: event.messageId,
                threadId: event.threadId,
                runId: event.runId,
                role: "assistant",
                messageType: "assistant",
                content: event.content,
                createdAt: new Date().toISOString()
              }
            ]
          }
        };
      });
      setPending(null);
      return;
    }

    if (event.type === "run_cancelled") {
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

  function selectThread(threadId: string | null) {
    setSelectedThreadId(threadId);
    setThreadUrl(threadId, true);
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
              onClick={() => {
                persistCurrentScroll(activeScrollThreadRef.current, messageStreamRef.current);
                selectThread(thread.id);
              }}
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

        <section
          className="message-stream"
          ref={messageStreamRef}
          onScroll={(event) => {
            if (!selectedThreadId) {
              return;
            }

            writeThreadScroll(selectedThreadId, event.currentTarget.scrollTop);
            activeScrollThreadRef.current = selectedThreadId;
          }}
        >
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
              {message.role === "assistant" ? (
                <div
                  className="markdown-body"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
              ) : (
                <pre>{message.content}</pre>
              )}
            </article>
          ))}

          {pending ? (
            <div className="status-rail">
              <span className="status-dot" />
              <p>{pending.statusLabel}</p>
              {pending.sections.length > 0 ? <p>{pending.sections.length} planned sections</p> : null}
            </div>
          ) : null}
          <div className="message-buffer" aria-hidden="true" />
        </section>

        <form className="composer" onSubmit={(event) => void handleSend(event)}>
          <textarea
            placeholder="Write the thing you want drafted..."
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.ctrlKey && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
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

function renderMarkdown(content: string) {
  return DOMPurify.sanitize(marked.parse(content, { breaks: true }) as string);
}

function readThreadScroll(threadId: string) {
  try {
    const raw = window.localStorage.getItem(scrollStorageKey);
    if (!raw) {
      return 0;
    }

    const parsed = JSON.parse(raw) as Record<string, number>;
    return typeof parsed[threadId] === "number" ? parsed[threadId] : 0;
  } catch {
    return 0;
  }
}

function writeThreadScroll(threadId: string, scrollTop: number) {
  try {
    const raw = window.localStorage.getItem(scrollStorageKey);
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    parsed[threadId] = scrollTop;
    window.localStorage.setItem(scrollStorageKey, JSON.stringify(parsed));
  } catch {
    // Ignore storage failures and keep scrolling functional.
  }
}

function persistCurrentScroll(threadId: string | null, container: HTMLElement | null) {
  if (!threadId || !container) {
    return;
  }

  writeThreadScroll(threadId, container.scrollTop);
}

function readThreadIdFromLocation() {
  const match = window.location.pathname.match(/^\/thread\/([0-9a-f-]+)$/i);
  return match?.[1] ?? null;
}

function setThreadUrl(threadId: string | null, push: boolean) {
  const nextPath = threadId ? `/thread/${threadId}` : "/";
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (currentPath === nextPath) {
    return;
  }

  const method = push ? "pushState" : "replaceState";
  window.history[method](null, "", nextPath);
}
