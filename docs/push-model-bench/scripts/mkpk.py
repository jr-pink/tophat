#!/usr/bin/env python3
"""Build a packets file with the system prompt composed from a base plus appendix files.
usage: mkpk.py OUT.json BASE(frozen|live) appendix1.txt[,appendix2.txt...]
BASE frozen = each packet's own recorded system prompt; live = the current push system prompt, saved as prompts/live-push-system.txt.
Appendices are appended in order, each preceded by a blank line. The user part is never changed."""
import json,sys,os
D=os.path.dirname(os.path.abspath(__file__))
out,base,apps=sys.argv[1],sys.argv[2],[a for a in sys.argv[3].split(',') if a]
P=json.load(open(f'{D}/frozen-v2.json'))
live=open(f'{D}/prompts/live-push-system.txt').read() if base=='live' else None
suf=''.join(open(f'{D}/prompts/{a}').read() for a in apps)
for p in P:
    p['system']=(live if base=='live' else p['system'])+suf
json.dump(P,open(out if out.startswith('/') else f'{D}/{out}','w'))
print(out,len(P),len(P[0]['system']))
