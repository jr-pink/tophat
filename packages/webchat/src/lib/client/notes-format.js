import { parseListItem } from '../core/notes-doc.js';
const names = ['bold', 'italic', 'underline'];
const same = (a,b) => names.every(key => Boolean(a[key]) === Boolean(b[key]));
const clean = marks => Object.fromEntries(names.map(key => [key, Boolean(marks[key])]));
const escaped = text => text.replace(/[\\*_<>]/g, '\\$&');
function closing(raw, token, from, end) {
  for (let at=from; at<end; at++) {
    if(raw[at]==='\\') {at++;continue;}
    if(raw.startsWith(token,at)) return at;
  }
  return -1;
}
export function parseInline(input) {
  const raw=String(input ?? ''), chars=[];
  function parse(from,to,marks) {
    for(let i=from;i<to;) {
      if(raw[i]==='\\' && i+1<to && /[\\*_<>]/.test(raw[i+1])) {chars.push({text:raw[i+1],...clean(marks),from:i,to:i+2});i+=2;continue;}
      const token = raw.startsWith('<u>',i) ? ['<u>','</u>','underline'] : raw.startsWith('**',i) ? ['**','**','bold'] : raw[i]==='_' || raw[i]==='*' ? [raw[i],raw[i],'italic'] : null;
      const end=token && !marks[token[2]] ? closing(raw,token[1],i+token[0].length,to) : -1;
      if(token && end>i+token[0].length) {parse(i+token[0].length,end,{...marks,[token[2]]:true});i=end+token[1].length;continue;}
      chars.push({text:raw[i],...clean(marks),from:i,to:i+1});i++;
    }
  }
  parse(0,raw.length,{});
  const runs=[];
  for(const char of chars) {
    if(runs.length && same(runs.at(-1),char)) runs.at(-1).text+=char.text;
    else runs.push({text:char.text,...clean(char)});
  }
  return {text:chars.map(char=>char.text).join(''),runs,positions:chars.map(({from,to})=>({from,to}))};
}
export function serializeInline(runs) {
  const merged=[];
  for(const run of runs) {
    if(!run.text)continue;
    if(merged.length && same(merged.at(-1),run))merged.at(-1).text+=run.text;
    else merged.push({text:run.text,...clean(run)});
  }
  return merged.map(run=>{
    let text=escaped(run.text);
    if(run.underline)text=`<u>${text}</u>`;
    if(run.italic)text=`_${text}_`;
    if(run.bold)text=`**${text}**`;
    return text;
  }).join('');
}
export function visibleOffset(raw, offset) {
  return parseInline(raw).positions.filter(position=>position.to<=offset).length;
}
export function rawOffset(raw, offset) {
  const positions=parseInline(raw).positions;
  const at=Math.max(0,Math.min(offset,positions.length));
  return at===positions.length ? positions.at(-1)?.to ?? 0 : positions[at].from;
}
function characters(raw) {
  return parseInline(raw).runs.flatMap(run=>run.text.split('').map(text=>({...run,text})));
}
export function toggleInline(raw, start, end, mark) {
  if(!names.includes(mark))throw new Error('Unknown inline format');
  const from=visibleOffset(raw,Math.min(start,end)), to=visibleOffset(raw,Math.max(start,end));
  const chars=characters(raw), selected=chars.slice(from,to);
  const enabled=selected.some(char=>!char[mark]);
  selected.forEach(char=>{char[mark]=enabled;});
  const body=serializeInline(chars);
  return {body,start:rawOffset(body,from),end:rawOffset(body,to)};
}
export function replaceInline(raw,start,end,text) {
  const from=visibleOffset(raw,Math.min(start,end)),to=visibleOffset(raw,Math.max(start,end));
  const chars=characters(raw), marks=chars[from] || chars[from-1] || {};
  chars.splice(from,to-from,...text.split('').map(text=>({...clean(marks),text})));
  const body=serializeInline(chars);
  return {body,caret:rawOffset(body,from+text.length)};
}
export function headingLine(raw, level) {
  if(!Number.isInteger(level) || level<0 || level>4)throw new Error('Heading level must be 0–4');
  const item=parseListItem(raw), prefix=item ? raw.slice(0,item.prefix) : /^[\t ]*/.exec(raw)[0];
  const text=raw.slice(prefix.length).replace(/^#{1,4}[ \t]/, '');
  return prefix+(level ? `${'#'.repeat(level)} ` : '')+text;
}
