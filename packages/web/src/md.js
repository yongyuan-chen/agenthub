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

function sanitizeNode(node) {
  for (const child of [...node.children]) {
    if (!ALLOWED_TAGS.has(child.tagName.toLowerCase())) {
      child.replaceWith(document.createTextNode(child.textContent || ''));
      continue;
    }
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase();
      if (!ALLOWED_ATTRS.has(name)) { child.removeAttribute(attr.name); continue; }
      if ((name === 'href' || name === 'src') && /^\s*(javascript|data|vbscript):/i.test(attr.value)) {
        child.removeAttribute(attr.name);
      }
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
