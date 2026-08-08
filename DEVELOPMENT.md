# AgentHub 开发文档

> 一个自托管的 AI 编码 Agent 任务中枢:agent 常驻在自己的服务器上,通过 Cloudflare 从任何设备(浏览器/手机)访问,以任务看板 + 聊天面板取代终端和分散的对话框。
>
> 本文档交给 Claude Code 作为开发依据。按里程碑顺序实现,每个里程碑结束时应有可运行的产物。

---

## 1. 需求背景与目标

### 1.1 用户现状与痛点

- 用户是 LLM 研究者,拥有一台或多台 GPU 服务器(如 8×H100),日常通过 VS Code Remote-SSH 连接服务器,用 Claude Code(VS Code 插件/终端)进行开发。
- 痛点一:**每天重连**。SSH 会话不持久,每天要重新连接、重新打开多个对话窗口,工作状态无法延续。
- 痛点二:**对话框即任务**。多个并行任务靠开多个对话窗口管理,没有全局视图,容易遗忘和混乱。
- 痛点三:**终端交互体验差**。tmux 中滚动历史消息体验糟糕(TUI 画布不是结构化数据);用户已基本不看代码本身,更关心任务进展、diff 和决策点。
- 用户通过 **API 中转站** 访问 Claude 模型(有自己的 base URL 和 API key),不使用官方订阅直连。

### 1.2 产品目标(v1,通用版)

1. **Agent 常驻服务器**:agent 会话由服务器上的 daemon 管理,7×24 存活,与用户的连接状态解耦。用户合上电脑,任务继续跑。
2. **Web 看板为主界面**:任务卡片(Kanban)组织工作;每张卡点开是一个结构化聊天面板(markdown 渲染、工具调用折叠、diff 高亮、流畅滚动),体验对标 VS Code 插件。
3. **随处可达**:前端部署在 Cloudflare Pages,手机/浏览器直接访问,服务器不暴露任何入站端口。
4. **推送通知**:agent 完成任务、等待人工决策、出错时,通过 Web Push 通知用户。
5. **多服务器**:支持注册多台执行服务器(可能不在同一内网),统一在一个看板管理。
6. **VS Code 接力**:任何会话可以随时切换到 VS Code / 终端里用官方 Claude Code 继续(基于 session resume),看板与 IDE 共享同一会话状态。

### 1.3 明确不做(v1 砍掉,留给 v2)

- GPU 调度器、实验监控/自动诊断等科研专属组件
- 多 agent 协作、自动任务分解
- 记忆层(向量检索、自动摘要)
- 语音交互
- 数据集/checkpoint 跨机同步

---

## 2. 总体架构

```
┌─────────────┐        ┌──────────────────────────────┐
│  手机/浏览器  │◄──────►│  Cloudflare                   │
│  (Pages 前端) │  HTTPS │  ├─ Pages: React 看板前端       │
└─────────────┘  WS/SSE│  ├─ Worker: API 网关 (Hono)     │
                        │  ├─ Durable Object: Hub(状态协调)│
                        │  ├─ D1: 任务/消息/节点 持久化      │
                        │  └─ Web Push (VAPID)           │
                        └──────────▲───────────────────┘
                                   │ 仅出站 WebSocket(每台服务器一条)
              ┌────────────────────┼────────────────────┐
              │                    │                    │
      ┌───────┴───────┐    ┌───────┴───────┐    ┌───────┴───────┐
      │ 服务器 A        │    │ 服务器 B       │    │ 服务器 C ...   │
      │ executor daemon│    │ executor daemon│    │               │
      │ ├─ Agent SDK 会话│   │                │    │               │
      │ ├─ worktree 管理 │   │                │    │               │
      │ ├─ 本地 SQLite   │   │                │    │               │
      │ └─ ttyd(应急终端)│   │                │    │               │
      └───────────────┘    └───────────────┘    └───────────────┘
```

### 2.1 职责划分

