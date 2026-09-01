/**
 * arknights-bridge —— Arknights Code 的第一方 DSH 桥接插件。
 *
 * 职责边界（计划 §3.1）：所有 Galgame 特化逻辑都收在这里，server.js 只做反代，
 * electron-main 只管进程代际。
 *
 * 对外暴露 six 条桥路由，前端只见 ark.v1 帧（计划 §3.2）：
 *   GET  /bridge/health
 *   POST /bridge/turn       { uuid, text, permMode, recap? } → NDJSON 流至 done
 *   POST /bridge/approval   { reqId, decision }
 *   GET  /bridge/commands
 *   POST /bridge/operator   { operator }
 *   GET  /bridge/config
 *
 * @module arknights-bridge
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { SessionMap } from './session-map.js';
import { Persona } from './persona.js';
import { ApprovalBroker } from './approval.js';

export const name = 'arknights-bridge';

/**
 * P1 诊断探针：把插件生命周期写文件，绕开 DSH 的日志系统。
 * 只在 ARKCODE_PROBE 指向一个路径时启用，正式发行时零开销、零副作用。
 */
const PROBE = process.env.ARKCODE_PROBE;
function probe(stage, detail = '') {
  if (!PROBE) return;
  try {
    fs.appendFileSync(PROBE, `${new Date().toISOString()} ${stage} ${detail}\n`);
  } catch {
    /* 探针失败绝不能影响插件 */
  }
}
probe('module-loaded', `pid=${process.pid}`);

/**
 * 注入名单（声明值；真正生效的配置在 profile 的 cordis.patch.yml 条目里）。
 *
 * ⚠️ P1 实测：DSH 0.1.1-rc.2 的 loader **不读**插件模块导出的 inject，
 * 只认 patch entry 上的 `inject: [...]` 字段（见 dsh-web-app 给 webserver
 * 注入 webStartup 的写法）。两边保持一致，改一处记得改另一处。
 *
 * 只有这三项是桥的立足点；其余服务（systemPrompt / commands / tools /
 * approval / llm）一律用 `ctx.get(name)` 机会性获取 —— Cordis 对未声明的服务
 * **禁止属性访问**（直接 `ctx.foo` 会抛 "cannot get property without inject"），
 * 而 `ctx.get()` 缺席时返回 undefined，正是「缺谁降谁」需要的语义
 * （写法与 dsh-tools 官方消耗 approval seam 的方式一致）。
 */
export const inject = ['webServer', 'agents', 'sessions'];

const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

/** 兜底命令表：ctx.commands 缺席或抛错时使用（迁移自 server.js BUILTIN_COMMANDS）。 */
const FALLBACK_COMMANDS = [
  { command: '/permission', description: '管理工具权限' },
  { command: '/btw', description: '发送旁白消息，不触发AI回复' },
  { command: '/clear', description: '清除对话历史' },
  { command: '/config', description: '查看和修改配置' },
  { command: '/model', description: '切换AI模型' },
  { command: '/fast', description: '切换快速模式' },
  { command: '/help', description: '查看帮助信息' },
  { command: '/init', description: '初始化项目 AGENTS.md' },
  { command: '/review', description: '代码审查' },
  { command: '/security-review', description: '安全审查' },
  { command: '/simplify', description: '简化代码' },
  { command: '/verify', description: '验证代码变更' },
  { command: '/run', description: '启动并测试项目' },
  { command: '/loop', description: '循环执行命令' },
  { command: '/pdf', description: '处理PDF文件' },
  { command: '/xlsx', description: '处理Excel文件' },
  { command: '/pptx', description: '处理PowerPoint文件' },
  { command: '/docx', description: '处理Word文件' },
  { command: '/code-review', description: '代码审查 (skill)' },
  { command: '/scientific-writing', description: '科学写作辅助' },
  { command: '/literature-review', description: '文献综述' },
  { command: '/paper-lookup', description: '查找论文' },
  { command: '/deep-research', description: '深度研究报告' },
  { command: '/generate-image', description: '生成图片' },
  { command: '/exploratory-data-analysis', description: '探索性数据分析' },
  { command: '/statistical-analysis', description: '统计分析' },
  { command: '/scientific-visualization', description: '科学可视化' },
  { command: '/matplotlib', description: 'Matplotlib 绘图' },
  { command: '/seaborn', description: 'Seaborn 绘图' },
  { command: '/scikit-learn', description: '机器学习' },
  { command: '/pytorch-lightning', description: 'PyTorch Lightning' },
  { command: '/markdown-mermaid-writing', description: 'Mermaid 图表' },
  { command: '/exa-search', description: '深度搜索' },
];

