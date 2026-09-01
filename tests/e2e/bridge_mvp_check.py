#!/usr/bin/env python3
"""
P1 判据验收：arknights-bridge MVP 的四条 curl 级判据。

跑法（host 需已启动，mock LLM 需在 9911 待命）：
    python tests/e2e/bridge_mvp_check.py

判据（对计划 §P1 完成判据 1:1）：
  1. POST /bridge/turn 持续收到 text_delta 直至 done，且 result.ok
  2. 触发敏感工具 → 收到 question 帧 → /bridge/approval 应答 → 原流推进至 done；
     deny 分支也要能礼貌收尾（不允许悬挂）
  3. 同一 uuid 二次 POST 上下文延续（mock 侧 messageCount 递增），
     且 persona 分节无重复注入（system prompt 中锚点出现次数恒定）
  4. system prompt 含 operators/<干员>.md 正文（不是文件名，是内容）

设计要点：判据 2 必须一边读流一边应答，所以读流放后台线程、收到 question
帧后主线程回 POST /bridge/approval。curl 做不了这件事，这也是本脚本存在的理由。
"""
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = r'D:/ai/cc Programm/arknightscode'
HOST_OUT = ROOT + '/.superpowers/spike/host-out.log'
MOCK_REQUESTS = ROOT + '/tests/mock-llm/requests.jsonl.json'
OPERATORS_DIR = ROOT + '/operators'

PASS, FAIL = 'PASS', 'FAIL'
results = []


def record(name, ok, detail=''):
    results.append((name, ok, detail))
    print('[%s] %s%s' % (PASS if ok else FAIL, name, ('  — ' + detail) if detail else ''))
    return ok


def host_base():
    txt = open(HOST_OUT, encoding='utf-8', errors='replace').read()
    m = re.search(r'http://127\.0\.0\.1:(\d+)', txt)
    if not m:
        print('未从 host-out.log 解析到端口，先跑 hostctl.py start')
        sys.exit(1)
    return 'http://127.0.0.1:' + m.group(1)


def post_json(url, payload, timeout=30):
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode('utf-8', 'replace')


def get_json(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode('utf-8', 'replace'))