| 层 | 职责 | 不负责 |
|---|---|---|
| **executor daemon**(每台服务器) | 运行 agent 会话(Agent SDK)、git worktree 管理、执行现场的本地持久化、事件上报、会话租约 | 全局任务队列、用户认证、推送 |
| **Cloudflare Worker + DO** | 全局任务状态机、节点注册与心跳、事件路由与广播、用户认证、Web Push | 运行任何 agent、执行任何代码 |
| **D1** | 任务、消息、节点、订阅的持久化(全局视图) | 执行现场的真相(见 2.2) |
| **Pages 前端** | 看板 UI、聊天面板、diff 视图、通知订阅 | 业务逻辑 |

### 2.2 核心一致性原则(必须遵守)

**执行现场的真相在本地,全局视图的真相在云端;重连对账时,本地覆盖云端。**

- executor 对自己正在运行的会话/任务状态,以本地 SQLite 为准。
- 断网期间 executor 继续正常运行任务,事件在本地排队(带单调递增 seq)。
- 重连后 executor 回放未确认事件,DO 按 seq 幂等吸收,**不得**用云端过期状态反向覆盖 executor。
- 节点心跳超时(建议 60s)后,DO 将节点标记 `offline`,其上任务标记 `unknown`,并推送通知;恢复后由对账流程修正。

---

## 3. 技术选型

| 组件 | 选型 | 理由 |
|---|---|---|
| executor daemon | **Node.js 20+ / TypeScript** | 与 `@anthropic-ai/claude-agent-sdk` 同生态,SDK 自带 Claude Code 二进制 |
| Agent 运行时 | **`@anthropic-ai/claude-agent-sdk`**(注意:不是已弃用的 `@anthropic-ai/claude-code` SDK 包名) | 与 CLI 同引擎,结构化 JSON 消息流,支持 resume |
| 本地存储 | SQLite(`better-sqlite3`) | 单文件、零运维 |
| daemon↔云 通道 | executor 主动发起的 WebSocket(断线重连 + 指数退避) | 服务器零入站端口 |
| Worker 框架 | **Hono** | 轻量,DO/Pages 兼容好 |
| 全局状态 | **1 个 Hub Durable Object**(v1 单用户,单 DO 足够)+ **D1** | DO 做串行化协调与 WS 广播,D1 做持久化查询 |
| 前端 | **React + Vite**,部署 Cloudflare Pages | 生态成熟 |
| 前端↔Worker 实时通道 | WebSocket(浏览器 → Worker → DO) | 双向:下发用户消息,上行 agent 事件流 |
| 推送 | Web Push(VAPID),Worker 端实现 | 免费、无需 APP |
| 应急终端 | ttyd(仅监听 127.0.0.1)+ cloudflared tunnel | 抢修后门,平时不用 |
| 认证 | 单用户:长随机 Bearer token(前端登录页输入一次,存 localStorage);executor 用独立的 node token | v1 不做多用户 |

---

## 4. 模型接入(中转站配置)——重要

用户通过中转站访问 Anthropic API。**所有 agent 会话必须走中转站**,配置方式:

1. executor daemon 的配置文件(`executor.config.json`)包含:
   ```json
   {
     "anthropic": {
       "baseUrl": "https://<用户的中转站域名>",
       "apiKey": "<用户的 key>"
     }
   }
   ```
   实际值由用户在部署时填入,**严禁写死或提交到 git**(提供 `executor.config.example.json`,真实配置加入 `.gitignore`)。
2. daemon 启动 agent 会话时,通过 SDK 的 `env` 选项(或进程环境)注入:
   - `ANTHROPIC_BASE_URL=<baseUrl>`
   - `ANTHROPIC_API_KEY=<apiKey>`
   - 同时确保不继承宿主机可能存在的 `ANTHROPIC_AUTH_TOKEN`/登录态,避免绕过中转站。
