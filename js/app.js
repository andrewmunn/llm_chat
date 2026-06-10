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
    settingsBtn: $("#settings-btn"),
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
    stopBtn: $("#stop-btn"),
    settingsModal: $("#settings-modal"),
    apiKeyInput: $("#api-key-input"),
    settingsSave: $("#settings-save"),
    settingsCancel: $("#settings-cancel"),
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

    if (!Store.getApiKey()) openSettings();
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

    els.settingsBtn.addEventListener("click", openSettings);
    els.settingsSave.addEventListener("click", () => {
      Store.setApiKey(els.apiKeyInput.value);
      els.settingsModal.classList.add("hidden");
    });
    els.settingsCancel.addEventListener("click", () => {
      els.settingsModal.classList.add("hidden");
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
    els.stopBtn.addEventListener("click", () => abortController?.abort());
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
      const inPrice = (m.promptPrice * 1e6).toFixed(2);
      const outPrice = (m.completionPrice * 1e6).toFixed(2);
      item.innerHTML = `
        <div class="model-id"></div>
        <div class="model-meta">$${inPrice}/M in · $${outPrice}/M out · ${formatNum(m.contextLength)} ctx</div>`;
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
    els.reasoningSelect.value = convo.reasoningEffort || "off";
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
      return;
    }
    convo.messages.forEach((msg, i) => els.messages.appendChild(buildMessageEl(msg, i)));
    scrollToBottom(true);
  }

  function buildMessageEl(msg, idx) {
    const wrap = document.createElement("div");
    wrap.className = `msg ${msg.role}`;
    wrap.dataset.id = msg.id;

    const tools = document.createElement("div");
    tools.className = "msg-tools";
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
    wrap.appendChild(tools);

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
    const badge = document.createElement("div");
    badge.className = "usage-badge";
    const cached = u.cachedTokens
      ? ` (<span class="cache-hit">${formatNum(u.cachedTokens)} cached</span>)`
      : "";
    const cost = u.cost != null ? ` · $${u.cost.toFixed(u.cost < 0.01 ? 5 : 4)}` : "";
    badge.innerHTML =
      `↑ ${formatNum(u.promptTokens)}${cached} · ↓ ${formatNum(u.completionTokens)}${cost} · ${u.model}`;
    badge.title =
      `Prompt tokens: ${u.promptTokens}\n` +
      `Cached (read): ${u.cachedTokens}\n` +
      (u.cacheWriteTokens ? `Cache write: ${u.cacheWriteTokens}\n` : "") +
      `Completion tokens: ${u.completionTokens}\n` +
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
    if (!Store.getApiKey()) {
      openSettings();
      return false;
    }
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
        apiKey: Store.getApiKey(),
        model: convo.model,
        messages: Api.buildMessages({ ...convo, messages: contextMessages }),
        reasoningEffort: convo.reasoningEffort,
        signal: abortController.signal,
        onUpdate: (state) => { lastState = state; paint(state); },
      });
      msg.content = result.content;
      msg.reasoning = result.reasoning || null;
      msg.usage = Api.normalizeUsage(result.usage, convo.model);
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
  }

  // ---------- misc ----------

  function openSettings() {
    els.apiKeyInput.value = Store.getApiKey();
    els.settingsModal.classList.remove("hidden");
    els.apiKeyInput.focus();
  }

  function showBanner(text) {
    document.querySelector(".error-banner")?.remove();
    const banner = document.createElement("div");
    banner.className = "error-banner";
    banner.textContent = text;
    banner.addEventListener("click", () => banner.remove());
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 8000);
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
