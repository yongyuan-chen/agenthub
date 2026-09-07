# AgentHub

自托管的 AI 编码 Agent 任务中枢:agent 常驻在你自己的机器上,通过 Cloudflare 从任何设备(浏览器/手机)访问,以任务看板 + 结构化聊天面板取代终端和分散的对话窗口。

```
手机/浏览器 ──HTTPS/WS──► Cloudflare Worker(看板前端 + API + Hub DO + D1 + Web Push)
                              ▲
                              │ 仅出站 WebSocket(零入站端口)
                    executor daemon(每台机器一个)
                    ├─ 驱动 claude CLI(stream-json 双向流,走你的 API 中转站)
                    └─ 驱动 codex CLI(app-server JSON-RPC,走你的 API 中转站)
```

看板、审批、断线重连、diff、推送、定时任务对两种 agent 是同一套 —— 差异全部收在 executor 的 session 适配层里。

## 部署(一条命令)

前提:本机装有 Node ≥ 22、git,以及 claude CLI 和/或 codex CLI(装哪个就能跑哪个,节点会在握手时上报自己装了什么);`deploy/.env` 已填好(Cloudflare token —— 该文件已 gitignore)。

```bash
bash deploy/setup-all.sh
```

脚本会依次:构建前端 → 创建 D1 并建表 → 部署 Worker 到 `agenthub.win`(token 权限不足时自动回退 workers.dev)→ 引导创建管理员账号 → 注册本机为执行节点 → 写 `~/.agenthub/executor.config.json` → 安装 launchd/systemd 常驻服务 → 验证节点在线,最后打印**访问地址和管理员账号密码**。

手机打开地址 → 用管理员账号登录 → 在「设置」里保存一次模型中转站 Base URL / API Key(登录后会自动下发到你名下所有节点,以后新增节点无需再填)→ 建议「添加到主屏幕」并点 🔔 开启推送。

### 加更多服务器(M3)

在新机器上 clone 本仓库后,用你的账号登录网页版拿到会话 token(或直接在网页「添加节点」对话框里复制现成的一行命令,已经带好 token):

```bash
APP_URL=https://agenthub.win USER_TOKEN=<你的会话 token> \
bash deploy/setup-node.sh my-h100-box
```

无需再传中转站地址 / API Key —— 只要这台服务器和第一台属于同一个账号,登录后保存过的模型配置会自动同步过来。

### 升级

节点在握手时上报协议版本。**协议版本落后的节点会被明确标记为不可派单**(建卡时直接报错让你去升级),而不是收到看不懂的字段后静默跑错。升级顺序:**先升所有 executor 节点,再部署 worker**。

## 使用

- **新建任务**:标题 + 任务描述(首条 prompt)+ 选节点,可选 repo(自动 clone + `git worktree add -b task/<id>`)。
- **选后端 = 选模型档案**:档案同时钉住「用哪个 agent CLI」和「走哪个中转站」,所以「切换模型」也就是「切换后端」。已经产生会话的卡不能跨后端切换(两边的 session ID 不通用),服务端会直接拒绝。
- **状态机**:`queued → starting → running → waiting_human ⇄ running → review → done`;失败 `failed`、节点失联 `unknown`、随时可取消。
- **审批流**:agent 要跑未授权的 Bash 等操作时任务进入「等待决策」,手机收到推送,点开允许/拒绝(4 小时超时自动拒绝)。
- **Review**:每轮结束自动生成完整 diff(「变更」标签页),可继续对话或标记完成;每张卡持续显示累计参考成本,AgentHub 不按轮数或累计成本中断对话。
- **IDE 接力**:任务详情「信息」→「在 IDE 中接管」,executor 会把**这台节点上的完整命令**贴进对话(命令里的隔离目录只有节点自己知道):claude 是 `CLAUDE_CONFIG_DIR=<workRoot>/claude-config claude --resume <session_id>`,codex 是 `CODEX_HOME=<workRoot>/codex-home codex resume <session_id>` —— 这两个环境变量都**不能省**,否则 CLI 会去 `~/.claude` / `~/.codex` 找,报会话不存在。IDE 侧同样要配好中转站。完事点「归还」。
- **定时任务**:claude 侧扫任务目录里的 `.claude/scheduled_tasks.json`(agent 自己用 CronCreate 建的,5 段 cron);codex 侧扫 `CODEX_HOME/automations/*/automation.toml`(RRULE),按 `target_thread_id` 投给对应的卡 —— 于是**你在 Codex 桌面 App 里建的自动化,不开 App 也能在服务器上跑**,结果推到手机。两边互不串门。
- **断网**:executor 断网期间任务照跑、事件本地排队(outbox),重连后按 seq 幂等补齐;心跳超时 60s 节点标离线并推送。

