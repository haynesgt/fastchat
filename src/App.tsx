import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState, startTransition } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import {
  BootstrapState,
  MessageDetail,
  Message,
  ModelsResponse,
  PendingRunState,
  RunPlanResponse,
  Settings,
  StreamEvent,
  ThreadDetail,
  ThreadSummary
} from "./types";

const defaultSettings: Settings = {
  apiKey: "",
  customInstructions: "",
  model: "gpt-4.1-mini",
  preset: "balanced",
  theme: "system"
};

const pendingMessageId = "__pending__";
const scrollStorageKey = "fastchat.threadScroll";

export function App() {
  const initialRoute = readRouteFromLocation();
  const [activeThreads, setActiveThreads] = useState<ThreadSummary[]>([]);
  const [archivedThreads, setArchivedThreads] = useState<ThreadSummary[]>([]);
  const [threadTab, setThreadTab] = useState<"active" | "archived">("active");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(initialRoute.threadId);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(initialRoute.messageId);
  const [threadDetails, setThreadDetails] = useState<Record<string, ThreadDetail>>({});
  const [messageDetails, setMessageDetails] = useState<Record<string, MessageDetail>>({});
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [composer, setComposer] = useState("");
  const [mode, setMode] = useState<"staged" | "chat">("staged");
  const [pending, setPending] = useState<PendingRunState | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showComposerMenu, setShowComposerMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);
  const [modelsCachedAt, setModelsCachedAt] = useState<number | null>(null);
  const [openPlanRunId, setOpenPlanRunId] = useState<string | null>(null);
  const [planCache, setPlanCache] = useState<Record<string, RunPlanResponse>>({});
  const [isLoadingPlanRunId, setIsLoadingPlanRunId] = useState<string | null>(null);
  const [planErrorRunId, setPlanErrorRunId] = useState<string | null>(null);
  const [expandedMessages, setExpandedMessages] = useState<Record<string, boolean>>({});
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
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
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = settings.theme === "system" ? (media.matches ? "dark" : "light") : settings.theme;
      document.documentElement.dataset.theme = resolved;
    };

    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [settings.theme]);

  useEffect(() => {
    document.body.classList.toggle("standalone-message-route", Boolean(selectedMessageId));
    return () => document.body.classList.remove("standalone-message-route");
  }, [selectedMessageId]);

  useEffect(() => {
    const handlePopState = () => {
      const route = readRouteFromLocation();
      setSelectedThreadId(route.threadId);
      setSelectedMessageId(route.messageId);
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

  useEffect(() => {
    if (!selectedMessageId || messageDetails[selectedMessageId]) {
      return;
    }

    void loadMessage(selectedMessageId);
  }, [messageDetails, selectedMessageId]);

  const selectedThread = selectedThreadId ? threadDetails[selectedThreadId] : null;
  const selectedMessageDetail = selectedMessageId ? messageDetails[selectedMessageId] : null;
  const activeThreadId = selectedMessageDetail?.thread.id ?? selectedThreadId;
  const visibleThreads = threadTab === "active" ? activeThreads : archivedThreads;

  useEffect(() => {
    if (selectedMessageId) {
      return;
    }

    restoredScrollThreadRef.current = null;
  }, [selectedMessageId, selectedThreadId]);

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

  useEffect(() => {
    if (!showSettings || settings.apiKey.trim().length < 20) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void loadModels(false);
    }, 500);

    return () => window.clearTimeout(timeout);
  }, [showSettings, settings.apiKey]);

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
    const visiblePreview = stagedPreview.trim() || `_${pending.statusLabel}..._`;

    const optimisticAssistant: Message = {
      id: pendingMessageId,
      threadId: pending.threadId,
      runId: pending.runId,
      role: "assistant",
      messageType: "assistant",
      content: visiblePreview,
      createdAt: new Date().toISOString()
    };

    return [...baseMessages, optimisticAssistant];
  }, [pending, selectedThread]);

  async function loadBootstrap() {
    const response = await fetch("/api/bootstrap");
    const data = (await response.json()) as BootstrapState;
    setActiveThreads(data.activeThreads);
    setArchivedThreads(data.archivedThreads);
    setSettings(data.settings);
    setSelectedThreadId((current) => {
      if (current || selectedMessageId) {
        return current;
      }

      return data.selectedThreadId ?? data.activeThreads[0]?.id ?? null;
    });
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

  async function loadMessage(messageId: string) {
    const response = await fetch(`/api/messages/${messageId}`);
    if (!response.ok) {
      if (response.status === 404) {
        setSelectedMessageId(null);
        setAppUrl({ threadId: selectedThreadId, messageId: null }, false);
      }
      return;
    }

    const detail = (await response.json()) as MessageDetail;
    startTransition(() => {
      setMessageDetails((current) => ({ ...current, [messageId]: detail }));
    });
  }

  async function createThread() {
    const response = await fetch("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const thread = (await response.json()) as ThreadSummary;
    setActiveThreads((current) => [thread, ...current]);
    setThreadDetails((current) => ({
      ...current,
      [thread.id]: { thread, messages: [], runs: [] }
    }));
    setThreadTab("active");
    selectThread(thread.id);
    return thread.id;
  }

  async function renameThread(threadId: string) {
    const current = [...activeThreads, ...archivedThreads].find((thread) => thread.id === threadId);
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
    setActiveThreads((currentThreads) => currentThreads.map((thread) => (thread.id === threadId ? updated : thread)));
    setArchivedThreads((currentThreads) => currentThreads.map((thread) => (thread.id === threadId ? updated : thread)));
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
    const archivedThread = activeThreads.find((thread) => thread.id === threadId);
    setActiveThreads((current) => current.filter((thread) => thread.id !== threadId));
    if (archivedThread) {
      setArchivedThreads((current) => [{ ...archivedThread, archived: true }, ...current]);
    }
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

  async function loadModels(refresh: boolean) {
    const apiKey = settings.apiKey.trim();
    if (!apiKey) {
      setAvailableModels([]);
      setModelLoadError(null);
      setModelsCachedAt(null);
      return;
    }

    setIsLoadingModels(true);
    setModelLoadError(null);

    try {
      const response = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, refresh })
      });
      const data = (await response.json()) as ModelsResponse;
      if (!response.ok) {
        throw new Error(data.error || "Unable to load models.");
      }

      setAvailableModels(data.models);
      setModelsCachedAt(data.cachedAt);

      if (data.models.length > 0 && !data.models.includes(settings.model)) {
        setSettings((current) => ({
          ...current,
          model: data.models[0]
        }));
      }
    } catch (loadError) {
      setModelLoadError((loadError as Error).message);
    } finally {
      setIsLoadingModels(false);
    }
  }

  async function toggleRunPlan(runId: string) {
    if (openPlanRunId === runId) {
      setOpenPlanRunId(null);
      setPlanErrorRunId(null);
      return;
    }

    setOpenPlanRunId(runId);
    setPlanErrorRunId(null);

    if (planCache[runId]) {
      return;
    }

    setIsLoadingPlanRunId(runId);
    try {
      const response = await fetch(`/api/runs/${runId}/plan`);
      const data = (await response.json()) as RunPlanResponse;
      if (!response.ok) {
        throw new Error(data.error || "Unable to load execution plan.");
      }

      setPlanCache((current) => ({ ...current, [runId]: data }));
    } catch (loadError) {
      setPlanErrorRunId(runId);
      setError((loadError as Error).message);
    } finally {
      setIsLoadingPlanRunId((current) => (current === runId ? null : current));
    }
  }

  function toggleMessageExpansion(messageId: string) {
    setExpandedMessages((current) => ({ ...current, [messageId]: !current[messageId] }));
  }

  function toggleSectionExpansion(sectionKey: string) {
    setExpandedSections((current) => ({ ...current, [sectionKey]: !current[sectionKey] }));
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

    setPending({
      runId: `local-${crypto.randomUUID()}`,
      threadId,
      mode,
      intro: "",
      summary: "",
      sections: [],
      sectionContents: {},
      statusLabel: "Starting"
    });

    await streamRun("/api/runs", { threadId, prompt, mode });
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
      setPending((current) =>
        current && current.threadId === event.threadId
          ? { ...current, runId: event.runId, mode: event.mode, statusLabel: current.statusLabel || "Starting" }
          : {
              runId: event.runId,
              threadId: event.threadId,
              mode: event.mode,
              intro: "",
              summary: "",
              sections: [],
              sectionContents: {},
              statusLabel: "Starting"
            }
      );
      return;
    }

    if (event.type === "thread_title") {
      setActiveThreads((current) =>
        current.map((thread) => (thread.id === event.threadId ? { ...thread, title: event.title } : thread))
      );
      setArchivedThreads((current) =>
        current.map((thread) => (thread.id === event.threadId ? { ...thread, title: event.title } : thread))
      );
      setThreadDetails((current) => {
        const detail = current[event.threadId];
        if (!detail) {
          return current;
        }

        return {
          ...current,
          [event.threadId]: {
            ...detail,
            thread: { ...detail.thread, title: event.title }
          }
        };
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
    if (selectedMessageId) {
      await Promise.all([loadBootstrap(), loadMessage(selectedMessageId)]);
      return;
    }

    if (!selectedThreadId) {
      await loadBootstrap();
      return;
    }

    await Promise.all([loadBootstrap(), loadThread(selectedThreadId)]);
  }

  function selectThread(threadId: string | null) {
    setSelectedThreadId(threadId);
    setSelectedMessageId(null);
    setAppUrl({ threadId, messageId: null }, true);
  }

  function selectMessage(messageId: string, threadId: string) {
    setSelectedThreadId(threadId);
    setSelectedMessageId(messageId);
    setAppUrl({ threadId, messageId }, true);
  }

  function renderMessageCard(message: Message) {
    const standalone = Boolean(selectedMessageDetail);

    return (
      <article key={message.id} className={`message ${message.role} ${standalone ? "standalone-message-card" : ""}`}>
        <div className="message-meta">
          <span>{message.role === "assistant" ? "Assistant" : "You"}</span>
          <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
          <div className="message-meta-actions">
            {message.id !== pendingMessageId && !selectedMessageDetail ? (
              <a
                className="message-meta-action message-meta-link"
                href={getMessagePath(message.id)}
                rel="noopener noreferrer"
                target="_blank"
              >
                View
              </a>
            ) : null}
            {message.role === "assistant" && message.runId && message.id !== pendingMessageId ? (
              <button
                className="message-meta-action"
                onClick={() => void toggleRunPlan(message.runId!)}
                type="button"
              >
                Plan
              </button>
            ) : null}
          </div>
        </div>
        {message.id === pendingMessageId && pending ? (
          <button className="inline-stop-button" onClick={() => void stopRun()}>
            Stop
          </button>
        ) : null}
        {message.role === "assistant" && message.runId && openPlanRunId === message.runId ? (
          <div className="plan-popover">
            <div className="plan-popover-header">
              <strong>Execution plan</strong>
              <button className="plan-close-button" onClick={() => setOpenPlanRunId(null)} type="button">
                Close
              </button>
            </div>
            {isLoadingPlanRunId === message.runId ? <p className="plan-loading">Loading plan...</p> : null}
            {planErrorRunId === message.runId ? (
              <p className="plan-loading">Unable to load the saved plan for this response.</p>
            ) : null}
            {planCache[message.runId] ? (
              <div className="plan-stage-list">
                {groupBranchesByStage(planCache[message.runId].branches).map(([stage, branches]) => (
                  <section key={stage} className="plan-stage">
                    <h4>{formatStageLabel(stage)}</h4>
                    {branches.map((branch) => (
                      <div key={branch.id} className="plan-branch">
                        <div className="plan-branch-header">
                          <strong>{branch.title || branch.branchKey}</strong>
                          <span>{branch.status}</span>
                        </div>
                        <p>{toSingleLine(branch.prompt)}</p>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {message.role === "assistant" ? (
          renderAssistantBody({
            message,
            pending,
            expandedMessages,
            expandedSections,
            standalone,
            onToggleMessage: toggleMessageExpansion,
            onToggleSection: toggleSectionExpansion
          })
        ) : (
          <pre>{message.content}</pre>
        )}
      </article>
    );
  }

  if (selectedMessageDetail) {
    return (
      <div className="standalone-message-page">
        <main className="standalone-message-panel">
          <section className="message-stream single-message-stream standalone-message-stream">
            <div className="chat-title-block standalone-message-header">
              <p className="eyebrow">Single message</p>
              <div className="chat-title-row">
                <h2>{selectedMessageDetail.thread.title}</h2>
                <a className="ghost-button standalone-back-link" href={getThreadPath(selectedMessageDetail.thread.id)}>
                  Back to thread
                </a>
              </div>
            </div>
            {renderMessageCard(selectedMessageDetail.message)}
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <button className="ghost-button" onClick={() => void createThread()}>
            New thread
          </button>
        </div>

        <div className="thread-list">
          <div className="thread-tabs">
            <button
              className={`thread-tab ${threadTab === "active" ? "active" : ""}`}
              onClick={() => setThreadTab("active")}
              type="button"
            >
              Chats
            </button>
            <button
              className={`thread-tab ${threadTab === "archived" ? "active" : ""}`}
              onClick={() => setThreadTab("archived")}
              type="button"
            >
              Archived
            </button>
          </div>

          {visibleThreads.map((thread) => (
            <div
              key={thread.id}
              className={`thread-card ${thread.id === activeThreadId ? "active" : ""}`}
              onClick={() => {
                persistCurrentScroll(activeScrollThreadRef.current, messageStreamRef.current);
                selectThread(thread.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  persistCurrentScroll(activeScrollThreadRef.current, messageStreamRef.current);
                  selectThread(thread.id);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <div className="thread-card-header">
                <strong>{thread.title}</strong>
                <span className="thread-date">{new Date(thread.updatedAt).toLocaleDateString()}</span>
              </div>
              <div className="thread-card-footer">
                <div className="thread-card-actions">
                  <button
                    aria-label="Rename thread"
                    className="thread-icon-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void renameThread(thread.id);
                    }}
                    type="button"
                  >
                    ✏️
                  </button>
                  <button
                    aria-label="Archive thread"
                    className="thread-icon-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void archiveThread(thread.id);
                    }}
                    type="button"
                  >
                    🗄️
                  </button>
                </div>
              </div>
            </div>
          ))}

          {visibleThreads.length === 0 ? (
            <p className="thread-empty">{threadTab === "archived" ? "No archived chats yet." : "No chats yet."}</p>
          ) : null}
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
                {availableModels.length === 0 ? <option value={settings.model}>{settings.model}</option> : null}
                {availableModels.length > 0 && !availableModels.includes(settings.model) ? (
                  <option value={settings.model}>{settings.model}</option>
                ) : null}
                {availableModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
            <div className="settings-inline-row">
              <button
                className="ghost-button"
                disabled={isLoadingModels || settings.apiKey.trim().length === 0}
                onClick={() => void loadModels(true)}
                type="button"
              >
                {isLoadingModels ? "Loading models..." : "Refresh models"}
              </button>
              <span className="settings-help-text">
                {modelLoadError
                  ? modelLoadError
                  : modelsCachedAt
                    ? `Cached ${new Date(modelsCachedAt).toLocaleTimeString()}`
                    : settings.apiKey.trim()
                      ? "Load the latest models for this API key."
                      : "Add an API key to load current models."}
              </span>
            </div>
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
              Theme
              <select
                value={settings.theme}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    theme: event.target.value as Settings["theme"]
                  }))
                }
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
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
          <div className="chat-title-block">
            <h2>{selectedThread?.thread.title ?? "Create a thread to start"}</h2>
          </div>

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

          {renderedMessages.map(renderMessageCard)}

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
          <div className="composer-field">
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
            <button className="primary-button" disabled={isSending || !composer.trim()} type="submit">
              {isSending ? "Streaming..." : "Send"}
            </button>
            <div className="composer-menu">
              <button
                aria-expanded={showComposerMenu}
                aria-haspopup="menu"
                className="composer-menu-button"
                onClick={() => setShowComposerMenu((value) => !value)}
                type="button"
              >
                Mode
              </button>

              {showComposerMenu ? (
                <div className="composer-menu-popover" role="menu">
                  <button
                    className={`composer-menu-item ${mode === "staged" ? "active" : ""}`}
                    onClick={() => {
                      setMode("staged");
                      setShowComposerMenu(false);
                    }}
                    role="menuitemradio"
                    type="button"
                  >
                    Staged writer
                  </button>
                  <button
                    className={`composer-menu-item ${mode === "chat" ? "active" : ""}`}
                    onClick={() => {
                      setMode("chat");
                      setShowComposerMenu(false);
                    }}
                    role="menuitemradio"
                    type="button"
                  >
                    Normal chat
                  </button>
                </div>
              ) : null}
            </div>
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

function renderAssistantBody(input: {
  message: Message;
  pending: PendingRunState | null;
  expandedMessages: Record<string, boolean>;
  expandedSections: Record<string, boolean>;
  standalone?: boolean;
  onToggleMessage: (messageId: string) => void;
  onToggleSection: (sectionKey: string) => void;
}) {
  const { message, pending, expandedMessages, expandedSections, standalone = false, onToggleMessage, onToggleSection } =
    input;

  if (message.id === pendingMessageId && pending?.mode === "staged") {
    const stack = (
      <div className="assistant-stack">
        {pending.intro.trim() ? (
          <ScrollableBlock
            bodyClassName="markdown-body"
            content={renderMarkdown(pending.intro)}
            expanded={Boolean(expandedMessages[`${message.id}:intro`])}
            isHtml
            label="Intro"
            onToggle={isLongSectionContent(pending.intro) ? () => onToggleMessage(`${message.id}:intro`) : undefined}
          />
        ) : null}
        {pending.sections.map((section, index) => {
          const sectionKey = `${message.id}:section:${index}`;
          const content = pending.sectionContents[index]?.trim() || "_Writing this section..._";
          return renderSectionCard(section.title, content, sectionKey, expandedSections, onToggleSection, standalone);
        })}
        {pending.summary.trim() ? (
          <ScrollableBlock
            bodyClassName="markdown-body"
            content={renderMarkdown(pending.summary)}
            expanded={Boolean(expandedMessages[`${message.id}:summary`])}
            isHtml
            label="Summary"
            onToggle={isLongSectionContent(pending.summary) ? () => onToggleMessage(`${message.id}:summary`) : undefined}
          />
        ) : null}
      </div>
    );

    return (
      <MessageStackBlock
        expanded={standalone || Boolean(expandedMessages[message.id])}
        hasSections={pending.sections.length > 0}
        onToggle={() => onToggleMessage(message.id)}
        standalone={standalone}
      >
        {stack}
      </MessageStackBlock>
    );
  }

  const parsedSections = splitAssistantSections(message.content);
  if (parsedSections) {
    const stack = (
      <div className="assistant-stack">
        {parsedSections.intro.trim() ? (
          <ScrollableBlock
            bodyClassName="markdown-body"
            content={renderMarkdown(parsedSections.intro)}
            expanded={Boolean(expandedMessages[`${message.id}:intro`])}
            isHtml
            label="Intro"
            onToggle={
              isLongSectionContent(parsedSections.intro) ? () => onToggleMessage(`${message.id}:intro`) : undefined
            }
          />
        ) : null}
        {parsedSections.sections.map((section, index) =>
          renderSectionCard(
            section.title,
            section.content,
            `${message.id}:section:${index}`,
            expandedSections,
            onToggleSection,
            standalone
          )
        )}
        {parsedSections.summary.trim() ? (
          <ScrollableBlock
            bodyClassName="markdown-body"
            content={renderMarkdown(parsedSections.summary)}
            expanded={Boolean(expandedMessages[`${message.id}:summary`])}
            isHtml
            label="Summary"
            onToggle={
              isLongSectionContent(parsedSections.summary) ? () => onToggleMessage(`${message.id}:summary`) : undefined
            }
          />
        ) : null}
      </div>
    );

    return (
      <MessageStackBlock
        expanded={standalone || Boolean(expandedMessages[message.id])}
        hasSections={parsedSections.sections.length > 0}
        onToggle={() => onToggleMessage(message.id)}
        standalone={standalone}
      >
        {stack}
      </MessageStackBlock>
    );
  }

  const shouldClamp = isLongAssistantMessage(message.content);
  const expanded = Boolean(expandedMessages[message.id]);

  return (
    <ScrollableBlock
      bodyClassName="markdown-body"
      content={renderMarkdown(message.content)}
      expanded={standalone || expanded}
      insetBody
      isHtml
      label={shouldClamp ? undefined : undefined}
      onToggle={standalone ? undefined : shouldClamp ? () => onToggleMessage(message.id) : undefined}
    />
  );
}

function MessageStackBlock(input: {
  children: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  hasSections?: boolean;
  standalone?: boolean;
}) {
  const { children, expanded, onToggle, hasSections = true, standalone = false } = input;
  const stackScrollClassName = [
    "assistant-stack-scroll",
    expanded ? "expanded" : "collapsed",
    hasSections ? "" : "no-sections",
    standalone ? "standalone" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="assistant-message-stack">
      {!standalone ? (
        <div className="assistant-block-controls">
          <button
            aria-label={expanded ? "Collapse message" : "Expand message"}
            className="section-toggle-button assistant-block-toggle"
            onClick={onToggle}
            type="button"
          >
            {toggleSymbol(expanded)}
          </button>
        </div>
      ) : null}
      <div className={stackScrollClassName}>{children}</div>
      {!standalone ? (
        <div className="assistant-block-controls">
          <button
            aria-label={expanded ? "Collapse message" : "Expand message"}
            className="section-toggle-button assistant-block-toggle"
            onClick={onToggle}
            type="button"
          >
            {toggleSymbol(expanded)}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function renderSectionCard(
  title: string,
  content: string,
  sectionKey: string,
  expandedSections: Record<string, boolean>,
  onToggleSection: (sectionKey: string) => void,
  standalone = false
) {
  const canToggle = !standalone && isLongSectionContent(content);
  const isExpanded = standalone || Boolean(expandedSections[sectionKey]);

  return (
    <section className="assistant-section-card" key={sectionKey}>
      <div className="assistant-section-header">
        <h3>{title}</h3>
        {canToggle ? (
          <button
            aria-label={isExpanded ? "Collapse section" : "Expand section"}
            className="section-toggle-button"
            onClick={() => onToggleSection(sectionKey)}
            type="button"
          >
            {toggleSymbol(isExpanded)}
          </button>
        ) : null}
      </div>
      <div
        className={`assistant-section-body ${isExpanded || !canToggle ? "expanded" : "collapsed"}`}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
      />
      {canToggle ? (
        <div className="assistant-section-footer">
          <button
            aria-label={isExpanded ? "Collapse section" : "Expand section"}
            className="section-toggle-button"
            onClick={() => onToggleSection(sectionKey)}
            type="button"
          >
            {toggleSymbol(isExpanded)}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ScrollableBlock(input: {
  content: string;
  expanded: boolean;
  isHtml?: boolean;
  bodyClassName: string;
  label?: string;
  onToggle?: () => void;
  insetBody?: boolean;
}) {
  const { content, expanded, isHtml, bodyClassName, label, onToggle, insetBody = false } = input;
  const canToggle = Boolean(onToggle);
  const scrollBodyClassName = [
    bodyClassName,
    "assistant-scroll-body",
    expanded ? "expanded" : canToggle ? "collapsed" : "",
    insetBody ? "inset-body" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="assistant-block">
      {label ? <div className="assistant-block-label">{label}</div> : null}
      {canToggle ? (
        <div className="assistant-block-controls">
          <button
            aria-label={expanded ? "Collapse section" : "Expand section"}
            className="section-toggle-button assistant-block-toggle"
            onClick={onToggle}
            type="button"
          >
            {toggleSymbol(expanded)}
          </button>
        </div>
      ) : null}
      {isHtml ? (
        <div className={scrollBodyClassName} dangerouslySetInnerHTML={{ __html: content }} />
      ) : (
        <div className={scrollBodyClassName}>{content}</div>
      )}
      {canToggle ? (
        <div className="assistant-block-controls">
          <button
            aria-label={expanded ? "Collapse section" : "Expand section"}
            className="section-toggle-button assistant-block-toggle"
            onClick={onToggle}
            type="button"
          >
            {toggleSymbol(expanded)}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function isLongAssistantMessage(content: string) {
  return content.length > 1400 || content.split(/\n/).length > 18;
}

function isLongSectionContent(content: string) {
  return content.length > 900 || content.split(/\n/).length > 10;
}

function toggleSymbol(expanded: boolean) {
  return expanded ? "▴" : "▾";
}

function splitAssistantSections(content: string) {
  const normalized = content.replace(/\r\n/g, "\n");
  const sectionMatches = [...normalized.matchAll(/^##\s+(.+)$/gm)];
  if (sectionMatches.length === 0) {
    return null;
  }

  const intro = normalized.slice(0, sectionMatches[0].index).trim();
  const sections: Array<{ title: string; content: string }> = [];

  for (let index = 0; index < sectionMatches.length; index += 1) {
    const match = sectionMatches[index];
    const title = match[1].trim();
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < sectionMatches.length ? (sectionMatches[index + 1].index ?? normalized.length) : normalized.length;
    const body = normalized.slice(start, end).trim();
    sections.push({ title, content: body });
  }

  let summary = "";
  if (sections.length > 0) {
    const lastSection = sections[sections.length - 1];
    const summarySplit = lastSection.content.match(/\n(?=In summary\b|Overall\b|To sum up\b|Ultimately\b)/i);
    if (summarySplit?.index) {
      summary = lastSection.content.slice(summarySplit.index).trim();
      lastSection.content = lastSection.content.slice(0, summarySplit.index).trim();
    }
  }

  return { intro, sections, summary };
}

function groupBranchesByStage(branches: RunPlanResponse["branches"]) {
  const groups = new Map<string, RunPlanResponse["branches"]>();

  for (const branch of branches) {
    const current = groups.get(branch.stage) ?? [];
    current.push(branch);
    groups.set(branch.stage, current);
  }

  return [...groups.entries()];
}

function formatStageLabel(stage: string) {
  return stage.replace(/_/g, " ").replace(/\bstage\b/gi, "Stage").replace(/\b\w/g, (char) => char.toUpperCase());
}

function toSingleLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
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

function readRouteFromLocation() {
  const messageMatch = window.location.pathname.match(/^\/message\/([0-9a-f-]+)$/i);
  if (messageMatch) {
    return { threadId: null, messageId: messageMatch[1] };
  }

  const threadMatch = window.location.pathname.match(/^\/thread\/([0-9a-f-]+)$/i);
  if (threadMatch) {
    return { threadId: threadMatch[1], messageId: null };
  }

  return { threadId: null, messageId: null };
}

function getThreadPath(threadId: string) {
  return `/thread/${threadId}`;
}

function getMessagePath(messageId: string) {
  return `/message/${messageId}`;
}

function setAppUrl(route: { threadId: string | null; messageId: string | null }, push: boolean) {
  const nextPath = route.messageId ? getMessagePath(route.messageId) : route.threadId ? getThreadPath(route.threadId) : "/";
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (currentPath === nextPath) {
    return;
  }

  const method = push ? "pushState" : "replaceState";
  window.history[method](null, "", nextPath);
}
