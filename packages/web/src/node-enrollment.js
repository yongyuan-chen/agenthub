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

export function buildNodeInstallCommand({ os, origin, token, nodeId = '', teamId = '' }) {
  if (os === 'windows') {
    return `$env:APP_URL='${origin}'; $env:USER_TOKEN='${token}'; ${teamId ? `$env:TEAM_ID='${teamId}'; ` : ''}${nodeId ? `$env:NODE_ID='${nodeId}'; ` : ''}Write-Host '[install] downloading AgentHub bootstrap...'; $agenthubInstaller = irm ${origin}/install.ps1 -TimeoutSec 60; & ([scriptblock]::Create($agenthubInstaller))`;
  }
  return `curl -fsSL ${origin}/install.sh | APP_URL=${shQuote(origin)} USER_TOKEN=${shQuote(token)}${teamId ? ` TEAM_ID=${shQuote(teamId)}` : ''}${nodeId ? ` NODE_ID=${shQuote(nodeId)}` : ''} bash`;
}

// The one-liner is the happy path, but it can still fail on a machine with an
// old Node, no git, a proxy in the way, or a service manager that refuses to
// start — situations where the useful next step is to read an error, not to
// re-run the same command. This hands the whole job (including that
// troubleshooting) to a coding agent running on the target machine.
//
// Deliberately carries the same USER_TOKEN the command does: it has to, or the
// agent cannot enroll anything. The UI warns that this makes it a secret.
export function buildNodeInstallPrompt({ os, origin, token, teamId = '' }) {
  const cmd = buildNodeInstallCommand({ os, origin, token, teamId });
  const shell = os === 'windows' ? 'PowerShell' : 'a terminal';
  const logPath = os === 'windows'
    ? '$env:USERPROFILE\\agenthub\\logs\\executor.log'
    : '~/agenthub/logs/executor.log';
  const svc = os === 'windows'
    ? 'the AgentHubExecutor scheduled task (Get-ScheduledTask AgentHubExecutor)'
    : 'launchd on macOS (launchctl list | grep agenthub) or systemd on Linux (systemctl status agenthub-executor, add --user if it was installed without sudo)';
  return [
    'Install the AgentHub executor daemon on THIS machine, so it shows up as an execution node on my board.',
    '',
    `Run this in ${shell}:`,
    '',
    cmd,
    '',
    'It installs missing dependencies (Node.js, git, the claude/codex CLI) into my user directory, registers this machine, writes its config, and installs a background service that restarts on boot.',
    '',
    'If it fails, do not just re-run it — read the actual error and fix the cause. Most likely:',
    `- Node.js older than 22.5, or missing entirely (the executor needs node:sqlite)`,
    '- git missing',
    `- no network route to ${origin} (check a proxy or firewall; ${os === 'windows' ? `Invoke-RestMethod ${origin}/api/register/status` : `curl -sS ${origin}/api/register/status`} should return ok:true)`,
    `- the service installed but never started — check ${svc}`,
    '',
    'When it finishes, verify before telling me it worked:',
    `- the daemon is running (see the service check above)`,
    `- ${logPath} shows it connected, with no repeating errors`,
    '',
    'Then tell me the node name it registered as. Do not change anything else on this machine.',
  ].join('\n');
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
