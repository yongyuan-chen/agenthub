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

// No credential in either form: the installer prints a /connect link and the
// account is chosen by whoever opens it (see node-auth.mjs). That's what lets
// this be the same command for everyone — and safe to paste anywhere.
// nodeId is the repair flow's "re-enroll this exact node" hint.
export function buildNodeInstallCommand({ os, origin, nodeId = '' }) {
  if (os === 'windows') {
    return `${nodeId ? `$env:NODE_ID='${nodeId}'; ` : ''}Write-Host '[install] downloading AgentHub bootstrap...'; $agenthubInstaller = irm ${origin}/install.ps1 -TimeoutSec 60; & ([scriptblock]::Create($agenthubInstaller))`;
  }
  return `curl -fsSL ${origin}/install.sh | ${nodeId ? `NODE_ID=${shQuote(nodeId)} ` : ''}bash`;
}

// The one-liner is the happy path, but it can still fail on a machine with an
// old Node, no git, a proxy in the way, or a service manager that refuses to
// start — situations where the useful next step is to read an error, not to
// re-run the same command. This hands the whole job (including that
// troubleshooting) to a coding agent running on the target machine. The agent
// can't click 连接 for you, so it has to hand the link back.
export function buildNodeInstallPrompt({ os, origin }) {
  const cmd = buildNodeInstallCommand({ os, origin });
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
    'It installs missing dependencies (Node.js, git, the claude/codex CLI) into my user directory, then prints a link like ' + `${origin}/connect/XXXX-XXXX` + ' and waits. Show me that link right away — I will open it and click Connect — and keep the command running until it finishes on its own (the link is valid for 15 minutes). After approval it writes its config and installs a background service that restarts on boot.',
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
