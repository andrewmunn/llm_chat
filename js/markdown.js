// Markdown rendering: marked (parse) + DOMPurify (sanitize).
"use strict";

marked.setOptions({
  gfm: true,
  breaks: true,
});

function renderMarkdown(text) {
  if (!text) return "";
  const html = marked.parse(text);
  return DOMPurify.sanitize(html, {
    // allow target=_blank links to keep working after sanitization
    ADD_ATTR: ["target", "rel"],
  });
}
