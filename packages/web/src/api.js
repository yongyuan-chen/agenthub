// REST + WebSocket client for the AgentHub worker.
import { state } from './store.js';

export const getToken = () => localStorage.getItem('agenthub_token') || '';
export const setToken = (t) => localStorage.setItem('agenthub_token', t);
export const clearToken = () => localStorage.removeItem('agenthub_token');

async function req(method, path, body, options = {}) {
  const { skipTeamHeader = false } = options;
  // Most calls intentionally follow the currently selected project. A few
  // delayed/background writes (layout sync in particular) must stay attached
  // to the scope that produced them even if the user switches projects before
  // fetch() runs, so an explicitly supplied teamId wins over mutable state.
  const teamId = Object.hasOwn(options, 'teamId') ? options.teamId : state.activeTeamId;
  const res = await fetch(path, {
    method,
    headers: {
      'authorization': `Bearer ${getToken()}`,
      ...(teamId && !skipTeamHeader ? { 'x-team-id': teamId } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (res.status === 401) throw new AuthError(data.error || 'unauthorized');
  if (!data.ok) throw new ApiError(data.error || `HTTP ${res.status}`, res.status);
  return data;
}

export class AuthError extends Error {}
export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function anon(path, body) {
  const res = await fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  registrationStatus: () => fetch('/api/register/status').then(r => r.json()),
  register: (username, password) => anon('/api/register', { username, password }),
  login: (username, password) => anon('/api/login', { username, password }),
  logout: () => req('POST', '/api/logout', {}).catch(() => {}),
  me: () => req('GET', '/api/me'),
  getSettings: () => req('GET', '/api/settings'),
  saveSettings: (settings) => req('POST', '/api/settings', settings),
  recentRepos: () => req('GET', '/api/recent-repos'),
  browseNode: (nodeId, path) => req('GET', `/api/nodes/${nodeId}/browse?path=${encodeURIComponent(path)}`),
  // File browser. taskId with no path asks the node to start in that task's
  // own working directory — only it knows the worktree path.
  listNodeFiles: (nodeId, path = '', taskId = '') =>
    req('GET', `/api/nodes/${nodeId}/files?path=${encodeURIComponent(path)}&taskId=${encodeURIComponent(taskId)}`),
  readNodeFile: (nodeId, path) =>
    req('GET', `/api/nodes/${nodeId}/file?path=${encodeURIComponent(path)}`),
  writeNodeFile: (nodeId, path, content, expectedMtime) =>
    req('POST', `/api/nodes/${nodeId}/file`, { path, content, expectedMtime }),
  listNodeSessions: (nodeId, path) => req('GET', `/api/nodes/${nodeId}/sessions?path=${encodeURIComponent(path)}`),
  switchSession: (taskId, sessionId) => req('POST', `/api/tasks/${taskId}/switch-session`, { sessionId }),
  switchModel: (taskId, modelProfileId) => req('POST', `/api/tasks/${taskId}/switch-model`, { modelProfileId }),
  getLayout: () => req('GET', '/api/layout'),
  saveLayout: (panes, teamId = state.activeTeamId) => req('POST', '/api/layout', { panes }, { teamId }),
  modelProfiles: () => req('GET', '/api/model-profiles'),
  createModelProfile: (p) => req('POST', '/api/model-profiles', p),
  updateModelProfile: (id, p) => req('PUT', `/api/model-profiles/${id}`, p),
  deleteModelProfile: (id) => req('DELETE', `/api/model-profiles/${id}`),
  setDefaultModelProfile: (id) => req('POST', `/api/model-profiles/${id}/set-default`),
  fetchModelList: (baseUrl, apiKey) => req('POST', '/api/fetch-models', { baseUrl, apiKey }),
  adminCreateUser: (username, password) => req('POST', '/api/admin/users', { username, password }),
  adminSetRegistration: (open) => req('POST', '/api/admin/registration', { open }),
  adminTeams: () => req('GET', '/api/admin/teams'),
  adminCreateTeam: (name) => req('POST', '/api/admin/teams', { name }),
  adminDeleteTeam: (id) => req('DELETE', `/api/admin/teams/${id}`),
  adminAddTeamMember: (teamId, username, role) => req('POST', `/api/admin/teams/${teamId}/members`, { username, role }),
  adminRemoveTeamMember: (teamId, userId) => req('DELETE', `/api/admin/teams/${teamId}/members/${userId}`),
  adminUsers: () => req('GET', '/api/admin/users'),
  adminDisableUser: (id) => req('POST', `/api/admin/users/${id}/disable`),
  adminEnableUser: (id) => req('POST', `/api/admin/users/${id}/enable`),
  adminResetPassword: (id, password) => req('POST', `/api/admin/users/${id}/reset-password`, { password }),
  adminToggleAdmin: (id) => req('POST', `/api/admin/users/${id}/toggle-admin`),
  adminOverview: () => req('GET', '/api/admin/overview'),
  myTeams: () => req('GET', '/api/teams'),
  createTeam: (name) => req('POST', '/api/teams', { name }),
  projectMembers: (teamId) => req('GET', `/api/teams/${teamId}/members`),
  addProjectMember: (teamId, username) => req('POST', `/api/teams/${teamId}/members`, { username }),
  removeProjectMember: (teamId, userId) => req('DELETE', `/api/teams/${teamId}/members/${userId}`),
  tasks: () => req('GET', '/api/tasks'),
  // Unread counts for every scope at once (see hub-core's /api/unread) — not
  // scope-filtered, so deliberately sent without the X-Team-Id header.
  unread: () => req('GET', '/api/unread', undefined, { skipTeamHeader: true }),
  markTaskSeen: (id) => req('POST', `/api/tasks/${id}/seen`),
  conversationSources: () => req('GET', '/api/conversation-sources'),
  conversationSourceHistory: (id, { cursor = null, details = false } = {}) => {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    if (details) params.set('details', '1');
    return req('GET', `/api/conversation-sources/${id}/history${params.size ? `?${params}` : ''}`);
  },
  activateConversationSource: (id, text) => req('POST', `/api/conversation-sources/${id}/activate`, { text }),
  getTask: (id) => req('GET', `/api/tasks/${id}`),
  createTask: (t) => req('POST', '/api/tasks', t),
  messages: (id, afterSeq = 0) => req('GET', `/api/tasks/${id}/messages?after_seq=${afterSeq}&limit=1000`),
  // clientMessageId makes the send durable and idempotent end-to-end: the
  // cloud stores it before answering, keeps redelivering until the node
  // echoes that same id back, and collapses a retry of the same id onto the
  // one message instead of sending it twice. See hub-core's outbound_messages.
  // queue=false means "send it into the running turn anyway" (关闭排队);
  // omitted defaults to queueing on the server, so an older cached frontend
  // keeps the behaviour it was written against.
  sendMessage: (id, text, images, clientMessageId, queue = true) =>
    req('POST', `/api/tasks/${id}/message`, { text, clientMessageId, queue, ...(images?.length ? { images } : {}) }),
  retryMessage: (id, clientMessageId) => req('POST', `/api/tasks/${id}/retry-message`, { clientMessageId }),
  editQueuedMessage: (id, clientMessageId, text) =>
    req('POST', `/api/tasks/${id}/queued-message`, { clientMessageId, text }),
  // 直接发送 — release this one held message into the running turn now,
  // without changing the conversation's queueing preference.
  sendQueuedMessageNow: (id, clientMessageId) =>
    req('POST', `/api/tasks/${id}/queued-message`, { clientMessageId, sendNow: true }),
  // The id goes in the path, not a body: the worker only parses JSON for
  // POST/PUT, so a DELETE body is silently dropped (it reads query params
  // instead). Same shape as the other DELETE routes here.
  cancelQueuedMessage: (id, clientMessageId) =>
    req('DELETE', `/api/tasks/${id}/queued-message/${encodeURIComponent(clientMessageId)}`),
  decision: (id, requestId, behavior, message, updatedInput, autoApprove, forceAll) =>
    req('POST', `/api/tasks/${id}/decision`, { requestId, behavior, message, updatedInput, autoApprove, forceAll }),
  cancel: (id) => req('POST', `/api/tasks/${id}/cancel`, {}),
  retryTask: (id, opts) => req('POST', `/api/tasks/${id}/retry`, opts || {}),
  resyncSession: (id) => req('POST', `/api/tasks/${id}/resync`, {}),
  markDone: (id) => req('POST', `/api/tasks/${id}/done`, {}),
  lease: (id, lease) => req('POST', `/api/tasks/${id}/lease`, { lease }),
  archiveTask: (id) => req('POST', `/api/tasks/${id}/archive`, {}),
  unarchiveTask: (id) => req('POST', `/api/tasks/${id}/unarchive`, {}),
  renameTask: (id, title) => req('POST', `/api/tasks/${id}/rename`, { title }),
  addTaskTeam: (id, teamId) => req('POST', `/api/tasks/${id}/teams/${teamId}`),
  removeTaskTeam: (id, teamId) => req('DELETE', `/api/tasks/${id}/teams/${teamId}`),
  nodes: () => req('GET', '/api/nodes'),
  // Always your personal-scope node list, regardless of the currently active
  // project tab — used by NodeManageModal so you can see (and assign) every
  // node you own while managing a specific project's bindings, not just
  // whichever ones already happen to be bound to it.
  myNodes: () => req('GET', '/api/nodes', undefined, { skipTeamHeader: true }),
  addNodeTeam: (id, teamId) => req('POST', `/api/nodes/${id}/teams/${teamId}`),
  removeNodeTeam: (id, teamId) => req('DELETE', `/api/nodes/${id}/teams/${teamId}`),
  renameNode: (id, name) => req('POST', `/api/nodes/${id}/rename`, { name }),
  vapid: () => req('GET', '/api/vapid'),
  subscribePush: (subscription) => req('POST', '/api/push/subscribe', { subscription }),
};

export function connectWs(handlers) {
  let ws = null;
  let closed = false;
  let backoff = 1000;
  let switching = false; // deliberate team-switch reconnect, skip the backoff delay
  let generation = 0;

  function open() {
    if (closed) return;
    const currentGeneration = ++generation;
    const capturedTeamId = state.activeTeamId;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const teamParam = capturedTeamId ? `&teamId=${encodeURIComponent(capturedTeamId)}` : '';
    const socket = new WebSocket(`${proto}://${location.host}/ws/frontend?token=${encodeURIComponent(getToken())}${teamParam}`);
    ws = socket;
    socket.onopen = () => {
      if (generation !== currentGeneration || ws !== socket) return;
      backoff = 1000; handlers.onOpen?.();
    };
    socket.onmessage = (e) => {
      if (generation !== currentGeneration || ws !== socket || state.activeTeamId !== capturedTeamId) return;
      try { handlers.onMessage(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    socket.onclose = () => {
      if (generation !== currentGeneration || ws !== socket) return;
      handlers.onClose?.();
      if (closed) return;
      if (switching) { switching = false; open(); return; }
      setTimeout(open, backoff = Math.min(backoff * 2, 15000));
    };
  }
  open();
  return {
    close: () => { closed = true; ws?.close(); },
    // Switching the active team needs a fresh connection tagged for the new
    // scope (see hub.mjs's fe:team:${teamId} vs fe:${userId} socket tags) —
    // reuses the same reconnect machinery but skips the backoff delay since
    // this is a deliberate user action, not a dropped connection.
    reconnect: () => { switching = true; try { ws?.close(); } catch { /* already dead */ } },
  };
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
