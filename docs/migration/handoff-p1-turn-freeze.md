# P1 交接文档：DSH turn 推进导致事件循环冻结

> 交接日期：2026-09-01
> 状态：**已结案（2026-09-01 下午）**——结论见文末「结案报告」
> 目标读者：接手本任务的全新 agent（无此前对话上下文）

---

## 一、任务目标（一句话）

把「明日方舟主题桌面伴侣」应用从自研 LLM 接入，迁移到 **DSH（DeepSeek Agent SDK，developer preview）**，
通过自研桥插件 `arknights-bridge` 把阿米娅人设注入 DSH agent，并用 HTTP 接口对外提供对话能力。

关键架构要求（用户 2026-08-31 明确）：**不要双视图共存，改为两个独立进程**。
即控制台视图与 Host agent 各自独立，不要在同一进程里同时跑。

---

## 二、环境速查

| 项 | 值 |
|---|---|
| 仓库根 | `D:\ai\cc Programm\arknightscode` |
| DSH 测试安装 | `.superpowers/spike/dsh-test/node_modules/@deepseek-ai/dsh` |
| DSH Home | `.superpowers/spike/dsh-home` |
| profile 目录 | `.superpowers/spike/dsh-home/profiles/{arknights,arkengine,arkbare}` |
| Node | `C:/Program Files/nodejs/node.exe` |
| Python | `C:/Users/Lfq06/.workbuddy/binaries/python/versions/3.13.12/python.exe` |
| 探针日志 | `.superpowers/spike/probe.log`（`ARKCODE_PROBE` 指向它） |
| Mock LLM | `tests/mock-llm/server.mjs`，请求记录 `tests/mock-llm/raw-requests.log` |
| 技术侦查结论 | `docs/migration/spike-results.md`（含前几轮全部发现） |

### 启动 Host

```bash
cd "D:/ai/cc Programm/arknightscode"
ARKCODE_PORT=3080 "C:/Users/Lfq06/.workbuddy/binaries/python/versions/3.13.12/python.exe" \
  .superpowers/spike/hostctl.py restart
```

- `ARKCODE_PORT` 固定端口（默认 0 = OS 分配）
- `ARKCODE_DSH_PROFILE` 切换 profile（默认 `arknights`）
- `ARKCODE_INSPECT=9229` 开 inspector
- 启动成功后 `/bridge/health` 返回 `{"ok":true,"operator":"阿米娅"}`

### 复现卡点（一键）

```bash
ARKCODE_DSH_PROFILE=arkbare "C:/Users/Lfq06/.workbuddy/binaries/python/versions/3.13.12/python.exe" \
  -c "import subprocess,os,time;env=dict(os.environ);env.update({'DSH_HOME':r'D:/ai/cc Programm/arknightscode/.superpowers/spike/dsh-home','DEEPSEEK_API_KEY':'mock','ARKCODE_PROBE':r'D:/ai/cc Programm/arknightscode/.superpowers/spike/probe.log'});open('.superpowers/spike/probe.log','w').close();p=subprocess.Popen([r'C:/Program Files/nodejs/node.exe',r'D:/ai/cc Programm/arknightscode/.superpowers/spike/dsh-test/node_modules/@deepseek-ai/dsh/lib/bin.js','--profile','arkbare'],stdout=open('.superpowers/spike/bare-out.log','w'),stderr=open('.superpowers/spike/bare-err.log','w'),env=env,cwd='.');time.sleep(18);p.kill()"
```

然后读 `.superpowers/spike/probe.log`。

---

## 三、⚠️ 本环境的坑（每个都真踩过，务必遵守）

1. **headless 进程跑完会杀死启动它的宿主 shell**。Bash 和 PowerShell 都被杀过
   （命令块整体中断、exit 1、无输出）。**不要在 Bash/PowerShell 里直接跑
   `dsh --profile headless "<task>"`**，否则会丢掉整个工具会话。
2. **Bash 长命令（约 >30 秒）会被内部超时杀掉**，且输出被吞。
   对策：拆成短命令；结果**写文件**，再用**另一条独立短命令**读。
