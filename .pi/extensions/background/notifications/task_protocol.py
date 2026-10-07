# 后台事件与签收协议：复用 Joye task_protocol.py 的 inbox/claim/ack/drain/report；关联 notify-agent.py、notify-telegram.py 和 relay-notify.ts。
import contextlib
import copy
import fcntl
import json
import os
import re
import time
import uuid
from pathlib import Path
from datetime import datetime
from execution.runner import atomic_json as atomic, digest, read, summary
from execution.runner import emit
from storage.registry import DEFAULT_ROOT, transaction as registry_transaction
from projects.registry import assert_active, inactive

ROOT = DEFAULT_ROOT
TERMINAL = ('reported', 'closed_legacy', 'cancelled')
CONTROL_PHASES = {'done', 'ready_for_review', 'verified', 'rework', 'blocked', 'needs_reconciliation', 'batch_finished', 'review_overdue', 'observation_overdue', 'blocked_overdue', 'needs_reconciliation_overdue', 'verified_overdue', 'rework_overdue', 'batch_finished_overdue', 'user_input_required', 'human_fallback'}


def epoch(value):
    return datetime.fromisoformat(value).timestamp() if isinstance(value, str) else value


def task(registry, task_id):
    value = registry['tasks'][task_id]
    project = registry.get('projects', {}).get(value.get('projectId'))
    if project:
        assert_active(project)
    return value


