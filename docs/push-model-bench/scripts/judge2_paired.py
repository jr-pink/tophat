#!/usr/bin/env python3
"""Paired bootstrap (10k) of per-packet coverage difference label - opus on judge2 results. usage: judge2_paired.py JT IDS labels"""
import json,os,sys,random,re
D=os.path.dirname(os.path.abspath(__file__))
def fj(t):
    t=t or ''; i=t.find('{')
    try: return json.JSONDecoder().raw_decode(t[i:])[0] if i>=0 else None
    except Exception: return None
JT,ids,labs=sys.argv[1],json.load(open(f'{D}/{sys.argv[2]}')),sys.argv[3].split(',')
def cov(lab,pid):
    K=fj(json.load(open(f'{D}/judge2/{JT}/keys/{pid}.json'))['text']) or {}; keys={k['id'] for k in K.get('key_facts') or [] if isinstance(k,dict)}
    f=f'{D}/judge2/{JT}/score/{lab}/{pid}.json'
    if not keys or not os.path.exists(f): return None
    s=fj(json.load(open(f))['text']) or {}; return len(set(s.get('covered') or [])&keys),len(keys)
for lab in labs:
    pairs=[(cov(lab,p),cov('opus',p)) for p in ids]; pairs=[(a,b) for a,b in pairs if a and b]
    d=[a[0]/a[1]-b[0]/b[1] for a,b in pairs]; r=random.Random(1); bs=[]
    for _ in range(10000):
        s=[d[r.randrange(len(d))] for _ in d]; bs.append(sum(s)/len(s))
    bs.sort(); m=sum(d)/len(d)
    print(f"{lab}: macro diff vs opus {100*m:+.1f} pts, 95% CI [{100*bs[250]:+.1f}, {100*bs[9750]:+.1f}], n={len(d)}, worse/same/better pkts {sum(x<0 for x in d)}/{sum(x==0 for x in d)}/{sum(x>0 for x in d)}")
