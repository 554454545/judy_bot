# 离线验证 Python SDK 观测：请求/响应配对、usage、凭据脱敏、异常和文件权限。
import importlib.util
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('memory_observer', root / '.pi/extensions/memory/mem0/observability.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with TemporaryDirectory(dir=root / '.cache/tmp') as directory:
    path = Path(directory) / 'session.jsonl'
    context = {'file': str(path), 'sessionId': 'fixture', 'operationId': 'operation'}
    payload = {'choices': [{'message': {'content': 'result'}}], 'usage': {'prompt_tokens': 8, 'completion_tokens': 2}}
    response = SimpleNamespace(model_dump=lambda **kwargs: payload)
    resource = SimpleNamespace(create=lambda **kwargs: response)
    module.wrap_create(resource, context, 'memory.mem0.llm')
    assert resource.create(model='fixture', messages=[{'content': 'Bearer credential'}]) is response
    def fail(**kwargs):
        raise TimeoutError('fixture')
    resource = SimpleNamespace(create=fail)
    module.wrap_create(resource, context, 'memory.mem0.embedding')
    try:
        resource.create(model='fixture', input=['query'])
    except TimeoutError:
        pass
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert [row['stage'] for row in rows] == ['memory_request', 'memory_response', 'memory_request', 'memory_error']
    assert rows[0]['requestId'] == rows[1]['requestId']
    assert rows[1]['rawUsage']['prompt_tokens'] == 8
    assert rows[1]['cost'] is None
    assert 'credential' not in path.read_text()
    assert rows[2]['requestId'] == rows[3]['requestId']
    assert all('+08:00' in row['at'] for row in rows)
    assert path.stat().st_mode & 0o777 == 0o600
print('PASS Python memory request/response observations')
