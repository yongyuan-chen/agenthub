import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { api, connectWs, getToken, setToken, clearToken, AuthError, ApiError, enablePush } from './api.js';
import { state, subscribe, getVersion, applyWsMessage, bump, scopeKeyOf, resetUserState } from './store.js';
import { AuthScreen } from './login.jsx';
import { SettingsModal } from './settings.jsx';
import { AppShell } from './shell.jsx';

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

const ACTIVE_TEAM_KEY = 'agenthub_active_team';
state.activeTeamId = localStorage.getItem(ACTIVE_TEAM_KEY) || null;

function App() {
  useStore();
  const hash = useHashRoute();
  const [authed, setAuthed] = useState(!!getToken());
  const [user, setUser] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [pushState, setPushState] = useState(localStorage.getItem('agenthub_push') || 'off');
  const wsRef = useRef(null);

  // REST fallback so a broken WS still shows data — same calls used at
  // mount, extracted so switchTeam() can re-run them against the new scope
  // (X-Team-Id, read fresh from state.activeTeamId by api.js's req()).
  // Captures which scope this request was FOR at call time and re-checks it
  // when the response lands — if the user has since switched to a third
  // scope (rapid tab-flipping), this response only refreshes that scope's
  // cache entry for next time, it must not clobber whatever's on screen now.
  const loadScopedData = (onAuthError) => {
    const scopeKey = scopeKeyOf(state.activeTeamId);
    const userGeneration = state.userGeneration;
    const taskEpoch = state.taskEpochs[scopeKey] || 0;
    api.tasks().then(r => {
      if (state.userGeneration !== userGeneration || (state.taskEpochs[scopeKey] || 0) !== taskEpoch) return;
      const tasks = new Map(r.tasks.map(t => [t.id, t]));
      state.scopeCache[scopeKey] = { ...(state.scopeCache[scopeKey] || {}), tasks };
      if (scopeKeyOf(state.activeTeamId) === scopeKey) { state.tasks = tasks; state.loaded = true; bump(); }
    }).catch(onAuthError);
    api.nodes().then(r => {
      if (state.userGeneration !== userGeneration) return;
      const nodes = new Map(r.nodes.map(n => [n.id, n]));
      state.scopeCache[scopeKey] = { ...(state.scopeCache[scopeKey] || {}), nodes };
      if (scopeKeyOf(state.activeTeamId) === scopeKey) { state.nodes = nodes; bump(); }
    }).catch(() => {});
    const sourceEpoch = state.sourceEpochs[scopeKey] || 0;
    const sourceRequestSeq = (state.sourceRequestSeq[scopeKey] || 0) + 1;
    state.sourceRequestSeq[scopeKey] = sourceRequestSeq;
    state.sourceStatus[scopeKey] = { loading: true, error: '', unavailableNodeIds: [] };
    api.conversationSources().then(r => {
      if (state.userGeneration !== userGeneration || state.sourceRequestSeq[scopeKey] !== sourceRequestSeq) return;
      if ((state.sourceEpochs[scopeKey] || 0) !== sourceEpoch) {
        state.sourceStatus[scopeKey] = { loading: false, error: '', unavailableNodeIds: [] };
        if (scopeKeyOf(state.activeTeamId) === scopeKey) bump();
        return;
      }
      const conversationSources = new Map((r.sources || []).map(source => [source.id, source]));
      const unavailable = new Set(r.unavailableNodeIds || []);
      const priorSources = state.scopeCache[scopeKey]?.conversationSources || new Map();
      for (const [id, source] of priorSources) {
        if (unavailable.has(source.nodeId) && !conversationSources.has(id)) conversationSources.set(id, { ...source, stale: true });
      }
      state.scopeCache[scopeKey] = { ...(state.scopeCache[scopeKey] || {}), conversationSources };
      state.sourceStatus[scopeKey] = { loading: false, error: '', unavailableNodeIds: r.unavailableNodeIds || [] };
      if (scopeKeyOf(state.activeTeamId) === scopeKey) { state.conversationSources = conversationSources; bump(); }
    }).catch(error => {
      if (state.userGeneration !== userGeneration || state.sourceRequestSeq[scopeKey] !== sourceRequestSeq) return;
      if (error instanceof AuthError) { onAuthError(error); return; }
      const cache = state.scopeCache[scopeKey];
      const authorizationLost = error instanceof ApiError && (error.status === 403 || error.status === 404);
      if (authorizationLost) {
        if (cache) cache.conversationSources = new Map();
        if (scopeKeyOf(state.activeTeamId) === scopeKey) state.conversationSources = new Map();
      } else if (cache?.conversationSources) {
        cache.conversationSources = new Map([...cache.conversationSources].map(([id, source]) => [id, { ...source, stale: true }]));
        if (scopeKeyOf(state.activeTeamId) === scopeKey) state.conversationSources = new Map(cache.conversationSources);
      }
      state.sourceStatus[scopeKey] = { loading: false, error: error.message || '历史会话扫描失败', unavailableNodeIds: [] };
      if (scopeKeyOf(state.activeTeamId) === scopeKey) bump();
    });
  };

  useEffect(() => {
    if (!authed) return;
    // state.activeTeamId was never persisted anywhere — it always reset to
    // null (个人) on a fresh page load regardless of which project you were
    // actually viewing. Restore it optimistically before the very first
    // connect/fetch below, so they already target the right scope instead of
    // flashing personal content first and then jumping — found live,
    // reported as "点刷新就跑到个人了". myTeams() further down corrects it
    // if it turns out stale (removed from that project, or it was deleted).
    const ws = connectWs({
      onMessage: applyWsMessage,
      onOpen: () => { state.wsConnected = true; bump(); },
      onClose: () => { state.wsConnected = false; bump(); },
    });
    wsRef.current = ws;
    const onAuthError = (e) => {
      if (!(e instanceof AuthError)) return;
      clearToken();
      localStorage.removeItem(ACTIVE_TEAM_KEY);
      localStorage.removeItem('agenthub_open_panes');
      localStorage.removeItem('agenthub_active_panes');
      resetUserState();
      setUser(null); setAuthed(false);
    };
    // api.me() resolves the raw {ok, user} response envelope, not the user
    // object itself — passing it straight to setUser() (as this did before)
    // silently breaks every user?.xxx check downstream (isAdmin, username),
    // since it overwrites the correctly-shaped object login.jsx's onOk()
    // sets right after auth with this wrong-shaped one on every reload.
    api.me().then(r => setUser(r.user)).catch(onAuthError);
    loadScopedData(onAuthError);
    api.myTeams().then(r => {
      state.teams = r.teams;
      // A persisted project the account is no longer a member of (removed,
      // or the project itself got deleted) would otherwise leave every
      // request in that stale scope silently 403ing forever, looking
      // permanently stuck — fall back to personal instead.
      if (state.activeTeamId && !r.teams.some(x => x.id === state.activeTeamId)) switchTeam(null);
      bump();
    }).catch(() => {});
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  // Switching teams changes which tasks/nodes are visible — the WS socket's
  // scope tag is fixed at connect time (see hub.mjs), so it needs a fresh
  // connection, not just a re-filter of what's already loaded. Used to
  // *always* clear tasks/nodes to empty here and block on a fresh network
  // round trip before showing anything again — visibly a ~1s reload, not a
  // tab switch. If this scope has been visited before, show its last-known
  // snapshot immediately instead (from state.scopeCache) and let the
  // reconnect + loadScopedData below correct anything stale in the
  // background — same stale-while-revalidate feel as flipping a browser tab.
  // Only a genuinely first-ever visit to a scope still shows the loading
  // state, same as before.
  const switchTeam = (teamId) => {
    if (state.activeTeamId === teamId) return;
    state.activeTeamId = teamId;
    if (teamId) localStorage.setItem(ACTIVE_TEAM_KEY, teamId);
    else localStorage.removeItem(ACTIVE_TEAM_KEY);
    const cached = state.scopeCache[scopeKeyOf(teamId)];
    if (cached) {
      state.tasks = new Map(cached.tasks || []);
      state.nodes = new Map(cached.nodes || []);
      state.conversationSources = new Map(cached.conversationSources || []);
      state.loaded = true;
    } else {
      state.tasks = new Map();
      state.nodes = new Map();
      state.conversationSources = new Map();
      state.loaded = false;
    }
    bump();
    wsRef.current?.reconnect();
    loadScopedData(() => {});
  };

  const togglePush = async () => {
    try {
      await enablePush();
      localStorage.setItem('agenthub_push', 'on');
      setPushState('on');
    } catch (e) { alert('开启推送失败:' + e.message); }
  };

  const logout = () => {
    api.logout();
    clearToken();
    localStorage.removeItem(ACTIVE_TEAM_KEY);
    localStorage.removeItem('agenthub_open_panes');
    localStorage.removeItem('agenthub_active_panes');
    resetUserState();
    setAuthed(false);
    setUser(null);
  };

  if (!authed) return <AuthScreen onOk={(u) => { setUser(u); setAuthed(true); }} />;

  const m = hash.match(/^#\/task\/([A-Za-z0-9]+)$/);
  return (
    <>
      <AppShell
        taskId={m ? m[1] : null}
        user={user}
        pushState={pushState}
        onEnablePush={togglePush}
        onOpenSettings={() => setShowSettings(true)}
        onLogout={logout}
        onSwitchTeam={switchTeam}
      />
      {showSettings && <SettingsModal user={user} onClose={() => setShowSettings(false)} />}
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
