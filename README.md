# LLM Chat

A frontend-only clone of OpenRouter's chat interface with **aggressive Anthropic prompt caching** — built for long story-writing conversations where you frequently edit and regenerate messages.

No webserver, no build step, no framework. Just open `index.html` in a browser.

## Features

- **Prompt caching** — for `anthropic/*` models, up to 4 `cache_control` breakpoints are placed automatically: the system prompt, the last message, and two slow-moving anchors inside the history. Editing a message near the end still gets a cache *read* at the highest anchor below the edit, so only the suffix is re-processed.
- **Streaming** token-by-token via SSE, with a Stop button.
- **Full message editing** — edit user *and* assistant messages, delete messages, delete thinking blocks, regenerate any assistant message in place.
- **Per-response usage badge** — prompt/completion tokens, cached tokens (cache hits shown in green), exact cost, and the model that produced the response. Hover for a breakdown.
- **Model picker** — searchable, fetched live from OpenRouter's `/models` endpoint with pricing and context length; switchable mid-conversation.
- **Reasoning control** — off/low/medium/high via OpenRouter's unified `reasoning.effort` parameter. Thinking is displayed (and deletable) but never sent back, keeping prompts cache-stable.
- **Multiple conversations** — sidebar with rename (double-click) and delete; everything persists in localStorage.
- **Markdown rendering** via vendored [marked](https://github.com/markedjs/marked), sanitized with [DOMPurify](https://github.com/cure53/DOMPurify).

## Usage

1. Open `index.html` in a browser.
2. Click ⚙ Settings and paste your [OpenRouter API key](https://openrouter.ai/keys) (stored only in localStorage).
3. Pick a model, optionally set a system prompt, and chat.

## Notes

- Conversations and the API key live in your browser's localStorage — clearing site data deletes them.
- Cache reads only occur on Anthropic models within the cache TTL (~5 minutes), so back-to-back turns benefit most.
- The first request after editing the system prompt or switching models is always a full cache miss (prefix-match semantics).
