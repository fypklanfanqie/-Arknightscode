/**
 * 本地 mock LLM —— 让 DSH 全链路在没有真实 API 密钥的情况下可验证。
 *
 * 用法：
 *   DEEPSEEK_BASE_URL=http://127.0.0.1:9911 DEEPSEEK_API_KEY=mock \
 *     node tests/mock-llm/server.mjs
 *
 * 原理：`@deepseek-ai/dsh-llm-deepseek` 的 baseURL 会回退到 $DEEPSEEK_BASE_URL，
 * 且「没有 key」只在发起请求时才失败（不阻塞插件加载），所以只要给一个占位
 * key 并把端点指到这里，prompt 组装、流式增量、工具调用、审批闭环全都能跑。
 *
 * 剧本由**最后一条用户消息**里的标记驱动：
 *   [THINK]        先吐一段 reasoning_content（验证 thinking_delta）
 *   [TOOL:名字]    吐文本后发起一次工具调用（验证 tool_call + 审批问询）
 *   其它           分块吐文本（验证 text_delta）
 *
 * 每次请求会把收到的 messages 完整落盘到 last-request.json，
 * 用于校验人格分节是否真的进了 system prompt（P1 判据 4）。
 *
 * @module tests/mock-llm/server
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_LLM_PORT || 9911);
const DUMP_FILE = path.join(HERE, 'last-request.json');
const ALL_FILE = path.join(HERE, 'requests.jsonl.json');

function chunk(model, delta, finishReason = null) {
  return {
    id: 'mock-chat-1',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sendChunk(res, model, delta, finishReason = null) {
  res.write(`data: ${JSON.stringify(chunk(model, delta, finishReason))}\n\n`);
}

/** 把文本切成若干块，模拟真实 token 流。 */
function splitText(text, size = 12) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const RAW_FILE = path.join(HERE, 'raw-requests.log');

const server = http.createServer(async (req, res) => {
  // 诊断：先记录每一个进来的请求（含会被 404 的路径），用来确认 DSH 到底
  // 有没有发请求、发到了哪个路径。成本可忽略，排查完保留。
  try {
    fs.appendFileSync(
      RAW_FILE,
      `${new Date().toISOString()} ${req.method} ${req.url} ct=${req.headers['content-type'] || '-'}\n`,
    );
  } catch {
    /* 记录失败不影响服务 */
  }
  if (!req.url?.startsWith('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `mock: unknown path ${req.url}` } }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock: invalid json' } }));
    return;
  }

  const model = payload.model || 'mock-model';
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
  const lastText =
    typeof lastUser?.content === 'string'
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? lastUser.content.map((p) => p?.text ?? '').join('')
        : '';

  // 落盘供断言使用。一次 turn 会打来多个请求（主请求 + 会话标题请求），
  // 所以保留全部而非只留最后一条。
  try {
    const record = {
      receivedAt: new Date().toISOString(),
      model,
      messageCount: messages.length,
      toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
      toolNames: Array.isArray(payload.tools) ? payload.tools.map((t) => t?.name) : [],
      systemPrompt: messages
        .filter((m) => m?.role === 'system' || m?.role === 'developer')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n----\n'),
      messages,
    };
    let all = [];
    try {
      all = JSON.parse(fs.readFileSync(ALL_FILE, 'utf8'));
      if (!Array.isArray(all)) all = [];
    } catch {
      all = [];
    }
    all.push(record);
    fs.writeFileSync(ALL_FILE, JSON.stringify(all, null, 2), 'utf8');
    fs.writeFileSync(DUMP_FILE, JSON.stringify(record, null, 2), 'utf8');
  } catch (e) {
    console.error(`[mock-llm] dump failed: ${e.message}`);
  }

  console.log(
    `[mock-llm] ${req.method} ${req.url} model=${model} msgs=${messages.length} tools=${Array.isArray(payload.tools) ? payload.tools.length : 0}`,
  );

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const stream = payload.stream !== false;
  if (!stream) {
    res.end(
      JSON.stringify({
        id: 'mock-chat-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK_NON_STREAM' }, finish_reason: 'stop' }],
      }),
    );
    return;
  }

  const toolMatch = lastText.match(/\[TOOL:([^\]]+)\]/);
  const think = lastText.includes('[THINK]');

  if (think) {
    for (const piece of splitText('正在思考博士的话语……', 8)) {
      sendChunk(res, model, { reasoning_content: piece });
    }
  }

  for (const piece of splitText('博士，这里是 mock 模型的回复。', 10)) {
    sendChunk(res, model, { content: piece });
  }

  if (toolMatch) {
    const toolName = toolMatch[1].trim() || 'bash';
    sendChunk(res, model, {
      tool_calls: [
        {
          index: 0,
          id: 'mock_call_1',
          type: 'function',
          function: { name: toolName, arguments: '{"command":"echo mock"}' },
        },
      ],
    });
    sendChunk(res, model, {}, 'tool_calls');
  } else {
    sendChunk(res, model, {}, 'stop');
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}`);
});
