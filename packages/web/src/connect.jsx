import React, { useEffect, useState } from 'react';
import { api } from './api.js';

const OS_NAMES = { darwin: 'macOS', linux: 'Linux', windows: 'Windows' };

// The browser half of "run one command, click Connect": install.sh printed
// /connect/<code> and is polling for it. The project binding is picked here,
// explicitly, instead of being inherited from whichever tab was active when
// someone copied an install command.
export function ConnectPage({ code }) {
  const [info, setInfo] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [teams, setTeams] = useState([]);
  const [teamId, setTeamId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [connectedAs, setConnectedAs] = useState('');

  useEffect(() => {
    api.nodeAuthStatus(code)
      .then(r => { if (r.ok) setInfo(r); else setLoadErr(r.error || '找不到这个连接请求'); })
      .catch(e => setLoadErr(e.message));
    api.myTeams().then(r => {
      const list = r.teams || [];
      setTeams(list);
      // Default to the project this browser was last looking at: someone who
      // hit 「安装一台新机器」 from a project's new-chat pane means that project.
      const active = localStorage.getItem('agenthub_active_team');
      if (active && list.some(t => t.id === active)) setTeamId(active);
    }).catch(() => {});
  }, [code]);

  const connect = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.approveNodeAuth(code, teamId || null);
      setConnectedAs(r.id);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const goHome = () => { location.href = '/'; };
  const os = info?.labels?.map(l => OS_NAMES[l] || l).join(' / ');

  let body;
  if (loadErr) {
    body = (
      <>
        <h1>链接无效</h1>
        <p>{loadErr}。请在那台机器上重新运行安装命令,用它新打印的链接。</p>
        <button type="button" onClick={goHome}>打开看板</button>
      </>
    );
  } else if (!info) {
    body = <p>加载中…</p>;
  } else if (connectedAs || info.status === 'approved' || info.status === 'approving') {
    body = (
      <>
        <h1>已连接 ✓</h1>
        <p>
          {connectedAs || info.nodeId
            ? <>这台机器已接入为 <b>{connectedAs || info.nodeId}</b>。</>
            : '这台机器已经被接入。'}
          终端里的安装会自动继续,装好后节点会在看板上变为在线。
        </p>
        <button type="button" onClick={goHome}>打开看板</button>
      </>
    );
  } else if (info.status === 'expired') {
    body = (
      <>
        <h1>链接已过期</h1>
        <p>连接链接 15 分钟内有效。请在那台机器上重新运行安装命令。</p>
        <button type="button" onClick={goHome}>打开看板</button>
      </>
    );
  } else {
    body = (
      <>
        <h1>连接这台机器?</h1>
        <p>连接后,它会作为执行节点出现在你的看板上,可以在上面运行 agent。</p>
        <dl className="connect-machine">
          <dt>主机名</dt><dd>{info.hostname || '—'}</dd>
          <dt>系统用户</dt><dd>{info.user || '—'}</dd>
          {os && <><dt>系统</dt><dd>{os}</dd></>}
          <dt>节点名</dt>
          <dd>
            {info.existingId ? <>{info.existingId}<span className="muted">(之前接入过,如属于你会原地重新接入)</span></> : info.suggestedId}
          </dd>
          <dt>验证码</dt><dd><code>{info.code}</code></dd>
        </dl>
        <label>
          加入
          <select value={teamId} onChange={e => setTeamId(e.target.value)}>
            <option value="">个人(只有你自己能用)</option>
            {teams.map(t => <option key={t.id} value={t.id}>项目:{t.name}(项目成员都能用)</option>)}
          </select>
        </label>
        <p className="muted connect-warning">
          只连接你自己刚刚运行了安装命令的机器。核对一下上面的主机名和终端里显示的验证码是否一致。
        </p>
        {err && <div className="err">{err}</div>}
        <button type="button" disabled={busy} onClick={connect}>{busy ? '连接中…' : '连接'}</button>
        <button type="button" className="ghost" onClick={goHome}>取消</button>
      </>
    );
  }

  return (
    <div className="login-page">
      <div className="login-shell">
        <div className="login-brand">
          <div className="login-brand-row">
            <div className="login-mark" aria-hidden="true">◈</div>
            <div className="login-wordmark">
              <strong>AgentHub</strong>
              <span>添加执行节点</span>
            </div>
          </div>
        </div>
        <div className="login-card connect-card">{body}</div>
      </div>
    </div>
  );
}
