#!/usr/bin/env python3
"""Resumable, budget-capped replay of frozen push packets. Never touches live memory.sqlite or config.
usage: runner.py LABEL MODEL PROVIDER IDSFILE [--retry-from VALIDATION.json] [--workers N] [--temp T] [--effort low|none]
PROVIDER: openrouter (temperature 0 unless --temp, reasoning only if --effort) | bridge (production path: rev6/pull/bridge.mjs, native Anthropic, no temperature, no effort).
Result per packet: results2/LABEL/ID.json written atomically as it finishes; existing files are skipped (resume). Spend: append-only spend.jsonl; HARD cap BENCH_CAP (default 25) over ALL v2 spend."""
import json,os,sys,time,threading,subprocess,urllib.request,urllib.error,argparse
from concurrent.futures import ThreadPoolExecutor
D=os.path.dirname(os.path.abspath(__file__))
ap=argparse.ArgumentParser(); ap.add_argument('label'); ap.add_argument('model'); ap.add_argument('provider'); ap.add_argument('ids')
ap.add_argument('--retry-from'); ap.add_argument('--workers',type=int,default=6); ap.add_argument('--temp',type=float,default=0.0); ap.add_argument('--effort',default='none')
ap.add_argument('--packets',default=f'{D}/frozen-v2.json')
a=ap.parse_args()
CAP=float(os.environ.get('BENCH_CAP','25')); SPEND=f'{D}/spend.jsonl'
KEY=os.environ['OPENROUTER_API_KEY']  # never a literal key
lock=threading.Lock()
def spent():
    t=0.0
    if os.path.exists(SPEND):
        for l in open(SPEND):
            try: t+=json.loads(l)['cost']
            except: pass
    return t
def log_spend(cost,tag):
    with lock, open(SPEND,'a') as f: f.write(json.dumps({'t':time.time(),'tag':tag,'cost':cost})+'\n')
pk={p['id']:p for p in json.load(open(a.packets))}
ids=json.load(open(a.ids))
CORR=lambda r:f"\n\n[The store refused your previous answer for this same input and nothing was written: {r}. Send the whole batch again with that one thing corrected and nothing else changed. If an identity is bound elsewhere, attach to the entity it is bound to, or pass rebind:true only if the handle really moved to a different person. If a name was refused, give the thing its globally qualified name, carrying whose it is and what kind of thing it is.]"
retry={}
if a.retry_from:
    for v in (lambda d: list(d.values()) if isinstance(d,dict) else d)(json.load(open(a.retry_from))):
        r=None
        if v.get('parse_error'): r=f"your answer could not be read: {v['parse_error']}"
        elif v.get('underqualified'): r='these names are not globally qualified: '+'; '.join(v['underqualified'])
        if r: retry[v['key']]=r
    ids=[i for i in ids if i in retry]
def or_call(system,user,mt):
    body={'model':a.model,'messages':[{'role':'system','content':system},{'role':'user','content':user}],'max_tokens':mt,'usage':{'include':True},'temperature':a.temp}
    if a.effort!='none': body['reasoning']={'effort':a.effort}
    req=urllib.request.Request('https://openrouter.ai/api/v1/chat/completions',json.dumps(body).encode(),{'authorization':'Bearer '+KEY,'content-type':'application/json'})
    r=json.load(urllib.request.urlopen(req,timeout=900))
    if 'error' in r: return {'ok':False,'error':str(r['error'])[:300]}
    ch=r['choices'][0]; u=r.get('usage',{})
    return {'ok':True,'text':ch['message'].get('content') or '','finish':ch.get('finish_reason'),'usage':u,'cost':u.get('cost',0),'served_by':r.get('model')}
def bridge_call(system,user,mt):
    env=dict(os.environ)
    req={'system':system,'user':user,'model':a.model,'max_tokens':mt,'purpose':'interpret','caller':'push'}
    p=subprocess.run(['node',os.environ['BENCH_BRIDGE']]  # a stdin/stdout model bridge: {system,user,model,max_tokens} in, {ok,text,usage,cost_usd} out,input=json.dumps(req),capture_output=True,text=True,timeout=1500,env=env)
    r=json.loads(p.stdout)
    if not r.get('ok'): return {'ok':False,'error':f"{r.get('reason')}: {r.get('detail')}"[:300]}
    return {'ok':True,'text':r.get('text') or '','finish':r.get('stop_reason'),'usage':r.get('usage'),'cost':r.get('cost_usd') or 0,'served_by':r.get('model')}
def run(pid):
    out=f'{D}/results2/{a.label}/{pid}.json'
    if os.path.exists(out): return
    if spent()>=CAP: print('CAP reached, stop',flush=True); return
    p=pk[pid]; user=p['user']+(CORR(retry[pid]) if pid in retry else '')
    mt=min(32000,int(p.get('max_tokens') or 32000)); t=time.time(); res={'ok':False,'error':'unreached'}
    for attempt in range(2):
        try: res=(or_call if a.provider=='openrouter' else bridge_call)(p['system'],user,mt); break
        except urllib.error.HTTPError as e: res={'ok':False,'error':f'HTTP {e.code} '+e.read().decode()[:200]}
        except Exception as e: res={'ok':False,'error':str(e)[:200]}
        if attempt==0: time.sleep(3)
    res['ms']=int((time.time()-t)*1000); res['label']=a.label
    os.makedirs(os.path.dirname(out),exist_ok=True)
    tmp=out+'.tmp'; json.dump(res,open(tmp,'w')); os.replace(tmp,out)
    log_spend(res.get('cost') or 0,a.label)
    print(a.label,pid,res['ok'],res.get('cost'),res['ms'],flush=True)
with ThreadPoolExecutor(a.workers) as ex: list(ex.map(run,ids))
print('done',a.label,'total spent',round(spent(),3),flush=True)