class TurnStream(threading.Thread):
    """后台读 NDJSON 流，逐帧收集。"""

    def __init__(self, base, payload):
        super().__init__(daemon=True)
        self.base = base
        self.payload = payload
        self.frames = []
        self.lock = threading.Lock()
        self.error = None
        self.finished = threading.Event()

    def run(self):
        try:
            req = urllib.request.Request(
                self.base + '/bridge/turn',
                data=json.dumps(self.payload).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
            )
            with urllib.request.urlopen(req, timeout=120) as r:
                for raw in r:
                    line = raw.decode('utf-8', 'replace').strip()
                    if not line:
                        continue
                    with self.lock:
                        self.frames.append(json.loads(line))
        except Exception as e:
            self.error = e
        finally:
            self.finished.set()

    def snapshot(self):
        with self.lock:
            return list(self.frames)

    def wait_for(self, predicate, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for f in self.snapshot():
                if predicate(f):
                    return f
            if self.finished.is_set():
                # 结束前最后再看一次，避免漏掉末帧
                for f in self.snapshot():
                    if predicate(f):
                        return f
                return None
            time.sleep(0.05)
        return None


def mock_requests():
    try:
        return json.load(open(MOCK_REQUESTS, encoding='utf-8'))
    except Exception:
        return []


def main():
    base = host_base()
    print('host =', base)

    # ── 判据 1：纯文本流式 ────────────────────────────────
    stream = TurnStream(base, {'uuid': 'p1-c1', 'text': '博士你好', 'permMode': 'default'})
    stream.start()
    stream.finished.wait(90)
    frames = stream.snapshot()
    types = [f['type'] for f in frames]
    text = ''.join(f['data']['text'] for f in frames if f['type'] == 'text_delta')
    ok1 = (
        stream.error is None
        and types
        and types[0] == 'hello'
        and 'turn_start' in types
        and types.count('text_delta') > 0
        and types[-1] == 'done'
        and any(f['type'] == 'result' and f['data'].get('ok') for f in frames)
        and len(text) > 0
    )
    record('判据1 流式 text_delta 至 done', ok1,
           '帧序列=%s 文本=%r' % (types, text[:40]))

    # ── 判据 2：审批闭环（allow 分支）────────────────────
    stream2 = TurnStream(base, {'uuid': 'p1-c2', 'text': '[TOOL:bash] 请执行一条命令', 'permMode': 'default'})
    stream2.start()
    q = stream2.wait_for(lambda f: f['type'] == 'question', timeout=60)
    ok2_get_question = q is not None
    record('判据2a 敏感工具触发 question 帧', ok2_get_question,
           (json.dumps(q['data'], ensure_ascii=False)[:160] if q else '未收到 question 帧（可能工具被直裁放行）'))

    ok2_answer = False
    ok2_finished = False
    deny_ok = False
    if q:
        qid = q['data']['qId']
        status, body = post_json(base + '/bridge/approval', {'reqId': qid, 'decision': 'allow'})
        ok2_answer = status == 200 and json.loads(body).get('ok') is True
        record('判据2b /bridge/approval 应答被接受', ok2_answer, 'HTTP %s %s' % (status, body.strip()))

        stream2.finished.wait(90)
        types2 = [f['type'] for f in stream2.snapshot()]
        ok2_finished = stream2.error is None and types2[-1] == 'done'
        record('判据2c 应答后原流推进至 done', ok2_finished, '帧序列=%s' % types2)

    # ── 判据 2：审批闭环（deny 分支，不许悬挂）────────────
    stream3 = TurnStream(base, {'uuid': 'p1-c3', 'text': '[TOOL:bash] 再执行一条', 'permMode': 'default'})
    stream3.start()
    q3 = stream3.wait_for(lambda f: f['type'] == 'question', timeout=60)
    if q3:
        post_json(base + '/bridge/approval', {'reqId': q3['data']['qId'], 'decision': 'deny'})
        stream3.finished.wait(90)
        t3 = [f['type'] for f in stream3.snapshot()]
        deny_ok = stream3.error is None and t3[-1] == 'done'
        record('判据2d deny 后礼貌收尾不悬挂', deny_ok, '帧序列=%s' % t3)
    else:
        record('判据2d deny 后礼貌收尾不悬挂', False, '未收到 question 帧，无法验证 deny 分支')

    # ── 判据 3：上下文延续 + persona 无重复注入 ───────────
    anchor = read_persona_anchor()
    before = [r for r in mock_requests() if 'concise title' not in (r.get('systemPrompt') or '')]

    uuid3 = 'p1-ctx'
    for msg in ('第一句话', '我刚才说了什么？'):
        s = TurnStream(base, {'uuid': uuid3, 'text': msg, 'permMode': 'default'})
        s.start()
        s.finished.wait(90)

    after = [r for r in mock_requests() if 'concise title' not in (r.get('systemPrompt') or '')]
    # 上下文延续：同一 uuid 的第二次请求，messages 比第一次更多
    grew = len(after) > len(before) and after[-1]['messageCount'] > after[len(before)]['messageCount']
    record('判据3a 同 uuid 二次 turn 上下文延续', grew,
           'messageCount %s -> %s' % (after[len(before)]['messageCount'] if len(after) > len(before) else '?',
                                      after[-1]['messageCount'] if after else '?'))

    counts = [r['systemPrompt'].count(anchor) for r in after if anchor and r.get('systemPrompt')]
    stable = bool(counts) and len(set(counts)) == 1 and counts[0] > 0
    record('判据3b persona 无重复注入', stable,
           '锚点出现次数序列=%s' % (counts[-6:] if counts else '无'))

    # ── 判据 4：system prompt 含干员正文 ──────────────────
    last = after[-1] if after else None
    ok4 = bool(last) and bool(anchor) and anchor in last['systemPrompt']
    record('判据4 system prompt 含干员正文', ok4,
           '锚点=%r 出现 %s 次' % (anchor[:24], last['systemPrompt'].count(anchor) if last and anchor else 0))

    # ── 汇总 ────────────────────────────────────────────
    print()
    failed = [n for n, ok, _ in results if not ok]
    print('通过 %d/%d' % (len(results) - len(failed), len(results)))
    if failed:
        print('未通过：')
        for n in failed:
            print('  -', n)
    return 1 if failed else 0


def read_persona_anchor():
    """取当前激活干员 md 正文里的一句稳定文本，作为「人设真的进了 prompt」的锚点。"""
    try:
        active = json.load(open(OPERATORS_DIR + '/active.json', encoding='utf-8'))['active']
    except Exception:
        active = '阿米娅'
    try:
        md = open('%s/%s.md' % (OPERATORS_DIR, active), encoding='utf-8').read()
    except Exception:
        return ''
    for line in md.splitlines():
        line = line.strip().lstrip('#').strip()
        # 选一句足够长、含中文、且不含 markdown 噪声的行
        if len(line) >= 12 and re.search(r'[\u4e00-\u9fff]', line) and not line.startswith('|'):
            return line
    return ''


if __name__ == '__main__':
    sys.exit(main())
