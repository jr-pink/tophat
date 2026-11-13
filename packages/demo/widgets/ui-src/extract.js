(async function(rootSel){
  // Collects the html of the matching elements and the stylesheet rules that apply inside them. Rules are taken from the stylesheets'
  // source text, not from the CSSOM, because Chrome's cssText prints a shorthand holding var() as empty longhands.
  const roots = [...document.querySelectorAll(rootSel)];
  if (!roots.length) return JSON.stringify({err:'no root '+rootSel});
  const els = []; roots.forEach(r => { els.push(r); r.querySelectorAll('*').forEach(e => els.push(e)); });
  const split = (s) => { const o=[]; let d=0,cur=''; for (const ch of s){ if(ch==='('||ch==='[')d++; if(ch===')'||ch===']')d--; if(ch===','&&d===0){o.push(cur);cur='';} else cur+=ch;} o.push(cur); return o; };
  const strip = (s) => s.replace(/::?(?:hover|focus-visible|focus-within|focus|active|before|after|placeholder|-webkit-[a-z-]+|selection|disabled|checked|first-child|last-child|first-of-type|last-of-type|visited|target|marker|backdrop|-moz-[a-z-]+)(?:\([^)]*\))?/g,'').replace(/(^|[\s>+~(,])(?=[\s>+~),]|$)/g,'$1*').trim() || '*';
  const matches = (sel) => {
    if (!/\.(svelte|s)-[A-Za-z0-9_-]{6}/.test(sel)) return true;          // not a component's scoped rule: global
    for (const part of split(sel)) { const s = strip(part.trim()); try { if (els.some(e => e.matches(s))) return true; } catch(e) {} }
    return false;
  };
  // rule splitter: [{pre, body}] where body is the text between the outer braces
  const parse = (t) => { const out=[]; let i=0, n=t.length;
    while (i<n) {
      while (i<n && /\s/.test(t[i])) i++;
      if (t.startsWith('/*',i)) { const e=t.indexOf('*/',i+2); i = e<0?n:e+2; continue; }
      if (i>=n) break;
      let j=i, depth=0, str=null;
      while (j<n) { const ch=t[j];
        if (str) { if (ch==='\\') j++; else if (ch===str) str=null; }
        else if (ch==='"'||ch==="'") str=ch;
        else if (ch==='('||ch==='[') depth++; else if (ch===')'||ch===']') depth--;
        else if (depth===0 && (ch==='{'||ch===';')) break;
        j++; }
      const pre=t.slice(i,j).trim();
      if (t[j]===';') { out.push({pre, stmt:true}); i=j+1; continue; }
      let k=j+1, d=1; str=null;
      while (k<n && d>0) { const ch=t[k]; if (str) { if (ch==='\\') k++; else if (ch===str) str=null; } else if (ch==='"'||ch==="'") str=ch; else if (ch==='{') d++; else if (ch==='}') d--; k++; }
      out.push({pre, body:t.slice(j+1,k-1)}); i=k; }
    return out; };
  const out = [];
  const walk = (rules, wrap) => { for (const r of rules) {
    if (r.stmt) { out.push(r.pre + ';'); continue; }
    const pre = r.pre;
    if (/^@(media|supports|container|layer|scope)\b/.test(pre)) { walk(parse(r.body), (t) => (wrap ? wrap : (x)=>x)(`${pre}{${t}}`)); continue; }
    if (/^@(keyframes|font-face|property|-webkit-keyframes)/.test(pre)) { out.push((wrap?wrap:(x)=>x)(`${pre}{${r.body}}`)); continue; }
    if (pre.startsWith('@')) continue;
    if (matches(pre)) out.push((wrap?wrap:(x)=>x)(`${pre}{${r.body}}`)); } };
  for (const node of document.querySelectorAll('style, link[rel=stylesheet]')) {
    let text = '';
    try { text = node.tagName === 'STYLE' ? node.textContent : await (await fetch(node.href)).text(); } catch(e) { continue; }
    walk(parse(text), null);
  }
  return JSON.stringify({ html: roots.map(r => r.outerHTML), css: out });
})
