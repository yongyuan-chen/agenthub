import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { api, connectWs, getToken, setToken, clearToken, AuthError, enablePush } from './api.js';
import { state, subscribe, getVersion, applyWsMessage, addMessage, bump } from './store.js';
import { Board } from './board.jsx';
import { TaskDetail } from './task.jsx';

function useStore() {
  return useSyncExternalStore(subscribe, getVersion);
}

function useHashRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const fn = () => setHash(location.hash);
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);
  return hash;
}

function Login({ onOk }) {
  const [token, setTok] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    const res = await api.login(token.trim()).catch(() => ({ ok: false }));
    setBusy(false);
    if (res.ok) { setToken(token.trim()); onOk(); }
    else setErr('Token 无效');
  };
  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>🤖 AgentHub</h1>
        <p>输入访问令牌</p>
        <input type="password" value={token} onChange={e => setTok(e.target.value)} placeholder="access token" autoFocus />
        {err && <div className="err">{err}</div>}
        <button disabled={busy || !token.trim()}>{busy ? '验证中…' : '进入'}</button>
      </form>
    </div>
  );
}

function App() {
  useStore();
  const hash = useHashRoute();
  const [authed, setAuthed] = useState(!!getToken());
  const [pushState, setPushState] = useState(localStorage.getItem('agenthub_push') || 'off');

  useEffect(() => {
    if (!authed) return;
    const ws = connectWs({
      onMessage: applyWsMessage,
      onOpen: () => { state.wsConnected = true; bump(); },
      onClose: () => { state.wsConnected = false; bump(); },
    });
    // REST fallback so a broken WS still shows data.
    api.tasks().then(r => { r.tasks.forEach(t => state.tasks.set(t.id, t)); state.loaded = true; bump(); })
      .catch(e => { if (e instanceof AuthError) { clearToken(); setAuthed(false); } });
    api.nodes().then(r => { r.nodes.forEach(n => state.nodes.set(n.id, n)); bump(); }).catch(() => {});
    return () => ws.close();
  }, [authed]);

  const togglePush = async () => {
    try {
      await enablePush();
      localStorage.setItem('agenthub_push', 'on');
      setPushState('on');
    } catch (e) { alert('开启推送失败:' + e.message); }
  };

  if (!authed) return <Login onOk={() => setAuthed(true)} />;

  const m = hash.match(/^#\/task\/([A-Za-z0-9]+)/);
  if (m) return <TaskDetail taskId={m[1]} />;
  return <Board pushState={pushState} onEnablePush={togglePush} onLogout={() => { clearToken(); setAuthed(false); }} />;
}

createRoot(document.getElementById('root')).render(<App />);
