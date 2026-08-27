# AgentHub

自托管的 AI 编码 Agent 任务中枢:agent 常驻在你自己的机器上,通过 Cloudflare 从任何设备(浏览器/手机)访问,以任务看板 + 结构化聊天面板取代终端和分散的对话窗口。

```
手机/浏览器 ──HTTPS/WS──► Cloudflare Worker(看板前端 + API + Hub DO + D1 + Web Push)
                              ▲
                              │ 仅出站 WebSocket(零入站端口)
                    executor daemon(每台机器一个)
                    └─ 驱动 claude CLI(stream-json 双向流,走你的 API 中转站)
```

## 部署(一条命令)

前提:本机装有 Node ≥ 22、git、claude CLI;`deploy/.env` 已填好(Cloudflare token —— 该文件已 gitignore)。

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

## 使用

- **新建任务**:标题 + 任务描述(首条 prompt)+ 选节点,可选 repo(自动 clone + `git worktree add -b task/<id>`)。
- **状态机**:`queued → starting → running → waiting_human ⇄ running → review → done`;失败 `failed`、节点失联 `unknown`、随时可取消。
- **审批流**:agent 要跑未授权的 Bash 等操作时任务进入「等待决策」,手机收到推送,点开允许/拒绝(4 小时超时自动拒绝)。
- **Review**:每轮结束自动生成完整 diff(「变更」标签页),可继续对话或标记完成;每张卡持续显示累计参考成本,AgentHub 不按轮数或累计成本中断对话。
- **IDE 接力**:任务详情「信息」→「在 IDE 中接管」,然后在节点上 `claude --resume <session_id>`(注意 IDE 侧也要配置同样的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`);完事点「归还」。
- **断网**:executor 断网期间任务照跑、事件本地排队(outbox),重连后按 seq 幂等补齐;心跳超时 60s 节点标离线并推送。

## 目录结构

```
packages/shared/     协议常量、状态机、ulid(前后端共用,零依赖)
packages/executor/   常驻 daemon:node:sqlite 本地真相 + outbox、claude CLI 会话驱动
                     (stream-json 双向流 + can_use_tool 审批控制协议)、worktree 管理
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
npm test          # 单测 + 集成(不需要网络)
npm run smoke     # M0 冒烟:真实 claude CLI + 中转站,验证工具调用/审批路由/resume
```

## 安全

- 服务器零入站端口;三种凭据分离:用户访问令牌(前端)、节点 token(逐节点、存哈希、可换发)、中转站 API key(只存在于各节点本地配置,绝不经过 Cloudflare)。
- 默认权限模式 `acceptEdits`(自动编辑,Bash 需人工审批);`bypassPermissions` 需在建卡时显式选择并有红色警示。
- agent 输出经 allowlist sanitizer 后渲染,防注入。

## 排障

```bash
tail -f ~/agenthub/logs/executor.log        # executor 日志(macOS)
launchctl kickstart -k gui/$UID/com.agenthub.executor   # 重启 daemon
npx wrangler tail --config packages/worker/wrangler.generated.jsonc  # worker 实时日志
```