3. **输出经常被吞**（exit 1 且 stdout 为空），不是脚本出错。落盘 + 单独读取是唯一可靠模式。
4. **`/tmp` 对 Python 不可靠**（写入后读不到）。一律用工作区内路径。
5. **`cat` 对部分文件崩溃**（exit 3221225773 / 访问冲突）。用 Read 工具或 Python 读文件。
6. **Git Bash 的 `/d/...` 传给 Node 会被解析成 `C:\d\...`**。给 Node 的路径一律写 `D:/...`。
7. **Bash 的 `rm` 被 safe-delete hook 拦截**。删文件用 Python `os.remove`。
8. **`.py` 脚本文件跑长任务会被杀**，`python -c` 内联相对更稳（但同样受 30 秒限制）。
9. 搜索 `node_modules` 时 Grep 工具会忽略它，需用 Python `os.walk` 遍历。

---

## 四、已修掉的 4 个真实缺陷（有实测复现，勿回退）

1. **启动命令写错了**：`dsh web` 是 `--profile web` 的硬编码别名（bin.js 第 91-94 行），
   会去读**空的** web patch 层，导致插件永不加载、`/bridge/*` 全 404 且**不报任何错**。
   必须用 `--profile arknights`。
2. **插件 `name` 必须是以 `.` 开头的相对路径且指到具体文件**：
   `boot()` 不传 `bareModuleBaseUrl`，裸包名/绝对路径被**静默跳过**，目录路径报
   `ERR_UNSUPPORTED_DIR_IMPORT`。定稿：`'../node_modules/arknights-bridge/index.js'`。
3. **必须在 agent 的 `setup` 里调 `installModelSelection`**（来自 `@deepseek-ai/dsh-agent`）。
   缺了它，agent 一直 `running`、一个 LLM 请求都不发、也不报错。
   provider/model 优先读 `ctx.agentDefaultModel`，这样控制台换模型下一条请求即生效。
4. **不能 insert `dsh-user-approval`**：默认树里已有，重复注册会让 ApprovalService 二次注册、
   host 启动直接崩。

**已验证通过**：6 条路由注册成功，`/bridge/health` 正常；
人设锚点在 system prompt 里恒定出现 15 次（无重复注入）；
上下文随 `messageCount` 递增（3→5→7→9→12）延续正常。

---

## 五、当前卡点（含本次精确测量数据）

### 现象

`agent.followup()` 返回后（turn/start 已产生、seq 3→6），**再无任何事件、不发 LLM 请求**，
随后**整个 Node 事件循环被冻结**：后续所有 HTTP 请求超时，连 CDP 的 `Debugger.pause` 都插不进去
（说明卡在原生层，不是 JS 死循环）。

### 本次精确时间线（50ms 心跳，arkbare profile，2026-09-01 实测）

```
10:30:47.319  apply-entered
10:30:47.320  apply-returned
10:30:47.440  beat #1  (uptime 2.8s)     ← 心跳机制正常
10:30:47.457  selection {provider,model}
10:30:47.462  created session=startup-...
10:30:47.464  idle-before seq=3
10:30:47.467  followup-sent status=running seq=6   ← followup() 同步返回
10:30:47.490  beat #2  (+23ms)           ← 事件循环仍正常
10:30:47.539  beat #3  (+72ms)           ← 最后一次心跳
              ... 之后 18 秒 0 心跳
mock LLM 收到请求：0
```

### 由此确定的三个事实

1. **心跳机制本身正常**（beat #1~#3 都触发了），所以"冻结"结论成立，不是探针失效。
2. **`agent.followup()` 是同步返回的**，冻结发生在它返回后约 **70–120ms** 的一个
   **定时器回调**里（此前 CDP 抓栈也显示卡在 `processTimers`，与此完全吻合）。
3. **mock 零请求** → 阻塞发生在**发起 LLM 请求之前**，即在 prompt 组装/工具定义生成阶段。

---

## 六、已排除清单（共 20 项，请勿重复劳动）

| 类别 | 已排除项 |
|---|---|
| 桥自身 | bridge 代码问题（照抄官方的最小 runner 同样卡） |
| 配置 | persona 动态分节、工具开关、审批策略、`tools.mode`、`system-prompt.persona` |
| 插件 | code-runtime worker；**全部 31 个 `ui-*`**（bisect 穷尽）；精简 patch 到只留 2 个 insert 仍卡 |
| 组合 | 剥掉 web-app（纯 `dsh-base` 的 arkbare/arkengine）仍卡；headless 的 `hmr: disabled` 补齐仍卡 |
| 时机 | 启动期驱动 vs HTTP 请求期驱动（两者都卡） |
| 实现细节 | `apply` 返回 promise vs 游离调用；`inject` 补上 `agentDefaultModel`（照官方三项对齐后仍卡） |
| 环境 | session 数据量（仅 0.1MB）；`--port 0` vs 固定端口；**stdin**（dsh 全代码库无任何 stdin 读取，`stdin=DEVNULL` 也无效） |
| 框架机制 | `profile-boot` 的 timer/hmr watch-only fallback（两组配置完全相同；`fiber.state===2` 即 ACTIVE，两模式都满足） |
| 数据 | **工作区扫描假设**（把 cwd 换成空目录，同样卡） |

