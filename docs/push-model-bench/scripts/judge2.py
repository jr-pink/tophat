#!/usr/bin/env python3
"""Two-stage blind judge, source-anchored (not Opus-as-truth). Replay only; never touches live memory.
Stage K (once per packet): judge model reads the RAW PACKET only (no candidate output) and lists key facts in the ARRIVALS
  and the arrivals that need action on the owner's side. Saved judge2/<J>/keys/<pid>.json, reused by every candidate.
Stage S (once per packet x candidate): the same judge sees rubric + packet + the fixed key-fact list (identical cached prefix),
  then ONE anonymous candidate's rendered notes/work; returns covered key ids and unsupported claims. Opus ('opus' = recorded
  live output) is scored exactly like any other label. Candidate wake lists are compared to the judge's action list in code.
usage: judge2.py JUDGE_TAG JUDGE_MODEL IDSFILE LABELS(comma) [--workers N]
"""
import json,os,sys,re,time,threading,urllib.request,urllib.error
from concurrent.futures import ThreadPoolExecutor
D=os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0,D)
# fj and render copied verbatim from judge.py (importing judge.py would execute it)
def fj(t):
    t=t or ''; i=t.find('{')
    if i<0: return None
    try: return json.JSONDecoder().raw_decode(t[i:])[0]
    except Exception:
        m=re.search(r'```(?:json)?\s*(\{.*\})\s*```',t,re.S)
        try: return json.loads(m.group(1)) if m else None
        except Exception: return None
def render(t,u):
    j=fj(t)
    if not isinstance(j,dict): return '(the candidate returned no readable output)'
    ents={}
    for m in re.finditer(r'^(E\d+) (.+?)(?: \((\w[\w -]*)\))?$',u,re.M): ents[m.group(1)]=m.group(2)
    nm=lambda e: ents.get(e,e)
    out=[]
    for i,n in enumerate(j.get('notes') or [],1):
        if not isinstance(n,dict): continue
        out.append(f"NOTE {i} [about: {', '.join(nm(e) for e in n.get('entities') or [])}] [cites: {', '.join(n.get('sources') or [])}] {n.get('body')}")
    for i,w in enumerate(j.get('work') or [],1):
        if isinstance(w,dict): out.append(f"WORK {i} [{w.get('status')}] {w.get('title')}: {w.get('body')}")
    for e in j.get('entities') or []:
        if isinstance(e,dict) and str(e.get('ref','')).startswith('$'): out.append(f"NEW ENTITY {e.get('name')} ({e.get('type')})")
    return '\n'.join(out) or '(no notes, no work)'
CAP=float(os.environ.get('BENCH_CAP','25')); SPEND=f'{D}/spend.jsonl'
KEY=os.environ['OPENROUTER_API_KEY']  # never a literal key
P={p['id']:p for p in json.load(open(f'{D}/frozen-v2.json'))}
lock=threading.Lock()
def spent(): return sum(json.loads(l)['cost'] for l in open(SPEND)) if os.path.exists(SPEND) else 0
def text_of(lab,pid):
    if lab=='opus': return P[pid]['ref_text']
    f=f'{D}/results2/{lab}/{pid}.json'
    if not os.path.exists(f): return None
    r=json.load(open(f)); return (r.get('text') or '') if r.get('ok') else ''
def head_of(pid):
    # the WHOLE packet the candidates saw (arrivals, history, existing pages, open work, recent notes), so claims
    # grounded in existing memory are not miscounted as unsupported (judge.py cut everything after CANDIDATE ENTITIES)
    return P[pid]['user']
