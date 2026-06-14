// UI wiring: sidebar, model picker, message rendering, streaming, editing.
"use strict";

(() => {
  const $ = (sel) => document.querySelector(sel);

  const els = {
    sidebar: $("#sidebar"),
    convoList: $("#convo-list"),
    newChatBtn: $("#new-chat-btn"),
    collapseBtn: $("#collapse-btn"),
    expandBtn: $("#expand-btn"),
    modelBtn: $("#model-btn"),
    modelDropdown: $("#model-dropdown"),
    modelSearch: $("#model-search"),
    modelList: $("#model-list"),
    reasoningSelect: $("#reasoning-select"),
    systemPromptBox: $("#system-prompt-box"),
    systemPrompt: $("#system-prompt"),
    systemPromptHint: $("#system-prompt-hint"),
    messages: $("#messages"),
    input: $("#input"),
    sendBtn: $("#send-btn"),
    regenBtn: $("#regen-btn"),
    stopBtn: $("#stop-btn"),
  };

  let convo = null;          // current conversation object
  let models = [];           // model list from OpenRouter
  let abortController = null;
  let saveTimer = null;

  // ---------- init ----------

  function init() {
    const index = Store.listConversations();
    convo = index.length ? Store.loadConversation(index[0].id) : null;
    if (!convo) convo = Store.createConversation();

    bindEvents();
    renderSidebar();
    renderConversation();

    Api.fetchModels().then((m) => {
      models = m;
      renderModelButton();
    }).catch((e) => showBanner(`Could not load model list: ${e.message}`));
  }

  function bindEvents() {
    els.newChatBtn.addEventListener("click", () => {
      convo = Store.createConversation();
      renderSidebar();
      renderConversation();
      els.input.focus();
    });

    els.collapseBtn.addEventListener("click", () => {
      els.sidebar.classList.add("collapsed");
      els.expandBtn.classList.remove("hidden");
    });
    els.expandBtn.addEventListener("click", () => {
      els.sidebar.classList.remove("collapsed");
      els.expandBtn.classList.add("hidden");
    });

    // model picker
    els.modelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      els.modelDropdown.classList.toggle("hidden");
      if (!els.modelDropdown.classList.contains("hidden")) {
        els.modelSearch.value = "";
        renderModelList("");
        els.modelSearch.focus();
      }
    });
    els.modelSearch.addEventListener("input", () => renderModelList(els.modelSearch.value));
    els.modelSearch.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = els.modelList.querySelector(".model-item");
        if (first) selectModel(first.dataset.id);
      } else if (e.key === "Escape") {
        els.modelDropdown.classList.add("hidden");
      }
    });
    document.addEventListener("click", (e) => {
      if (!els.modelDropdown.contains(e.target) && e.target !== els.modelBtn) {
        els.modelDropdown.classList.add("hidden");
      }
    });

    els.reasoningSelect.addEventListener("change", () => {
      convo.reasoningEffort = els.reasoningSelect.value;
      const settings = Store.getSettings();
      settings.reasoningEffort = convo.reasoningEffort;
      Store.setSettings(settings);
      saveConvo();
    });

    els.systemPrompt.addEventListener("input", () => {
      convo.systemPrompt = els.systemPrompt.value;
      renderSystemPromptHint();
      saveConvoDebounced();
    });

    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    els.sendBtn.addEventListener("click", send);
    els.regenBtn.addEventListener("click", regenerateLast);
    els.stopBtn.addEventListener("click", () => abortController?.abort());
  }

  // Regenerate the most recent assistant message (composer shortcut).
  function regenerateLast() {
    if (!ensureReady()) return;
    for (let i = convo.messages.length - 1; i >= 0; i--) {
      if (convo.messages[i].role === "assistant") {
        regenerate(i);
        return;
      }
    }
  }

  // Show the composer regenerate button only when idle and the last message
  // is an assistant reply that can be regenerated.
  function updateRegenButton() {
    const last = convo.messages[convo.messages.length - 1];
    const show = !abortController && last && last.role === "assistant";
    els.regenBtn.classList.toggle("hidden", !show);
  }

  // ---------- persistence helpers ----------

  function saveConvo() {
    Store.saveConversation(convo);
    renderSidebar();
  }

  function saveConvoDebounced() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveConvo, 400);
  }

  // ---------- sidebar ----------

  function renderSidebar() {
    els.convoList.innerHTML = "";
    for (const entry of Store.listConversations()) {
      const item = document.createElement("div");
      item.className = "convo-item" + (entry.id === convo?.id ? " active" : "");

      const title = document.createElement("span");
      title.className = "convo-title";
      title.textContent = entry.title;
      item.appendChild(title);

      const del = document.createElement("button");
      del.className = "convo-delete";
      del.textContent = "✕";
      del.title = "Delete conversation";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${entry.title}"?`)) return;
        Store.deleteConversation(entry.id);
        if (entry.id === convo.id) {
          const index = Store.listConversations();
          convo = index.length ? Store.loadConversation(index[0].id) : Store.createConversation();
          renderConversation();
        }
        renderSidebar();
      });
      item.appendChild(del);

      item.addEventListener("click", () => {
        if (entry.id === convo.id) return;
        convo = Store.loadConversation(entry.id);
        renderSidebar();
        renderConversation();
      });

      item.addEventListener("dblclick", () => startRename(item, title, entry));
      els.convoList.appendChild(item);
    }
  }

  function startRename(item, titleEl, entry) {
    const input = document.createElement("input");
    input.value = entry.title;
    item.replaceChild(input, titleEl);
    input.focus();
    input.select();
    const commit = () => {
      const name = input.value.trim() || entry.title;
      const c = entry.id === convo.id ? convo : Store.loadConversation(entry.id);
      c.title = name;
      Store.saveConversation(c);
      renderSidebar();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") { input.value = entry.title; input.blur(); }
    });
  }

  // ---------- model picker ----------

  function renderModelButton() {
    els.modelBtn.textContent = convo.model || "Select model…";
  }

  function renderModelList(filter) {
    const q = filter.trim().toLowerCase();
    const matches = models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    ).slice(0, 100);
    els.modelList.innerHTML = "";
    for (const m of matches) {
      const item = document.createElement("div");
      item.className = "model-item";
      item.dataset.id = m.id;
      item.innerHTML = `
        <div class="model-id"></div>
        <div class="model-meta">${m.name} · $${m.promptPrice}/M in · $${m.completionPrice}/M out</div>`;
      item.querySelector(".model-id").textContent = m.id;
      item.addEventListener("click", () => selectModel(m.id));
      els.modelList.appendChild(item);
    }
  }

  function selectModel(id) {
    convo.model = id;
    const settings = Store.getSettings();
    settings.defaultModel = id;
    Store.setSettings(settings);
    saveConvo();
    renderModelButton();
    els.modelDropdown.classList.add("hidden");
  }

  // ---------- conversation rendering ----------

  function renderConversation() {
    renderModelButton();
    const effort = convo.reasoningEffort;
    els.reasoningSelect.value =
      [...els.reasoningSelect.options].some((o) => o.value === effort) ? effort : "default";
    els.systemPrompt.value = convo.systemPrompt || "";
    renderSystemPromptHint();
    renderMessages();
  }

  function renderSystemPromptHint() {
    const t = (convo.systemPrompt || "").trim();
    els.systemPromptHint.textContent = t
      ? "— " + t.slice(0, 60).replace(/\s+/g, " ") + (t.length > 60 ? "…" : "")
      : "— empty";
  }

  function renderMessages() {
    els.messages.innerHTML = "";
    if (!convo.messages.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = "<h1>LLM Chat</h1><p>Pick a model, set a system prompt, and start writing.</p>";
      els.messages.appendChild(empty);
      updateRegenButton();
      return;
    }
    convo.messages.forEach((msg, i) => els.messages.appendChild(buildMessageEl(msg, i)));
    updateRegenButton();
    scrollToBottom(true);
  }

  function buildMessageEl(msg, idx) {
    const wrap = document.createElement("div");
    wrap.className = `msg ${msg.role}`;
    wrap.dataset.id = msg.id;

    // Build a fresh toolbar (a DOM node can't live in two places). Shown at
    // both the top-right and bottom-right of the message on hover.
    const makeTools = (position) => {
      const tools = document.createElement("div");
      tools.className = `msg-tools ${position}`;
      tools.appendChild(toolBtn("Copy", () => navigator.clipboard.writeText(msg.content)));
      tools.appendChild(toolBtn("Edit", () => startEdit(wrap, msg, idx)));
      if (msg.role === "assistant") {
        tools.appendChild(toolBtn("Regenerate", () => regenerate(idx)));
      }
      const delBtn = toolBtn("Delete", () => {
        convo.messages.splice(idx, 1);
        saveConvo();
        renderMessages();
      });
      delBtn.classList.add("tool-delete");
      tools.appendChild(delBtn);
      return tools;
    };
    wrap.appendChild(makeTools("top"));

    const inner = document.createElement("div");
    inner.className = "msg-inner";

    const role = document.createElement("div");
    role.className = "msg-role";
    role.textContent = msg.role === "user" ? "You" : "Assistant";
    inner.appendChild(role);

    if (msg.role === "assistant" && msg.reasoning) {
      inner.appendChild(buildThinkingEl(msg, idx));
    }

    const md = document.createElement("div");
    md.className = "md-content";
    md.innerHTML = renderMarkdown(msg.content);
    inner.appendChild(md);

    if (msg.role === "assistant" && msg.usage) {
      inner.appendChild(buildUsageBadge(msg.usage));
    }

    wrap.appendChild(inner);
    wrap.appendChild(makeTools("bottom"));
    return wrap;
  }

  function toolBtn(label, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function buildThinkingEl(msg, idx) {
    const details = document.createElement("details");
    details.className = "thinking";

    const summary = document.createElement("summary");
    summary.textContent = "Thinking";
    const del = document.createElement("button");
    del.className = "thinking-delete";
    del.textContent = "✕";
    del.title = "Delete thinking block";
    del.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      convo.messages[idx].reasoning = null;
      saveConvo();
      renderMessages();
    });
    summary.appendChild(del);
    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "thinking-body";
    body.textContent = msg.reasoning;
    details.appendChild(body);
    return details;
  }

  function buildUsageBadge(u) {
    // Old OpenRouter-era messages stored promptTokens (total incl. cached);
    // CLI usage stores inputTokens as the uncached remainder only.
    const totalIn = u.promptTokens
      ?? (u.inputTokens ?? 0) + (u.cachedTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    const out = u.completionTokens ?? u.outputTokens ?? 0;

    const badge = document.createElement("div");
    badge.className = "usage-badge";
    const cached = u.cachedTokens
      ? ` (<span class="cache-hit">${formatNum(u.cachedTokens)} cached</span>)`
      : "";
    const cost = u.cost != null ? ` · $${u.cost.toFixed(u.cost < 0.01 ? 5 : 4)}` : "";
    badge.innerHTML =
      `↑ ${formatNum(totalIn)}${cached} · ↓ ${formatNum(out)}${cost} · ${u.model}`;
    badge.title =
      `Input tokens (total): ${totalIn}\n` +
      `Cached (read): ${u.cachedTokens ?? 0}\n` +
      (u.cacheWriteTokens ? `Cache write: ${u.cacheWriteTokens}\n` : "") +
      `Output tokens: ${out}\n` +
      (u.cost != null ? `Cost: $${u.cost}\n` : "") +
      `Model: ${u.model}`;
    return badge;
  }

  // ---------- editing ----------

  function startEdit(wrap, msg, idx) {
    const inner = wrap.querySelector(".msg-inner");
    inner.innerHTML = "";

    const area = document.createElement("textarea");
    area.className = "msg-edit-area";
    area.value = msg.content;
    inner.appendChild(area);
    // Grow the textarea to fit its content so no inner scrolling is needed.
    const autosize = () => {
      area.style.height = "auto";
      area.style.height = area.scrollHeight + "px";
    };
    area.addEventListener("input", autosize);
    autosize();

    const buttons = document.createElement("div");
    buttons.className = "msg-edit-buttons";

    const save = (regen) => {
      msg.content = area.value;
      saveConvo();
      renderMessages();
      if (regen) {
        // Regenerate the assistant response that follows this user message,
        // or append a new one if this message is last.
        const next = convo.messages[idx + 1];
        if (next && next.role === "assistant") regenerate(idx + 1);
        else runCompletion();
      }
    };

    buttons.appendChild(toolBtn("Save", () => save(false)));
    if (msg.role === "user") {
      buttons.appendChild(toolBtn("Save & regenerate", () => save(true)));
    }
    buttons.appendChild(toolBtn("Cancel", () => renderMessages()));
    inner.appendChild(buttons);
    area.focus();
  }

  // ---------- sending / streaming ----------

  function ensureReady() {
    if (!convo.model) {
      showBanner("Pick a model first.");
      return false;
    }
    if (abortController) return false; // already streaming
    return true;
  }

  function send() {
    const text = els.input.value.trim();
    if (!text || !ensureReady()) return;

    convo.messages.push(Store.newMessage("user", text));
    if (convo.title === "New chat") {
      convo.title = text.slice(0, 48) + (text.length > 48 ? "…" : "");
    }
    els.input.value = "";
    saveConvo();
    renderMessages();
    runCompletion();
  }

  // Stream a new assistant message appended at the end of the conversation.
  function runCompletion() {
    if (!ensureReady()) return;
    const msg = Store.newMessage("assistant", "");
    convo.messages.push(msg);
    streamInto(msg, convo.messages.length - 1, convo.messages.slice(0, -1));
  }

  // Re-request the assistant message at idx using only the messages before it.
  function regenerate(idx) {
    if (!ensureReady()) return;
    const msg = convo.messages[idx];
    msg.content = "";
    msg.reasoning = null;
    msg.usage = null;
    streamInto(msg, idx, convo.messages.slice(0, idx));
  }

  async function streamInto(msg, idx, contextMessages) {
    abortController = new AbortController();
    setStreamingUI(true);
    renderMessages();

    const wrap = els.messages.querySelector(`.msg[data-id="${msg.id}"]`);
    const inner = wrap.querySelector(".msg-inner");
    const md = inner.querySelector(".md-content");
    md.classList.add("streaming-cursor");

    let thinkingBody = null;
    let lastPaint = 0;
    let lastState = { content: "", reasoning: "" };

    const paint = (state, force = false) => {
      const now = performance.now();
      if (!force && now - lastPaint < 100) return;
      lastPaint = now;
      if (state.reasoning && !thinkingBody) {
        const details = document.createElement("details");
        details.className = "thinking";
        details.open = true;
        details.innerHTML = "<summary>Thinking</summary>";
        thinkingBody = document.createElement("div");
        thinkingBody.className = "thinking-body";
        details.appendChild(thinkingBody);
        inner.insertBefore(details, md);
      }
      if (thinkingBody) thinkingBody.textContent = state.reasoning;
      md.innerHTML = renderMarkdown(state.content);
      scrollToBottom();
    };

    try {
      const result = await Api.streamCompletion({
        request: Api.buildRequest(convo, contextMessages),
        signal: abortController.signal,
        onUpdate: (state) => { lastState = state; paint(state); },
      });
      msg.content = result.content;
      msg.reasoning = result.reasoning || null;
      msg.usage = { ...result.usage, model: convo.model };
      // Remember which history this CC session now represents, so the next
      // plain append can resume it instead of resending the transcript.
      convo.sessionId = result.sessionId;
      convo.sessionHash = Api.fingerprint(
        convo.systemPrompt,
        [...contextMessages, { role: "assistant", content: msg.content }]
      );
    } catch (err) {
      if (err.name === "AbortError") {
        // keep whatever streamed in so far
        msg.content = lastState.content;
        msg.reasoning = lastState.reasoning || null;
        if (!msg.content && !msg.reasoning) {
          const i = convo.messages.indexOf(msg);
          if (i !== -1) convo.messages.splice(i, 1);
        }
      } else {
        showBanner(`Request failed: ${err.message}`);
        if (!msg.content) {
          // remove the empty placeholder
          const i = convo.messages.indexOf(msg);
          if (i !== -1) convo.messages.splice(i, 1);
        }
      }
    } finally {
      abortController = null;
      setStreamingUI(false);
      saveConvo();
      renderMessages();
    }
  }

  function setStreamingUI(streaming) {
    els.sendBtn.classList.toggle("hidden", streaming);
    els.stopBtn.classList.toggle("hidden", !streaming);
    if (streaming) els.regenBtn.classList.add("hidden");
    else updateRegenButton();
  }

  // ---------- misc ----------

  function showBanner(text) {
    document.querySelector(".error-banner")?.remove();
    const banner = document.createElement("div");
    banner.className = "error-banner";

    const msg = document.createElement("div");
    msg.className = "error-text";
    msg.textContent = text;
    banner.appendChild(msg);

    const actions = document.createElement("div");
    actions.className = "error-actions";

    const copy = document.createElement("button");
    copy.textContent = "Copy";
    copy.title = "Copy error to clipboard";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1500);
      } catch {
        copy.textContent = "Copy failed";
      }
    });
    actions.appendChild(copy);

    const dismiss = document.createElement("button");
    dismiss.textContent = "✕";
    dismiss.title = "Dismiss";
    dismiss.addEventListener("click", () => banner.remove());
    actions.appendChild(dismiss);

    banner.appendChild(actions);
    // No auto-dismiss: errors stay until dismissed so they can be copied.
    document.body.appendChild(banner);
  }

  function scrollToBottom(force = false) {
    const el = els.messages;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (force || nearBottom) el.scrollTop = el.scrollHeight;
  }

  function formatNum(n) {
    return (n ?? 0).toLocaleString("en-US");
  }

  init();
})();
