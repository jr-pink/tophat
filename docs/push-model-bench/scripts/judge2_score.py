#!/usr/bin/env python3
"""Score judge2 output. usage: judge2_score.py JUDGE_TAG IDSFILE label,label [--json OUT]
Coverage = covered key facts / key facts (micro over packets with >=1 key fact; macro = mean per packet).
Unsupported = judge-listed unsupported claims per packet. Wake: candidate wake R-codes vs the judge's action_needed
(blind to candidates). Precision counts a wake on a certain OR borderline arrival as correct; recall is over certain ones.
Packet-level wake: does the packet get any wake vs does the judge list any certain action. Invalid = production validator
(validate.mjs via score2) parse error or failed call; an invalid packet scores 0 coverage (judge sees no readable output)."""
import json,os,sys,statistics,re
D=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,D)
def fj(t):
    t=t or ''; i=t.find('{')
    if i<0: return None
    try: return json.JSONDecoder().raw_decode(t[i:])[0]
    except Exception:
        m=re.search(r'```(?:json)?\s*(\{.*\})\s*```',t,re.S)
        try: return json.loads(m.group(1)) if m else None
        except Exception: return None
JT=sys.argv[1]; ids=json.load(open(os.path.join(D,sys.argv[2]))); labs=sys.argv[3].split(',')
P={p['id']:p for p in json.load(open(f'{D}/frozen-v2.json'))}
def cand_text(lab,pid):
    if lab=='opus': return P[pid]['ref_text'],P[pid]['ref_cost'] or 0
    f=f'{D}/results2/{lab}/{pid}.json'
    if not os.path.exists(f): return None,0
    r=json.load(open(f)); return (r.get('text') if r.get('ok') else ''),(r.get('cost') or 0)
def val(lab):
    f=f'{D}/validation/{lab}.json'
    return json.load(open(f)) if os.path.exists(f) else {}
out={}
for lab in labs:
    V=val(lab); rows=[]
    for pid in ids:
        kf=f'{D}/judge2/{JT}/keys/{pid}.json'; sf=f'{D}/judge2/{JT}/score/{lab}/{pid}.json'
        if not (os.path.exists(kf) and os.path.exists(sf)): continue
        K=fj(json.load(open(kf))['text']) or {}; S=json.load(open(sf)); s=fj(S.get('text')) or {}
        keys={k.get('id') for k in K.get('key_facts') or [] if isinstance(k,dict)}
        an={str(a.get('rec')):a.get('certainty','certain') for a in K.get('action_needed') or [] if isinstance(a,dict)}
        cert={r for r,c in an.items() if c!='borderline'}
        t,cost=cand_text(lab,pid); j=fj(t) if t else None
        wk={str(w.get('source')) for w in ((j or {}).get('wake') or []) if isinstance(w,dict)} if isinstance(j,dict) else set()
        nn=len((j or {}).get('notes') or []) if isinstance(j,dict) else 0
        inv = (lab!='opus' and pid in V and bool(V[pid].get('parse_error'))) or not t
        rows.append(dict(pid=pid,nk=len(keys),cov=len(set(s.get('covered') or [])&keys),uns=len(s.get('unsupported') or []),wk=wk,an=set(an),cert=cert,cost=cost,inv=inv,nn=nn,unsup=s.get('unsupported') or []))
    if not rows: continue
    kr=[r for r in rows if r['nk']]
    tp=sum(len(r['wk']&r['an']) for r in rows); fp=sum(len(r['wk']-r['an']) for r in rows); rc=sum(len(r['wk']&r['cert']) for r in rows); nc=sum(len(r['cert']) for r in rows)
    pk_tp=sum(1 for r in rows if r['wk'] and r['cert']); pk_fp=sum(1 for r in rows if r['wk'] and not r['an']); pk_fn=sum(1 for r in rows if not r['wk'] and r['cert'])
    out[lab]={'n':len(rows),'cov_micro%':round(100*sum(r['cov'] for r in kr)/max(1,sum(r['nk'] for r in kr)),1),'cov_macro%':round(100*statistics.mean(r['cov']/r['nk'] for r in kr),1) if kr else None,
      'unsup/pkt':round(sum(r['uns'] for r in rows)/len(rows),2),'unsup/note':round(sum(r['uns'] for r in rows)/max(1,sum(r['nn'] for r in rows)),3),'pkts_w_unsup':sum(1 for r in rows if r['uns']),'invalid':sum(r['inv'] for r in rows),
      'wake_prec%':round(100*tp/max(1,tp+fp),1),'wake_rec%':round(100*rc/max(1,nc),1),'wakes':tp+fp,'judge_certain':nc,'pkt_wake_tp/fp/fn':f'{pk_tp}/{pk_fp}/{pk_fn}','notes/pkt':round(sum(r['nn'] for r in rows)/len(rows),2),'$/pkt':round(sum(r['cost'] for r in rows)/len(rows),4)}
    print(lab,json.dumps(out[lab]))
if '--json' in sys.argv: json.dump(out,open(sys.argv[sys.argv.index('--json')+1],'w'),indent=1)