### 关键反直觉事实

- headless 的 bundles 是 `[base, web-app, headless]` —— 它**包含 web-app** 却能跑。
  所以「base + web-app」组合本身不是问题。
- 官方 RPC 路线（`session.create` → `session.prompt` 返回 `accepted:true`）之后同样冻结，
  而它内部就是 `agent.followup()`。
- `headless-runner` 与我的 runner 逻辑逐行一致，唯一实质差异是它在结尾调用 `io.exit(0)`
  （one-shot 模式，由 `dsh-cmdline` 提供的 `ctx.appExit` 实现）。

---

## 七、下一步建议（按优先级）

### A. 直接抓元凶（推荐，信息量最大）

既然已确定"冻结发生在 followup 后 ~70ms 的某个定时器回调里"，最有效的做法是
**在 startup-runner 里 monkey-patch 全局 `setTimeout`/`setInterval`/`setImmediate`**，
记录每次调度的 `new Error().stack`，冻结后从日志里读**最后几条调度记录**及其调用栈，
就能直接定位到是哪个模块的哪个回调。

模板（插入 `.superpowers/spike/startup-runner.mjs` 顶部）：

```js
const origSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function (fn, delay, ...args) {
  const stack = (new Error().stack || '').split('\n').slice(1, 6).join(' | ');
  probe('setTimeout', `delay=${delay} ${stack}`);
  return origSetTimeout.call(this, fn, delay, ...args);
};
```

做完 `cp` 到 `.superpowers/spike/dsh-home/profiles/node_modules/startup-runner/` 再跑 arkbare。

### B. 次选：`--cpu-prof` 落盘

之前 `Profiler.stop` 无响应（主线程已卡）。改用启动参数
`node --cpu-prof --cpu-prof-dir=<dir>`，在进程被 kill 前让 V8 自行落盘
（kill 用 SIGINT 让 Node 有机会写文件，或直接等更久）。

### C. 向 DSH 上游提 issue

DSH 是 developer preview，这是正当路径。最小复现已备好：
`tests/mock-llm/server.mjs` + `.superpowers/spike/startup-runner.mjs` 一键可跑。
附上文第五节的时间线数据，说服力很强。

### D. 架构备选（用户倾向，可并行推进）

用户已明确「两个独立进程」而非双视图共存。即使 A/B 未果也不阻塞主线：

- **进程 1（agent）**：类 headless 组合驱动 agent
- **进程 2（控制台视图）**：单独起一个 web profile 进程做 UI

代价是多一个进程，但可绕开长驻模式的冻结问题（headless 抢先 `io.exit()` 所以"看起来正常"）。

---

## 八、现有工具脚本清单

| 文件 | 用途 |
|---|---|
| `.superpowers/spike/hostctl.py` | Host + mock 生命周期管理（restart/mock/stop），含诊断开关 |
| `.superpowers/spike/startup-runner.mjs` | 启动期 runner 探针（**当前最有效的观测工具**，含 50ms 心跳 + tick 采样） |
| `.superpowers/spike/mini-runner.mjs` | HTTP 路由 `/mini/run` 触发 turn 的探针（含心跳） |
| `.superpowers/spike/state-dump.mjs` | 运行时状态 dump（`/diag/state`）——**注意：目前取不到 fiber.state，需先修探针** |
| `.superpowers/spike/bisect.py` | 逐组禁用插件做二分（判据：心跳是否中断） |
| `.superpowers/spike/beat_watch.py` | 触发 turn 并观测心跳时间序列 |
| `.superpowers/spike/stack_capture2.mjs` | CDP 抓栈（主线程卡死时无效，已验证） |
| `.superpowers/spike/stdin_test.py` | stdin 对照实验（**会杀 shell，勿直接跑**） |

诊断插件部署方式：把 `.mjs` 复制到
`.superpowers/spike/dsh-home/profiles/node_modules/<名字>/`，并配好 `package.json`
（`{"type":"module","main":"<名字>.mjs"}`），再在 profile 的 `cordis.patch.yml` 里 `insert`。

---

