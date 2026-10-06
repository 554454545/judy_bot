# 邮箱收取：Python 标准库连接 QQ/163/Gmail 的只读 IMAP；index.ts 调用，配置和数据保存在项目 .pi/agent。
import email
import hashlib
import email.policy
import imaplib
import json
import os
import re
import ssl
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "agent"
CONFIG = ROOT / "config/mail/accounts.json"
DATA = ROOT / "mail"
HOSTS = {"qq": "imap.qq.com", "163": "imap.163.com", "gmail": "imap.gmail.com"}


def now():
    return datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf8") as output:
        json.dump(value, output, ensure_ascii=False)
    os.replace(temporary, path)


def load(path, default=None):
    if not path.exists():
        return default
    with path.open(encoding="utf8") as source:
        return json.load(source)


def validate(account):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", str(account.get("id", ""))):
        raise ValueError("账号 id 必须是 1—40 位英文、数字、下划线或连字符")
    if account.get("provider") not in HOSTS:
        raise ValueError("provider 仅支持 qq、163、gmail")
    if not isinstance(account.get("email"), str) or "@" not in account["email"]:
        raise ValueError("请填写完整邮箱地址")
    oauth = account.get("oauth")
    if oauth:
        if account["provider"] != "gmail" or not all(oauth.get(key) for key in ("clientId", "clientSecret", "refreshToken")):
            raise ValueError("Gmail OAuth 需要 clientId、clientSecret、refreshToken")
    elif not account.get("password"):
        raise ValueError("请填写邮箱授权码或 Gmail 应用专用密码")


def authenticate(client, account):
    oauth = account.get("oauth")
    if oauth:
        data = urllib.parse.urlencode({
            "client_id": oauth["clientId"],
            "client_secret": oauth["clientSecret"],
            "refresh_token": oauth["refreshToken"],
            "grant_type": "refresh_token",
        }).encode()
        request = urllib.request.Request("https://oauth2.googleapis.com/token", data=data)
        with urllib.request.urlopen(request, timeout=20) as response:
            token = json.load(response)["access_token"]
        auth = f'user={account["email"]}\x01auth=Bearer {token}\x01\x01'.encode()
        client.authenticate("XOAUTH2", lambda _: auth)
    else:
        password = account["password"]
        if account["provider"] == "gmail":
            password = password.replace(" ", "")
        client.login(account["email"], password)
    if account["provider"] == "163":
        # 网易客户端识别要求；使用固定客户端元数据，不发送用户隐私。
        imaplib.Commands.setdefault("ID", ("AUTH",))
        client._simple_command("ID", '("name" "pi-bot" "version" "1.0")')


def parse(raw):
    message = email.message_from_bytes(raw, policy=email.policy.default)
    text = []
    html = []
    for part in message.walk():
        if part.get_content_disposition() == "attachment" or part.is_multipart():
            continue
        kind = part.get_content_type()
        if kind not in ("text/plain", "text/html"):
            continue
        try:
            content = part.get_content()
        except (LookupError, UnicodeError):
            content = (part.get_payload(decode=True) or b"").decode("utf8", errors="replace")
        (text if kind == "text/plain" else html).append(str(content))
    date = None
    try:
        value = parsedate_to_datetime(str(message.get("Date", "")))
        if value.tzinfo is not None:
            date = value.isoformat()
    except (ValueError, TypeError, OverflowError):
        pass
    return {
        "from": str(message.get("From", "?")),
        "subject": str(message.get("Subject", "(无主题)")),
        "date": date,
        "receivedAt": now(),
        "text": "\n".join(text)[:100000],
        "html": "\n".join(html)[:100000],
    }


def sync_account(account, factory=imaplib.IMAP4_SSL):
    validate(account)
    identity = account["provider"] + ":" + account["email"].lower()
    state_path = DATA / "state" / (account["id"] + ".json")
    previous = load(state_path, {})
    client = factory(HOSTS[account["provider"]], 993, ssl_context=ssl.create_default_context(), timeout=20)
    try:
        authenticate(client, account)
        status, _ = client.select("INBOX", readonly=True)
        if status != "OK":
            raise RuntimeError("无法只读打开收件箱")
        validity = client.response("UIDVALIDITY")[1]
        if not validity or not validity[0] or not bytes(validity[0]).isdigit():
            raise RuntimeError("服务端未返回 UIDVALIDITY")
        epoch = int(validity[0])
        initial = previous.get("identity") != identity or previous.get("uidValidity") != epoch
        last = 0 if initial else int(previous.get("lastUid", 0))
        status, found = client.uid("search", None, "ALL" if initial else f"UID {last + 1}:*")
        if status != "OK":
            raise RuntimeError("邮件搜索失败")
        uids = sorted(int(uid) for uid in (found[0] or b"").split() if int(uid) > last)
        uids = uids[-10:] if initial else uids[:30]
        baseline = max(uids, default=0) if initial else int(previous.get("bootstrapUntil", 0))
        count = 0
        for uid in uids:
            fingerprint = hashlib.sha256(identity.encode()).hexdigest()[:12]
            filename = f'{account["id"]}_{fingerprint}_{epoch}_{uid:012d}.json'
            path = DATA / "inbox" / filename
            if not path.exists():
                # PEEK 不标记已读；只获取至多 2 MiB，不下载附件到磁盘。
                status, response = client.uid("fetch", str(uid), "(BODY.PEEK[]<0.2097152>)")
                raw = next((part[1] for part in response if isinstance(part, tuple)), None)
                if status != "OK" or raw is None:
                    raise RuntimeError("邮件读取失败")
                item = parse(raw)
                item.update({
                    "account": account["id"],
                    "identity": identity,
                    "uid": uid,
                    "notificationPending": uid > baseline,
                    "sourcePartial": len(raw) >= 2097152,
                })
                save(path, item)
                count += 1
            last = uid
            save(state_path, {"identity": identity, "uidValidity": epoch, "lastUid": last, "bootstrapUntil": baseline, "updatedAt": now()})
        # 空收件箱也建立基线，下一封新邮件应通知。
        if not uids:
            save(state_path, {"identity": identity, "uidValidity": epoch, "lastUid": last, "bootstrapUntil": baseline, "updatedAt": now()})
        return {"account": account["id"], "ok": True, "saved": count, "initial": initial, "at": now()}
    finally:
        try:
            client.logout()
        except Exception:
            pass


def main():
    config = load(CONFIG, {"accounts": []})
    accounts = config.get("accounts", [])
    if not isinstance(accounts, list):
        raise ValueError("accounts 必须是列表")
    active = [account for account in accounts if account.get("enabled") is True]
    ids = [account.get("id") for account in active]
    if len(ids) != len(set(ids)):
        raise ValueError("启用账号 id 不得重复")
    results = []
    for account in active:
        try:
            result = sync_account(account)
        except Exception as error:
            # 不保存异常正文（可能包含服务器信息或凭据）。
            result = {"account": str(account.get("id", "unknown")), "ok": False, "error": type(error).__name__, "at": now()}
        results.append(result)
    save(DATA / "status.json", {"at": now(), "accounts": results})
    print(json.dumps({"accounts": results}, ensure_ascii=False))


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": type(error).__name__}))
        sys.exit(1)
