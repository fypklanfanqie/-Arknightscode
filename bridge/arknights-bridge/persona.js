/**
 * 干员人格：动态 prompt 分节。
 *
 * DSH 的 PromptSection.text 支持 (context) => string 形式的动态 provider，
 * 每次 prompt 组装时求值（P0-S5 实测确认）。所以这里什么都不缓存 ——
 * 每次组装现读盘，切干员后下一个回合自动生效，无需任何热切换机制。
 *
 * 激活干员的解析优先级与迁移前 server.js 保持一致：
 *   env(ARKCODE_ACTIVE_OPERATOR) > operators/active.json > 第一个可用干员
 *
 * @module arknights-bridge/persona
 */
import fs from 'node:fs';
import path from 'node:path';

export class Persona {
  /**
   * @param {object} opts
   * @param {string} opts.operatorsDir operators/ 目录（含 *.md 与 active.json）
   * @param {(msg: string) => void} [opts.log]
   * @param {string} [opts.fallback] 无任何干员文件时的兜底人格
   */
  constructor({ operatorsDir, log = () => {}, fallback = '' }) {
    this.operatorsDir = operatorsDir;
    this.log = log;
    this.fallback = fallback;
  }

  /** operators/ 下的可用干员名（不含扩展名） */
  list() {
    try {
      return fs
        .readdirSync(this.operatorsDir)
        .filter((f) => f.endsWith('.md') && f !== 'active.json')
        .map((f) => f.replace(/\.md$/, ''));
    } catch {
      return [];
    }
  }

  /** 当前激活干员 */
  active() {
    const valid = this.list();
    const envOp = process.env.ARKCODE_ACTIVE_OPERATOR;
    if (envOp && valid.includes(envOp)) return envOp;
    try {
      const f = path.join(this.operatorsDir, 'active.json');
      if (fs.existsSync(f)) {
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (d.active && valid.includes(d.active)) return d.active;
      }
    } catch {
      /* active.json 损坏时回退 */
    }
    return valid[0] || '阿米娅';
  }

  /** 切换干员：写 active.json（下一次 prompt 组装即生效） */
  setActive(name) {
    const valid = this.list();
    if (!valid.includes(name)) {
      const err = new Error(`未知干员：${name}（可用：${valid.join('、') || '无'}）`);
      err.code = 'ENOENT_OPERATOR';
      throw err;
    }
    fs.mkdirSync(this.operatorsDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.operatorsDir, 'active.json'),
      JSON.stringify({ active: name }, null, 2),
      'utf8',
    );
    this.log(`Persona switched: ${name}`);
    return name;
  }

  /** 读取指定干员的人设正文；文件缺失返回空串 */
  read(name = this.active()) {
    const file = path.join(this.operatorsDir, `${name}.md`);
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
      this.log(`Persona file not found: ${file}`);
    } catch (e) {
      this.log(`Failed to load persona: ${e.message}`);
    }
    return '';
  }

  /**
   * 交给 ctx.systemPrompt.section() 的分节对象。
   * 每次组装现读盘，所以切干员无需任何额外机制。
   */
  section(order = 50) {
    return {
      name: 'arknights-persona',
      order,
      text: () => this.read() || this.fallback,
    };
  }
}
