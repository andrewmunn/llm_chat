// localStorage persistence for conversations, settings, and the API key.
"use strict";

const Store = (() => {
  const KEY_SETTINGS = "orchat.settings";
  const KEY_INDEX = "orchat.index";
  const KEY_MODELS = "orchat.models";
  const KEY_CONVO = (id) => `orchat.convo.${id}`;

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---- Settings ----
  const getSettings = () =>
    readJSON(KEY_SETTINGS, { defaultModel: "claude-sonnet-4-6", reasoningEffort: "default" });
  const setSettings = (s) => writeJSON(KEY_SETTINGS, s);

  // ---- Models cache ----
  const getModelsCache = () => readJSON(KEY_MODELS, null);
  const setModelsCache = (models) => writeJSON(KEY_MODELS, { fetchedAt: Date.now(), models });

  // ---- Conversations ----
  const listConversations = () => readJSON(KEY_INDEX, []);

  function saveIndex(index) {
    writeJSON(KEY_INDEX, index);
  }

  function createConversation() {
    const settings = getSettings();
    const convo = {
      id: uid(),
      title: "New chat",
      model: settings.defaultModel,
      systemPrompt: "",
      reasoningEffort: settings.reasoningEffort,
      sessionId: null,    // Claude Code CLI session backing this conversation
      sessionHash: null,  // fingerprint of the history that session represents
      messages: [],
    };
    writeJSON(KEY_CONVO(convo.id), convo);
    const index = listConversations();
    index.unshift({ id: convo.id, title: convo.title, updatedAt: Date.now() });
    saveIndex(index);
    return convo;
  }

  const loadConversation = (id) => readJSON(KEY_CONVO(id), null);

  function saveConversation(convo) {
    writeJSON(KEY_CONVO(convo.id), convo);
    const index = listConversations();
    const entry = index.find((e) => e.id === convo.id);
    if (entry) {
      entry.title = convo.title;
      entry.updatedAt = Date.now();
      index.sort((a, b) => b.updatedAt - a.updatedAt);
    } else {
      index.unshift({ id: convo.id, title: convo.title, updatedAt: Date.now() });
    }
    saveIndex(index);
  }

  function deleteConversation(id) {
    localStorage.removeItem(KEY_CONVO(id));
    saveIndex(listConversations().filter((e) => e.id !== id));
  }

  function newMessage(role, content) {
    return { id: uid(), role, content, reasoning: null, usage: null };
  }

  return {
    getSettings, setSettings,
    getModelsCache, setModelsCache,
    listConversations, createConversation, loadConversation,
    saveConversation, deleteConversation,
    newMessage,
  };
})();
