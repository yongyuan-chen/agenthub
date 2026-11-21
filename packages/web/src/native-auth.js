// How a node's CLI is logged in / configured on its own, as reported by the
// executor (native-auth.mjs) — turned into words for the 「本机账号」 hints.
export const BACKEND_LABELS = { claude: 'Claude Code', codex: 'Codex' };

export function nativeAuthLabel(backend, info) {
  if (!info) return '未检测到';
  if (!info.loggedIn) return '未登录';
  if (backend === 'codex') {
    if (info.customProvider) return `config.toml 里的 provider「${info.customProvider}」`;
    if (info.method === 'chatgpt') return 'ChatGPT 账号登录';
    if (info.method === 'api_key') return 'OpenAI API Key 登录';
    return '已登录';
  }
  if (info.provider === 'bedrock') return 'AWS Bedrock';
  if (info.provider === 'vertex') return 'Google Vertex';
  // A relay configured on the machine itself (ANTHROPIC_BASE_URL in the
  // shell or settings.json) — its token reads as "oauth_token" otherwise.
  if (info.customEndpoint) return '自定义 API 地址(ANTHROPIC_BASE_URL)';
  if (info.method === 'claude.ai') return 'Claude 官方账号登录';
  if (info.method === 'oauth_token') return 'Claude 官方账号(长期 token)';
  if (info.method === 'api_key' || info.source) return `API Key${info.source ? `(${info.source})` : ''}`;
  return info.method || '已登录';
}

// What a 「本机账号」 conversation can switch between: the official models,
// by the exact IDs the CLI accepts in ANTHROPIC_MODEL. '' = whatever the CLI
// itself defaults to for that login. Not every plan includes every model —
// the CLI says so in the conversation if one isn't available.
export const NATIVE_MODELS = {
  claude: [
    { id: '', label: '默认' },
    { id: 'claude-fable-5-2', label: 'Fable 5.2' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  ],
  codex: [{ id: '', label: '默认' }],
};

export function nativeModelLabel(backend, model) {
  return (NATIVE_MODELS[backend] || []).find(m => m.id === (model || ''))?.label || model;
}

// Which of a node's CLIs can run on its own login for this user: only the
// node's owner (it's their account), and only what's actually logged in.
export function nativeBackendsFor(node, userId) {
  if (!node || !userId || node.owner_user_id !== userId || !node.nativeAuth) return [];
  return Object.keys(BACKEND_LABELS).filter(b => node.nativeAuth[b]?.loggedIn);
}

// The "API vs 账号直连" badge's words and hover text, shared by the new-chat
// pane and the conversation header so the two can't describe it differently.
export function authModeOf(native, baseUrl = '') {
  if (native) return { cls: 'auth-native', text: '账号直连', title: '用这台机器上已登录的官方账号直连(订阅 / 官方登录 / 机器自己的配置),不经过中转站' };
  let host = '';
  try { host = baseUrl ? new URL(baseUrl).host : ''; } catch { host = baseUrl; }
  return { cls: 'auth-api', text: 'API', title: `通过 API Key 调用${host ? `(${host})` : '(账户默认中转站)'}` };
}
