import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';
import { state, upsertTask, bump, taskInScope, getVersion, scopeKeyOf } from './store.js';
import { Sidebar } from './sidebar.jsx';
import { TaskPane } from './task.jsx';
import { DraftPane } from './draftpane.jsx';
import { ConversationSourcePane } from './sourcepane.jsx';
import { STATUS_META } from './board.jsx';
import { MobileConversationSwitcher } from './mobileswitcher.jsx';
import { layoutNeedsSave, mergeCloudLayout } from './layout-sync.js';

const PANES_KEY = 'agenthub_open_panes';
const ACTIVE_PANE_KEY = 'agenthub_active_panes';
const DRAG_MIME = 'application/x-agenthub-task';
const isDraft = (id) => typeof id === 'string' && id.startsWith('draft-');
const isSource = (id) => typeof id === 'string' && id.startsWith('source:');
const isTransientPane = (id) => isDraft(id) || isSource(id);
// scopeKeyOf lives in store.js now — it's also used there for the
// tasks/nodes cache, and the two must always agree on what "personal" is
// called or a scope's pane list and its task/node cache silently disagree
// about which bucket they're in.
const PERSONAL = scopeKeyOf(null);
const scopeKey = scopeKeyOf;

// Which panes are open is tracked *per scope* (personal, or each project) —
// not one flat list — so switching projects and back restores exactly what
// was open in each, instead of a single list getting pruned/clobbered every
// time the active scope changes. Legacy shape (a flat array, from before
// per-project layouts existed) is migrated into the personal bucket rather
// than discarded.
function loadActivePanes() {
  try {
    const value = JSON.parse(localStorage.getItem(ACTIVE_PANE_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function loadPanesMap() {
  try {
    const saved = JSON.parse(localStorage.getItem(PANES_KEY) || '{}');
    if (Array.isArray(saved)) return { [PERSONAL]: saved.filter(id => typeof id === 'string') };
    if (saved && typeof saved === 'object') {
      const out = {};
      for (const k of Object.keys(saved)) {
        if (Array.isArray(saved[k])) out[k] = saved[k].filter(id => typeof id === 'string');
      }
      return out;
    }
  } catch { /* fall through */ }
  return {};
}

export function AppShell({ taskId, user, pushState, onEnablePush, onOpenSettings, onLogout, onSwitchTeam }) {
  // Scoped to the currently active personal/project view — state.tasks can
  // also hold a task resolved purely to satisfy a direct link outside that
  // scope (see the URL-driven-focus effect below), which must never count
  // here or it leaks into "jump to latest" / the loading-placeholder check
  // for a scope it doesn't actually belong to.
  const tasks = [...state.tasks.values()].filter(taskInScope);
  const scope = scopeKey(state.activeTeamId);
  const [navOpen, setNavOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherQuery, setSwitcherQuery] = useState('');
  const [panesByScope, setPanesByScope] = useState(loadPanesMap);
  const [activePaneByScope, setActivePaneByScope] = useState(loadActivePanes);
  useEffect(() => {
    const media = matchMedia('(max-width: 720px)');
    const onChange = event => { if (!event.matches) { setNavOpen(false); setSwitcherOpen(false); } };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = event => { if (event.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);
  const openPanes = panesByScope[scope] || [];
  const rememberedActivePane = activePaneByScope[scope];
  const activePaneId = (openPanes.includes(rememberedActivePane) ? rememberedActivePane : null)
    || (openPanes.includes(taskId) ? taskId : null) || openPanes[0] || null;
  const prevTaskId = useRef(null);
  const mountedRef = useRef(false);
  const pendingTaskIds = useRef(new Set());

  const setOpenPanes = (updater) => {
    setPanesByScope(prev => {
      const current = prev[scope] || [];
      const next = typeof updater === 'function' ? updater(current) : updater;
      // A genuine no-op (updater returned the same array back, e.g. the
      // stale-pane prune effect below finding nothing to drop) must not
      // register this scope's key at all — that would mark it "visited" and
      // permanently suppress the jump-to-latest-on-first-visit effect above.
      if (next === current) return prev;
      return { ...prev, [scope]: next };
    });
  };

  // URL-driven focus (deep link / browser back-forward / sidebar navigation):
  // only force exclusive-focus when the target isn't already visible, so
  // switching between two already-open panes doesn't collapse the layout.
  // On the very first mount, never *replace* — the URL hash can be stale
  // (e.g. still pointing at a pane the user closed last session, since
  // closePane() below only updates the hash when closing the pane it points
  // at while the shell is mounted, not across a full page reload) and
  // collapsing an otherwise-correctly-restored multi-pane layout down to one
  // pane on refresh is exactly the bug this guards against. Just fold the
  // URL's task into whatever was already restored instead.
  // A task URL can point at a task outside whichever scope (personal/
  // project) happens to be active — most commonly a project conversation
  // opened from a notification/shared link while still viewing "个人". The
  // scoped task list deliberately won't include it, so state.tasks.has(id)
  // stays false and the pane never renders (shell only mounts TaskPane once
  // the task is actually in the map, below) — found live: opening such a
  // link left the workspace stuck on "正在加载对话…" indefinitely. Resolve
  // it directly via the scope-independent single-task route instead of
  // requiring the sidebar's active tab to already match.
  //
  // Deliberately folded into *this* effect (keyed only on [taskId], a real
  // navigation event) rather than a separate one reacting to state.loaded —
  // an earlier version did that and it re-fired on every personal/project
  // switch, re-merging a stale link's task into whatever scope you'd just
  // switched to. Now that panes are tracked per scope this is less
  // catastrophic than it was, but still pointless work — resolving only on
  // an actual navigation event is correct regardless.
  const resolveIfMissing = (id) => {
    if (id && !state.tasks.has(id) && !pendingTaskIds.current.has(id)) {
      pendingTaskIds.current.add(id);
      api.getTask(id).then(r => {
        upsertTask(r.task);
        setOpenPanes(p => (p.includes(id) ? p : [...p, id]));
        bump();
      }).catch(() => {
        setOpenPanes(p => p.filter(paneId => paneId !== id));
      }).finally(() => pendingTaskIds.current.delete(id));
    }
  };
  // Which (taskId, scope) pair the effect below most recently placed into a
  // pane list — a plain ref, not state, specifically so the jump-to-latest
  // effect can read it *synchronously within the same commit*, before any
  // state update from this effect has actually applied. That's what makes
  // it safe to use as "is a claim for this exact scope already in flight."
  const claimedRef = useRef({ taskId: null, scope: null });
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      prevTaskId.current = taskId;
      if (taskId) {
        setOpenPanes(p => (p.includes(taskId) ? p : [...p, taskId]));
        setActivePaneByScope(prev => ({ ...prev, [scope]: taskId }));
        claimedRef.current = { taskId, scope };
        resolveIfMissing(taskId);
      }
      return;
    }
    if (taskId && taskId !== prevTaskId.current) {
      setOpenPanes(p => (p.includes(taskId) ? p : [...p, taskId]));
      setActivePaneByScope(prev => ({ ...prev, [scope]: taskId }));
      claimedRef.current = { taskId, scope };
      resolveIfMissing(taskId);
    }
    prevTaskId.current = taskId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Cross-device layout sync, per scope: /api/layout GET returns every scope
  // this account has ever saved a layout for from any device; POST (further
  // below) writes just the current scope's list. A scope key already
  // present locally (even an empty list — meaning this device has
  // deliberately closed everything there) always wins over the cloud copy;
  // only scope keys this device has never touched get seeded from it, so
  // opening a project on a second device for the first time picks up
  // whatever was left open on the first. Deliberately doesn't also fold in
  // the current taskId here — the URL-driven-focus effect above already
  // does that unconditionally at mount, and this callback's own taskId/scope
  // would be a stale closure by the time this async response actually lands
  // anyway (deps are `[]`, captured once at mount).
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const lastQueuedLayoutsRef = useRef({});
  const layoutSaveQueueRef = useRef(Promise.resolve());
  useEffect(() => {
    api.getLayout().then(r => {
      const cloudLayout = {};
      for (const [k, v] of Object.entries(r.layout || {})) {
        if (Array.isArray(v)) cloudLayout[k] = v.filter(id => typeof id === 'string' && !isTransientPane(id));
      }
      // The first save comparison starts from what the server actually has,
      // not from an implicit [] for whichever scope happens to be selected.
      // That distinction prevents merely visiting a scope from recording an
      // empty layout before its task list has had a chance to load.
      lastQueuedLayoutsRef.current = cloudLayout;
      setPanesByScope(prev => mergeCloudLayout(prev, cloudLayout));
      setLayoutLoaded(true);
    }).catch(() => {
      // With no authoritative baseline, a populated local layout may still be
      // uploaded, but layoutNeedsSave() refuses an ambiguous empty one. A
      // temporary GET failure must never turn into a destructive [] write.
      lastQueuedLayoutsRef.current = {};
      setLayoutLoaded(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First-ever visit to a scope (personal or a given project) with nothing
  // in the URL: jump to its most recent conversation instead of requiring a
  // click — "first-ever" meaning the scope key has literally never been
  // recorded in panesByScope, not just "currently empty," so a scope you've
  // deliberately closed every pane in stays that way on later visits instead
  // of re-jumping every time. Archived tasks are excluded — jumping to one
  // here would reopen a conversation the user just put away (found live: an
  // archived task with a very recent updated_at otherwise won the sort).
  //
  // Gated on layoutLoaded, not just state.loaded — the scoped task list
  // (state.loaded) and the cross-device layout fetch (layoutLoaded) are two
  // independent requests, and if the task list wins the race, this used to
  // fire first, jump to a *single* task, and register the scope key with
  // just that one entry — by the time the cloud layout response landed
  // afterward, the scope already "existed" so its real (possibly
  // multi-pane) saved list was silently discarded. Found live: a fresh
  // device only ever showed one restored personal pane instead of all three
  // that were actually open on the device that saved them.
  const jumpedScopesRef = useRef(new Set());
  useEffect(() => {
    if (openPanes.length || !state.loaded || !layoutLoaded) return;
    if ((scope in panesByScope) || jumpedScopesRef.current.has(scope)) return;
    // Only block on a taskId that the effect above *just* claimed for this
    // exact scope (see claimedRef) — not merely "a taskId happens to be in
    // the URL." Switching scope never touches the URL, so right after a
    // switch taskId still points at whatever was focused in the *previous*
    // scope; treating that as "spoken for" here blocked this scope's own
    // jump forever — found live: switching to a project whose only
    // conversation wasn't already open left the workspace stuck on
    // "正在加载对话…" because state.tasks had also been wiped for the old
    // scope's task by then, making a naive "is it resolved yet" check
    // permanently ambiguous instead of just "not ours."
    if (taskId && claimedRef.current.taskId === taskId && claimedRef.current.scope === scope) return;
    const visible = tasks.filter(t => !t.archived_at);
    if (!visible.length) return; // nothing here yet — leave the "还没有对话" placeholder as-is
    jumpedScopesRef.current.add(scope);
    const latest = [...visible].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
    location.hash = `#/task/${latest.id}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, state.loaded, layoutLoaded, scope, tasks.length, openPanes.length]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_PANE_KEY, JSON.stringify(activePaneByScope));
  }, [activePaneByScope]);

  useEffect(() => {
    const active = activePaneByScope[scope];
    if (active && openPanes.includes(active) && !isTransientPane(active)) {
      if (taskId !== active) location.hash = `#/task/${active}`;
    } else if (taskId && !openPanes.includes(taskId)) {
      location.hash = '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    const toSave = {};
    for (const [k, v] of Object.entries(panesByScope)) toSave[k] = v.filter(id => !isTransientPane(id));
    localStorage.setItem(PANES_KEY, JSON.stringify(toSave));
  }, [panesByScope]);

  // One-time re-bucketing right after the flat-list -> per-scope migration
  // above: every pane that was open *before* per-project tracking existed
  // landed in 'personal' regardless of which project its task actually
  // belongs to, because "a project has its own open panes" wasn't a concept
  // yet — found live, reported as "我明明之前打开过很多对话" after switching
  // to a project and finding it empty. Once personal's own task list has
  // loaded, anything sitting in its pane list that ISN'T actually a personal
  // task (state.tasks won't have it — personal's list excludes anything with
  // teamIds) gets looked up via the scope-independent single-task route and,
  // if it turns out to belong to a project, moved into that project's pane
  // list instead of just being pruned away as if it no longer existed.
  const rebucketedRef = useRef(false);
  useEffect(() => {
    // layoutLoaded matters here too, not just state.loaded — running before
    // the cloud-synced pane list has merged in would only see whatever
    // localStorage happened to have on this device, missing anything only
    // recorded server-side (e.g. opened on a different device before today).
    if (rebucketedRef.current || scope !== PERSONAL || !state.loaded || !layoutLoaded) return;
    rebucketedRef.current = true;
    const misplaced = (panesByScope[PERSONAL] || []).filter(id => !isDraft(id) && !state.tasks.has(id));
    if (!misplaced.length) return;
    Promise.all(misplaced.map(id =>
      api.getTask(id).then(r => ({ id, teamIds: r.task.teamIds || [] })).catch(() => null),
    )).then(results => {
      const byTarget = new Map();
      for (const r of results) {
        if (!r || !r.teamIds.length) continue; // genuinely gone, or truly personal — left for the prune effect below
        const target = r.teamIds[0];
        if (!byTarget.has(target)) byTarget.set(target, []);
        byTarget.get(target).push(r.id);
      }
      if (!byTarget.size) return;
      setPanesByScope(prev => {
        const next = { ...prev };
        const movedIds = new Set([...byTarget.values()].flat());
        next[PERSONAL] = (next[PERSONAL] || []).filter(id => !movedIds.has(id));
        for (const [target, ids] of byTarget) {
          const existing = next[target] || [];
          next[target] = [...existing, ...ids.filter(id => !existing.includes(id))];
        }
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, state.loaded, layoutLoaded]);

  useEffect(() => {
    const sourceClaims = state.sourceClaims[scope];
    if (!sourceClaims?.size) return;
    for (const [sourcePaneId, taskId] of sourceClaims) {
      setOpenPanes(p => {
        if (!p.includes(sourcePaneId)) return p;
        const at = p.indexOf(sourcePaneId);
        const withoutBoth = p.filter(id => id !== sourcePaneId && id !== taskId);
        return [...withoutBoth.slice(0, at), taskId, ...withoutBoth.slice(at)];
      });
      if (activePaneId === sourcePaneId) {
        setActivePaneByScope(prev => ({ ...prev, [scope]: taskId }));
        location.hash = `#/task/${taskId}`;
      }
      resolveIfMissing(taskId);
      sourceClaims.delete(sourcePaneId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getVersion(), scope]);

  // Drop any open pane whose task no longer resolves in this scope — a task
  // removed from a project (or archived) since this scope was last visited
  // would otherwise render as a permanently blank pane (state.tasks.has(id)
  // false forever) — found live: "6 stuck blank panes after switching
  // projects", an archived task reappearing on every login, and later a
  // *live* reassignment while its pane was already open (sidebar.jsx's
  // toggleTaskTeam does state.tasks.delete() the moment a task you're
  // currently looking at moves out of the active scope, with nothing else
  // to close its now-empty pane). getVersion() is in the deps specifically
  // for that last case — state.loaded/scope alone only catch a scope
  // reload, not a live single-task removal that happens without either
  // changing. Safe to re-run this often (idempotent no-op once clean, and
  // only ever removes panes whose task is genuinely gone).
  useEffect(() => {
    if (!state.loaded) return;
    setOpenPanes(p => {
      const kept = p.filter(id => {
        if (isDraft(id)) return true;
        if (isSource(id)) return state.conversationSources.has(id.slice(7));
        return pendingTaskIds.current.has(id) || (state.tasks.has(id) && !state.tasks.get(id)?.archived_at);
      });
      if (kept.length !== p.length && !kept.includes(activePaneId)) {
        setActivePaneByScope(prev => ({ ...prev, [scope]: kept[0] || null }));
      }
      return kept.length === p.length ? p : kept;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.loaded, scope, openPanes, layoutLoaded, getVersion()]);

  useEffect(() => {
    if (!layoutLoaded) return;
    const panes = openPanes.filter(id => !isTransientPane(id));
    const prior = lastQueuedLayoutsRef.current[scope];
    if (!layoutNeedsSave(prior, panes)) return;

    // No debounce: saves are cheap/infrequent (pane add/remove), and any
    // delay widens the window where a refresh could race ahead of it. Queue
    // writes globally so two rapid changes cannot arrive out of order, and
    // bind each call to this render's scope instead of letting api.js read the
    // mutable activeTeamId later (the old behavior could save project A's
    // panes under project B while switching tabs).
    lastQueuedLayoutsRef.current = { ...lastQueuedLayoutsRef.current, [scope]: panes };
    const teamId = scope === PERSONAL ? null : scope;
    layoutSaveQueueRef.current = layoutSaveQueueRef.current
      .catch(() => {})
      .then(() => api.saveLayout(panes, teamId));
  }, [openPanes, layoutLoaded, scope]);

  // Sidebar items are plain buttons (their onClick calls preventDefault on
  // the anchor), so this is the only thing that ever moves the hash for a
  // sidebar click — deliberately, in the same tick as the pane-list update,
  // batched together by React. Previously the sidebar item was a real <a
  // href>, so its native navigation *also* changed the hash independently —
  // racing the "URL-driven focus" effect in shell.jsx against addPane's own
  // update, one appending the pane, the other collapsing to just that one,
  // whichever committed last winning: a visible flash / spurious pane.
  const addPane = (id) => {
    setOpenPanes(p => (p.includes(id) ? p : [...p, id]));
    setActivePaneByScope(prev => ({ ...prev, [scope]: id }));
    if (!isTransientPane(id)) location.hash = `#/task/${id}`;
    setNavOpen(false); setSwitcherOpen(false);
  };
  const closePane = (id) => {
    setOpenPanes(p => {
      const index = p.indexOf(id);
      const next = p.filter(x => x !== id);
      if (id === activePaneId || id === taskId) {
        const fallbackActive = next[Math.min(index, next.length - 1)] || null;
        setActivePaneByScope(prev => ({ ...prev, [scope]: fallbackActive }));
        location.hash = fallbackActive && !isTransientPane(fallbackActive) ? `#/task/${fallbackActive}` : '';
      }
      return next;
    });
  };
  const newDraft = () => addPane(`draft-${Math.random().toString(36).slice(2)}-${Date.now()}`);
  const replacePane = (oldId, realId) => {
    setOpenPanes(p => {
      const at = p.indexOf(oldId);
      if (at < 0) return p.includes(realId) ? p : [...p, realId];
      const withoutBoth = p.filter(id => id !== oldId && id !== realId);
      return [...withoutBoth.slice(0, at), realId, ...withoutBoth.slice(at)];
    });
    setActivePaneByScope(prev => ({ ...prev, [scope]: realId }));
    location.hash = `#/task/${realId}`;
  };
  const onWorkspaceDrop = (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData(DRAG_MIME);
    if (id) addPane(id);
  };

  // Clicking a sidebar item only tells you *which task* got selected — with
  // several panes open side by side there was no way to tell which one on
  // the right it actually corresponds to. Scroll that pane into view and
  // give it a persistent highlighted border (matching the sidebar item's own
  // `.active` treatment) so the two stay visually linked.
  const paneRefs = useRef(new Map());
  useEffect(() => {
    if (!activePaneId || matchMedia('(max-width: 720px)').matches) return;
    paneRefs.current.get(activePaneId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [activePaneId]);

  const itemForPane = (id) => {
    if (!id) return null;
    if (isDraft(id)) return { paneId: id, kind: 'draft', title: '新对话' };
    if (isSource(id)) {
      const source = state.conversationSources.get(id.slice(7));
      return source ? { paneId: id, kind: 'source', title: source.preview || 'Claude Code 历史对话', ...source } : null;
    }
    const task = state.tasks.get(id);
    return task ? { paneId: id, kind: 'task', ...task } : null;
  };
  const openItems = openPanes.map(itemForPane).filter(Boolean);
  const allItems = [
    ...tasks.filter(task => !task.archived_at).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)).map(task => ({ paneId: task.id, kind: 'task', ...task })),
    ...[...state.conversationSources.values()].sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).map(source => ({ paneId: `source:${source.id}`, kind: 'source', title: source.preview || 'Claude Code 历史对话', ...source })),
  ];
  const activeItem = itemForPane(activePaneId);
  const activeStatus = activeItem?.kind === 'task' ? (STATUS_META[activeItem.status] || { label: activeItem.status, cls: '' }) : null;
  const activeTeamName = state.teams.find(team => team.id === state.activeTeamId)?.name || '个人';

  return (
    <div className="app-shell">
      <Sidebar
        open={navOpen}
        selectedTaskId={activePaneId}
        openPanes={openPanes}
        onSelect={addPane}
        onNewDraft={newDraft}
        user={user}
        pushState={pushState}
        onEnablePush={onEnablePush}
        onOpenSettings={onOpenSettings}
        onLogout={onLogout}
        onSwitchTeam={(teamId) => { onSwitchTeam(teamId); setNavOpen(false); setSwitcherOpen(false); setSwitcherQuery(''); }}
      />
      {navOpen && <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />}
      <main className="main-pane">
        <div className="mobile-app-bar">
          <button type="button" className="ghost mobile-menu-btn" onClick={() => setNavOpen(!navOpen)} aria-label="项目和设置" aria-expanded={navOpen} aria-controls="app-sidebar">☰</button>
          <button type="button" className="mobile-current-btn" onClick={() => setSwitcherOpen(true)} aria-label="切换对话">
            <span className="mobile-current-scope">{activeTeamName}</span>
            <span className="mobile-current-title">{activeItem?.title || '选择对话'} ▾</span>
            {activeStatus && <span className={`chip ${activeStatus.cls}`}>{activeStatus.label}</span>}
            {activeItem?.kind === 'source' && <span className="chip source-chip">未接入</span>}
          </button>
          <button type="button" className="ghost mobile-new-btn" onClick={newDraft} aria-label="新对话">＋</button>
        </div>
        <button className="nav-toggle" onClick={() => setNavOpen(!navOpen)} aria-label="会话列表">☰</button>
        <div className="workspace" onDragOver={e => e.preventDefault()} onDrop={onWorkspaceDrop}>
          {openPanes.map(id => (
            <div
              className={`pane ${id === activePaneId ? 'pane-selected pane-mobile-active' : 'pane-mobile-inactive'}`} key={id}
              ref={el => { if (el) paneRefs.current.set(id, el); else paneRefs.current.delete(id); }}
              onPointerDownCapture={() => {
                if (activePaneId === id) return;
                setActivePaneByScope(prev => ({ ...prev, [scope]: id }));
                if (!isTransientPane(id)) location.hash = `#/task/${id}`;
              }}
            >
              {isDraft(id)
                ? <DraftPane onCreated={(realId) => replacePane(id, realId)} onClose={() => closePane(id)} />
                : isSource(id)
                  ? (state.conversationSources.has(id.slice(7))
                      ? <ConversationSourcePane source={state.conversationSources.get(id.slice(7))} onActivated={(realId) => replacePane(id, realId)} onClose={() => closePane(id)} />
                      : null)
                  : (state.tasks.has(id) ? <TaskPane taskId={id} user={user} onClose={() => closePane(id)} /> : null)}
            </div>
          ))}
          {!openPanes.length && (
            <div className="empty-shell">
              {/* tasks is derived from state.tasks, which is empty until
                  state.loaded flips true — so this branch is never actually
                  reached mid-load (tasks.length would still be 0 then, hitting
                  the other branch instead). "正在加载对话…" here was pure
                  misdirection: nothing is loading, there's just nothing open
                  in this scope yet (most commonly a project you'd already
                  closed every pane in before — see the jump-to-latest effect
                  above, which deliberately doesn't re-jump once that's
                  happened). Found live: reported as looking permanently
                  stuck. */}
              <span className="desktop-empty-copy">{tasks.length ? '还没有打开的对话 — 点击左侧列表选择一个' : '还没有对话 — 点击左侧「+ 新对话」开始'}</span>
              <span className="mobile-empty-copy">{tasks.length ? '还没有打开的对话 — 点击顶部标题切换' : '还没有对话 — 点击顶部「＋」开始'}</span>
            </div>
          )}
        </div>
      </main>
      {switcherOpen && (
        <MobileConversationSwitcher
          openItems={openItems} allItems={allItems} activePaneId={activePaneId}
          query={switcherQuery} onQuery={setSwitcherQuery} onSelect={addPane}
          onClosePane={closePane} onNew={() => { setSwitcherOpen(false); newDraft(); }}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
    </div>
  );
}
