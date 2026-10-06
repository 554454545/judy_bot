# 后台 TG 投递：复用 Joye 凭据与退避，引用原任务消息并保存真实引用回执；关联 relay-notify.ts 和项目 telegram.json。
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import argparse, hashlib, json, os, sys, time, urllib.request, urllib.parse, urllib.error, uuid
from pathlib import Path
from task_protocol import ROOT, transaction, digest, delivery_hash

def cooldown_guard(config, profile, token, chat):
    """Respect live bridge cooldowns and serialize standalone notification attempts."""
    directory=Path(config).parent/'tmp'/'telegram'
    key=hashlib.sha256(json.dumps([profile,token,chat],separators=(',',':')).encode()).hexdigest()[:24]
    return directory,key

def send(text, config, profile='personal', opener=urllib.request.urlopen, target=None, parse_mode=None, reply_to_message_id=None):
    try:
        cfg=json.loads(Path(config).read_text())
    except (OSError,ValueError):
        return {'state':'failed','reason':'configuration_unavailable'}
    if not isinstance(cfg,dict) or not isinstance(cfg.get('profiles'),dict):
        return {'state':'failed','reason':'configuration_invalid'}
    prof=cfg['profiles'].get(profile,{})
    if not isinstance(prof,dict):
        return {'state':'failed','reason':'configuration_invalid'}
    token=prof.get('botToken')
    chat=prof.get('allowedUserId')
    if not token or not chat:
        return {'state':'failed','reason':'skipped_missing_configuration'}
    target=target or {'chatId':chat}
    if target.get('chatId')!=chat:
        return {'state':'failed','reason':'target_not_paired'}
    directory,key=cooldown_guard(config,profile,token,chat)
    # This is a bounded mitigation, not a second queue: preserve caller's durable
    # event for later, and yield to the bridge's already accepted text replies.
    with transaction(directory,'notification-cooldowns.json') as cooldowns:
        until=cooldowns.get(key,0)
        try:
            for file in (directory/'outbox').glob(key+'-*.json'):
                record=json.loads(file.read_text())
                until=max(until,record.get('retryAt',0)/1000+2 if record.get('retryAt') else 0)
                if record.get('status') in ('queued','in-flight','rate-limited'):
                    until=max(until,time.time()+30)
        except (OSError,ValueError,TypeError):
            return {'state':'failed','reason':'bridge_delivery_state_unavailable'}
        if until>time.time():
            return {'state':'failed','reason':'local_cooldown','retry_at':until}
        # Reserve a small window across notifier processes before network IO.
        cooldowns[key]=time.time()+3
    payload={'chat_id':chat,'text':text}
    if parse_mode is not None:
        if parse_mode != 'HTML':
            return {'state':'failed','reason':'invalid_rendering_mode'}
        payload['parse_mode']=parse_mode
    if target.get('threadId') is not None:
        payload['message_thread_id']=target['threadId']
    if reply_to_message_id is not None:
        payload['reply_parameters'] = json.dumps({
            'message_id': reply_to_message_id,
            'allow_sending_without_reply': True,
        }, separators=(',', ':'))
    req=urllib.request.Request('https://api.telegram.org/bot'+token+'/sendMessage',data=urllib.parse.urlencode(payload).encode())
    try:
        with opener(req,timeout=15) as r:
            data=json.loads(r.read())
            if not 200<=r.status<300:
                return {'state':'unknown','reason':'unexpected_http_status'}
            if data.get('ok') is not True:
                return {'state':'failed','reason':'api_rejected'}
            mid=data.get('result',{}).get('message_id')
            if not isinstance(mid,int) or isinstance(mid,bool):
                return {'state':'unknown','reason':'missing_message_id'}
            return {
                'state': 'success',
                'status': 'success',
                'message_id': mid,
                'target': target,
                'confirmed_reply_to_message_id': data['result'].get('reply_to_message', {}).get('message_id'),
            }
    except urllib.error.HTTPError as e:
        result={'state':'failed' if 400<=e.code<500 else 'unknown','reason':'http_error','http_status':e.code}
        if e.code==429:
            try:
                delay=max(1,int(json.loads(e.read()).get('parameters',{}).get('retry_after',60)))
            except Exception:
                delay=60
            result['retry_at']=time.time()+delay+2
            with transaction(directory,'notification-cooldowns.json') as cooldowns:
                cooldowns[key]=max(cooldowns.get(key,0),result['retry_at'])
        return result
    except Exception as error:
        # 不保存可能含 Token/URL 的异常正文；保留可核查的非敏感类型与系统错误码。
        cause = getattr(error, 'reason', None)
        return {
            'state': 'unknown',
            'reason': 'transport_or_response_unknown',
            'exception_type': type(error).__name__,
            'cause_type': type(cause).__name__ if cause is not None else None,
            'errno': getattr(cause, 'errno', getattr(error, 'errno', None)),
        }

