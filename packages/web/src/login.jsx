import React, { useEffect, useState } from 'react';
import { api, setToken } from './api.js';

export function AuthScreen({ onOk }) {
  const [status, setStatus] = useState(null); // {open, hasUsers} | null while loading
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.registrationStatus().then(s => {
      setStatus(s);
      if (!s.hasUsers) setMode('register'); // first run: nothing to log into yet
    }).catch(() => setStatus({ open: true, hasUsers: true }));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (mode === 'register' && password !== confirm) { setErr('两次密码不一致'); return; }
    setBusy(true);
    try {
      const res = mode === 'register'
        ? await api.register(username.trim(), password)
        : await api.login(username.trim(), password);
      setToken(res.token);
      onOk(res.user);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  const firstRun = status && !status.hasUsers;
  const canRegister = status && (status.open || firstRun);

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>AgentHub</h1>
        {firstRun && <p>还没有账号 — 创建第一个账号(将自动成为管理员)</p>}
        {!firstRun && canRegister && (
          <div className="auth-tabs">
            <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>登录</button>
            <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>注册</button>
          </div>
        )}
        {!firstRun && !canRegister && <p className="muted">登录到你的账号</p>}
        <input value={username} onChange={e => setUsername(e.target.value)} placeholder="用户名" autoFocus autoComplete="username" />
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="密码" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
        {mode === 'register' && (
          <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="确认密码" autoComplete="new-password" />
        )}
        {err && <div className="err">{err}</div>}
        <button disabled={busy || !username.trim() || !password}>
          {busy ? '处理中…' : mode === 'register' ? '创建账号' : '登录'}
        </button>
      </form>
    </div>
  );
}
