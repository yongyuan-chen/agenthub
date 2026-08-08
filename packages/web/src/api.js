// REST + WebSocket client for the AgentHub worker.
export const getToken = () => localStorage.getItem('agenthub_token') || '';
export const setToken = (t) => localStorage.setItem('agenthub_token', t);
export const clearToken = () => localStorage.removeItem('agenthub_token');

async function req(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'authorization': `Bearer ${getToken()}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (res.status === 401) throw new AuthError(data.error || 'unauthorized');
  if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export class AuthError extends Error {}

export const api = {
  login: (token) => fetch('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
  }).then(r => r.json()),
  tasks: () => req('GET', '/api/tasks'),
  createTask: (t) => req('POST', '/api/tasks', t),
  messages: (id, afterSeq = 0) => req('GET', `/api/tasks/${id}/messages?after_seq=${afterSeq}&limit=1000`),
  sendMessage: (id, text) => req('POST', `/api/tasks/${id}/message`, { text }),
  decision: (id, requestId, behavior, message) => req('POST', `/api/tasks/${id}/decision`, { requestId, behavior, message }),
  cancel: (id) => req('POST', `/api/tasks/${id}/cancel`, {}),
  markDone: (id) => req('POST', `/api/tasks/${id}/done`, {}),
  lease: (id, lease) => req('POST', `/api/tasks/${id}/lease`, { lease }),
  nodes: () => req('GET', '/api/nodes'),
  vapid: () => req('GET', '/api/vapid'),
  subscribePush: (subscription) => req('POST', '/api/push/subscribe', { subscription }),
};

export function connectWs(handlers) {
  let ws = null;
  let closed = false;
  let backoff = 1000;

  function open() {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/frontend?token=${encodeURIComponent(getToken())}`);
    ws.onopen = () => { backoff = 1000; handlers.onOpen?.(); };
    ws.onmessage = (e) => {
      try { handlers.onMessage(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    ws.onclose = () => {
      handlers.onClose?.();
      if (!closed) setTimeout(open, backoff = Math.min(backoff * 2, 15000));
    };
  }
  open();
  return { close: () => { closed = true; ws?.close(); } };
}

export async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('此浏览器不支持推送');
  const reg = await navigator.serviceWorker.register('/sw.js');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('通知权限被拒绝');
  const { publicKey } = await api.vapid();
  if (!publicKey) throw new Error('服务端未配置 VAPID');
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8Array(publicKey),
  });
  await api.subscribePush(sub.toJSON());
}

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
