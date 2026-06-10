// OpenRouter API: model list, request building (with Anthropic prompt-cache
// breakpoints), and SSE streaming.
"use strict";

const Api = (() => {
  const BASE = "https://openrouter.ai/api/v1";
  const MODELS_TTL_MS = 24 * 60 * 60 * 1000;
  // Anchors only move every ANCHOR_STRIDE messages, so an edit near the end of
  // the conversation still gets a cache read at the highest anchor below it.
  const ANCHOR_STRIDE = 8;

  async function fetchModels(force = false) {
    const cached = Store.getModelsCache();
    if (!force && cached && Date.now() - cached.fetchedAt < MODELS_TTL_MS) {
      return cached.models;
    }
    const resp = await fetch(`${BASE}/models`);
    if (!resp.ok) {
      if (cached) return cached.models;
      throw new Error(`Failed to fetch models (${resp.status})`);
    }
    const data = await resp.json();
    const models = data.data
      .map((m) => ({
        id: m.id,
        name: m.name,
        contextLength: m.context_length,
        promptPrice: parseFloat(m.pricing?.prompt ?? "0"),
        completionPrice: parseFloat(m.pricing?.completion ?? "0"),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    Store.setModelsCache(models);
    return models;
  }

  function isAnthropic(model) {
    return model.startsWith("anthropic/");
  }

  // Build the OpenAI-style messages array. For Anthropic models, attach up to
  // 4 cache_control breakpoints: system prompt, last message, and two
  // slow-moving anchors at multiples of ANCHOR_STRIDE.
  function buildMessages(convo) {
    const cache = isAnthropic(convo.model);
    const msgs = convo.messages;
    const out = [];

    if (convo.systemPrompt.trim()) {
      out.push(
        cache
          ? { role: "system", content: [withCache(convo.systemPrompt)] }
          : { role: "system", content: convo.systemPrompt }
      );
    }

    const breakpoints = new Set();
    if (cache && msgs.length > 0) {
      breakpoints.add(msgs.length - 1);
      let anchor = Math.floor((msgs.length - 2) / ANCHOR_STRIDE) * ANCHOR_STRIDE;
      while (breakpoints.size < 3 && anchor >= 0) {
        breakpoints.add(anchor);
        anchor -= ANCHOR_STRIDE;
      }
    }

    msgs.forEach((m, i) => {
      out.push(
        breakpoints.has(i)
          ? { role: m.role, content: [withCache(m.content)] }
          : { role: m.role, content: m.content }
      );
    });
    return out;
  }

  function withCache(text) {
    return { type: "text", text, cache_control: { type: "ephemeral" } };
  }

  // Stream a chat completion. Calls onUpdate({content, reasoning}) as deltas
  // arrive; resolves with {content, reasoning, usage}.
  async function streamCompletion({ apiKey, model, messages, reasoningEffort, signal, onUpdate }) {
    const body = {
      model,
      messages,
      stream: true,
      usage: { include: true },
    };
    if (reasoningEffort && reasoningEffort !== "off") {
      body.reasoning = { effort: reasoningEffort };
    } else {
      body.reasoning = { enabled: false };
    }

    const resp = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const err = await resp.json();
        detail = err.error?.message || detail;
      } catch { /* non-JSON error body */ }
      throw new Error(detail);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    let usage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data: ")) continue; // SSE comments / blank lines
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;

        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        if (chunk.error) {
          throw new Error(chunk.error.message || "Stream error");
        }
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) content += delta.content;
        if (delta?.reasoning) reasoning += delta.reasoning;
        if (chunk.usage) usage = chunk.usage;
        if (delta?.content || delta?.reasoning) {
          onUpdate({ content, reasoning });
        }
      }
    }

    return { content, reasoning, usage };
  }

  // Normalize OpenRouter's usage object into what we store on the message.
  function normalizeUsage(usage, model) {
    if (!usage) return null;
    return {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens
        ?? usage.prompt_tokens_details?.cache_write_tokens ?? 0,
      cost: usage.cost ?? null,
      model,
    };
  }

  return { fetchModels, buildMessages, streamCompletion, normalizeUsage, isAnthropic };
})();
