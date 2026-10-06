# 邮箱同步离线验证：模拟 IMAP 的 UID 基线、重启续传、身份变更和失败重试；关联 .pi/extensions/mail/imap.py。
import sys
sys.dont_write_bytecode = True
import importlib.util
import json
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("mail_worker", root / ".pi/extensions/mail/imap.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Client:
    uids = [1, 2]
    fail = None
    epoch = b"77"

    def __init__(self, host, port, **kwargs):
        assert host == "imap.qq.com" and port == 993
        self.ssl = kwargs["ssl_context"]

    def login(self, user, password):
        assert user == "test@qq.com" and password == "fixture"

    def select(self, mailbox, readonly):
        assert mailbox == "INBOX" and readonly
        return "OK", []

    def response(self, kind):
        assert kind == "UIDVALIDITY"
        return kind, [self.epoch]

    def uid(self, action, *args):
        if action == "search":
            return "OK", [b" ".join(str(uid).encode() for uid in self.uids)]
        assert "BODY.PEEK[]" in args[1]
        if int(args[0]) == self.fail:
            return "NO", []
        return "OK", [(b"meta", b"From: sender@example.invalid\r\nSubject: hello\r\nDate: Mon, 5 Oct 2026 02:00:00 +0000\r\n\r\nfixture body")]

    def logout(self):
        pass


with tempfile.TemporaryDirectory(dir=root / ".cache/tmp", prefix="mail-imap-") as temp:
    worker.DATA = Path(temp)
    account = {"id": "qq", "provider": "qq", "email": "test@qq.com", "password": "fixture"}
    Client.fail = 2
    try:
        worker.sync_account(account, Client)
        raise AssertionError("fetch failure expected")
    except RuntimeError:
        pass
    Client.fail = None
    worker.sync_account(account, Client)
    files = list((worker.DATA / "inbox").glob("*.json"))
    assert len(files) == 2
    assert all(not json.loads(file.read_text())["notificationPending"] for file in files)
    Client.uids = [1, 2, 3]
    result = worker.sync_account(account, Client)
    assert result["saved"] == 1 and not result["initial"]
    pending = [file for file in (worker.DATA / "inbox").glob("*.json") if json.loads(file.read_text())["notificationPending"]]
    assert len(pending) == 1
    assert worker.sync_account(account, Client)["saved"] == 0
    Client.epoch = b"88"
    assert worker.sync_account(account, Client)["initial"]
    assert len(list((worker.DATA / "inbox").glob("*.json"))) == 6
    try:
        worker.validate({**account, "id": "../escape"})
        raise AssertionError("invalid id accepted")
    except ValueError:
        pass
print("Mail IMAP lifecycle checks passed; no network.")

from unittest.mock import patch
from io import BytesIO


class AuthClient:
    def login(self, user, password):
        self.login_value = (user, password)

    def _simple_command(self, name, values):
        assert name == "ID" and '"pi-bot"' in values
        self.identified = True

    def authenticate(self, method, callback):
        assert method == "XOAUTH2"
        assert callback(b"") == b"user=test@gmail.com\x01auth=Bearer fixture-token\x01\x01"
        self.oauth = True


client = AuthClient()
worker.authenticate(client, {"provider": "163", "email": "test@163.com", "password": "fixture"})
assert client.login_value == ("test@163.com", "fixture") and client.identified
client = AuthClient()
worker.authenticate(client, {"provider": "gmail", "email": "test@gmail.com", "password": "abcd efgh"})
assert client.login_value == ("test@gmail.com", "abcdefgh")
client = AuthClient()
with patch.object(worker.urllib.request, "urlopen", return_value=BytesIO(b'{"access_token":"fixture-token"}')) as request:
    worker.authenticate(client, {"provider": "gmail", "email": "test@gmail.com", "oauth": {
        "clientId": "fixture", "clientSecret": "fixture", "refreshToken": "fixture",
    }})
    assert request.call_args.args[0].full_url == "https://oauth2.googleapis.com/token"
assert client.oauth
print("163 identification and Gmail password/OAuth checks passed; no network.")
