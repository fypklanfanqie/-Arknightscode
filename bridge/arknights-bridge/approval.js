/**
 * 权限问询：把 DSH 的 approval seam 转成 arknights 前端的 question 帧。
 *
 * P0-S4 实测结论（docs/migration/spike-results.md）决定了这里的形态：
 *
 *  1. DSH 有**两层**权限 seam。工具层 PreToolDecision 直裁 allow/deny/ask，
 *     `ask` 再路由到 `ctx.approval`。本插件不碰工具层，只接管第二层。
 *  2. 应答器就是 `approval/request` 的 waterfall 监听器。**不注册即 fail closed**
 *     —— 所有需要审批的工具会被直接拒绝，所以这个监听器是必需的，不是可选的。
 *  3. 三条硬约束：请求只在 open turn 内有效；请求不携带工具参数（只有工具名、
 *     reason、callId），所以问询卡只能展示这些；授权是一次性的（allowed-once），
 *     DSH 不会记住选择 —— 因此「本次会话始终允许」的记忆由本插件自己维护。
 *
 * @module arknights-bridge/approval
 */

/** 只读工具：任何权限模式下都放行（迁移自 server.js SAFE_TOOLS，工具名换成 DSH 命名）。 */
const READ_ONLY_TOOLS = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'todo_write',
]);

/** 会改动工作区文件的工具：acceptEdits 放行、plan 拒绝。 */
const MUTATING_FS_TOOLS = new Set(['write', 'edit', 'multi_edit', 'notebook_edit']);

/** 执行类工具：除 bypass 外都需要问询（或按模式拒绝）。 */
const EXEC_TOOLS = new Set(['bash', 'pwsh', 'bash_persistent', 'pwsh_persistent', 'run_code']);

/** 与迁移前一致：Playwright 的浏览器观测类 MCP 工具视为只读。 */
const MCP_READ_ONLY_PREFIX = 'mcp__playwright__';

/** 分类一个工具名，决定它在各权限模式下的处置。 */
export function classifyTool(toolName) {
  const name = String(toolName || '');
  if (READ_ONLY_TOOLS.has(name)) return 'read';
  if (MUTATING_FS_TOOLS.has(name)) return 'write';
  if (EXEC_TOOLS.has(name)) return 'exec';
  if (name.startsWith(MCP_READ_ONLY_PREFIX)) return 'read';
  return 'unknown';
}

/**
 * 权限模式 × 工具类别 → 决策。
 *
 * 四档语义与迁移前 server.js 的 modeLabels 完全对齐：
 *   default      每步操作都需要确认（只读工具除外）
 *   acceptEdits  文件读写自动通过，Shell 仍需确认
 *   plan         纯只读，不能修改文件
 *   bypass       完全自主执行所有操作
 */
const POLICY = {
  bypass: { read: 'allow', write: 'allow', exec: 'allow', unknown: 'allow' },
  plan: { read: 'allow', write: 'deny', exec: 'deny', unknown: 'ask' },
  acceptEdits: { read: 'allow', write: 'allow', exec: 'ask', unknown: 'ask' },
  default: { read: 'allow', write: 'ask', exec: 'ask', unknown: 'ask' },
};

