// Markdown rendering with a strict allowlist sanitizer (agent output is
// semi-trusted; never let it inject script/handlers into the board).
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'input', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td',
  'th', 'thead', 'tr', 'ul', 'span', 'div',
]);
const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'class', 'type', 'checked', 'disabled', 'start']);

export function isSafeMarkdownUrl(value, attribute) {
  const raw = String(value || '');
  // Browsers canonicalize ASCII whitespace/control characters inside schemes
  // (e.g. java&#x09;script: -> javascript:). Remove them before URL parsing so
  // validation sees the same effective scheme the browser will execute.
  const compact = [...raw].filter(char => {
    const code = char.charCodeAt(0);
    return code > 0x20 && code !== 0x7f;
  }).join('');
  let url;
  try { url = new URL(compact, 'https://agenthub.invalid/'); } catch { return false; }
  if (url.protocol === 'http:' || url.protocol === 'https:') return true;
  if (attribute === 'href' && url.protocol === 'mailto:') return true;
  if (attribute === 'src' && /^data:image\/(?:png|jpeg|webp);base64,/i.test(compact)) return true;
  return false;
}

function sanitizeNode(node) {
  for (const child of [...node.children]) {
    if (!ALLOWED_TAGS.has(child.tagName.toLowerCase())) {
      child.replaceWith(document.createTextNode(child.textContent || ''));
      continue;
    }
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase();
      if (!ALLOWED_ATTRS.has(name)) { child.removeAttribute(attr.name); continue; }
      if ((name === 'href' || name === 'src') && !isSafeMarkdownUrl(attr.value, name)) child.removeAttribute(attr.name);
    }
    if (child.tagName === 'A') { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer'); }
    sanitizeNode(child);
  }
}

export function renderMarkdown(text) {
  const html = marked.parse(text ?? '');
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  sanitizeNode(root);
  return root.innerHTML;
}
