const shQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";

export function nodeDisplayName(node) {
  return String(node?.name || '').trim() || String(node?.id || '');
}

export function nodeLabels(node) {
  try {
    const labels = JSON.parse(node?.labels || '[]');
    return Array.isArray(labels) ? labels : [];
  } catch {
    return [];
  }
}

export function nodeProjectLabels(node, teamNames = new Map()) {
  const teamIds = Array.isArray(node?.teamIds) ? node.teamIds : [];
  return teamIds.length ? teamIds.map(id => teamNames.get(id) || id) : ['个人'];
}

export function nodeEnrollmentMode(nodeId, ownedNodes = []) {
  const trimmedId = String(nodeId || '').trim();
  if (!trimmedId) return { kind: 'new-derived-id', nodeId: '' };
  const matchingNode = ownedNodes.find(node => node.id === trimmedId);
  return matchingNode
    ? { kind: 'repair-owned', nodeId: trimmedId, matchingNode }
    : { kind: 'new-explicit-id', nodeId: trimmedId };
}

export function enrollmentNeedsAcknowledgement(enrollment) {
  return enrollment.kind !== 'new-explicit-id';
}

export function nodeIdValidationError(nodeId) {
  if (!nodeId) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(nodeId)) {
    return '这里应填写节点 ID，不能填写模型中转站或其他网址。';
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeId)) {
    return '节点 ID 只能包含英文字母、数字、点、下划线和短横线，且最长 128 个字符。';
  }
  return '';
}

export function buildNodeInstallCommand({ os, origin, token, nodeId = '', teamId = '' }) {
  if (os === 'windows') {
    return `$env:APP_URL='${origin}'; $env:USER_TOKEN='${token}'; ${teamId ? `$env:TEAM_ID='${teamId}'; ` : ''}${nodeId ? `$env:NODE_ID='${nodeId}'; ` : ''}Write-Host '[install] downloading AgentHub bootstrap...'; $agenthubInstaller = irm ${origin}/install.ps1 -TimeoutSec 60; & ([scriptblock]::Create($agenthubInstaller))`;
  }
  return `curl -fsSL ${origin}/install.sh | APP_URL=${shQuote(origin)} USER_TOKEN=${shQuote(token)}${teamId ? ` TEAM_ID=${shQuote(teamId)}` : ''}${nodeId ? ` NODE_ID=${shQuote(nodeId)}` : ''} bash`;
}

export function nodeRepairCommands(node, origin) {
  const labels = nodeLabels(node);
  if (labels.includes('windows')) {
    return {
      os: 'windows',
      shell: 'PowerShell',
      connectivity: `(Invoke-RestMethod '${origin}/api/register/status').ok`,
      connectivityExpected: '应返回 True',
      restart: 'Stop-ScheduledTask -TaskName AgentHubExecutor -ErrorAction SilentlyContinue; Enable-ScheduledTask -TaskName AgentHubExecutor; Start-ScheduledTask -TaskName AgentHubExecutor',
      logs: 'Get-Content "$env:USERPROFILE\\agenthub\\logs\\executor.log" -Tail 50',
    };
  }
  if (labels.includes('darwin')) {
    return {
      os: 'unix',
      shell: '终端',
      connectivity: `curl -sS ${origin}/api/register/status`,
      connectivityExpected: '返回内容应包含 "ok":true',
      restart: 'launchctl kickstart -k gui/$(id -u)/com.agenthub.executor',
      logs: 'tail -50 ~/agenthub/logs/executor.log',
    };
  }
  return {
    os: 'unix',
    shell: '终端',
    connectivity: `curl -sS ${origin}/api/register/status`,
    connectivityExpected: '返回内容应包含 "ok":true',
    restart: 'systemctl restart agenthub-executor(无 sudo 安装的用:systemctl --user restart agenthub-executor)',
    logs: 'journalctl -u agenthub-executor -n 50(用户级服务加 --user)',
  };
}