@contextlib.contextmanager
def transaction(root, filename='registry.json'):
    if filename == 'registry.json':
        with registry_transaction(root) as registry:
            yield registry
        return
    directory = Path(root)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(directory / (filename + '.lock'), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        data = read(directory / filename, {})
        if not isinstance(data, dict):
            raise ValueError('notification state must be an object')
        before = digest(data)
        yield data
        if digest(data) != before:
            atomic(directory / filename, data)
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


@contextlib.contextmanager
def registry_inbox(root, write_registry=False):
    # 与项目所有 writer 共用 registry.lock；严格固定 registry → inbox 锁顺序。
    with registry_transaction(root) as registry:
        with transaction(root, 'inbox.json') as box:
            yield registry, box


def binding(t):
    return {k: copy.deepcopy(t.get(k)) for k in ('route', 'type', 'agent_name', 'workspace_id', 'pane_id')}


def notification_task(registry, eid):
    # 当前接力已有的 final-TASK-RUN[-late-HASH] 以及分块 ID；不按项目名子串匹配。
    base = eid.split(':part-', 1)[0]
    event = registry.get('outbox', {}).get(base)
    if event:
        return registry.get('tasks', {}).get(event.get('task_id'))
    matches = []
    for value in registry.get('tasks', {}).values():
        for rid in value.get('runs', {}):
            expected = f"final-{value['taskId']}-{rid}"
            if base == expected or re.fullmatch(re.escape(expected) + '-late-[0-9a-f]{16}', base):
                matches.append(value)
    if len(matches) > 1:
        raise ValueError('notification identity is ambiguous')
    return matches[0] if matches else None


@contextlib.contextmanager
def notification_receipts(root, eid):
    # 发送意图与归档围栏共用 registry → ledger 锁顺序，防止检查后才开始旧项目投递。
    with registry_transaction(root) as registry:
        current = notification_task(registry, eid)
        project = registry.get('projects', {}).get(current.get('projectId')) if current else None
        if project:
            assert_active(project)
        with transaction(root, 'telegram-receipts.json') as receipts:
            yield receipts

def control_event(reg, e):
    canonical = reg.get('outbox', {}).get(e.get('event_id'))
    if canonical and all((canonical.get(k) == e.get(k) for k in ('task_id', 'run_id', 'route'))):
        return canonical
    return e if e.get('task_id') and e.get('run_id') else None

def freshness(reg, e):
    c = control_event(reg, e)
    if c is None:
        return (None, None)
    t = reg.get('tasks', {}).get(c['task_id'])
    if t is None:
        return (c, 'registry_missing')
    if inactive(reg.get('projects', {}).get(t.get('projectId'), {})):
        return (c, 'project_archived')
    if t.get('run_id') != c['run_id']:
        return (c, 'run_replaced')
    if t.get('status') in TERMINAL:
        return (c, 'task_terminal')
    if c.get('binding') is not None and c['binding'] != binding(t):
        return (c, 'binding_changed')
    if c.get('route', {}) != t.get('route', {}):
        return (c, 'route_changed')
    phase, status = (c.get('phase'), t.get('status'))
    if phase not in CONTROL_PHASES:
        return (c, 'phase_unknown')
    expected = {'review_overdue': ('done', 'ready_for_review'), 'done': ('done', 'ready_for_review')}
    if phase == 'observation_overdue':
        valid = bool(t.get('probe_unknown_since'))
    elif phase == 'human_fallback':
        valid = c.get('for_status') == status and bool(t.get('attention_required'))
    elif phase == 'user_input_required':
        valid = t.get('user_request', {}).get('event_id') == c['event_id'] and (not t.get('user_request', {}).get('resolved'))
    else:
        valid = status in expected.get(phase, (phase.removesuffix('_overdue'),))
    if not valid:
        return (c, 'phase_progressed')
    if c.get('status_since') is not None and phase not in ('user_input_required',) and (c['status_since'] != t.get('status_changed_at')):
        return (c, 'phase_reentered')
    return (c, None)

def handled_failure(root, reg, t):
    # 原失败已经有真实发送和 handled 文件证明时，抑制同一结果的旧提醒；不抑制新结果或未知发送。
    if t.get('status') != 'blocked':
        return False
    if t.get('observation') in ('result_unreadable', 'result_identity_mismatch', 'herdr_unavailable'):
        return False
    try:
        box = read(Path(root) / 'inbox.json', {})
        ledger = read(Path(root) / 'telegram-receipts.json', {})
    except (OSError, ValueError):
        return False
    if not isinstance(box, dict) or not isinstance(ledger, dict):
        return False
    for event in box.values():
        if event.get('state') != 'handled' or event.get('phase') not in ('blocked', 'blocked_overdue'):
            continue
        canonical, reason = freshness(reg, event)
        if reason or not canonical or canonical.get('task_id') != t['taskId']:
            continue
        if canonical.get('result_path') != t['runs'][t['run_id']].get('result_path'):
            continue
        proof = event.get('receipt', {})
        try:
            if not proof.get('path') or summary(proof['path']) != proof:
                continue
            detail = read(proof['path'], {})
            delivery = detail.get('receipt', {})
            known = any(item.get('state') == 'success' and all(item.get(key) == delivery.get(key) for key in ('event_id', 'message_id', 'hash', 'target')) for item in ledger.values())
            if detail.get('event_id') == event['event_id'] and detail.get('task_id') == t['taskId'] and detail.get('run_id') == t['run_id'] and detail.get('status') == 'blocked' and delivery.get('state') == 'success' and known:
                return True
        except (OSError, ValueError, TypeError):
            continue
    return False


def dispose_control(reg, e, now, root=None):
    c, reason = freshness(reg, e)
    if not reason and root is not None and (c or {}).get('phase') == 'blocked_overdue':
        current = reg['tasks'][c['task_id']]
        if handled_failure(root, reg, current):
            reason = 'failure_already_notified'
    if not reason:
        return False
    if e.get('state') in ('handled', 'superseded'):
        return True
    if reason in ('registry_missing', 'phase_unknown') and e.get('disposition', {}).get('reason') == reason:
        return True
    t = reg.get('tasks', {}).get(e.get('task_id'))
    disposition = dict(kind='internal', reason=reason, at=now, event_id=e['event_id'], registry_revision=reg.get('revision'), task_hash=digest(t), result_path=(c or {}).get('result_path'), previous_state=e.get('state'))
    e.setdefault('dispositions', []).append(disposition)
    e.update(state='needs_attention' if reason in ('registry_missing', 'phase_unknown') else 'superseded', disposition=disposition, next_at=now + 3600)
    return True

def delivery_hash(text):
    return digest(json.dumps(text, ensure_ascii=False, separators=(',', ':')).encode())

def event_id(tid, rid, phase):
    return digest([tid, rid, phase])

def request_user(root, tid, rid, evidence, text):
    proof = summary(evidence)
    if proof.get('size', 0) <= 0 or not text.strip():
        raise ValueError('decision text and evidence required')
    with transaction(root) as reg:
        t = task(reg, tid)
        if t.get('run_id') != rid or t.get('status') in TERMINAL:
            raise ValueError('not current')
        if t.get('user_request'):
            raise ValueError('request already recorded; reconcile before another request')
        eid = emit(reg, t, 'user_input_required')
        t['user_request'] = dict(event_id=eid, evidence=proof, text=text, resolved=False)
        reg['outbox'][eid]['human_reason'] = text
        return eid

def enqueue(root, text, source='', event=None):
    e = dict(event or {})
    e.setdefault('event_id', uuid.uuid4().hex)
    e.setdefault('route', {'profile': 'personal'})
    e.update(text=text[:500], source=source, ts=time.time())
    if e.get('phase') is not None and e['phase'] not in CONTROL_PHASES:
        raise ValueError('unknown control phase')
    eid = e['event_id']
    with registry_inbox(root) as (reg, box):
        canonical = control_event(reg, e)
        current = reg.get('tasks', {}).get(e.get('task_id'))
        if current:
            project = reg.get('projects', {}).get(current.get('projectId'))
            if project:
                assert_active(project)
        if canonical:
            for k in ('phase', 'binding', 'status_since', 'created_at', 'visibility'):
                if k in canonical:
                    e[k] = copy.deepcopy(canonical[k])
        if eid in box:
            for k in ('task_id', 'run_id', 'result_path', 'route'):
                if box[eid].get(k) != e.get(k):
                    raise ValueError('event collision')
        else:
            box[eid] = dict(e, state='pending', attempts=0, next_at=0, admission_order=max((v.get('admission_order', 0) for v in box.values()), default=0) + 1)
    return eid

def route_matches(want, owner):
    if not owner or not owner.get('main') or (not owner.get('idle')):
        return False
    if want.get('profile', 'personal') != owner.get('profile'):
        return False
    if want.get('session_id') and want['session_id'] != owner.get('session_id'):
        return False
    target = want.get('target')
    return target is None or target == owner.get('target')

def claim(root, owner, now=None):
    now = time.time() if now is None else now
    with registry_inbox(root) as (reg, box):
        for e in sorted(box.values(), key=lambda e: (max(e.get('last_claim_at', 0), epoch(e.get('created_at', e.get('ts', 0)))), e.get('ts', 0), e.get('admission_order', 0), e['event_id'])):
            if e['state'] in ('handled', 'superseded'):
                continue
            if dispose_control(reg, e, now, root):
                continue
            if not route_matches(e.get('route', {}), owner):
                continue
            if e['state'] == 'needs_attention' and e.get('attention_required') == 'delivery_unknown':
                # 网络结果不明不能因自身回复改了 leaf 或租约到期重新认领。
                continue
            changed_branch = e['state'] == 'needs_attention' and any((e.get('attention_owner', {}).get(k) != owner.get(k) for k in ('session_id', 'leaf_id')))
            if e.get('next_at', 0) > now and (not changed_branch):
                continue
            if e['state'] in ('claimed', 'enqueued') and e.get('lease_until', 0) > now:
                continue
            e.update(state='claimed', claim_id=uuid.uuid4().hex, owner=owner, lease_until=now + 120, attempts=e['attempts'] + 1, last_claim_at=now)
            return copy.deepcopy(e)
    return None

def validate_notice(root, eid, cid, owner, now=None):
    now = time.time() if now is None else now
    with registry_inbox(root) as (reg, box):
        e = box[eid]
        if e.get('claim_id') != cid:
            return {'action': 'stale_claim'}
        if e['state'] in ('handled', 'superseded'):
            return {'action': e['state']}
        if dispose_control(reg, e, now, root):
            return {'action': e['state']}
        keys = ('pid', 'session_id', 'profile', 'target', 'generation', 'epoch', 'leaf_id')
        if not route_matches(e.get('route', {}), dict(owner, idle=True)) or any((e.get('owner', {}).get(k) != owner.get(k) for k in keys)):
            return {'action': 'owner_changed'}
        c = control_event(reg, e)
        return {'action': 'current', 'internal': c is not None, 'phase': c.get('phase') if c else None}

def receipt(root, eid, cid, state, evidence=None):
    if state not in ('pending', 'enqueued', 'handled'):
        raise ValueError('bad receipt')
    proof = summary(evidence) if state == 'handled' and evidence else None
    if state == 'handled' and (not proof or proof.get('size', 0) <= 0):
        raise ValueError('handling evidence file required')
    with transaction(root, 'inbox.json') as box:
        e = box[eid]
        if e.get('claim_id') != cid:
            raise ValueError('stale claim')
        if e['state'] in ('handled', 'superseded'):
            return
        e.update(state=state, receipt=proof if state == 'handled' else evidence, updated_at=time.time(), updated_monotonic_ns=str(time.monotonic_ns()))
        if state == 'pending':
            e['next_at'] = time.time() + min(3600, 5 * 2 ** min(e['attempts'], 9))
        if state == 'enqueued':
            e.setdefault('first_enqueued_at', time.time())
            e['lease_until'] = time.time() + 1800

def attention(root, eid, cid, evidence):
    proof = summary(evidence)
    detail = read(evidence, {})
    if proof.get('size', 0) <= 0:
        raise ValueError('attention evidence required')
    with transaction(root, 'inbox.json') as box:
        event = box[eid]
        if event.get('claim_id') != cid:
            raise ValueError('stale claim')
        if event['state'] in ('handled', 'superseded'):
            return
        latest_owner = detail.get('owner')
        owner_keys = ('pid', 'session_id', 'profile', 'target', 'generation', 'epoch')
        if not isinstance(latest_owner, dict) or any(latest_owner.get(key) != event.get('owner', {}).get(key) for key in owner_keys):
            latest_owner = event.get('owner', {})
        uncertain = detail.get('receipt', {}).get('state') in ('unknown', 'sending')
        event.update(
            state='needs_attention',
            attention_required='delivery_unknown' if uncertain else 'delivery_or_review_unconfirmed',
            attention_owner=latest_owner,
            attention_evidence=proof,
            next_at=time.time() + 3600,
            updated_at=time.time(),
        )
        # API 明确拒绝或本地限速的重试时间来自实际回执；unknown 不能走此分支。
        if detail.get('receipt', {}).get('state') == 'failed' and detail.get('receipt', {}).get('retry_at', 0) > time.time():
            event.update(state='pending', next_at=detail['receipt']['retry_at'])

def observe_input(root, eid, cid, entry_id, session_id, recovery_entry_id=None, entry_at=None, now=None):
    """Persisted input proves admission only. One stable recovery prompt per branch.
    A persisted recovery without handled proof becomes visible needs_attention;
    it cannot renew enqueued forever or automatically repeat business side effects.
    """
    now = now or time.time()
    with registry_inbox(root) as (reg, box):
        e = box[eid]
        if e.get('claim_id') != cid:
            raise ValueError('stale claim')
        if e['state'] in ('handled', 'superseded'):
            return {'action': e['state']}
        if dispose_control(reg, e, now, root):
            return {'action': e['state']}
        if e.get('owner', {}).get('session_id') != session_id:
            raise ValueError('session mismatch')
        e['observed_input'] = {'entry_id': entry_id, 'session_id': session_id, 'at': now}
        e.setdefault('first_enqueued_at', min(now, entry_at) if entry_at is not None and entry_at > 0 else now)
        deadline = e['first_enqueued_at'] + e.get('handling_timeout', 1800)
        if now < deadline:
            e.update(state='enqueued', lease_until=deadline)
            return {'action': 'defer', 'deadline': deadline}
        if recovery_entry_id:
            e.update(state='needs_attention', attention_required='handling_unconfirmed', recovery_entry_id=recovery_entry_id, attention_owner=e['owner'], next_at=now + 3600)
            return {'action': 'attention'}
        e.update(attention_required='handling_overdue', recovery_requested_at=e.get('recovery_requested_at', now))
        return {'action': 'recover'}

def drain(root, sender, now=None):
    now = now or time.time()
    snapshot = read(Path(root) / 'registry.json', {'outbox': {}})
    for eid, event in sorted(snapshot.get('outbox', {}).items(), key=lambda pair: (epoch(pair[1].get('created_at', 0)), pair[0])):
        for target in ('agent', 'telegram'):
            claim_id = uuid.uuid4().hex
            with transaction(root) as reg:
                d = reg['outbox'][eid]['targets'][target]
                if d['state'] in ('success', 'unknown', 'superseded', 'internal'):
                    continue
                _, reason = freshness(reg, event)
                if not reason and event.get('phase') == 'blocked_overdue' and handled_failure(root, reg, reg['tasks'][event['task_id']]):
                    reason = 'failure_already_notified'
                if reason in ('registry_missing', 'phase_unknown'):
                    continue
                if reason and d['state'] != 'sending':
                    d.update(state='superseded', reason=reason, at=now)
                    continue
                if target == 'telegram' and event['phase'] not in ('human_fallback', 'user_input_required') and (d['state'] != 'sending'):
                    d.update(state='internal', reason='internal_control', at=now)
                    continue
                if d.get('next_at', 0) > now:
                    continue
                if d['state'] == 'sending':
                    if d.get('lease_until', 0) > now:
                        continue
                    if target == 'telegram':
                        d['state'] = 'unknown'
                        continue
                d.update(state='sending', claim_id=claim_id, lease_until=now + 60, attempts=d['attempts'] + 1)
            try:
                result = sender(target, event)
            except Exception:
                result = {'state': 'unknown' if target == 'telegram' else 'failed'}
            with transaction(root) as reg:
                d = reg['outbox'][eid]['targets'][target]
                if d.get('claim_id') != claim_id:
                    continue
                state = result.get('state', 'failed')
                if state not in ('success', 'unknown', 'failed'):
                    state = 'failed'
                d.update(state=state, receipt=result, next_at=now + min(3600, 15 * 2 ** min(d['attempts'], 8)))

def prepare_report(root, tid, rid, body_hash, target):
    if not re.fullmatch('[0-9a-f]{64}', body_hash) or not target.get('chatId'):
        raise ValueError('expected delivery hash and target required')
    with transaction(root) as reg:
        t = task(reg, tid)
        if t.get('run_id') != rid or t['status'] != 'verified':
            raise ValueError('not verified')
        intent = dict(task_id=tid, run_id=rid, hash=body_hash, target=target, verification_hash=digest(t['verification']), at=time.time())
        old = t.get('report_intent')
        if old:
            if any((old[k] != intent[k] for k in intent if k != 'at')):
                raise ValueError('report intent already bound')
        else:
            t['report_intent'] = intent
    return old or intent

def report(root, tid, rid, proof):
    if proof.get('status') != 'success' or not proof.get('message_id') or (not proof.get('target')):
        raise ValueError('confirmed delivery receipt required')
    candidates = list(read(Path(root) / 'telegram-receipts.json', {}).values())
    ledger = DEFAULT_ROOT.parent / 'tmp/telegram/outbox/delivery-ledger.jsonl'
    if proof.get('delivery_id') and ledger.exists():
        with ledger.open() as f:
            for line in f:
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                if item.get('delivery_id') == proof['delivery_id']:
                    item['target'] = {'chatId': item.get('target'), **({'threadId': item['thread']} if item.get('thread') is not None else {})}
                    candidates.append(item)
    known = next((r for r in candidates if (r.get('status') == 'success' or r.get('state') == 'success') and r.get('message_id') == proof['message_id'] and (r.get('target') == proof['target']) and (proof.get('event_id') and r.get('event_id') == proof['event_id'] or (proof.get('delivery_id') and r.get('delivery_id') == proof['delivery_id']))), None)
    if not known:
        raise ValueError('receipt not found in sender ledger')
    with transaction(root) as reg:
        t = task(reg, tid)
        if t.get('run_id') != rid or t['status'] != 'verified' or (not t.get('verification', {}).get('ok')):
            raise ValueError('not verified')
        intent = t.get('report_intent', {})
        if not intent or intent['verification_hash'] != digest(t['verification']) or intent['target'] != known.get('target') or (intent['hash'] != known.get('hash')):
            raise ValueError('receipt does not match prepared final report')
        if epoch(known.get('at', known.get('timestamp', 0) / 1000)) < intent['at']:
            raise ValueError('delivery predates prepared report')
        t.update(status='reported', report=dict(proof, run_id=rid, verification_hash=digest(t['verification'])))
        t['runs'][rid]['report'] = copy.deepcopy(t['report'])