/** 权限模式的模型可见提示（迁移自 server.js modeLabels，语义不变）。 */
const MODE_LABELS = {
  default: '默认模式（每步操作都需要确认）',
  acceptEdits: '编辑模式（文件读写自动通过，Shell仍需确认）',
  plan: '计划模式（纯只读，不能修改文件）',
  bypass: '自动模式（完全自主执行所有操作）',
};

function defaultDataDir() {
  return process.env.ARKCODE_DATA_DIR || path.join(os.homedir(), '.arkcode');
}

function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

function writeFrame(res, frame) {
  if (res.writableEnded) return;
  res.write(`${JSON.stringify(frame)}\n`);
}

function withTimeout(promise, ms, onTimeout) {
  if (!ms || ms <= 0) return promise;
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(onTimeout()), ms);
    }),
  ]);
}

/** 把 DSH 的失败值压成一句人话（LlmFailure 有 message/code，其他是裸 Error）。 */
function describeError(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  if (err.message && err.code) return `${err.message}（${err.code}）`;
  return err.message || String(err);
}

/** turn/end 的 reason → 用户可见文案。 */
function describeTurnEnd(reason) {
  switch (reason?.kind) {
    case 'aborted':
      return '本回合已被取消。';
    case 'blocked':
      return '本回合被阻断（没有可继续的输入）。';
    case 'max-tokens':
      return '本回合达到输出长度上限。';
    case 'interrupted':
      return '上一回合因进程中断而未完成，已自动收尾。';
    case 'error':
      return describeError(reason.error);
    default:
      return '本回合异常结束。';
  }
}