export class ApprovalBroker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] 无人应答的超时（超时按 deny 处理，与 fail-closed 一致）
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ timeoutMs = 120000, log = () => {} } = {}) {
    this.timeoutMs = timeoutMs;
    this.log = log;

    /** uuid → 写帧函数（把 question 帧推给对应前端连接） */
    this.sinks = new Map();
    /** reqId → { resolve, timer, uuid } 挂起中的问询 */
    this.pending = new Map();
    /** `${uuid}\u0000${toolName}` → 'allow' | 'deny' 会话内记忆（DSH 只给一次性授权） */
    this.remembered = new Map();
    /** uuid → 权限模式（由 /bridge/turn 每回合带下） */
    this.modes = new Map();
    this.seq = 0;
  }

  /** 绑定一个前端连接（一次 turn 期间有效） */
  setSink(uuid, sink) {
    this.sinks.set(uuid, sink);
  }

  clearSink(uuid) {
    this.sinks.delete(uuid);
    this.cancelAllFor(uuid);
  }

  setPermissionMode(uuid, mode) {
    this.modes.set(uuid, mode);
  }

  modeOf(uuid) {
    return this.modes.get(uuid) || 'default';
  }

  /**
   * `approval/request` waterfall 监听器。
   *
   * @param {{agent: {id: string}, toolName: string, callId?: string, reason?: string, signal?: AbortSignal}} req
   * @param {() => Promise<string>} next 委托给下一个应答器（我们不拥有该 agent 时必须调用）
   * @returns {Promise<string>} 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
   */
  handle(req, next) {
    const uuid = this.uuidOf(req);
    const toolName = req?.toolName ?? '';
    const mode = this.modeOf(uuid);

    const decision = (POLICY[mode] || POLICY.default)[classifyTool(toolName)];

    if (decision === 'allow') {
      this.log(`approval: allow ${toolName} (mode=${mode})`);
      return Promise.resolve('allowed-once');
    }
    if (decision === 'deny') {
      this.log(`approval: deny ${toolName} (mode=${mode})`);
      return Promise.resolve('rejected');
    }

    // 会话内记忆：用户选过「始终允许」的同名工具不再打扰
    const key = `${uuid}\u0000${toolName}`;
    const memo = this.remembered.get(key);
    if (memo === 'allow') return Promise.resolve('allowed-once');
    if (memo === 'deny') return Promise.resolve('rejected');

    const sink = uuid && this.sinks.get(uuid);
    if (!sink) {
      // 没有前端连接（例如控制台视图发起的会话）：不冒充应答者，
      // 委托给下游；下游也没有则 DSH 自己 fail closed。
      this.log(`approval: no sink for uuid=${uuid} — delegating ${toolName}`);
      return next();
    }

    const reqId = `q${++this.seq}_${Date.now()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        this.log(`approval: timeout ${toolName} (${this.timeoutMs}ms) — deny`);
        resolve('rejected');
      }, this.timeoutMs);

      this.pending.set(reqId, { resolve, timer, uuid, toolName });

      sink({
        type: 'question',
        data: {
          qId: reqId,
          toolName,
          callId: req.callId,
          // 请求不携带工具参数，只能展示工具名与理由
          text: req.reason || `「${toolName}」需要博士的许可，是否允许执行？`,
          options: [
            { label: '允许', value: 'allow' },
            { label: '始终允许', value: 'allow-always' },
            { label: '拒绝', value: 'deny' },
          ],
        },
      });
    });
  }

  /**
   * 前端应答（POST /bridge/approval）。
   * @param {string} reqId
   * @param {'allow'|'deny'|'allow-always'} decision
   * @returns {boolean} 是否命中了一个挂起中的问询
   */
  answer(reqId, decision) {
    const entry = this.pending.get(reqId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(reqId);

    if (decision === 'allow-always') {
      // DSH 只给一次性授权，所以「始终允许」由本插件在进程内记忆
      this.remembered.set(`${entry.uuid}\u0000${entry.toolName}`, 'allow');
      entry.resolve('allowed-once');
      return true;
    }
    entry.resolve(decision === 'allow' ? 'allowed-once' : 'rejected');
    return true;
  }

  /** 连接断开/回合结束：所有挂起问询按 cancelled 收尾，不留悬挂 promise。 */
  cancelAllFor(uuid) {
    for (const [reqId, entry] of this.pending) {
      if (entry.uuid !== uuid) continue;
      clearTimeout(entry.timer);
      this.pending.delete(reqId);
      entry.resolve('cancelled');
    }
  }

  /** 从 approval 请求反查 uuid（agent.id 即 dshSessionId） */
  uuidOf(req) {
    const sessionId = req?.agent?.id;
    if (!sessionId) return undefined;
    for (const [uuid, handle] of this.handles || []) {
      if (handle?.agent?.id === sessionId) return uuid;
    }
    return undefined;
  }

  /** 注入 live handle 表，供 uuidOf 反查；由 index.js 在启动时调用 */
  bindHandles(map) {
    this.handles = map;
  }
}
