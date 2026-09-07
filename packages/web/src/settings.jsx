import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { ModalBackdrop } from './modal.jsx';

function FetchModelsButton({ baseUrl, apiKey, onPick }) {
  const [models, setModels] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const fetchModels = async () => {
    if (!baseUrl.trim() || !apiKey.trim()) { setErr('先填 Base URL 和 API Key'); return; }
    setBusy(true); setErr(''); setModels(null);
    try {
      const r = await api.fetchModelList(baseUrl.trim(), apiKey.trim());
      setModels(r.models || []);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <div className="fetch-models">
      <button type="button" className="ghost link" disabled={busy} onClick={fetchModels}>
        {busy ? '拉取中…' : '拉取模型列表'}
      </button>
      {err && <div className="err">{err}</div>}
      {models && (
        models.length
          ? (
            <select defaultValue="" onChange={e => { if (e.target.value) onPick(e.target.value); }}>
              <option value="" disabled>选择一个模型…</option>
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          )
          : <div className="muted">中转站没有返回模型列表</div>
      )}
    </div>
  );
}

const TABS = (isAdmin) => [
  { id: 'general', label: '常规' },
  { id: 'model', label: '模型' },
  ...(isAdmin ? [{ id: 'team', label: '项目管理' }, { id: 'admin', label: '管理员' }] : []),
];

export function SettingsModal({ user, onClose }) {
  const [tab, setTab] = useState('general');
  const tabs = TABS(user?.isAdmin);

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
        <h2>设置</h2>
        <nav className="tabs">
          {tabs.map(t => (
            <button key={t.id} type="button" className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </nav>
        <div className="modal-tab-body">
          {tab === 'general' && <GeneralSection />}
          {tab === 'model' && <ModelProfilesSection />}
          {tab === 'team' && user?.isAdmin && <TeamManagementSection />}
          {tab === 'admin' && user?.isAdmin && (
            <>
              <AdminSection />
              <UserManagementSection currentUserId={user.id} />
              <OverviewSection />
            </>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </ModalBackdrop>
  );
}

function GeneralSection() {
  const [defaultRepoUrl, setDefaultRepoUrl] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.getSettings().then(s => {
      setDefaultRepoUrl(s.defaultRepoUrl || '');
      setLoaded(true);
    }).catch(e => { setErr(e.message); setLoaded(true); });
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(''); setSaved(false);
    try {
      await api.saveSettings({ defaultRepoUrl: defaultRepoUrl.trim() });
      setSaved(true);
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  };

  if (!loaded) return <div className="muted">加载中…</div>;
  return (
    <form className="admin-section" onSubmit={save}>
      <label>默认仓库 URL(可选)
        <input value={defaultRepoUrl} onChange={e => setDefaultRepoUrl(e.target.value)} placeholder="git@github.com:me/repo.git" />
      </label>
      <p className="muted">新对话没有手动选路径时用这个仓库;留空则用无仓库的临时目录。</p>
      {saved && <div className="ok-note">已保存</div>}
      {err && <div className="err">{err}</div>}
      <button type="submit" className="ghost" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
    </form>
  );
}

// Model config used to be split across a single "账号默认" form plus this
// list of named profiles, with no link between them — confusing since it
// wasn't clear which one actually governed what got pushed to nodes. Now
// it's just this list: multiple url/key pairs, each independently able to
// pull its own model list, and exactly one flagged "默认" — that flagged
// one is what's mirrored to users.api_base_url/api_key/api_model and
// auto-pushed to every node (see hub-core.mjs's set-default route).
function ModelProfilesSection() {
  const [profiles, setProfiles] = useState(null);
  const [editingId, setEditingId] = useState(null); // null = the form adds a new profile
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  // Which agent CLI this profile drives. It lives on the profile rather than on
  // the create-task form because picking a relay and picking an agent are the
  // same decision in practice — a Codex relay can't serve Claude and vice
  // versa. One consequence: 「切换模型」on a card is also 「切换后端」.
  const [backend, setBackend] = useState('claude');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api.modelProfiles().then(r => setProfiles(r.profiles || [])).catch(() => setProfiles([]));
  useEffect(() => { load(); }, []);

  const resetForm = () => { setEditingId(null); setName(''); setBaseUrl(''); setApiKey(''); setModel(''); setBackend('claude'); };

  const startEdit = (p) => {
    setEditingId(p.id); setName(p.name); setBaseUrl(p.baseUrl || ''); setApiKey(p.apiKey || ''); setModel(p.model || '');
    setBackend(p.backend || 'claude');
    setErr('');
  };

  const save = async (e) => {
    e.preventDefault();
    if (!name.trim() || !baseUrl.trim() || !apiKey.trim()) { setErr('名称、Base URL、API Key 都要填'); return; }
    setBusy(true); setErr('');
    const payload = { name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() || null, backend };
    try {
      if (editingId) await api.updateModelProfile(editingId, payload);
      else await api.createModelProfile(payload);
      resetForm();
      await load();
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  };

  const setDefault = async (id) => {
    setBusy(true); setErr('');
    try { await api.setDefaultModelProfile(id); await load(); } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const remove = async (id) => {
    setBusy(true);
    try {
      await api.deleteModelProfile(id);
      if (editingId === id) resetForm();
      await load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <fieldset className="admin-section">
      <legend>模型配置</legend>
      <p className="muted">保存一个或多个中转站/API Key,每一条都能自动拉取它支持的模型列表。标为「默认」的那一条会自动同步到你名下所有节点。</p>
      {profiles === null ? <div className="muted">加载中…</div> : (
        <>
          {profiles.map(p => (
            <div className="row-inline profile-row" key={p.id}>
              <span>{p.name}</span>
              <span className="chip">{p.backend === 'codex' ? 'Codex' : 'Claude Code'}</span>
              <span className="muted">{p.baseUrl}{p.model ? ` · ${p.model}` : ''}</span>
              {/* 「默认」is the relay that tasks which picked *no* profile use,
                  and those always run Claude Code — so a Codex profile can't
                  hold it (the server refuses too). */}
              {p.isDefault
                ? <span className="chip">默认</span>
                : p.backend === 'codex'
                  ? <span className="muted" title="默认配置是给「没有选档案」的对话用的,那些对话跑的是 Claude Code">不可设为默认</span>
                  : <button type="button" className="ghost link" disabled={busy} onClick={() => setDefault(p.id)}>设为默认</button>}
              <button type="button" className="ghost link" disabled={busy} onClick={() => startEdit(p)}>编辑</button>
              <button type="button" className="ghost deny" disabled={busy} onClick={() => remove(p.id)}>删除</button>
            </div>
          ))}
          {!profiles.length && <div className="muted">还没有模型配置</div>}
        </>
      )}
      {editingId && <div className="ok-note">正在编辑「{profiles?.find(p => p.id === editingId)?.name || name}」— 保存后立即生效{profiles?.find(p => p.id === editingId)?.isDefault ? ',并自动推送到你名下所有节点' : ''}</div>}
      <div className="row2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="名称,比如 Claude 官方" />
        <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="Base URL" />
      </div>
      <div className="row2">
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="API Key" />
        <input value={model} onChange={e => setModel(e.target.value)} placeholder="Model(可选)" />
      </div>
      <div className="row-inline">
        <label><input type="radio" name="profile-backend" checked={backend === 'claude'} onChange={() => setBackend('claude')} /> Claude Code</label>
        <label><input type="radio" name="profile-backend" checked={backend === 'codex'} onChange={() => setBackend('codex')} /> Codex</label>
      </div>
      {backend === 'codex' && <p className="muted">Codex 只支持 <code>/v1/responses</code>(旧的 <code>/v1/chat/completions</code> 已被移除),中转站必须支持它。用这个档案的节点上要装好 <code>codex</code> CLI。</p>}
      <FetchModelsButton baseUrl={baseUrl} apiKey={apiKey} onPick={setModel} />
      {err && <div className="err">{err}</div>}
      <div className="row-inline">
        <button type="button" className="ghost" disabled={busy} onClick={save}>{editingId ? '保存修改' : '添加模型配置'}</button>
        {editingId && <button type="button" className="ghost link" disabled={busy} onClick={resetForm}>取消编辑</button>}
      </div>
    </fieldset>
  );
}

function TeamManagementSection() {
  const [teams, setTeams] = useState(null);
  const [newTeam, setNewTeam] = useState('');
  const [memberInputs, setMemberInputs] = useState({}); // teamId -> username being typed
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const reload = () => api.adminTeams().then(r => setTeams(r.teams)).catch(e => setNote(e.message));
  useEffect(() => { reload(); }, []);

  const createTeam = async (e) => {
    e.preventDefault();
    setBusy(true); setNote('');
    try { await api.adminCreateTeam(newTeam.trim()); setNewTeam(''); reload(); }
    catch (e2) { setNote(e2.message); }
    setBusy(false);
  };

  const deleteTeam = async (id) => {
    setBusy(true);
    try { await api.adminDeleteTeam(id); reload(); }
    catch (e) { setNote(e.message); }
    setBusy(false);
  };

  const addMember = async (teamId) => {
    const username = (memberInputs[teamId] || '').trim();
    if (!username) return;
    setBusy(true); setNote('');
    try {
      await api.adminAddTeamMember(teamId, username);
      setMemberInputs(prev => ({ ...prev, [teamId]: '' }));
      reload();
    } catch (e) { setNote(e.message); }
    setBusy(false);
  };

  const removeMember = async (teamId, userId) => {
    setBusy(true);
    try { await api.adminRemoveTeamMember(teamId, userId); reload(); }
    catch (e) { setNote(e.message); }
    setBusy(false);
  };

  return (
    <fieldset className="admin-section">
      <legend>项目管理</legend>
      <div className="row2">
        <input value={newTeam} onChange={e => setNewTeam(e.target.value)} placeholder="新项目名称" />
        <button type="button" className="ghost" disabled={busy || !newTeam.trim()} onClick={createTeam}>创建项目</button>
      </div>
      {(teams || []).map(t => (
        <div key={t.id} className="team-row">
          <div className="row-inline">
            <b>{t.name}</b>
            <button type="button" className="ghost link" disabled={busy} onClick={() => deleteTeam(t.id)}>删除项目</button>
          </div>
          <ul className="team-member-list">
            {t.members.map(m => (
              <li key={m.user_id}>
                {m.username}{m.role === 'owner' ? ' (owner)' : ''}
                <button type="button" className="ghost link" disabled={busy} onClick={() => removeMember(t.id, m.user_id)}>移除</button>
              </li>
            ))}
            {!t.members.length && <li className="muted">还没有成员</li>}
          </ul>
          <div className="row2">
            <input
              value={memberInputs[t.id] || ''} placeholder="用户名"
              onChange={e => setMemberInputs(prev => ({ ...prev, [t.id]: e.target.value }))}
            />
            <button type="button" className="ghost" disabled={busy} onClick={() => addMember(t.id)}>添加成员</button>
          </div>
        </div>
      ))}
      {teams && !teams.length && <div className="muted">还没有项目</div>}
      {note && <div className="err">{note}</div>}
    </fieldset>
  );
}

function AdminSection() {
  const [open, setOpen] = useState(null);
  const [newUser, setNewUser] = useState('');
  const [newPass, setNewPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    api.registrationStatus().then(s => setOpen(s.open)).catch(() => setOpen(true));
  }, []);

  const toggleRegistration = async () => {
    setBusy(true);
    try {
      const r = await api.adminSetRegistration(!open);
      setOpen(r.open);
    } catch (e) { setNote(e.message); }
    setBusy(false);
  };

  const createUser = async (e) => {
    e.preventDefault();
    setBusy(true); setNote('');
    try {
      await api.adminCreateUser(newUser.trim(), newPass);
      setNote(`已创建用户 ${newUser.trim()}`);
      setNewUser(''); setNewPass('');
    } catch (e2) { setNote(e2.message); }
    setBusy(false);
  };

  return (
    <fieldset className="admin-section">
      <legend>管理员</legend>
      <label className="row-inline">
        <input type="checkbox" checked={!!open} disabled={open === null || busy} onChange={toggleRegistration} />
        开放自助注册
      </label>
      <div className="row2">
        <input value={newUser} onChange={e => setNewUser(e.target.value)} placeholder="新用户名" />
        <input type="password" value={newPass} onChange={e => setNewPass(e.target.value)} placeholder="初始密码" />
      </div>
      <button type="button" className="ghost" disabled={busy || !newUser.trim() || !newPass} onClick={createUser}>创建用户</button>
      {note && <div className="muted">{note}</div>}
    </fieldset>
  );
}

function UserManagementSection({ currentUserId }) {
  const [users, setUsers] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [pwInputs, setPwInputs] = useState({}); // userId -> new password being typed

  const reload = () => api.adminUsers().then(r => setUsers(r.users)).catch(e => setNote(e.message));
  useEffect(() => { reload(); }, []);

  const run = async (fn) => {
    setBusy(true); setNote('');
    try { await fn(); await reload(); }
    catch (e) { setNote(e.message); }
    setBusy(false);
  };

  const resetPassword = (id) => {
    const password = (pwInputs[id] || '').trim();
    if (password.length < 8) { setNote('新密码至少 8 位'); return; }
    run(async () => {
      await api.adminResetPassword(id, password);
      setPwInputs(prev => ({ ...prev, [id]: '' }));
    });
  };

  return (
    <fieldset className="admin-section">
      <legend>用户管理</legend>
      {users === null ? <div className="muted">加载中…</div> : (
        <>
          {users.map(u => (
            <div key={u.id} className="team-row">
              <div className="row-inline">
                <b>{u.username}</b>
                {u.isAdmin && <span className="chip">管理员</span>}
                {u.disabled && <span className="chip st-failed">已禁用</span>}
                <span className="muted">{u.taskCount} 个对话 · {u.nodeCount} 个节点{u.teams.length ? ` · ${u.teams.map(t => t.name).join('、')}` : ''}</span>
              </div>
              <div className="row-inline">
                {u.id !== currentUserId && (
                  u.disabled
                    ? <button type="button" className="ghost link" disabled={busy} onClick={() => run(() => api.adminEnableUser(u.id))}>启用</button>
                    : <button type="button" className="ghost link" disabled={busy} onClick={() => run(() => api.adminDisableUser(u.id))}>禁用</button>
                )}
                <button type="button" className="ghost link" disabled={busy} onClick={() => run(() => api.adminToggleAdmin(u.id))}>
                  {u.isAdmin ? '取消管理员' : '设为管理员'}
                </button>
              </div>
              <div className="row2">
                <input
                  type="password" value={pwInputs[u.id] || ''} placeholder="新密码(至少8位)"
                  onChange={e => setPwInputs(prev => ({ ...prev, [u.id]: e.target.value }))}
                />
                <button type="button" className="ghost" disabled={busy} onClick={() => resetPassword(u.id)}>重置密码</button>
              </div>
            </div>
          ))}
          {!users.length && <div className="muted">还没有用户</div>}
        </>
      )}
      {note && <div className="err">{note}</div>}
    </fieldset>
  );
}

function OverviewSection() {
  const [overview, setOverview] = useState(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    api.adminOverview().then(r => setOverview(r.overview)).catch(e => setNote(e.message));
  }, []);

  return (
    <fieldset className="admin-section">
      <legend>全局概况</legend>
      <p className="muted">按用户汇总的节点/任务统计,不包含对话内容。</p>
      {overview === null ? <div className="muted">加载中…</div> : (
        <table className="overview-table">
          <thead><tr><th>用户</th><th>节点</th><th>对话状态</th></tr></thead>
          <tbody>
            {overview.map(o => (
              <tr key={o.userId}>
                <td>{o.username}</td>
                <td>{o.nodesOnline}/{o.nodeCount} 在线</td>
                <td className="muted">
                  {Object.entries(o.tasksByStatus).map(([status, n]) => `${status}:${n}`).join(' ') || '无'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {note && <div className="err">{note}</div>}
    </fieldset>
  );
}
