# memory-receipts — 离线验证 mem0 写入凭据与中断核对，避免重启后重复添加记忆。
# 流程：临时目录 + 假 Memory → 首次写入、重复调用、部分写入、配置失败。
# 关联：.pi/extensions/memory/mem0/mem0-cli.py；不连接模型、真实数据库或 Telegram。
import json
from pathlib import Path
import runpy
import shutil
import tempfile

root = Path(__file__).resolve().parents[2]
temporary = Path(tempfile.mkdtemp(prefix="memory-receipts-", dir=root / ".cache/tmp"))
module = runpy.run_path(str(root / ".pi/extensions/memory/mem0/mem0-cli.py"))
namespace = module["add_task"].__globals__
namespace["PROJECT_ROOT"] = temporary


class FakeMemory:
    def __init__(self):
        self.calls = 0
        self.fail = False

    def add(self, content, user_id, metadata):
        self.calls += 1
        assert metadata["bot_source_session_id"] == "session"
        assert metadata["bot_source_message_id"] == "message"
        if self.fail:
            raise TimeoutError("possibly committed")
        return {"results": [{"id": "full-memory-id", "event": "ADD"}]}

    def get_all(self, filters, top_k):
        assert "bot_memory_task_id" in filters
        return {"results": [{"id": "partial-memory-id"}]}


try:
    memory = FakeMemory()
    namespace["get_memory"] = lambda: memory
    task = "a" * 64
    first = module["add_task"](task, "fact", "session", "message")
    assert first["status"] == "completed"
    assert first["ids"] == ["full-memory-id"]
    assert module["add_task"](task, "fact", "session", "message")["status"] == "completed"
    assert memory.calls == 1
    receipt = module["receipt_file"](task)
    assert receipt.stat().st_mode & 0o777 == 0o600
    assert json.loads(receipt.read_text())["updatedAt"].endswith("+08:00")

    interrupted = "b" * 64
    module["save_receipt"](module["receipt_file"](interrupted), {"status": "writing", "ids": []})
    result = module["add_task"](interrupted, "fact", "session", "message")
    assert result["status"] == "unknown"
    assert result["matches"] == ["partial-memory-id"]
    assert memory.calls == 1
    assert module["check_task"]("c" * 64)["status"] == "safe_retry"

    memory.fail = True
    uncertain = "d" * 64
    assert module["add_task"](uncertain, "fact", "session", "message")["status"] == "unknown"
    assert module["add_task"](uncertain, "fact", "session", "message")["status"] == "unknown"
    assert memory.calls == 2

    def invalid_config():
        raise ValueError("invalid configuration")

    namespace["get_memory"] = invalid_config
    assert module["add_task"]("e" * 64, "fact", "session", "message")["status"] == "blocked"
    assert memory.calls == 2
    print("PASS durable receipts, no replay after completion/partial write, configuration failures")
finally:
    shutil.rmtree(temporary)
