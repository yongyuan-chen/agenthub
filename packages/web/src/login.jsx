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
      <div className="login-shell">
        <div className="login-brand">
          <div className="login-brand-row">
            <div className="login-mark" aria-hidden="true">◈</div>
            <div className="login-wordmark">
              <strong>AgentHub</strong>
              <span>自托管编码中枢</span>
            </div>
          </div>
          <div className="login-tagline">把你的每一台机器变成随时待命的编码 agent</div>
        </div>
        <form className="login-card" onSubmit={submit}>
          <h1>{firstRun ? '创建管理员账号' : mode === 'register' ? '创建账号' : '欢迎回来'}</h1>
          <p>
            {firstRun ? '这是第一个账号，它将自动成为站点管理员'
              : mode === 'register' ? '注册后即可添加节点、开始对话'
                : '登录你的账号，继续未完成的对话'}
          </p>
          {!firstRun && canRegister && (
            <div className="auth-tabs">
              <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>登录</button>
              <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>注册</button>
            </div>
          )}
          <label>
            用户名
            <input value={username} onChange={e => setUsername(e.target.value)} placeholder="请输入用户名" autoFocus autoComplete="username" />
          </label>
          <label>
            密码
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="请输入密码" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
          </label>
          {mode === 'register' && (
            <label>
              确认密码
              <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="请再次输入密码" autoComplete="new-password" />
            </label>
          )}
          {err && <div className="err">{err}</div>}
          <button disabled={busy || !username.trim() || !password}>
            {busy ? '处理中…' : mode === 'register' ? '创建账号' : '登录'}
          </button>
        </form>
        <div className="login-footnote">AgentHub · 自托管 AI 编码 agent 中枢</div>
      </div>
    </div>
  );
}
