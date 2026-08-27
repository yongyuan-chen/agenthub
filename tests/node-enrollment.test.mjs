import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNodeInstallCommand,
  enrollmentNeedsAcknowledgement,
  nodeDisplayName,
  nodeEnrollmentMode,
  nodeIdValidationError,
  nodeLabels,
  nodeProjectLabels,
  nodeRepairCommands,
} from '../packages/web/src/node-enrollment.js';

const nodes = [
  { id: 'gpu31', name: 'A100 训练机', labels: '["linux","a100"]', teamIds: ['team-a', 'missing-team'] },
  { id: 'Case-Sensitive', name: '', labels: 'legacy-invalid-json', teamIds: [] },
];

test('node enrollment: exact owned ID is an acknowledged repair', () => {
  const mode = nodeEnrollmentMode('  gpu31  ', nodes);
  assert.equal(mode.kind, 'repair-owned');
  assert.equal(mode.nodeId, 'gpu31');
  assert.equal(mode.matchingNode, nodes[0]);
  assert.equal(enrollmentNeedsAcknowledgement(mode), true);
});

test('node enrollment: matching stays case-sensitive', () => {
  const mode = nodeEnrollmentMode('case-sensitive', nodes);
  assert.deepEqual(mode, { kind: 'new-explicit-id', nodeId: 'case-sensitive' });
  assert.equal(enrollmentNeedsAcknowledgement(mode), false);
});

test('node enrollment: explicit unknown ID is a normal new node', () => {
  const mode = nodeEnrollmentMode('new-server', nodes);
  assert.deepEqual(mode, { kind: 'new-explicit-id', nodeId: 'new-server' });
  assert.equal(enrollmentNeedsAcknowledgement(mode), false);
});

test('node enrollment: blank ID is derived on target and requires acknowledgement', () => {
  const mode = nodeEnrollmentMode('   ', nodes);
  assert.deepEqual(mode, { kind: 'new-derived-id', nodeId: '' });
  assert.equal(enrollmentNeedsAcknowledgement(mode), true);
});

test('node enrollment: URLs and shell-hostile IDs are rejected before command generation', () => {
  assert.equal(
    nodeIdValidationError(nodeEnrollmentMode('https://claudecode.yun:8081', nodes).nodeId),
    '这里应填写节点 ID，不能填写模型中转站或其他网址。',
  );
  assert.equal(
    nodeIdValidationError(nodeEnrollmentMode('https://legacy-node.example', [{ id: 'https://legacy-node.example' }]).nodeId),
    '这里应填写节点 ID，不能填写模型中转站或其他网址。',
    'even a legacy owned URL-shaped node cannot be repaired from the Add Node flow',
  );
  assert.match(nodeIdValidationError(nodeEnrollmentMode('bad id/with spaces', nodes).nodeId), /只能包含/);
  assert.equal(nodeIdValidationError(nodeEnrollmentMode('gpu31', nodes).nodeId), '', 'an owned ID remains valid for explicit repair');
  assert.equal(nodeIdValidationError(nodeEnrollmentMode('new_gpu.server-2', nodes).nodeId), '');
  assert.equal(nodeIdValidationError(nodeEnrollmentMode('', nodes).nodeId), '', 'blank keeps the installer-derived-ID path');
});

test('node enrollment: presentation helpers have honest legacy fallbacks', () => {
  const teamNames = new Map([['team-a', '量化项目']]);
  assert.equal(nodeDisplayName(nodes[0]), 'A100 训练机');
  assert.equal(nodeDisplayName(nodes[1]), 'Case-Sensitive');
  assert.deepEqual(nodeLabels(nodes[0]), ['linux', 'a100']);
  assert.deepEqual(nodeLabels(nodes[1]), []);
  assert.deepEqual(nodeProjectLabels(nodes[0], teamNames), ['量化项目', 'missing-team']);
  assert.deepEqual(nodeProjectLabels(nodes[1], teamNames), ['个人']);
});

test('node enrollment: add and repair flows share the same command builder', () => {
  assert.equal(
    buildNodeInstallCommand({
      os: 'unix', origin: 'https://agenthub.win', token: "tok'en", nodeId: 'gpu31', teamId: 'team-a',
    }),
    "curl -fsSL https://agenthub.win/install.sh | APP_URL='https://agenthub.win' USER_TOKEN='tok'\\''en' TEAM_ID='team-a' NODE_ID='gpu31' bash",
  );
  assert.equal(
    buildNodeInstallCommand({ os: 'windows', origin: 'https://agenthub.win', token: 'token', nodeId: 'gpu31' }),
    "$env:APP_URL='https://agenthub.win'; $env:USER_TOKEN='token'; $env:NODE_ID='gpu31'; Write-Host '[install] downloading AgentHub bootstrap...'; $agenthubInstaller = irm https://agenthub.win/install.ps1 -TimeoutSec 60; & ([scriptblock]::Create($agenthubInstaller))",
  );
});

test('node enrollment: Windows one-liner gives immediate progress and bounds bootstrap download time', () => {
  const command = buildNodeInstallCommand({
    os: 'windows', origin: 'https://agenthub.win', token: 'token', teamId: 'project-id',
  });
  assert.match(command, /Write-Host '\[install\] downloading AgentHub bootstrap\.\.\.'/);
  assert.match(command, /irm https:\/\/agenthub\.win\/install\.ps1 -TimeoutSec 60/);
  assert.match(command, /\[scriptblock\]::Create\(\$agenthubInstaller\)/);
  assert.doesNotMatch(command, /\| iex/);
});

test('node repair: every Windows instruction is directly executable in PowerShell', () => {
  const commands = nodeRepairCommands({ labels: '["windows"]' }, 'https://agenthub.win');
  assert.equal(commands.os, 'windows');
  assert.equal(commands.shell, 'PowerShell');
  assert.equal(commands.connectivity, "(Invoke-RestMethod 'https://agenthub.win/api/register/status').ok");
  assert.equal(commands.connectivityExpected, '应返回 True');
  assert.match(commands.restart, /Enable-ScheduledTask/);
  assert.match(commands.restart, /Start-ScheduledTask/);
  assert.equal(commands.logs, 'Get-Content "$env:USERPROFILE\\agenthub\\logs\\executor.log" -Tail 50');
  for (const command of [commands.connectivity, commands.restart, commands.logs]) {
    assert.doesNotMatch(command, /\bcurl\b|%USERPROFILE%|\btype\s/i);
  }
});

test('node repair: Unix instructions retain platform-specific supervisors and logs', () => {
  const mac = nodeRepairCommands({ labels: '["darwin"]' }, 'https://agenthub.win');
  assert.equal(mac.restart, 'launchctl kickstart -k gui/$(id -u)/com.agenthub.executor');
  assert.equal(mac.logs, 'tail -50 ~/agenthub/logs/executor.log');
  assert.match(mac.connectivity, /^curl /);

  const linux = nodeRepairCommands({ labels: '["linux"]' }, 'https://agenthub.win');
  assert.match(linux.restart, /systemctl restart agenthub-executor/);
  assert.match(linux.logs, /journalctl -u agenthub-executor/);
  assert.match(linux.connectivity, /^curl /);
});
