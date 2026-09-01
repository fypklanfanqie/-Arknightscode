/**
 * uuid ⇄ dshSessionId 映射的持久化。
 *
 * Galgame 侧的存档键是前端生成的 uuid；DSH 侧的会话身份是 SessionId。
 * 两者必须一一对应，才能做到「载入存档 → 原生续聊」而不是重放历史。
 *
 * 映射丢失不是错误：查不到就退化成 recap 模式（server.js 侧生成回顾文本），
 * 用户无感，只是多花 token。所以这里所有读失败都静默返回 undefined。
 *
 * @module arknights-bridge/session-map
 */
import fs from 'node:fs';
import path from 'node:path';

/** 原子写：先写临时文件再 rename，避免断电/崩溃留下半个 JSON。 */
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export class SessionMap {
  /**
   * @param {string} file 映射文件路径（放 userData 下，不随安装包走）
   */
  constructor(file) {
    this.file = file;
    /** @type {Record<string, {sessionId: string, operator?: string, updatedAt: number}>} */
    this.data = readJson(file);
  }

  /** @returns {string | undefined} 该 uuid 对应的 DSH 会话 id */
  get(uuid) {
    return this.data[uuid]?.sessionId;
  }

  /** 该 uuid 最近一次使用的干员（用于冷恢复时还原人格） */
  getOperator(uuid) {
    return this.data[uuid]?.operator;
  }

  set(uuid, sessionId, extra = {}) {
    this.data[uuid] = { sessionId, updatedAt: Date.now(), ...extra };
    try {
      writeJsonAtomic(this.file, this.data);
    } catch {
      /* 持久化失败不影响本次会话 */
    }
  }

  delete(uuid) {
    if (!(uuid in this.data)) return;
    delete this.data[uuid];
    try {
      writeJsonAtomic(this.file, this.data);
    } catch {
      /* 同上 */
    }
  }
}
