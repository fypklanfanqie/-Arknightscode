# P0 技术侦查结论 — Arknights Code × DSH 迁移

> 状态：进行中。每完成一个 Spike 就把结论钉进本文件。
> 钉版目标：`@deepseek-ai/dsh@0.1.1-rc.2`（2026-08-27 时点 latest / next 均为此版本）
> 环境：Windows 11，Node v24.18.0（满足 DSH ≥22.19 要求）

---

## S1 npm 包自足性验证【决策门】

**结论：通过（带两个注意事项）**

- `npm pack @deepseek-ai/dsh@0.1.1-rc.2` 得 33KB tarball / 20 文件 —— 是聚合器型 CLI，
  package.json dependencies 声明约 **60 个同版本 `^0.1.1-rc.2` 的 @deepseek-ai/* 工作分包**
  （dsh-base、dsh-web-app、persona、plan-mode、全部 tool-* 等）+ cordis 内核，
  全部经普通 npm 分发。→ 分发路线确定：**npm 包即最终产物**，
  `scripts/fetch-dsh.mjs` 走「npm install 锁定版本 + 校验」即可，无需 submodule/源码构建。
- ⚠️ 注意事项 1：依赖里有 `node-addon-require-builtin`（原生模块加载器）。
  已在 P5 打包阶段验证其 node.exe 下可用性；Host 用便携 Node 24 跑（不用 Electron ABI）。
- ⚠️ 注意事项 2：60 个传递依赖 → 安装偏慢（本次实测 >10 分钟，普通家宽+国内网络）。
  打包期用 `npm ci --omit=dev` 预装配进安装包，用户端零安装。

实测记录：
- [x] npm pack 成功（33KB 聚合器 + ~60 个同版本依赖，全部普通 npm 分发）
- [x] 干净目录 `npm install @deepseek-ai/dsh@0.1.1-rc.2` 完成（197 包，>10min 国内网络）
- [x] `dsh --version` → `0.1.1-rc.2`
- [x] `DSH_HOME=<自定义>` + `dsh web --no-open --port 0` 成功启动，
      输出 `dsh web: http://127.0.0.1:4303`（OS 自动选端口），curl 首页 HTTP 200

**S1 判据全过 → 分发路线锁定为 npm 包。**

## S2 启动参数面

**结论：**

CLI launcher 自有 flags（bin.js 源码核实）：`--profile <name>`、`--patch <path>`(可重复)、
`--dump-config`、`--dump-default-config`；`web` 是 `--profile web` 硬编码别名；
`plugin --profile <name> <pnpm参数…>` 把参数原样转发给 profile 目录内的 pnpm。

Web app flags（`dsh web --help` 实测捕获）：
```
--host <host>                  bind host（默认 127.0.0.1）
--no-open                      不开浏览器
--port <port>                  监听端口；传 0 让 OS 挑空闲端口
--trusted-host <authority...>  /api 浏览器信任围栏的额外 authority（可重复）
```

环境变量：
- **`DSH_HOME` 重定向实测有效**（profile/storages 全部落在指定目录）
- CLI 内还有 `DSH_TELEMETRY_MODE`（默认 DISABLED）等开关
- 默认 home 为 `$DSH_HOME` 或用户主目录下 `.dsh`（home-paths 包解析）

**host 启动向量定稿（P1 修正 —— 原定稿是错的）：**
```
node dsh/lib/bin.js --profile arknights --no-open --port 0
env DSH_HOME=<userData>/dsh-home DEEPSEEK_API_KEY=...
```
⚠️ **绝不能写成 `dsh web`**：`web` 是 `--profile web` 的硬编码别名（bin.js 第 91-94 行），
会去读 `profiles/web/cordis.patch.yml`（那是空的），我们挂在 arknights profile 上的插件
**永远不会被加载** —— 表现为 `/bridge/*` 全部 404，host 不报任何错，极难排查。
（`--profile <name>` 之后的 `--no-open` / `--port` 由 `passThroughOptions` 转交 web-app。）

**profile 组装机制实测确认**（迁移的核心机制成立）：
- 首次 boot 自动在 `$DSH_HOME/profiles/<name>/` 落地四文件：
  `package.json`（`dsh.profile.bundles: ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]`）、
  `cordis.yml`(root, 空)、`cordis.patch.yml`(空补丁层)、`pnpm-workspace.yaml`
- **bundle 叠加顺序** = bundles 数组序 → profile 用户层(cordis.patch.yml) →
  home 层($DSH_HOME/cordis.patch.yml) → --patch overlays → telemetry 开关
- 用户插件经 `dsh plugin --profile arknights add <pkg>` 安装进该 profile 的依赖
- `--dump-config` 可打印整棵组合树（CI 升级冒烟用）；web-app 通过 patch 把
  host/port 注入 `@deepseek-ai/dsh-host-webserver`（`ctx.webStartup.port ?? 3080`）

## S3 provider schema 实测

**结论：9 家预设全部可平移，双通道覆盖。**

运行时实测：`supportedProtocols()` → `["openai-completions", "openai-responses", "anthropic-messages"]`
——**存在 anthropic-messages 协议**，现有以 `/anthropic` 端点为口径的供应商几乎 1:1 平移。

pi-ai 内置 catalog 已含 36 个 provider id，与本项目相关的：
`deepseek`、`anthropic`、`openrouter`、`moonshotai`/`moonshotai-cn`、`kimi-coding`、
`qwen-token-plan(-cn)`、`minimax(-cn)`、`zai(-coding-cn)` 等 —— catalog 路由连 baseURL 都不用写。

schema（README 权威定义 + settings namespace `llm-pi-ai:`）：

```yaml
llm-pi-ai:
  providers:
    <routeId>:
      apiKeyEnv: <ENV_NAME>          # 凭据引用，逐请求解析环境变量；密钥不落配置文件
      api: anthropic-messages        # 仅 hand-declared 路由必填；catalog 路由继承
      baseURL: https://...           # catalog 路由可省
      compat: { thinkingFormat, supportsDeveloperRole, maxTokensField, supportsTemperature }
      models: [{id, name?, contextWindow?, maxTokens?}]  # 声明即整体替换 catalog
      modelOverrides: {<modelId>: {...}}                 # 改单个模型，catalog 其余保留
      reasoning: high                # 部署默认思维档
```

**preset→provider 映射草案（9 家全量）**：

| 本项目 preset | DSH route | 协议 | 说明 |
|---|---|---|---|
| deepseek | `deepseek`（catalog） | 官方适配 | 只需 `apiKeyEnv: DEEPSEEK_API_KEY`；`agent-default-model` 默认即 deepseek-v4-flash |
| anthropic | `anthropic`（catalog） | catalog | 直接用 |
| openrouter | `openrouter`（catalog） | catalog | 模型带 org/ 前缀，models 从 preset 的 4 个平移 |
| siliconflow | 手声明 `siliconflow` | openai-completions | `baseURL: https://api.siliconflow.cn/v1` + models 列表 |
| dashscope(百炼) | 手声明 `bailian-coding` | **anthropic-messages** | coding-plan 专用端点 + sk-sp key 平移 |
| volcano(方舟) | 手声明 `volcano-coding` | anthropic-messages | 同上（/api/coding 口径） |
| tencent(混元) | 手声明 `hunyuan-coding` | anthropic-messages | /coding/anthropic 口径 |
| moonshot(Kimi) | `moonshotai-cn`(catalog) 或手声明 kimi-coding | catalog | kimi-k2.5 |
| qianfan(千帆) | 手声明 `qianfan-coding` | anthropic-messages | /anthropic/coding 口径 |

补充事实：
- 配置节是 dict 且 settings 用户层按 provider 键合并，「下一条请求生效、无需重启」
- 无效 profile 在**写入时被拒**（settings-rejected），不会静默挂掉
- 密钥必须走 `apiKeyEnv` 引用（headers 内联密钥是已知反模式且会被明文展示）
- `ctx.llm.listConfigurableProviders()` 可编程枚举可配供应商（控制台设置页数据源）

写入位置采用计划首选 B：**profile 的 cordis.patch.yml 或 home 层 $DSH_HOME/cordis.patch.yml 承载 providers 节**
（S2 已确认两层 patch 机制真实存在），实际用哪层在 P3 定（倾向 home 层=跨 profile 免疫）。

## S4 审批短路语义【原命题修正：存在两层 seam】

**结论：直裁 + 应答双层并存，arknights-bridge 两层都要接。**

原计划假设「tools/pre-execute 瀑布直裁能否短路默认审批 UI」是二选一。实测是**两级串联**：

1. **工具层决策** `PreToolDecision = allow | deny(reason) | ask(reason?)`
   —— 白名单内工具在此直裁 `allow`，无需任何应答器介入。
2. **ask 路由到 approval seam** —— `ask` 决策交由 `ctx.approval` 应答，
   该服务缺席时 **fail closed**（拒绝），不是放行。

`@deepseek-ai/dsh-user-approval` 权威定义（`README.md` + 类型）：

```
ctx.approval.request(req) → 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
应答器 = `approval/request` waterfall 监听器
        返回 outcome 应答；调用 next() 委托给下一个；不返回则 fail closed
        agent-scoped 监听器只收本 agent 的请求
        每个部署只能有一个终端应答器（兄弟监听器顺序不构成优先级）
```

**对 bridge 实现路线的定稿影响（改写原计划 §3.1 权限问询行）：**

| 原计划 | 实测定稿 |
|---|---|
| 挂 `tools/pre-execute` 瀑布，直裁 or 推 question 帧 | 白名单仍直裁 `allow`；非白名单走 `ask` → **bridge 自己注册 `approval/request` 应答器**（不注册则全部敏感工具直接被拒） |
| 挂起 Promise 等 `/bridge/approval` | 不变：推 question 帧 → 挂起 → 应答 → `return { kind: 'allowed-once' \| 'rejected' }` |
| 120s 超时默认 deny | 不变（`rejected` 与 fail-closed 语义一致） |

必须遵守的三条硬约束：
- **请求只在 open turn 内有效**，idle/turn 间调用直接 throw —— bridge 绝不能在 turn 外触发审批。
- **请求不携带工具参数**，应答器只看到 tool name / reason / 可选 callId —— 前端问询卡只能展示这些。
- **只有 one-shot 授权**（`allowed-once`），无 `allow-always`/记忆规则 —— 现有四档权限模式需在 bridge 侧自行记忆（UUID×工具名 表），不能指望 DSH 记。

补充：`ApprovalPolicy = 'ask' | 'never'`（`setApprovalPolicy()` 写入）；`'never'` 在交互式派发前即拒绝，
可用于「bypass 全放行」档的对偶实现。审计事件 `approval/asked` / `approval/decided` 是 log-only，
模型只看得到最终工具结果，不污染上下文。

## S5 systemPrompt.section 签名与生效语义

**结论：动态 provider 路线成立，切干员下一回合自动生效。**

```ts
PromptSection = { name, order, text, complete? }
text: string | (context: AssembleContext) => string   // 每次组装时求值
```

- 每次 prompt assembly 现算 → persona 读盘即可，**无需任何热切换机制**，干员切换下一回合自动生效。
- `AssembleContext.agent?` 可用，能按 agent 定制分节（多干员并行会话的未来扩展点）。
- agent-scoped persona 会 **shadow** 全局默认（无重复注入风险的机制保证，呼应 P1 判据 3）。
- 官方 `dsh-persona` 包是 agent-preset 级**静态**模板：适合「按干员建多 profile」，
  但我们是单 profile 热切换 → **采用动态 section 路线**，`dsh-persona` 不启用。
- 回退链保留：`ARKCODE_PERSONA_MODE=prepend` 首条消息拼人设（现状等价）作兜底。

## S6 冷恢复 / followup / model 选择编程面

**结论：全部可编程，且比计划预期更规整。**

**Agent 句柄（`dsh-agent` runtime-types）**
```ts
agent.followup(message)   // 排一个普通后续 turn 并唤醒 driver ← 我们用这个
agent.steer(message)      // 注入最近 step
agent.inject(message)     // 下个 pre-step 的模型可见上下文，不唤醒
agent.cancel(cause, opts) / whenIdle() / runMaintenance(task)
agent.status: 'idle' | 'running'
```

**冷恢复：显式而非自动。** `AgentFactory.resume(ownerCtx, { resumeSessionId, agentOptions?, setup?, signal? })`
—— 必须由我们调用；持久化先加载 → setup 组合 → 发布 → 启动 driver。
失败/回滚不发布任何 id。**bridge 需自己维护 uuid⇄dshSessionId 映射并主动 resume**（与计划一致）。

**模型选择：官方自带安装器。**
```ts
installModelSelection(agentCtx, ref: { current?: ModelSelection, assembled?: ModelSelection }): () => void
ModelSelection = { provider, model, reasoningEffort? }
```
装配时快照选中的模型再委托，因此**并发切换在下一个 step 生效，不会撕裂 prompt/request 两个面**。
另有 `agent/request` waterfall 可整体替换 `LlmCallConfig`（逐 step 路由切换）。
→ `/model pro|flash` 采用 `installModelSelection` 主线，`agent/request` 兜底（S6 三选一：选 A）。

**事件词汇表（P1 中继直接依据）**

`SessionEventMap`（dsh-session，持久日志即事件流）：
```
turn/start{turn}          turn/end{turn, reason: TurnEndReason}
step/start{turn,step}     step/end{turn,step}
user/message{UserMessage}
assistant/chunk{turn,step,chunk:StreamChunk}       ← 流式增量
assistant/message{turn,step,message,usage?,interrupted?}
tool/call{turn,step,callId,name,arguments}
tool/result{turn,step,message,error?,meta?}
todo/write{todos}         request/header{header,reason}
request/context{provider,model,contextWindow?}     session/end-seed{}
```
`TurnEndReason` = `completed | aborted | blocked | error | max-tokens | interrupted`

agent 层事件（cordis，bridge 挂监听器用）：
```
agent/created | agent/disposed | agent/status
agent/inbox/{inserted,claimed,discarded}
agent/session-start{source: startup|resume|clear|compact}
agent/pre-step      (waterfall)  — 可 reject 或替换进入 step 的消息
agent/request       (waterfall)  — 可替换 LlmCallConfig
agent/request-error (waterfall)  — 可返回 {kind:'retry'} 接管恢复
agent/turn-stopping (serial)     — 回合结束钩子（P4 回合完成通知插件用这个）
agent/error
```

**StreamChunk 变体**（`dsh-llm`，`assistant/chunk` 的 payload）：
```ts
{type:'block-start',      index, blockType}
{type:'text-delta',       index, text}              → ark.v1 text_delta
{type:'reasoning-delta',  index, text}              → ark.v1 thinking_delta
{type:'tool-call-delta',  index, id, name?, argumentsDelta}
{type:'block-end',        index, block}
{type:'usage',            usage: TokenUsage}
{type:'finish',           reason: FinishReason, replayState?}
```
`FinishReason` = `stop | tool-calls | max-tokens | aborted(failure) | error(failure)`

→ ark.v1 帧映射（§3.2）与实测词汇 1:1 对得上，`question` 帧由 bridge 的 approval 应答器合成（非原生事件）。

---

## P0 收尾结论

六个 Spike 全部完成，**无一票否决项**。计划的两条最坏回退（npm 包不自足 / 无 anthropic-messages 协议）
均已排除。三处对原计划的修正需在 P1 落地：
1. §3.1 权限问询：改为「白名单直裁 + 自注册 `approval/request` 应答器」双层（S4）。
2. 四档权限记忆须在 bridge 侧自建（DSH 只有 one-shot 授权）（S4）。
3. `/model` 用官方 `installModelSelection`，不自造（S6-A）。

---

## P1 进展：arknights-bridge 已能加载并注册路由，卡在 turn 推进

### 已解决（4 个真实缺陷，均已实测复现与修复）

**坑 1｜`dsh web` 是 profile 别名（上面 S2 已修正）**
启动必须显式 `--profile arknights`，否则改的 patch 层根本不会被读。

**坑 2｜插件 `name` 必须是「以 `.` 开头的相对路径」且指到具体文件**
`mountRootInclude` 的 `HostResolvedRootInclude.import()`（dsh-app-boot）规则：
- `dsh` 调 `boot()` 时**不传** `bareModuleBaseUrl`（bin.js 第 247 行只给 4 个实参）；
- 裸包名（`arknights-bridge`）→ 走 `internal.import(spec, undefined)` → 解析失败、
  **被静默跳过**（不报错、不加载，只剩 `/bridge/*` 全 404）；
- 绝对路径 → 虽转成 `file://` URL，同样落进 `undefined` 基准，也是静默跳过；
- 目录路径 → `ERR_UNSUPPORTED_DIR_IMPORT`（ESM 不认 package.json 的 `main`）；
- **只有以 `.` 开头才走 `super.import(spec)`**，以 `ctx.baseUrl`（本 profile 目录）为基准。

定稿写法：`name: '../node_modules/arknights-bridge/index.js'`

**坑 3｜必须在 agent 的 `setup` 里 `installModelSelection`**
否则 agent scope 内没有模型路由服务，表现为 `followup()` 后 agent 一直 `running`、
**一个 LLM 请求都不发**、也不报错。官方 `headless-runner.run()` 就是这么写的：
```js
setup: (agentCtx) => installModelSelection(agentCtx, { current: selection, assembled: undefined })
```
同时 provider/model 应优先读 `ctx.agentDefaultModel.currentSelection()`（控制台换模型后
下一条请求即生效），缺席才回退插件自己的 config。

**坑 4｜不要 insert `dsh-user-approval`**
dsh-base 默认树里已有 `- id: approval`（未 disabled）。再 insert 一份会让
`ApprovalService` 二次注册，启动直接崩：`service "approval" has been registered`。

### 当前阻塞：Web 组合下 turn 推进会同步卡死整个事件循环

**现象**：`agent.followup()` 返回后（status=running，turn/start 事件已产生 seq=4），
再无任何事件、不发 LLM 请求；挂在模块顶层的 1 秒心跳**立即归零**（20 秒新增 0），
且后续所有 HTTP 请求超时 —— 主线程连 inspector 的 `Debugger.pause` 都插不进去。

**已排除**（逐项实测）：
| 假设 | 结果 |
|---|---|
| bridge 代码问题（照抄 headless 的最小 runner 同样卡） | ❌ 排除 |
| persona 动态分节（ARKCODE_DISABLE_PERSONA=1） | ❌ 排除 |
| 工具开关（全禁用 / 启用 Windows 原生 tool-pwsh） | ❌ 排除 |
| 审批策略（DSH_PERMISSION_MODE=danger-full-access） | ❌ 排除 |
| code-runtime worker 线程 | ❌ 排除 |
| 我们 patch 里的 `disabled` 覆盖项（精简到只留两个 insert 仍卡） | ❌ 排除 |
| 驱动时机（启动期 apply 驱动，与 headless 同时机，仍卡） | ❌ 排除 |
| session 数据量（仅 6 个文件 / 0.1MB） | ❌ 排除 |
| `--port 0` 端口分配（改固定 3080） | ❌ 排除 |

**已确认的事实**：
- `dsh --profile headless "task"` 在**同一 DSH_HOME、同一 mock、同一 env** 下
  能完整跑通一轮并打印回复（mock 收到 2 条请求）。
- headless 的 bundles 是 `[dsh-base, dsh-web-app, dsh-headless]` —— **它包含 web-app**，
  所以「base+web-app」本身不是问题。
- 走官方 RPC（`session.create` → `session.prompt`）也返回 `accepted: true`，
  之后同样卡住；`session.prompt` 内部就是 `agent.followup()`，与 mini 路径一致。
- 相关服务全部就绪：`agentLoop=1 agents=1 sessions=1 llm=1 tools=1 systemPrompt=1`，
  无 pending entry。

### bisect 结果：已穷尽，「禁用单个插件」这条路走不通

对「arknights 有、headless 没有」的条目做了自动二分
（`.superpowers/spike/bisect.py`，判据 = 禁用后心跳是否恢复）：

| 批次 | 条目 | 结果 |
|---|---|---|
| 1 | session-projection-cache / session-reference / session-stats / storage / storage-domain / storage-json / modules | 仍卡 → 无辜 |
| 2 | agent-presets / client-hmr / client-runtime / file-reference-local / locale / message-feedback / plugin-inventory / session-log-download | 仍卡 → 无辜 |
| 3 | api-gateway / api-remotes | 仍卡 → 无辜 |
| 4 | connection | 仍卡 → 无辜 |
| 5 | cordis-host-runner | 仍卡 → 无辜 |
| 6 | cordis-client-runner | 仍卡 → 无辜 |
| 7 | 全部 31 个 `ui-*` | 仍卡 → 无辜 |
| — | web-runtime / web-startup | 禁用后 host 起不来（是依赖根），无法测 |

**结论：元凶不是某个可拆的插件，而是 web 模式（web-app 组合）的固有行为。**
「找到一个坏插件禁用掉」这条路 **已走死**。

### 下一步（待博士拍板：已选「两个独立」）

博士已定：**放弃「同一进程内同时双视图」，改为两个独立部分**。
据此收敛为两条：
1. **两个独立 profile**（主推）
   - `arknights`（对话引擎，常驻）：bundles 走 headless 类组合（已验证 turn 可跑通）；
     bridge 用 `node:http` 自建回环服务，不依赖 `webServer` 插件。
   - `arkconsole`（控制台，按需启动）：官方 web profile，只做橱窗/设置/市场。
   - 插件安装统一由我们自己的面板代理执行 `dsh plugin --profile arknights add`，
     装进对话 profile；控制台里的「安装」按钮只是触发器。
2. **向上游提问**（并行，不阻塞主线）：附最小复现提 issue，问 web 模式为何阻塞 turn。

> 复现工具已留在 `.superpowers/spike/`：
> `hostctl.py`（host/mock 生命周期）、`mini-runner.mjs`（最小对照 runner）、
> `beat_watch.py`（心跳判据）、`bisect.py`（自动二分）、`stack_capture2.mjs`（抓栈）、
> `call_api_probe.py`（官方 RPC 探测）、`diag_turn.py`（单次 turn 诊断）。

> 复现工具已留在 `.superpowers/spike/`：
> `hostctl.py`（host/mock 生命周期）、`mini-runner.mjs`（最小对照 runner）、
> `beat_watch.py`（心跳判据）、`stack_capture2.mjs`（抓栈）、`diag_turn.py`（单次 turn 诊断）。