3. **计费含义**:走 API key 即按中转站计费,与 Claude 订阅额度无关。stream-json 的 `result` 事件带 `total_cost_usd` 等元数据 —— 将其记录到任务卡并在前端显示每张卡的累计成本(中转站计价可能不同,标注为"参考成本")。
4. 兼容性验证(里程碑 M0 的一部分):先用最小脚本验证 SDK + 该中转站可以完整跑通一次带工具调用的会话(中转站需支持 streaming 与 tool use 透传)。如不支持 streaming,fallback 方案是 CLI `-p --output-format stream-json` 模式,但优先 SDK。

---

## 5. 数据模型

### 5.1 D1(全局)

```sql
-- 执行节点
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,            -- 用户命名,如 "h100-lab"
  token_hash TEXT NOT NULL,       -- 节点认证 token 的哈希
  labels TEXT DEFAULT '[]',       -- JSON 数组,如 ["gpu","cuda12"]
  status TEXT DEFAULT 'offline',  -- online | offline
  last_heartbeat_at INTEGER,
  created_at INTEGER
);

-- 任务卡
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,            -- ulid
  title TEXT NOT NULL,
  spec TEXT NOT NULL,             -- 用户写的任务描述(首条 prompt)
  repo_url TEXT,                  -- 可为空(非代码任务)
  base_branch TEXT DEFAULT 'main',
  node_id TEXT,                   -- 指派的节点;v1 由用户创建时手选
  status TEXT NOT NULL,           -- 见 5.3 状态机
  session_id TEXT,                -- Claude Code 会话 id(启动后回填)
  branch_name TEXT,               -- agent 工作分支,如 task/<id>
  lease TEXT DEFAULT 'daemon',    -- daemon | human  (会话租约,见 §8)
  cost_usd REAL DEFAULT 0,
  last_seq INTEGER DEFAULT 0,     -- 已吸收的最大事件 seq(对账用)
  created_at INTEGER, updated_at INTEGER
);

-- 消息/事件(聊天面板的数据源)
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,           -- 节点内单调递增,幂等键 = (task_id, seq)
  role TEXT NOT NULL,             -- user | assistant | tool_use | tool_result | system | result
  content TEXT NOT NULL,          -- JSON:原样保存 SDK 消息体
  created_at INTEGER,
  UNIQUE(task_id, seq)
);

-- Web Push 订阅
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  subscription TEXT NOT NULL,     -- JSON
  created_at INTEGER
);
```

### 5.2 executor 本地 SQLite

- `local_tasks`:本节点承接的任务及其运行时状态(pid、worktree 路径、session_id、lease)。
- `outbox`:待上报事件队列(`task_id, seq, payload, acked`)。事件先写 outbox 再发送,收到 DO 的 ack 才标记;重连后回放所有未 ack 事件。

### 5.3 任务状态机

```
queued ──► starting ──► running ──► waiting_human ──► running (用户回复后)
                          │              │
                          │              └──► review (agent 声明完成) ──► done
                          ├──► failed
                          └──► unknown (节点失联)      review ──► running (用户提出修改)
任何状态 ──► cancelled (用户取消)
```

- `waiting_human`:agent 触发需要许可的操作或明确提问时进入(触发 Web Push)。
- `review`:agent 会话结束(result 事件)且未失败时进入(触发 Web Push);用户在 review 界面看 diff,可"继续对话"(回到 running,基于 resume)或标记 done。
- 状态变更全部由 DO 串行执行,写 D1 并广播给所有前端连接。

---

## 6. executor daemon 详细设计

### 6.1 进程结构

单进程 Node 服务,以 systemd 部署(提供 `agenthub-executor.service` 模板,`Restart=always`)。模块:

- **CloudLink**:与 Worker 的 WebSocket。注册(`node_id` + token)、心跳(每 20s)、收指令、发事件(经 outbox)。
- **SessionManager**:每个 running 任务对应一个 SDK 会话。
- **WorktreeManager**:任务启动时 `git worktree add ../wt-<taskId> -b task/<taskId>`(仓库不存在则先 clone);任务 done/cancelled 后保留 worktree 与分支(用户手动清理或 v2 做回收)。无 repo 的任务在 `~/agenthub/scratch/<taskId>` 下建纯目录。
- **TerminalGateway**:按需拉起 ttyd 绑定某任务的 worktree 目录(127.0.0.1 随机端口),通过 cloudflared tunnel 暴露,返回一次性 URL。v1 可以只实现"在服务器上打印如何手动 attach 的命令",完整 ttyd 集成放低优先级。

### 6.2 会话生命周期(核心逻辑)

启动任务(收到 DO 指令 `start_task`):

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const stream = query({
  prompt: task.spec,                     // 后续消息通过 streaming input 追加
  options: {
    cwd: worktreePath,
    permissionMode: "acceptEdits",       // 文件编辑放行;Bash 等仍走 canUseTool
    allowedTools: ["Read","Edit","Write","Grep","Glob","Bash"],
    env: { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY },  // §4 中转站
    // 配置显式化:不要依赖交互模式的环境自动发现。
    // CLAUDE.md / MCP / hooks 如需要,一律在此显式声明(settingSources / mcpServers)。
    resume: task.session_id ?? undefined // 续聊时传入
  }
});
for await (const msg of stream) { handleMessage(task, msg); }
```

`handleMessage` 职责:

1. 每条消息 → 分配 `seq` → 写本地 → 入 outbox 上报(原样 JSON,前端负责渲染)。
2. `system/init` 消息 → 提取 `session_id` 回填任务。
3. **canUseTool 回调**(危险操作,如未预授权的 Bash 命令):暂停等待 → 任务状态置 `waiting_human` → 上报含工具名与参数的决策请求 → 用户在前端点"允许/拒绝"→ DO 下发 `human_decision` → 回调 resolve。设置超时(如 4 小时)自动拒绝并进入 `waiting_human` 保持态。
4. `result` 消息 → 记录 cost → 生成 diff 摘要(`git diff base_branch...HEAD --stat` + 完整 diff 存为一条 `system` 消息)→ 状态置 `review`。
5. 进程/流异常 → 状态 `failed`,附错误信息。

用户追问(`review` 或 `waiting_human` 后的普通回复):用 `resume: session_id` 重新发起 query,prompt 为用户消息,状态回 `running`。

### 6.3 并发与资源

- 每节点最大并行会话数可配置(默认 3),超出的任务在 DO 侧保持 `queued`。
- 每个会话设 `maxTurns`(默认 100)与单任务成本上限(默认 $10,超过转 `waiting_human` 询问是否继续)作为失控保险丝。

---

## 7. Cloudflare 侧详细设计

### 7.1 Worker 路由(Hono)

```
POST   /api/login                    # 校验用户 token,签发短期 JWT(或直接用 token,v1 从简)
GET    /api/tasks                    # 列表(D1)
POST   /api/tasks                    # 创建任务 {title, spec, repo_url?, node_id}
GET    /api/tasks/:id/messages?after_seq=  # 历史消息分页(D1)
POST   /api/tasks/:id/message        # 用户发消息(转发 DO → executor)
POST   /api/tasks/:id/decision       # 允许/拒绝工具调用
POST   /api/tasks/:id/lease          # 申请/归还会话租约(§8)
POST   /api/tasks/:id/cancel
GET    /api/nodes                    # 节点列表与状态
POST   /api/push/subscribe           # 保存 Web Push 订阅
GET    /ws/frontend                  # 前端 WS,升级后转交 Hub DO
GET    /ws/executor                  # executor WS(node token 认证),转交 Hub DO
```

### 7.2 Hub Durable Object

- 持有两类 WS 连接:前端(多个)与 executor(每节点一个)。
- **事件上行**:executor 事件 → 按 `(task_id, seq)` 幂等写 D1 → 更新任务状态 → 广播给前端 → 判定是否触发 Web Push(`waiting_human` / `review` / `failed` / 节点离线)→ 回 ack(`task_id, seq`)。
- **指令下行**:前端操作 → 校验状态机合法性 → 写 D1 → 下发对应 executor(`start_task` / `user_message` / `human_decision` / `cancel_task`)。目标节点离线时指令入 D1 待发队列,节点上线后补发。
- **心跳管理**:用 DO alarm 每 30s 扫描,超 60s 无心跳的节点标 offline 并推送。
- **对账**:executor 重连时上报每个本地任务的 `{task_id, status, last_seq}`,DO 以此为准修正 D1,并请求补发 `last_seq` 之后缺失的事件。

### 7.3 Web Push

- Worker 存 VAPID 密钥(wrangler secret)。
- 触发场景与文案:
  - `waiting_human`:"[任务标题] 在等你决策:<工具名>"
  - `review`:"[任务标题] 完成,待 review(改动 N 个文件)"
  - `failed` / 节点 offline:对应错误摘要。
- 点击通知深链到对应任务卡。

---

## 8. 会话租约与 VS Code 接力

同一 Claude Code 会话**不能双端同时驱动**(会话文件写冲突)。设计:

- 任务的 `lease` 字段:`daemon`(默认)或 `human`。
- 用户在任务卡点 **"在 IDE 中接管"**:
  1. 前端调 `/api/tasks/:id/lease` 申请 → DO 通知 executor → executor 若有活动会话则等当前轮结束后停止驱动 → lease 置 `human`。
  2. 前端展示接管指引:`ssh <node>` 后执行 `claude --resume <session_id>`(或 VS Code 插件里恢复该会话)。**注意提醒用户:IDE 侧也需配置同样的 ANTHROPIC_BASE_URL/API key 环境变量,否则接力后走不了中转站。**
  3. 接管期间看板对该卡只读(仍可看历史),状态显示"IDE 接管中"。
- 用户点 **"归还"**:lease 回 `daemon`,daemon 下次驱动前先读取会话文件同步 IDE 期间产生的新消息(通过 `--resume` 自然获得完整上下文;消息展示层面,v1 允许 IDE 期间的消息在看板上缺失,标注"此段在 IDE 中进行"即可,完整回填放 v2)。

---

## 9. 前端设计(Pages)

### 9.1 页面结构

- **看板页**(默认):按状态分列(Queued / Running / Waiting / Review / Done)的任务卡片;卡片显示标题、节点、状态时长、成本;顶部节点健康条(每节点在线状态与并行数)。
- **任务详情页**:左侧(或移动端全屏)聊天面板,右侧 Tab:Diff 视图 / 任务信息 / 操作(接管、终端、取消)。
- **新建任务**:标题 + spec(多行)+ 选择节点 + 可选 repo/分支。
- **登录页**:输入 access token。

### 9.2 聊天面板渲染要求(体验核心,对标 VS Code 插件)

- 消息按 `seq` 排序,虚拟滚动(历史可能数千条),支持无限上翻与"跳到最新"。
- `assistant` 文本:markdown 渲染(代码块高亮)。
- `tool_use`/`tool_result`:默认折叠为单行(图标 + 工具名 + 参数摘要,如 `Bash: pytest -x`),点击展开完整输入输出;Edit/Write 类工具展开后显示 diff 格式。
- `waiting_human` 决策请求:醒目卡片 + 允许/拒绝按钮。
- `result`:总结卡片(耗时、成本、改动文件统计)。
- 实时性:WS 收到新消息即追加;若用户正在上翻历史,不强制滚动到底部,显示"有新消息 ↓"浮标。
- 断线重连后按 `after_seq` 拉增量。

### 9.3 Diff 视图

- 数据来自 executor 在 `review` 时上报的完整 diff(unified 格式),前端用 diff 渲染库按文件分组展示,支持折叠。
- v1 只读;"针对某文件提意见"= 在聊天框引用文件名发消息。

---

## 10. 安全要求

- 服务器**零入站端口**:一切连接由 executor 出站发起;ttyd 仅绑定 localhost 且通过 tunnel 按需暴露。
- 三种凭据分离:用户 access token(前端)、node token(executor,逐节点独立、可吊销)、中转站 API key(仅存在于服务器配置文件,**绝不**经过 Cloudflare 或前端)。
- Worker 全部接口鉴权;WS 升级请求同样校验 token。
- agent 权限:默认 `acceptEdits` + Bash 走人工审批;`bypassPermissions` 仅允许用户在任务级显式开启并在 UI 上红色标注。
- 配置样例文件与 `.gitignore` 必须一开始就建好,防止密钥入库。

---

## 11. 仓库结构与里程碑

### 11.1 Monorepo 结构

```
agenthub/
├─ packages/
│  ├─ shared/        # 类型定义、事件协议、状态机常量(前后端共用)
│  ├─ executor/      # Node daemon
│  ├─ worker/        # Cloudflare Worker + DO(wrangler)
│  └─ web/           # React 前端(Pages)
├─ deploy/
│  ├─ agenthub-executor.service
│  └─ setup-node.sh  # 新节点一键安装脚本(装 daemon、填 token、注册)
└─ DEVELOPMENT.md
```

### 11.2 里程碑(每个结束时可运行、可演示)

**M0 — 打通链路(0.5 周)**
- 最小脚本:SDK + 中转站(baseUrl/apiKey)跑通一次带 Bash 工具调用的会话,打印 stream-json 消息流,验证 streaming/tool use 在中转站上可用,拿到 session_id 并成功 `resume` 一次。
- 产物:`packages/executor/scripts/smoke.ts`。**此项失败则先解决中转站兼容性,再继续。**

**M1 — 单机核心(1.5 周)**
- executor:SessionManager + WorktreeManager + 本地 SQLite + outbox。
- Worker/DO/D1:任务 CRUD、事件吸收与广播、状态机。
- 前端:看板 + 聊天面板(渲染要求 §9.2 全量)+ 新建任务。
- 验收:手机浏览器创建任务 → agent 在服务器上完成一次真实代码修改 → review 页看到 diff → 追问一轮 → 标记 done。全程不碰 SSH。

**M2 — 持久与通知(1 周)**
- Web Push 全场景;canUseTool 人工审批流;断网对账(拔网线测试:断网期间任务继续,恢复后事件补齐、状态正确);systemd 部署脚本;成本显示与保险丝。
- 验收:关掉所有客户端,agent 触发 Bash 审批 → 手机收到推送 → 点进去批准 → 任务继续。

**M3 — 多机与接力(1 周)**
- 节点注册/心跳/离线标记;setup-node.sh 一键加机;任务创建时选节点;会话租约与 IDE 接管流程;(可选)ttyd 应急终端。
- 验收:两台服务器各跑任务互不影响;其中一台断电,看板正确显示且另一台不受影响;一张卡成功接力到 VS Code 再归还。

### 11.3 开发注意事项(给 Claude Code 的提示)

- SDK 包名认准 `@anthropic-ai/claude-agent-sdk`(旧名 claude-code-sdk 已弃用);实现前先读一遍当前版本的 SDK 类型定义,`options` 字段名以实际类型为准,本文档中的字段名可能有出入。
- 事件协议(executor↔DO↔前端)先在 `packages/shared` 里用 TypeScript 类型 + zod schema 定死,再写两端。
- SDK 消息体原样透传存储,**前端渲染不要依赖手工解析文本**,只依赖消息的结构化字段。
- 所有时间戳用 epoch ms;所有 id 用 ulid。
- 每个里程碑写最小集成测试(尤其 M2 的对账逻辑,用注入假 WS 断连来测)。