def durable_send(root,eid,text,config,profile,opener=urllib.request.urlopen,target=None,parse_mode=None,chunks=None,reply_to_message_id=None):
    if reply_to_message_id is not None and (type(reply_to_message_id) is not int or reply_to_message_id <= 0):
        raise ValueError('invalid reply message id')
    if chunks is not None:
        if (not isinstance(chunks,list) or not chunks
                or any(not isinstance(chunk,str) or not chunk or len(chunk)>4096 for chunk in chunks)
                or ''.join(chunks)!=text):
            raise ValueError('invalid prepared message chunks')
    key=digest([eid,profile,target])
    h=delivery_hash(text)
    with transaction(root,'telegram-receipts.json') as receipts:
        previous=receipts.get(key)
        if previous:
            if previous['hash']!=h:
                raise ValueError('event payload collision')
            if previous.get('parse_mode')!=parse_mode:
                raise ValueError('event rendering collision')
            if previous.get('reply_to_message_id') != reply_to_message_id:
                raise ValueError('event reply target collision')
            if previous['state'] in ('success','unknown','sending'):
                return previous if previous['state']!='sending' else {'state':'unknown','reason':'previous_attempt_unresolved'}
        receipts[key] = {
            'state': 'sending',
            'hash': h,
            'event_id': eid,
            'parse_mode': parse_mode,
            'reply_to_message_id': reply_to_message_id,
        }
    if chunks is not None and len(chunks)>1:
        parts=[]
        for index,chunk in enumerate(chunks):
            # 已成功的块复用原回执；明确失败可续发，unknown/sending 不盲目重发。
            part = durable_send(
                root, f'{eid}:part-{index+1}', chunk, config, profile,
                opener, target, parse_mode, reply_to_message_id=reply_to_message_id,
            )
            parts.append(part)
            if part.get('state')!='success':
                break
        last=parts[-1]
        result={
            **last,
            'state':'success' if len(parts)==len(chunks) and all(part.get('state')=='success' for part in parts) else last['state'],
            'message_ids':[part['message_id'] for part in parts if part.get('state')=='success'],
            'parts':parts,
        }
        if result['state']=='success':
            result['status']='success'
        else:
            result.pop('status',None)
            result.pop('message_id',None)
    else:
        result=send(text,config,profile,opener,target,parse_mode,reply_to_message_id)
        result["at"]=time.time()
        result["monotonic_ns"]=str(time.monotonic_ns())
        try:
            result['boot_id']=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        except OSError:
            result['boot_id']=None
    result=dict(result,hash=h,event_id=eid,parse_mode=parse_mode,reply_to_message_id=reply_to_message_id)
    with transaction(root,'telegram-receipts.json') as receipts:
        receipts[key]=result
    return result

def main():
    p=argparse.ArgumentParser()
    p.add_argument('text')
    p.add_argument('--event-id')
    p.add_argument('--root',default=str(ROOT))
    p.add_argument('--config',default=str(ROOT.parent/'telegram.json'))
    p.add_argument('--target')
    p.add_argument('--parse-mode',choices=['HTML'])
    p.add_argument('--chunks-file',help='read immutable rendered chunks from the existing prepared receipt')
    p.add_argument('--reply-to-message-id',type=int,help='reply to the original task message in the paired chat')
    a=p.parse_args()
    if not a.text.strip():
        p.error('text required')
    chunks=json.loads(Path(a.chunks_file).read_text()).get('chunks') if a.chunks_file else None
    r = durable_send(
        a.root, a.event_id or uuid.uuid4().hex, a.text, a.config,
        os.environ.get('NOTIFY_PROFILE', 'personal'),
        target=json.loads(a.target) if a.target else None,
        parse_mode=a.parse_mode,
        chunks=chunks,
        reply_to_message_id=a.reply_to_message_id,
    )
    print(json.dumps(r))
    return 0 if r['state']=='success' else 2 if r['state']=='unknown' else 1
if __name__=='__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'state':'failed','reason':type(error).__name__}))
        sys.exit(1)
