# LLM Chat

A local chat UI for story writing, backed by the **Claude Code CLI** (`claude -p`) — so usage draws from your Claude subscription's included API credits instead of a pay-as-you-go key. Built for long conversations where you frequently edit and regenerate messages.

One tiny zero-dependency Node server; plain HTML/CSS/JS frontend; everything persists in your browser's localStorage.

## Usage

```sh
bun server.js           # or: node server.js — then open http://localhost:8741
```

Requirements: Bun or Node.js, and the [Claude Code CLI](https://claude.com/claude-code) installed and logged in (`claude auth status` should show your subscription).

The server auto-locates the `claude` binary (PATH plus common install dirs like `~/.local/bin`). If it can't find it — e.g. you launched the server from an environment with a minimal PATH — set `CLAUDE_BIN` to the full path (`which claude` shows it):

```sh
CLAUDE_BIN=/path/to/claude bun server.js
```

## Features

- **Subscription-billed** — the server shells out to `claude -p`, which authenticates the same way your terminal `claude` does. No API key in the app.
- **Cheap appends via session resume** — each conversation is backed by a Claude Code session. Sending a new message resumes that session (`--resume`), so only the new message is uploaded and Claude Code's built-in prompt caching applies to the whole history. Editing/deleting/regenerating diverges from the session, so the next request transparently starts a fresh one from the serialized transcript — correct, just a one-time cache rebuild.
- **Streaming** token-by-token (`--output-format stream-json --include-partial-messages`), with a Stop button that kills the CLI process.
- **Full message editing** — edit user *and* assistant messages, delete messages, delete thinking blocks, regenerate any assistant message in place.
- **Per-response usage badge** — total input tokens, cached tokens (green), output tokens, and the CLI-reported cost. Hover for the breakdown including cache writes.
- **Model picker** — current Claude models (Fable 5, Opus 4.8/4.7/4.6, Sonnet 4.6/4.5, Haiku 4.5), switchable mid-conversation.
- **Effort control** — Default/Low/Medium/High/X-High/Max via `claude --effort`.
- **Multiple conversations** — sidebar with rename (double-click) and delete.
- **Markdown rendering** via vendored [marked](https://github.com/markedjs/marked), sanitized with [DOMPurify](https://github.com/cure53/DOMPurify).
- **No tools** — the CLI runs with `--tools ""` and an isolated working directory (`.claude-sessions/`), so chats are pure conversation: no file access, no CLAUDE.md pickup.

## Reading the usage badge

The total input count looks large (~26k) because every request includes Claude Code's base system prompt — but that prefix is a **shared cache read** (~0.1× price) across *all* conversations, shown in green. What matters is the `$` figure and the non-cached remainder. Your system prompt is deliberately delivered inside the conversation's first message rather than via `--system-prompt`: any custom system-prompt flag switches the CLI to its full ~14k prompt *and* makes the whole thing a per-conversation cache entry, costing ~20k token-equivalents extra per new conversation. Measured behavior (Haiku): a resumed turn writes only ~80 uncached tokens; even a post-edit rebuild writes only the transcript itself.

## How session reuse works

The conversation stores `{sessionId, sessionHash}` where the hash fingerprints the message history the CC session represents.

- **Append** (the common case): history unchanged since the last reply → `--resume <sessionId>` with just the new message. Fast and cache-friendly.
- **Edit / delete / regenerate**: hash no longer matches → fresh session; the prior conversation is sent as a tagged transcript in the first prompt, and subsequent appends resume the *new* session.
- **System prompt edits** also re-fingerprint (the prompt lives in the session's first message), so they trigger the same one-time rebuild.

The usage badge makes this visible: resumed turns show most input tokens in green (`cached`).

## Notes

- Conversations live in localStorage; the CLI also persists its own session transcripts under `~/.claude/projects/`.
- The displayed cost is what the API call *would* cost — with subscription auth it draws from your included credits.
- The server binds to `127.0.0.1` only.
