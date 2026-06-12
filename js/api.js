// Backend API: model list and chat streaming via the local server, which
// shells out to the Claude Code CLI (`claude -p`).
//
// Session strategy: appending to an unmodified conversation resumes the
// existing Claude Code session (only the new message is sent — CC handles
// history and prompt caching). Any edit/delete/regenerate diverges from the
// session, so the next request starts a fresh session from the serialized
// transcript. The conversation stores {sessionId, sessionHash} where
// sessionHash fingerprints the message history the session represents.
"use strict";

const Api = (() => {
  async function fetchModels() {
    const resp = await fetch("/api/models");
    if (!resp.ok) throw new Error(`Failed to fetch models (${resp.status})`);
    return resp.json();
  }

  // FNV-1a over the [role, content] pairs; enough to detect divergence.
  function hashMessages(messages) {
    const str = JSON.stringify(messages.map((m) => [m.role, m.content]));
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  // Decide between resuming the conversation's CC session and starting fresh.
  function buildRequest(convo, contextMessages) {
    const last = contextMessages[contextMessages.length - 1];
    const canResume =
      convo.sessionId &&
      last?.role === "user" &&
      hashMessages(contextMessages.slice(0, -1)) === convo.sessionHash;

    const base = {
      model: convo.model,
      effort: convo.reasoningEffort !== "default" ? convo.reasoningEffort : null,
      systemPrompt: convo.systemPrompt,
    };
    return canResume
      ? { ...base, mode: "resume", sessionId: convo.sessionId, prompt: last.content }
      : { ...base, mode: "fresh", messages: contextMessages.map((m) => ({ role: m.role, content: m.content })) };
  }

  // Stream a completion. Calls onUpdate({content, reasoning}) as deltas
  // arrive; resolves with {content, reasoning, usage, sessionId}.
  async function streamCompletion({ request, signal, onUpdate }) {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    let done = null;

    while (true) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "delta") {
          content += ev.text;
          onUpdate({ content, reasoning });
        } else if (ev.type === "thinking") {
          reasoning += ev.text;
          onUpdate({ content, reasoning });
        } else if (ev.type === "done") {
          done = ev;
        } else if (ev.type === "error") {
          throw new Error(ev.message);
        }
      }
    }

    if (!done) throw new Error("Stream ended without a result");
    return {
      content: done.content || content,
      reasoning: done.thinking || reasoning,
      usage: done.usage,
      sessionId: done.sessionId,
    };
  }

  return { fetchModels, hashMessages, buildRequest, streamCompletion };
})();