KRUBRIC="""You are preparing an answer key for auditing memory-updater models. The packet above is the raw input they all read: ARRIVALS (new records R1.. to interpret), HISTORY (earlier records H1.., context only), and the existing memory (entities with pages, open work, recent notes).
1. KEY FACTS. Read the ARRIVALS. List the facts a person would later need to look up: names of people and organizations, dates, amounts, addresses, identifiers, decisions, commitments, deadlines, what was asked of whom, and for the owner's own writing what he thinks, concluded, is researching or decided. Skip boilerplate, marketing, tracking noise, delivery/receipt/verification-code mechanics, and pure acknowledgements. At most 20 facts, each short, each tagged with its record code (R#). If the arrivals hold nothing worth remembering, list none.
2. ACTION NEEDED. List each ARRIVAL (R codes only) that needs someone on the owner's side to act: a reply owed to a person, a payment or bill to settle, a deadline, a counterparty's question or request, a delivery/order/account problem, a direct request to the owner or his assistant, or a meeting time agreed/moved/cancelled (calendar to reconcile). NOT: the owner's own outgoing messages, text produced by his assistant/bots/watchers, newsletters/marketing, receipts/shipping notices/verification codes/reminders needing nothing, FYI, group chatter not addressed to him. Mark each certain or borderline.
Answer with JSON only: {"key_facts":[{"id":"K1","fact":"...","rec":"R1"}],"action_needed":[{"rec":"R3","why":"...","certainty":"certain|borderline"}]}"""
SRUBRIC="""You are auditing the output of a memory-updater model that read the raw packet above: ARRIVALS (new records R1..), HISTORY (earlier records H1.., context), and the existing memory (entities with pages, open work, recent notes). An answer key of KEY FACTS from the arrivals was prepared independently. The candidate produced NOTES (factual statements citing records), WORK items and new entities.
1. COVERAGE. Give the ids of key facts the candidate's notes/work state (covered if stated with its substance, even in different words; a fact only implied or only in an entity name does not count).
2. UNSUPPORTED. List claims in the candidate's notes/work that the packet (arrivals, history, existing memory) does not support or contradicts: a wrong name, number, date or relationship, an invented detail, a conclusion the records do not state, an offered/queued action reported as done. Give the claim (short quote) and why. Do not flag reasonable restatement or facts supported by HISTORY or existing memory.
Answer with JSON only: {"covered":["K1"],"unsupported":[{"claim":"...","why":"..."}]}"""
def post(model,msgs,mt):
    body={'model':model,'messages':msgs,'max_tokens':mt,'usage':{'include':True},'temperature':0}
    if EFFORT: body['reasoning']={'effort':EFFORT}
    for att in range(3):
        try:
            r=json.load(urllib.request.urlopen(urllib.request.Request('https://openrouter.ai/api/v1/chat/completions',json.dumps(body).encode(),{'authorization':'Bearer '+KEY,'content-type':'application/json'}),timeout=900))
            if 'error' in r: res={'ok':False,'error':str(r['error'])[:300]}; time.sleep(4); continue
            u=r.get('usage',{}); t=r['choices'][0]['message'].get('content') or ''
            res={'ok':fj(t) is not None,'text':t,'cost':u.get('cost',0),'usage':u}
            if res['ok']: return res
        except urllib.error.HTTPError as e: res={'ok':False,'error':f'HTTP {e.code} '+e.read().decode()[:200]}
        except Exception as e: res={'ok':False,'error':str(e)[:200]}
        time.sleep(4)
    return res
def save(path,res,tag):
    os.makedirs(os.path.dirname(path),exist_ok=True); json.dump(res,open(path+'.tmp','w')); os.replace(path+'.tmp',path)
    with lock, open(SPEND,'a') as f: f.write(json.dumps({'t':time.time(),'tag':tag,'cost':res.get('cost') or 0})+'\n')
def keys(pid):
    out=f'{D}/judge2/{JT}/keys/{pid}.json'
    if os.path.exists(out) and json.load(open(out)).get('ok'): return json.load(open(out))
    if spent()>=CAP: print('CAP stop',flush=True); return None
    res=post(JM,[{'role':'user','content':[{'type':'text','text':'=== RAW PACKET ===\n'+head_of(pid),'cache_control':{'type':'ephemeral'}},{'type':'text','text':'\n\n=== TASK ===\n'+KRUBRIC+'\n\nNow answer with the JSON.'}]}],16000)
    res['pid']=pid; save(out,res,f'judge2-{JT}-keys'); print('keys',pid,res['ok'],res.get('cost'),flush=True)
    return res if res['ok'] else None
def score(pid,lab,k):
    out=f'{D}/judge2/{JT}/score/{lab}/{pid}.json'
    if os.path.exists(out) and json.load(open(out)).get('ok'): return
    t=text_of(lab,pid)
    if t is None: return
    kf=fj(k['text']).get('key_facts') or []
    rend=render(t,P[pid]['user'])
    if not kf and rend.startswith('('):
        save(out,{'ok':True,'text':'{"covered":[],"unsupported":[]}','cost':0,'nkeys':0},f'judge2-{JT}-score'); return
    if spent()>=CAP: print('CAP stop',flush=True); return
    prefix='\n\n=== TASK ===\n'+SRUBRIC+'\n\n=== KEY FACTS ===\n'+'\n'.join(f"{x.get('id')} [{x.get('rec')}] {x.get('fact')}" for x in kf if isinstance(x,dict))
    # packet first and byte-identical to the keys call, so every score call reads it from cache
    msgs=[{'role':'user','content':[{'type':'text','text':'=== RAW PACKET ===\n'+head_of(pid),'cache_control':{'type':'ephemeral'}},{'type':'text','text':prefix+'\n\n=== CANDIDATE OUTPUT ===\n'+rend+'\n\nNow answer with the JSON.'}]}]
    res=post(JM,msgs,8000); res['pid']=pid; res['nkeys']=len(kf)
    save(out,res,f'judge2-{JT}-score'); print('score',lab,pid,res['ok'],res.get('cost'),flush=True)
def job(pid):
    k=keys(pid)
    if not k: return
    for lab in LABS: score(pid,lab,k)
if __name__=='__main__':
    JT,JM,idsf=sys.argv[1],sys.argv[2],sys.argv[3]; LABS=sys.argv[4].split(',')
    W=int(sys.argv[sys.argv.index('--workers')+1]) if '--workers' in sys.argv else 6
    EFFORT=sys.argv[sys.argv.index('--effort')+1] if '--effort' in sys.argv else None
    ids=json.load(open(f'{D}/{idsf}' if not idsf.startswith('/') else idsf))
    with ThreadPoolExecutor(W) as ex: list(ex.map(job,ids))
    print('done',JT,round(spent(),3),flush=True)
