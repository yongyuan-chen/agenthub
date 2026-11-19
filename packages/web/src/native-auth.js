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
