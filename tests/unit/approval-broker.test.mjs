/**
 * ApprovalBroker 单元测试（纯逻辑，不需要 DSH 进程）。
 *
 * 覆盖 P0-S4 定下的三条硬约束与四档权限语义：
 *   - 只读工具在任何模式下都放行，写入/执行类按模式裁决
 *   - 需要问询时推 question 帧并挂起，直到 /bridge/approval 应答
 *   - 超时按 rejected 收尾（与 DSH 的 fail-closed 一致）
 *   - DSH 只给一次性授权，「始终允许」由本插件记忆
 *   - 连接断开时挂起的 promise 全部以 cancelled 收尾，不留悬挂
 *
 * 运行：node --test tests/unit/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBroker, classifyTool } from '../../bridge/arknights-bridge/approval.js';

/** 起一个绑定了 sink 的 broker，返回它以及收到的帧与应答记录。 */
function setup(opts = {}) {
  const broker = new ApprovalBroker({ timeoutMs: 50, ...opts });
  const frames = [];
  broker.bindHandles(new Map([['uuid-1', { agent: { id: 'sess-1' } }]]));
  broker.setPermissionMode('uuid-1', opts.mode || 'default');
  broker.setSink('uuid-1', (frame) => frames.push(frame));
  return { broker, frames };
}

test('工具分类：只读 / 写入 / 执行 / 未知', () => {
  assert.equal(classifyTool('read'), 'read');
  assert.equal(classifyTool('glob'), 'read');
  assert.equal(classifyTool('web_search'), 'read');
  assert.equal(classifyTool('write'), 'write');
  assert.equal(classifyTool('edit'), 'write');
  assert.equal(classifyTool('bash'), 'exec');
  assert.equal(classifyTool('pwsh'), 'exec');
  assert.equal(classifyTool('mcp__playwright__navigate'), 'read');
  assert.equal(classifyTool('something_new'), 'unknown');
});

test('只读工具在 default 模式下直接放行，不打扰博士', async () => {
  const { broker, frames } = setup();
  const outcome = await broker.handle(
    { agent: { id: 'sess-1' }, toolName: 'read' },
    () => Promise.resolve('unavailable'),
  );
  assert.equal(outcome, 'allowed-once');
  assert.equal(frames.length, 0);
});

test('执行类工具在 default 模式下推送 question 帧并挂起', async () => {
  const { broker, frames } = setup();
  const pending = broker.handle(
    { agent: { id: 'sess-1' }, toolName: 'bash', callId: 'c1' },
    () => Promise.resolve('unavailable'),
  );
  // 微任务让 sink 收到帧
  await Promise.resolve();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'question');
  assert.equal(frames[0].data.toolName, 'bash');
  assert.equal(frames[0].data.callId, 'c1');
  assert.deepEqual(
    frames[0].data.options.map((o) => o.value),
    ['allow', 'allow-always', 'deny'],
  );

  const qId = frames[0].data.qId;
  assert.equal(broker.answer(qId, 'allow'), true);
  assert.equal(await pending, 'allowed-once');
});

test('拒绝：应答 deny 解析为 rejected', async () => {
  const { broker, frames } = setup();
  const pending = broker.handle(
    { agent: { id: 'sess-1' }, toolName: 'bash' },
    () => Promise.resolve('unavailable'),
  );
  await Promise.resolve();
  broker.answer(frames[0].data.qId, 'deny');
  assert.equal(await pending, 'rejected');
});

test('超时：无人应答按 rejected 收尾（fail-closed）', async () => {
  const { broker } = setup({ timeoutMs: 20 });
  const outcome = await broker.handle(
    { agent: { id: 'sess-1' }, toolName: 'bash' },
    () => Promise.resolve('unavailable'),
  );
  assert.equal(outcome, 'rejected');
});

test('始终允许：记忆后同名工具不再打扰', async () => {
  const { broker, frames } = setup();
  const first = broker.handle(
    { agent: { id: 'sess-1' }, toolName: 'bash' },
    () => Promise.resolve('unavailable'),
  );
  await Promise.resolve();
  broker.answer(frames[0].data.qId, 'allow-always');
  assert.equal(await first, 'allowed-once');

  const second = await broker.handle(
    { agent: { id: 'sess-1' }, toolName: 'bash' },
    () => Promise.resolve('unavailable'),
  );
  assert.equal(second, 'allowed-once');
  assert.equal(frames.length, 1, '第二次不应再推 question 帧');
});

test('bypass 模式：一切放行', async () => {
  const { broker, frames } = setup({ mode: 'bypass' });
  for (const name of ['read', 'write', 'bash', 'whatever']) {
    assert.equal(
      await broker.handle({ agent: { id: 'sess-1' }, toolName: name }, () => 'unavailable'),
      'allowed-once',
    );
  }
  assert.equal(frames.length, 0);
});

test('plan 模式：只读放行，写入与执行一律拒绝', async () => {
  const { broker, frames } = setup({ mode: 'plan' });
  assert.equal(
    await broker.handle({ agent: { id: 'sess-1' }, toolName: 'read' }, () => 'unavailable'),
    'allowed-once',
  );
  assert.equal(
    await broker.handle({ agent: { id: 'sess-1' }, toolName: 'write' }, () => 'unavailable'),
    'rejected',
  );
  assert.equal(
    await broker.handle({ agent: { id: 'sess-1' }, toolName: 'bash' }, () => 'unavailable'),
    'rejected',
  );
  assert.equal(frames.length, 0);
});

test('acceptEdits 模式：文件读写放行，Shell 仍需问询', async () => {
  const { broker, frames } = setup({ mode: 'acceptEdits' });
  assert.equal(
    await broker.handle({ agent: { id: 'sess-1' }, toolName: 'edit' }, () => 'unavailable'),
    'allowed-once',
  );
  const pending = broker.handle(
    { agent: { id: 'sess-1' }, toolName: 'bash' },
    () => Promise.resolve('unavailable'),
  );
  await Promise.resolve();
  assert.equal(frames.length, 1, 'bash 仍需问询');
  broker.answer(frames[0].data.qId, 'allow');
  assert.equal(await pending, 'allowed-once');
});

test('没有前端连接时不冒充应答者，委托给下游', async () => {
  const broker = new ApprovalBroker({ timeoutMs: 50 });
  broker.bindHandles(new Map([['uuid-1', { agent: { id: 'sess-1' } }]]));
  broker.setPermissionMode('uuid-1', 'default');
  // 故意不 setSink
  const outcome = await broker.handle(
    { agent: { id: 'sess-1' }, toolName: 'bash' },
    () => Promise.resolve('unavailable'),
  );
  assert.equal(outcome, 'unavailable');
});

test('连接断开：挂起的 promise 全部以 cancelled 收尾', async () => {
  const { broker, frames } = setup({ timeoutMs: 5000 });
  const pending = broker.handle(
    { agent: { id: 'sess-1' }, toolName: 'bash' },
    () => Promise.resolve('unavailable'),
  );
  await Promise.resolve();
  assert.equal(frames.length, 1);
  broker.clearSink('uuid-1');
  assert.equal(await pending, 'cancelled');
});

test('未知 reqId 的应答返回 false，不误伤挂起中的问询', async () => {
  const { broker, frames } = setup({ timeoutMs: 5000 });
  const pending = broker.handle(
    { agent: { id: 'sess-1' }, toolName: 'bash' },
    () => Promise.resolve('unavailable'),
  );
  await Promise.resolve();
  assert.equal(broker.answer('no-such-id', 'allow'), false);
  broker.answer(frames[0].data.qId, 'allow');
  assert.equal(await pending, 'allowed-once');
});