## 九、给下一位的三条提醒

1. **不要试图在 Bash/PowerShell 里跑 headless 验证基线**——会杀掉你的工具会话。
   基线结论（headless 能跑通）在历史记录中已验证过，直接采信即可。
2. **每次实验前先确认探针部署到位**：改了 `.mjs` 必须 `cp` 到
   `profiles/node_modules/<name>/` 才生效，这个坑浪费过多次循环。
3. **实验命令控制在 30 秒内**，长任务拆成「后台触发 + 短命令轮询读取」。

---

## 十、结案报告（2026-09-01 下午，接手 agent 完成）

### 结论 A：arknights turn 秒失败 —— 真缺陷 ×2，已修复并验证

通过 monkey-patch 全局定时器 + registerHooks 对 cordis 做**内存级**源码转换
（不改 node_modules 磁盘文件），在「cannot get property without inject」构造点
抓到完整调用栈，根因锁定：

1. **`mini-runner.mjs:43` 对 waterfall payload 做 JSON.stringify**
   payload 是 Cordis ctx 代理 → get trap 访问 toJSON 属性 → inject 违规同步抛出。
   `mini-runner` 以单参普通监听器挂在 `agent/pre-step`（waterfall 事件）上，
   异常炸掉整条瀑布 → turn 在 step/start 之前直接 `agent/error`。
   （2376 条违规记录里 prop=toJSON 全局仅此一处。）

2. **`mini-runner.mjs` 的单参监听器截断 waterfall**
   `agent/pre-step` / `agent/request` 是 waterfall 事件，监听器必须
   两参形式 `(payload, next)` 且调用并返回 `next()`。单参监听器不调 next()，
   下游 prepend 监听器（dsh-session-reference:361）`await next()` 拿到
   `decision === undefined` → `decision.kind` TypeError。
   ⚠️ 这条对 **bridge 自身**也是约束：bridge 的 `approval/request` 已是两参
   waterfall 形式，正确；未来给 `agent/pre-step`/`agent/request` 挂监听时必须
   两参 + 透传 next。

修复（`mini-runner.mjs` + 已同步部署到 profiles/node_modules/mini-runner/）：
- 新增 `safePayload()`：只提取标量字段，绝不 stringify 代理对象；
- waterfall 事件改两参监听器并 `return next()`。

**验证（全绿）**：
- `/bridge/turn` 返回 ok:true + mock 流式 text_delta 帧；
- system prompt 人设锚点 15 处（与交接记录一致），标题请求不掺人设；
- 同 uuid 第二条消息 messageCount 3→5，上下文延续正常；
- 6 连发 turn 全部 turn-end，host 长驻 2659 秒心跳 2630 次零中断。

### 结论 B：arkbare「事件循环冻结」——最可能是被外部误杀，非真冻结

13+ 次条件对齐复现**零复现**（原始命令/无插桩/有无 mock/mock 挂死/
双进程共享 DSH_HOME/双进程+并发 turn/inspector/5 连跑），且：

- kill 模拟实验（进程启动 3.1s 时外部 kill）产生与 probe4 **完全相同的日志形状**：
  心跳连续 → 戛然而止、无 error/uncaughtException/exit 记录
  （外部 kill 不触发这些钩子；真冻结会留下未配对的 timer :enter，
  而成功轮 enter/exit 全配对）；
- probe4 进程只活了 3.1 秒即「静默死亡」——外部 kill 特征；
- 真冻结机制候选逐一排除：会话持久化是异步写（write-behind）；
  koffi 仅用于 MoveFileExW 且在 async 链上；无 Atomics.wait、无同步子进程。

**怀疑来源**：`hostctl.py` 的 kill_hosts 用「CommandLine -like *dsh*bin.js*」
匹配——会**误杀所有 dsh 进程**，包括正在跑的 arkbare 复现进程。若 18:30
复现跑至 3 秒时有任何一步（如上一轮实验收尾）触发了 kill_hosts，
探针看到的正是 probe4 的样子。

**行动建议**：
1. hostctl.kill_hosts 的过滤串改成更精确的 profile 匹配，或约定
   「复现进程与 host 不并行起停」；
2. P1 主线可继续：turn 推进已通，「两个独立进程」架构照计划落地；
3. 若冻结再现，probe-hooks.mjs 已具备全套插桩
   （node --import probe-hooks.mjs + ARKCODE_PROBE；ARKCODE_INJECT_PROBE=1
   开 inject 违规栈记录），跑一次即可定位。
