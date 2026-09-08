import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';
import { state } from './store.js';
import { ModalBackdrop } from './modal.jsx';
import { ModelProfilesSection } from './settings.jsx';
import { NodeInstallPanel } from './board.jsx';

// A fresh account can't do anything until two things exist: somewhere to send
// the model requests, and a machine to run the agent on. Neither is
// discoverable — one lives behind 设置 → 模型, the other behind a sidebar
// button — so a new user lands on an empty board with no indication that the
// "+ 新对话" button they're drawn to will fail. This walks them through both,
// and gets out of the way permanently once they're done.
export function OnboardingModal({ hasModel, hasNode, onClose, onDone, onPollNodes }) {
  // Start on whichever step is actually outstanding, so someone who already
  // has a relay configured isn't made to click past it.
  const [step, setStep] = useState(hasModel ? 2 : 1);
  const nodeCount = state.nodes.size;

  // The node list arrives over the WS as soon as the machine enrolls, so the
  // wizard can confirm success on its own instead of asking the user whether
  // it worked. It also polls while waiting, so a dropped WS doesn't leave the
  // step stuck on "waiting" after the install has actually succeeded.
  useEffect(() => { if (nodeCount > 0 && step === 2) onDone?.(); }, [nodeCount]);
  useEffect(() => {
    if (hasNode || step !== 2 || !onPollNodes) return;
    const timer = setInterval(onPollNodes, 5000);
    return () => clearInterval(timer);
  }, [hasNode, step, onPollNodes]);

  const done = hasModel && hasNode;

  return createPortal(
    <ModalBackdrop onClose={onClose}>
      <div className="modal modal-lg onboarding-modal" onClick={e => e.stopPropagation()}>
        <h2>{done ? '设置完成 🎉' : '先完成两步设置'}</h2>
        <p className="muted">
          AgentHub 需要两样东西才能开始工作:一个模型中转站(agent 去哪里请求模型),以及至少一台执行机器(agent 在哪里跑)。
        </p>

        <ol className="onboarding-steps">
          <li className={`onboarding-step ${hasModel ? 'done' : step === 1 ? 'current' : ''}`}>
            <button type="button" className="onboarding-step-head" onClick={() => setStep(1)}>
              <span className="onboarding-step-mark">{hasModel ? '✓' : '1'}</span>
              <span className="onboarding-step-title">配置模型</span>
              <span className="muted">{hasModel ? '已配置' : '填一次,自动同步到你所有机器'}</span>
            </button>
            {step === 1 && (
              <div className="onboarding-step-body">
                <ModelProfilesSection onChange={list => {
                  if (!list.length) return;
                  onDone?.();
                  // Collapse this step the moment a relay exists — leaving the
                  // whole form open under a green ✓ reads as "still to do".
                  setStep(s => (s === 1 ? 2 : s));
                }} />
                {hasModel && (
                  <button type="button" onClick={() => setStep(2)}>下一步:添加机器 →</button>
                )}
              </div>
            )}
          </li>

          <li className={`onboarding-step ${hasNode ? 'done' : step === 2 ? 'current' : ''}`}>
            <button type="button" className="onboarding-step-head" onClick={() => setStep(2)}>
              <span className="onboarding-step-mark">{hasNode ? '✓' : '2'}</span>
              <span className="onboarding-step-title">添加执行机器</span>
              <span className="muted">{hasNode ? `已接入 ${nodeCount} 台` : '在那台机器上跑一条命令'}</span>
            </button>
            {step === 2 && (
              <div className="onboarding-step-body">
                {hasNode ? (
                  <p className="ok-note">已经有 {nodeCount} 台机器接入,可以开始建对话了。</p>
                ) : (
                  <>
                    <p className="muted">
                      在你想让 agent 干活的那台机器上执行下面的命令。装好后它会自动出现在这里,这个窗口会自己更新。
                    </p>
                    <p className="muted onboarding-waiting"><span className="thinking-dots"><span /><span /><span /></span> 正在等待机器接入…</p>
                    <NodeInstallPanel />
                  </>
                )}
              </div>
            )}
          </li>
        </ol>

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            {done ? '开始使用' : '稍后再说'}
          </button>
        </div>
      </div>
    </ModalBackdrop>,
    document.body,
  );
}

// Whether this account still needs the wizard. Model profiles aren't in the
// shared store (only Settings ever needed them), so they're fetched here;
// nodes already stream into state via the WS.
export function useSetupStatus(authed) {
  const [hasModel, setHasModel] = useState(null); // null = still unknown
  useEffect(() => {
    if (!authed) { setHasModel(null); return; }
    let cancelled = false;
    api.modelProfiles()
      .then(r => { if (!cancelled) setHasModel((r.profiles || []).length > 0); })
      // A failed check must not pop a setup wizard at someone whose account is
      // fine — treat unknown as "configured" and stay quiet.
      .catch(() => { if (!cancelled) setHasModel(true); });
    return () => { cancelled = true; };
  }, [authed]);
  return { hasModel, refresh: () => api.modelProfiles().then(r => setHasModel((r.profiles || []).length > 0)).catch(() => {}) };
}