export function apply(ctx, rawConfig = {}) {
  probe('apply-entered', `injectKeys=${Object.keys(ctx).length}`);
  const config = {
    operatorsDir:
      rawConfig.operatorsDir ||
      process.env.ARKCODE_OPERATORS_DIR ||
      path.resolve(process.cwd(), 'operators'),
    sessionMapFile:
      rawConfig.sessionMapFile || path.join(defaultDataDir(), 'dsh-session-map.json'),
    workspace: rawConfig.workspace || process.env.ARKCODE_WORKSPACE || process.cwd(),
    personaOrder: rawConfig.personaOrder ?? 50,
    approvalTimeoutMs: rawConfig.approvalTimeoutMs ?? 120000,
    turnTimeoutMs: rawConfig.turnTimeoutMs ?? 600000,
    // 缺省与 dsh-base 的 agent-default-model 一致；P3 由 lib/provider-map.js
    // 按所选预设写入。不传这两个值会让整次 turn 在 prompt 组装阶段失败
    // （P1 实测：`has no provider/model`，且 {{model}} 变量随之无值）。
    provider: rawConfig.provider || process.env.ARKCODE_PROVIDER || 'deepseek-official',
    model: rawConfig.model || process.env.ARKCODE_MODEL || 'deepseek-v4-flash',
    verbose: rawConfig.verbose ?? process.env.ARKCODE_BRIDGE_VERBOSE === '1',
  };

  const log = (msg) => {
    if (config.verbose) console.error(`[arknights-bridge] ${msg}`);
  };

  const persona = new Persona({ operatorsDir: config.operatorsDir, log });
  const sessions = new SessionMap(config.sessionMapFile);
  const broker = new ApprovalBroker({ timeoutMs: config.approvalTimeoutMs, log });

  /** uuid → AgentHandle（进程内存活；跨进程重启靠 sessionMap 冷恢复） */
  const live = new Map();
  /** 正在处理 turn 的 uuid 集合（并发闸） */
  const busy = new Set();
  /** uuid → 权限模式 */
  const modes = new Map();
  broker.bindHandles(live);

  let qSeq = 0;

  // ─── 1. 人格注入 ──────────────────────────────────────
  // text 是动态 provider，每次 prompt 组装现读盘 → 切干员下一回合自动生效（P0-S5）。
  const systemPrompt = ctx.get('systemPrompt');
  // 诊断开关：ARKCODE_DISABLE_PERSONA=1 时不注册人格分节，用来二分定位
  // prompt 组装阶段的挂起是否由动态 provider 引起。正式发行不受影响。
  const personaEnabled =
    rawConfig.persona !== false && process.env.ARKCODE_DISABLE_PERSONA !== '1';
  if (personaEnabled && systemPrompt?.section) {
    try {
      const dispose = systemPrompt.section(persona.section(config.personaOrder));
      ctx.on('dispose', () => {
        try {
          dispose?.();
        } catch {
          /* 卸载失败忽略 */
        }
      });
      log(`persona section registered (order=${config.personaOrder})`);
    } catch (e) {
      log(`persona section failed: ${e.message} — 需回退 ARKCODE_PERSONA_MODE=prepend`);
    }
  } else {
    log('systemPrompt service absent — persona section skipped');
  }

  // ─── 2. 权限问询应答器 ────────────────────────────────
  // 不注册 = fail closed（所有需审批工具直接被拒），所以这一行是必需的。
  ctx.on('approval/request', (req, next) => broker.handle(req, next));

  // ─── 3. 会话获取与恢复 ────────────────────────────────
  /**
   * 当前应使用的模型选择。
   *
   * 优先读官方 `ctx.agentDefaultModel` —— 控制台/settings 里换的模型走的就是
   * 这个服务，读它才能做到「下一条请求生效」（计划 §3.3）。缺席时才回退到
   * 本插件自己的 config（与 dsh-base 的组合默认值一致）。
   */
  const agentDefaultModel = ctx.get('agentDefaultModel');

  function currentSelection() {
    try {
      const s = agentDefaultModel?.currentSelection?.();
      if (s?.provider && s?.model) return s;
    } catch (e) {
      log(`agentDefaultModel lookup failed: ${e.message} — using plugin config`);
    }
    return { provider: config.provider, model: config.model };
  }

  /**
   * ⚠️ 关键：必须在 agent 的 setup 里安装模型选择，否则 agent scope 内没有
   * 模型路由服务 —— 表现是 `followup()` 后 agent 一直 running、**一个 LLM
   * 请求都不发**、也不报错（P1 实测踩坑，对照 headless 源码才定位到）。
   * 官方 headless-runner 的 run() 就是这么写的。
   */
  function setupAgent(agentCtx) {
    installModelSelection(agentCtx, { current: currentSelection(), assembled: undefined });
  }

  async function ensureAgent(uuid) {
    const cached = live.get(uuid);
    if (cached) return cached;

    const saved = sessions.get(uuid);
    if (saved) {
      try {
        // 总是显式带上当前 provider/model：持久化的 AgentOptions 可能是用户
        // 换供应商之前写下的（P1 实测，旧会话恢复时会带着空的 provider/model，
        // 导致整次 turn 在 prompt 组装阶段失败）。
        const handle = await ctx.agents.resume({
          resumeSessionId: SessionId(saved),
          agentOptions: currentSelection(),
          setup: setupAgent,
        });
        live.set(uuid, handle);
        log(`resumed uuid=${uuid} → session=${handle.agent.session.id}`);
        return handle;
      } catch (e) {
        // 冷恢复失败：静默回退到 recap 模式的新会话，两级保障永远可聊天
        log(`resume failed for uuid=${uuid}: ${e.message} — starting fresh`);
        sessions.delete(uuid);
      }
    }

    const handle = await ctx.agents.create({
      sessionId: SessionId(`ark-${randomUUID()}`),
      meta: { cwd: config.workspace },
      agentOptions: currentSelection(),
      setup: setupAgent,
    });
    live.set(uuid, handle);
    sessions.set(uuid, handle.agent.session.id, { operator: persona.active() });
    log(`created uuid=${uuid} → session=${handle.agent.session.id}`);
    // 与官方 headless-runner 一致：新建的 agent 先等它就绪再往里投消息
    await handle.agent.whenIdle();
    return handle;
  }

  /**
   * 组装发给模型的用户消息。
   * recap 由 server.js 对旧存档生成（分层压缩的历史回顾），新会话没有。
   */
  function buildUserMessage(text, recap, permMode) {
    let content = text;
    if (recap && recap.trim()) {
      content = `${recap.trim()}\n\n---\n\n博士刚刚说：${text}`;
    }
    const modeHint = MODE_LABELS[permMode] || permMode;
    content = `${content}\n\n[系统提示：当前会话运行在「${modeHint}」。]`;
    return createUserMessage({
      content: [{ type: 'text', text: content }],
      source: { kind: 'user' },
    });
  }

  let eventCount = 0;

  /** session 事件 → ark.v1 帧（P0-S6 词汇表）。 */
  function relayEvent(ev, res, startSeq, settle) {
    // 诊断：记录前 40 个事件的类型与 seq，判断 agent 到底有没有产出事件。
    if (eventCount < 40) {
      probe('event', `#${++eventCount} type=${ev?.type} seq=${ev?.seq} start=${startSeq}`);
    }
    // startSeq 取自 session.seq，而 session.seq 是「下一条事件的 seq」（= log 长度），
    // 所以本回合第一条新事件的 seq 恰好 == startSeq。用 < 而非 <=，否则首帧被吞。
    if (!ev || typeof ev.seq !== 'number' || ev.seq < startSeq) return;
    switch (ev.type) {
      case 'assistant/chunk': {
        const c = ev.data?.chunk;
        if (!c) return;
        if (c.type === 'text-delta' && c.text) {
          writeFrame(res, { type: 'text_delta', data: { text: c.text, index: c.index } });
        } else if (c.type === 'reasoning-delta' && c.text) {
          writeFrame(res, { type: 'thinking_delta', data: { text: c.text, index: c.index } });
        }
        // tool-call-delta 不发帧：tool/call 事件是更可靠的单一来源
        return;
      }
      case 'tool/call':
        writeFrame(res, {
          type: 'tool_call',
          data: { name: ev.data?.name, callId: ev.data?.callId },
        });
        return;
      case 'turn/end':
        settle({ kind: 'turn-end', reason: ev.data?.reason });
        return;
      default:
    }
  }

  // ─── 4. 桥路由 ───────────────────────────────────────
  function handleHealth(_req, res) {
    probe('route-health');
    sendJson(res, 200, {
      ok: true,
      gen: Number(process.env.ARKCODE_HOST_GEN || 1),
      dshVersion: process.env.DSH_VERSION || 'unknown',
      liveAgents: live.size,
      busy: [...busy],
      operator: persona.active(),
    });
  }

  let svcProbed = false;
  function probeServices() {
    if (svcProbed) return;
    svcProbed = true;
    const names = ['agentLoop', 'agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'webServer'];
    probe('services', names.map((n) => `${n}=${ctx.get(n) ? 1 : 0}`).join(' '));
    try {
      const loader = ctx.get('loader');
      if (loader?.entries) {
        const pending = [...loader.entries()].filter((e) => e.fiber === undefined && !e.disabled);
        probe('pending-entries', pending.map((e) => e.options?.id ?? '?').join(',') || '(none)');
      }
    } catch (e) {
      probe('pending-entries-err', e?.message || String(e));
    }
  }

  async function handleTurn(req, res) {
    probe('route-turn', `url=${req.url}`);
    probeServices();
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      sendJson(res, 400, { error: `请求体解析失败：${e.message}` });
      return;
    }

    const uuid = typeof body.uuid === 'string' ? body.uuid : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const permMode = body.permMode || 'default';
    const recap = typeof body.recap === 'string' ? body.recap : '';

    if (!uuid) return sendJson(res, 400, { error: '缺少 uuid' });
    if (!text) return sendJson(res, 400, { error: '消息内容为空' });

    // 并发闸：同一 uuid 有进行中的 turn 时立即返回 busy（防审批期串扰）
    if (busy.has(uuid)) {
      res.writeHead(200, NDJSON_HEADERS);
      writeFrame(res, { type: 'result', data: { ok: false, busy: true } });
      writeFrame(res, { type: 'done' });
      res.end();
      return;
    }

    let handle;
    try {
      handle = await ensureAgent(uuid);
    } catch (e) {
      log(`ensureAgent failed: ${e.message}`);
      sendJson(res, 503, { error: `会话启动失败：${describeError(e)}` });
      return;
    }

    const agent = handle.agent;
    const session = agent.session;
    const startSeq = session.seq;
    const qId = `q${++qSeq}`;

    res.writeHead(200, NDJSON_HEADERS);
    busy.add(uuid);
    modes.set(uuid, permMode);
    broker.setPermissionMode(uuid, permMode);

    writeFrame(res, { type: 'hello', qId });
    writeFrame(res, {
      type: 'turn_start',
      data: { operator: persona.active(), sessionId: session.id, permMode },
    });

    let settleTurn;
    const turnDone = new Promise((resolve) => {
      settleTurn = resolve;
    });
    let hadError = false;

    const offEvent = ctx.on('session/event', (s, ev) => {
      if (!s || s.id !== session.id) return;
      relayEvent(ev, res, startSeq, settleTurn);
    });

    const offError = ctx.on('agent/error', (payload) => {
      if (payload?.agent?.id !== session.id) return;
      hadError = true;
      probe('agent-error', String(payload.error?.stack || payload.error).slice(0, 1600));
      writeFrame(res, { type: 'result', data: { ok: false, error: describeError(payload.error) } });
      settleTurn({ kind: 'error' });
    });

    broker.setSink(uuid, (frame) => writeFrame(res, frame));

    // P1 诊断：driver 是否在跑。每次 turn 打 8 个 1 秒心跳，记录 agent 状态
    // 与 session.seq 的变化（seq 增长 = 真的有事件在产生）。
    let ticks = 0;
    const heartbeat = setInterval(() => {
      probe('tick', `t=${++ticks} status=${agent.status} seq=${session.seq} start=${startSeq}`);
      if (ticks >= 8) clearInterval(heartbeat);
    }, 1000);

    try {
      agent.followup(buildUserMessage(text, recap, permMode));
      probe('followup-sent', `status=${agent.status} seq=${session.seq}`);
      // 诊断：agent 何时回到 idle（不阻塞主流程，只是旁路记录）
      agent
        .whenIdle()
        .then(() => probe('agent-idle', `seq=${session.seq} events=${eventCount}`))
        .catch((e) => probe('agent-idle-err', e?.message || String(e)));
      const outcome = await withTimeout(turnDone, config.turnTimeoutMs, () => ({
        kind: 'timeout',
      }));
      probe('turn-settled', `kind=${outcome?.kind} seq=${session.seq}`);

      if (outcome?.kind === 'timeout') {
        writeFrame(res, { type: 'result', data: { ok: false, error: '回合超时，已自动收尾。' } });
      } else if (outcome?.kind === 'turn-end' && outcome.reason?.kind !== 'completed') {
        writeFrame(res, { type: 'result', data: { ok: false, error: describeTurnEnd(outcome.reason) } });
      } else if (!hadError) {
        writeFrame(res, { type: 'result', data: { ok: true } });
      }

      sessions.set(uuid, session.id, { operator: persona.active() });
    } catch (e) {
      writeFrame(res, { type: 'result', data: { ok: false, error: describeError(e) } });
    } finally {
      clearInterval(heartbeat);
      offEvent();
      offError();
      broker.clearSink(uuid);
      busy.delete(uuid);
      writeFrame(res, { type: 'done' });
      res.end();
    }
  }

  async function handleApproval(req, res) {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      sendJson(res, 400, { error: `请求体解析失败：${e.message}` });
      return;
    }
    const { reqId, decision } = body || {};
    if (!reqId || !['allow', 'deny', 'allow-always'].includes(decision)) {
      sendJson(res, 400, { error: '需要 reqId 与 decision(allow|deny|allow-always)' });
      return;
    }
    const hit = broker.answer(reqId, decision);
    sendJson(res, 200, { ok: hit });
  }

  function handleCommands(_req, res) {
    let list = FALLBACK_COMMANDS;
    try {
      const commands = ctx.get('commands');
      if (commands?.list) {
        const dynamic = commands.list();
        if (Array.isArray(dynamic) && dynamic.length) {
          list = dynamic.map((c) => ({
            command: c.command ?? c.name,
            description: c.description ?? '',
          }));
        }
      }
    } catch (e) {
      log(`commands lookup failed: ${e.message} — using fallback table`);
    }
    sendJson(res, 200, { commands: list });
  }

  async function handleOperator(req, res) {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      sendJson(res, 400, { error: `请求体解析失败：${e.message}` });
      return;
    }
    const operator = body?.operator;
    if (!operator) return sendJson(res, 400, { error: '缺少 operator' });
    try {
      const applied = persona.setActive(operator);
      sendJson(res, 200, { ok: true, operator: applied, available: persona.list() });
    } catch (e) {
      sendJson(res, 400, { error: e.message, available: persona.list() });
    }
  }

  function handleConfig(_req, res) {
    sendJson(res, 200, {
      carrierPort: ctx.webServer?.port ?? null,
      carrierHost: ctx.webServer?.host ?? null,
      dshVersion: process.env.DSH_VERSION || 'unknown',
      operator: persona.active(),
      operators: persona.list(),
      workspace: config.workspace,
    });
  }

  const routes = [
    { kind: 'exact', path: '/bridge/health', handler: handleHealth },
    { kind: 'exact', path: '/bridge/turn', handler: handleTurn },
    { kind: 'exact', path: '/bridge/approval', handler: handleApproval },
    { kind: 'exact', path: '/bridge/commands', handler: handleCommands },
    { kind: 'exact', path: '/bridge/operator', handler: handleOperator },
    { kind: 'exact', path: '/bridge/config', handler: handleConfig },
  ];
  for (const route of routes) {
    const dispose = ctx.webServer.register(route);
    ctx.on('dispose', dispose);
  }
  log(`routes registered on :${ctx.webServer?.port}`);
  probe('routes-registered', `port=${ctx.webServer?.port} count=${routes.length}`);

  // 会话释放：本插件创建/恢复的 agent 随插件卸载一起销毁
  ctx.on('dispose', () => {
    for (const [uuid, handle] of live) {
      handle
        .dispose()
        .catch((e) => log(`dispose agent ${uuid} failed: ${e.message}`));
    }
    live.clear();
  });
}

export default apply;
