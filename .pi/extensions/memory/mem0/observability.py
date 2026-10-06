# mem0 模型观测：包装已创建 SDK client 的调用，记录参数、完整解析响应和原始 usage 到所属 session。
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path


def sanitize(value):
    if isinstance(value, dict):
        return {key: '[REDACTED]' if re.fullmatch(r'authorization|api[-_]?key|token|secret|password', key, re.I) else sanitize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r'\bsk[-_][a-zA-Z0-9_-]{12,}\b', '[REDACTED]', value)
        return re.sub(r'Bearer\s+\S+', 'Bearer [REDACTED]', value, flags=re.I)
    return value


def record(context, stage, source, details):
    if not context:
        return
    try:
        path = Path(context['file'])
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        row = {'schemaVersion': 3, 'at': datetime.now(timezone(timedelta(hours=8))).isoformat(),
               'stage': stage, 'source': source, 'sessionId': context['sessionId'],
               'operationId': context['operationId'], **details}
        data = (json.dumps(sanitize(row), ensure_ascii=False) + '\n').encode()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            if os.write(fd, data) != len(data):
                raise OSError('Incomplete observation write')
        finally:
            os.close(fd)
    except Exception:
        print('Memory observability write failed', file=sys.stderr)


def wrap_create(resource, context, source):
    original = resource.create

    def create(*args, **kwargs):
        request_id = str(uuid.uuid4())
        started = time.monotonic()
        record(context, 'memory_request', source, {
            'requestId': request_id, 'providerPayload': kwargs,
            'boundary': 'OpenAI SDK create; internal HTTP retries not individually observed'})
        try:
            response = original(*args, **kwargs)
            payload = response.model_dump(mode='json')
            record(context, 'memory_response', source, {
                'requestId': request_id, 'providerResponse': payload,
                'rawUsage': payload.get('usage'), 'cost': None,
                'costStatus': 'unknown_missing_price',
                'elapsedMs': round((time.monotonic() - started) * 1000)})
            return response
        except Exception as error:
            record(context, 'memory_error', source, {
                'requestId': request_id, 'errorType': type(error).__name__,
                'status': getattr(error, 'status_code', None)})
            raise

    resource.create = create


def instrument(memory):
    raw = os.environ.get('BOT_MEMORY_OBSERVATION', '')
    if not raw:
        return memory
    context = json.loads(raw)
    wrap_create(memory.llm.client.chat.completions, context, 'memory.mem0.llm')
    wrap_create(memory.embedding_model.client.embeddings, context, 'memory.mem0.embedding')
    return memory