## Codex 后端注意事项

- **中转站必须支持 `POST /v1/responses`。** Codex 只剩 `wire_api = "responses"` 一种(`chat` 已被上游移除),所以一个能跑 claude 的中转站不一定能跑 Codex。建 Codex 档案时前端会提示这一点。
- **Codex 档案不能做账户默认档案。** 默认档案是「没钉档案的卡」用的中转站,而那些卡跑的都是 claude;把 Codex 档案设成默认会让它们集体失败,服务端返回 409。账户的第一个 **claude** 档案会自动成为默认。
- **已验证版本:codex `0.144.6`。** `codex app-server` 上游标着 `[experimental]`,升级 codex 后如果 Codex 卡起不来,先看 `~/agenthub/logs/executor.log` 里的握手报错。
- Codex 不上报美元成本(只有 token),所以 Codex 卡的「成本」显示为用量而不是金额 —— 不是坏了,是不编造。自动压缩阈值按 Codex 自报的上下文窗口算,比 claude 侧的固定常量更准。

## 目录结构

```
packages/shared/     协议常量、状态机、ulid(前后端共用,零依赖)
packages/executor/   常驻 daemon:node:sqlite 本地真相 + outbox、worktree 管理,以及两个后端:
                     session.mjs / sessions.mjs      claude CLI(stream-json 双向流 + can_use_tool)
                     codex-session.mjs               codex app-server(JSON-RPC)
                     codex-sessions.mjs              codex rollout jsonl 读取(无活进程时的增量尾随)
                     codex-automations.mjs           automation.toml + RRULE 子集
                     backends.mjs                    落盘/转录层的后端适配表
packages/worker/     Cloudflare Worker:路由/鉴权 + Hub DO(WS hibernation、事件吸收、
                     心跳 alarm、对账)+ D1 schema + Web Push(WebCrypto 实现 RFC8291/8292)
packages/web/        React 19 看板前端,esbuild 构建,产物由 Worker assets 直接托管
deploy/              一键部署/加机脚本、launchd/systemd 模板、VAPID 生成
tests/               单测 + 进程内集成测试(真实 executor 模块 ↔ 真实 hub-core,假 WS/假 D1)
```

## 一致性原则(实现要点)

**执行现场的真相在本地,全局视图的真相在云端;重连对账时本地覆盖云端。**

- executor 每条事件先写本地 outbox(`(task_id, seq)` 单调递增)再上报;云端 `INSERT OR IGNORE` 按 `(task_id, seq)` 幂等吸收并回 ack。
- 重连时 executor 上报各任务 `{status, lastSeq}`,DO 以 executor 为准修正 D1,并让 executor 补发 `lastSeq` 之后的事件。
- 任务级字段(status/session/cost)只按 seq 前进,回放与实时交错不会回退状态。

## 测试

```bash
npm test             # 单测 + 集成(不需要网络、不花钱,假子进程 + 假 WS + 假 D1)
npm run smoke        # 真实 claude CLI + 中转站,验证工具调用/审批路由/resume
npm run smoke:codex  # 真实 codex + 中转站,验证工具调用/审批路由/compact/resume
```

两个 smoke 都消耗真实额度,所以不在 `npm test` 里,手动触发。`smoke:codex` 的中转站要单独指定
(节点默认档案是 claude 档案):`CODEX_SMOKE_BASE_URL=... CODEX_SMOKE_API_KEY=... npm run smoke:codex`。

## 安全

- 服务器零入站端口;三种凭据分离:用户访问令牌(前端)、节点 token(逐节点、存哈希、可换发)、中转站 API key(只存在于各节点本地配置,绝不经过 Cloudflare)。
- 默认权限模式 `acceptEdits`(自动编辑,Bash 需人工审批);`bypassPermissions` 需在建卡时显式选择并有红色警示。Codex 侧映射为 `approvalPolicy`/`sandbox`:`acceptEdits → on-request / workspace-write`,`default → untrusted / workspace-write`,`bypassPermissions → never / danger-full-access`。
- agent 输出经 allowlist sanitizer 后渲染,防注入。

## 排障

```bash
tail -f ~/agenthub/logs/executor.log        # executor 日志(macOS)
launchctl kickstart -k gui/$UID/com.agenthub.executor   # 重启 daemon
npx wrangler tail --config packages/worker/wrangler.generated.jsonc  # worker 实时日志
```
