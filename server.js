#!/usr/bin/env node
// Minimal backend: serves the static frontend and proxies chat requests to
// the Claude Code CLI (`claude -p`), streaming results back as NDJSON.
//
// Usage: node server.js [port]   (default 8741)
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = parseInt(process.argv[2] || "8741", 10);
const ROOT = __dirname;
// Dedicated cwd for claude sessions: keeps project CLAUDE.md / settings out
// of story conversations.
const SESSIONS_DIR = path.join(ROOT, ".claude-sessions");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Curated model list (claude CLI accepts aliases and full names).
// Pricing is per million tokens, informational only — actual cost comes from
// the CLI's result event.
const MODELS = [
  { id: "claude-fable-5",    name: "Claude Fable 5",    promptPrice: 10, completionPrice: 50 },
  { id: "claude-opus-4-8",   name: "Claude Opus 4.8",   promptPrice: 5,  completionPrice: 25 },
  { id: "claude-opus-4-7",   name: "Claude Opus 4.7",   promptPrice: 5,  completionPrice: 25 },
  { id: "claude-opus-4-6",   name: "Claude Opus 4.6",   promptPrice: 5,  completionPrice: 25 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", promptPrice: 3,  completionPrice: 15 },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", promptPrice: 3,  completionPrice: 15 },
  { id: "claude-haiku-4-5",  name: "Claude Haiku 4.5",  promptPrice: 1,  completionPrice: 5 },
];

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

// Env vars that point a nested claude CLI at the wrong API endpoint or
// session. Strip them so the spawned CLI authenticates like a normal
// terminal invocation.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === "ANTHROPIC_BASE_URL" || k === "ANTHROPIC_API_KEY" ||
        k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_EFFORT") {
      delete env[k];
    }
  }
  return env;
}

// Serialize a conversation into a single prompt for fresh sessions
// (used after edits/deletes/regenerates, when no resumable session matches).
const TRANSCRIPT_NOTE =
  "\n\n---\nThe user message you receive contains a conversation transcript. " +
  "Turns are delimited by <user-turn> and <assistant-turn> tags. You are the assistant. " +
  "Write the next assistant reply only — no tags, no role labels, no commentary about the format.";

function serializeTranscript(messages) {
  return messages
    .map((m) => {
      const tag = m.role === "user" ? "user-turn" : "assistant-turn";
      return `<${tag}>\n${m.content}\n</${tag}>`;
    })
    .join("\n\n");
}

// ---------- /api/chat ----------

function handleChat(req, res) {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let params;
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }
    runChat(params, req, res);
  });
}

function runChat(params, req, res) {
  const { model, effort, systemPrompt, mode, messages, sessionId, prompt } = params;

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--tools", "",
    "--setting-sources", "",
  ];
  if (model) args.push("--model", model);
  if (effort && EFFORT_LEVELS.has(effort)) args.push("--effort", effort);

  let stdinPrompt;
  let system = (systemPrompt || "").trim() || "You are a helpful assistant.";

  if (mode === "resume" && sessionId && prompt) {
    args.push("--resume", sessionId);
    stdinPrompt = prompt;
  } else if (Array.isArray(messages) && messages.length === 1 && messages[0].role === "user") {
    // Fresh conversation with a single user message: send it directly.
    stdinPrompt = messages[0].content;
  } else if (Array.isArray(messages) && messages.length > 0) {
    // Fresh session over an edited/diverged history: send the transcript.
    system += TRANSCRIPT_NOTE;
    stdinPrompt = serializeTranscript(messages);
  } else {
    res.writeHead(400).end("no messages");
    return;
  }
  args.push("--system-prompt", system);

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });

  const child = spawn("claude", args, {
    cwd: SESSIONS_DIR,
    env: cleanEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const send = (obj) => {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n");
  };

  let stderrBuf = "";
  let gotResult = false;
  let finalContent = null; // from the complete assistant message event
  let buf = "";

  child.stdin.write(stdinPrompt);
  child.stdin.end();

  child.stderr.on("data", (d) => { stderrBuf += d; });

  child.stdout.on("data", (data) => {
    buf += data;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      handleEvent(ev);
    }
  });

  function handleEvent(ev) {
    switch (ev.type) {
      case "stream_event": {
        const e = ev.event;
        if (e?.type === "content_block_delta") {
          if (e.delta?.type === "text_delta") send({ type: "delta", text: e.delta.text });
          else if (e.delta?.type === "thinking_delta") send({ type: "thinking", text: e.delta.thinking });
        }
        break;
      }
      case "assistant": {
        // Complete message — authoritative content (covers any missed deltas).
        const blocks = ev.message?.content || [];
        finalContent = {
          text: blocks.filter((b) => b.type === "text").map((b) => b.text).join(""),
          thinking: blocks.filter((b) => b.type === "thinking").map((b) => b.thinking).join(""),
        };
        if (ev.error) {
          gotResult = true;
          send({ type: "error", message: finalContent.text || ev.error });
        }
        break;
      }
      case "result": {
        if (gotResult) break; // error already reported from the assistant event
        gotResult = true;
        if (ev.is_error) {
          send({ type: "error", message: ev.result || "Unknown error" });
        } else {
          const u = ev.usage || {};
          send({
            type: "done",
            sessionId: ev.session_id,
            content: finalContent?.text ?? ev.result ?? "",
            thinking: finalContent?.thinking || "",
            usage: {
              inputTokens: u.input_tokens ?? 0,
              cachedTokens: u.cache_read_input_tokens ?? 0,
              cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cost: ev.total_cost_usd ?? null,
            },
          });
        }
        break;
      }
    }
  }

  child.on("close", (code) => {
    if (!gotResult) {
      send({
        type: "error",
        message: `claude exited (${code})${stderrBuf ? ": " + stderrBuf.trim().slice(0, 500) : ""}`,
      });
    }
    res.end();
  });

  child.on("error", (err) => {
    send({ type: "error", message: `failed to start claude CLI: ${err.message}` });
    res.end();
  });

  // Client disconnected (Stop button / closed tab) — kill the CLI.
  // Watch the response side: req "close" fires when the request body is
  // consumed (immediately, under Bun), not when the client goes away.
  res.on("close", () => {
    if (!res.writableEnded && child.exitCode === null) child.kill("SIGTERM");
  });
}

// ---------- static files ----------

function handleStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(ROOT, path.normalize(urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------- server ----------

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
  if (req.method === "GET" && req.url === "/api/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(MODELS));
  }
  if (req.method === "GET") return handleStatic(req, res);
  res.writeHead(405).end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`llm_chat: http://localhost:${PORT}`);
});
