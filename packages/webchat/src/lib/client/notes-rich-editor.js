import { parseInline, serializeInline, rawOffset, visibleOffset, replaceInline } from './notes-format.js';

/** Safe rendering: only text nodes and the three explicitly supported formatting elements. */
export function renderInline(node, raw) {
  const fragment=document.createDocumentFragment();
  for(const run of parseInline(raw).runs) {
    let child=document.createTextNode(run.text);
    for(const [key,tag] of [['underline','u'],['italic','em'],['bold','strong']]) {
      if(!run[key])continue;
      const wrapper=document.createElement(tag);wrapper.append(child);child=wrapper;
    }
    fragment.append(child);
  }
  node.replaceChildren(fragment);
}
// Unchanged words are left alone: rebuilding them replaces the text nodes a selection sits in, and
// a drag across the lines (each hover redraws the note) then lost its anchor.
export function inlineView(node, raw) {
  let shown=raw;
  renderInline(node,raw);
  return {update(value){if(value===shown&&node.childNodes.length)return;shown=value;renderInline(node,value);}};
}
function readRuns(node) {
  const runs=[];
  function walk(current,marks) {
    if(current.nodeType===Node.TEXT_NODE){runs.push({text:current.nodeValue,...marks});return;}
    const tag=current.nodeName.toLowerCase(), style=current.style;
    const next={...marks,
      bold:marks.bold || tag==='b' || tag==='strong' || style?.fontWeight==='bold' || Number(style?.fontWeight)>=600,
      italic:marks.italic || tag==='i' || tag==='em' || style?.fontStyle==='italic',
      underline:marks.underline || tag==='u' || style?.textDecorationLine?.includes('underline') || style?.textDecoration?.includes('underline')};
    if(tag==='br'){if(current.nextSibling)runs.push({text:'\n',...next});return;}
    for(const child of current.childNodes)walk(child,next);
  }
  for(const child of node.childNodes)walk(child,{});
  return runs;
}
function localRange(node) {
  const selection=window.getSelection();
  if(!selection?.rangeCount)return [0,0];
  const range=selection.getRangeAt(0);
  if(!node.contains(range.startContainer)||!node.contains(range.endContainer))return [0,0];
  const before=document.createRange();before.selectNodeContents(node);
  before.setEnd(range.startContainer,range.startOffset);const start=before.toString().length;
  before.setEnd(range.endContainer,range.endOffset);return [start,before.toString().length];
}
function pointAt(node,offset) {
  const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let current,last;
  while((current=walker.nextNode())){
    if(offset<=current.length)return [current,offset];
    offset-=current.length;last=current;
  }
  return last?[last,last.length]:[node,0];
}
function select(node,start,end) {
  const range=document.createRange();
  const [a,x]=pointAt(node,Math.min(start,end)),[b,y]=pointAt(node,Math.max(start,end));
  range.setStart(a,x);range.setEnd(b,y);
  const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
}
/** One entry per visible character, each carrying the marks of the run it came from. */
function characters(raw) {
  return parseInline(raw).runs.flatMap(run=>run.text.split('').map(text=>({...run,text})));
}
function insertPlain(raw,start,end,text) {
  const from=visibleOffset(raw,Math.min(start,end)),to=visibleOffset(raw,Math.max(start,end));
  const chars=characters(raw), added=String(text).split('');
  chars.splice(from,to-from,...added.map(text=>({text})));
  const body=serializeInline(chars);
  return {body,caret:rawOffset(body,from+added.length)};
}
/** A rich line implements the same raw-text editing contract as the neighboring textarea. */
export function richEditor(node, raw) {
  renderInline(node,raw);
  const value=()=>serializeInline(readRuns(node));
  const setSelection=(start,end)=>select(node,visibleOffset(value(),start),visibleOffset(value(),end));
  Object.defineProperties(node,{
    value:{configurable:true,get:value,set(raw){renderInline(node,raw);}},
    selectionStart:{configurable:true,get(){return rawOffset(value(),localRange(node)[0]);},set(start){setSelection(start,Math.max(start,node.selectionEnd));}},
    selectionEnd:{configurable:true,get(){return rawOffset(value(),localRange(node)[1]);},set(end){setSelection(Math.min(node.selectionStart,end),end);}}
  });
  node.setSelectionRange=(start,end)=>setSelection(start,end);
  node.setRangeText=(text,start=node.selectionStart,end=node.selectionEnd)=>{
    const edit=replaceInline(value(),start,end,text);renderInline(node,edit.body);setSelection(edit.caret,edit.caret);
  };
  node.toggleFormat=mark=>{node.focus();document.execCommand(mark,false);};
  const yank=event=>{
    if(event.inputType!=='insertFromYank')return;
    event.preventDefault();
    const text=event.data ?? event.dataTransfer?.getData('text/plain') ?? '';
    if(!text)return;
    const edit=insertPlain(value(),node.selectionStart,node.selectionEnd,text);
    renderInline(node,edit.body);setSelection(edit.caret,edit.caret);
    node.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromYank',data:text}));
  };
  // An edit that takes out the last of a line's markup stops the line being rich, and the page
  // swaps this host for a textarea underneath the caret: without carrying the offset across, the
  // new box opens unfocused with the caret at the end rather than where the edit left it.
  const carry=()=>{
    if(document.activeElement!==node)return;
    const row=node.closest('[data-line]'), at=node.selectionStart;
    if(!row)return;
    requestAnimationFrame(()=>{
      if(node.isConnected)return;
      const next=row.querySelector('[data-testid="notes-box"]');
      if(!next || document.activeElement===next)return;
      next.focus({preventScroll:true});
      next.setSelectionRange?.(at,at);
    });
  };
  node.addEventListener('beforeinput',yank);
  node.addEventListener('input',carry);
  return {
    update(raw){
      if(serializeInline(parseInline(raw).runs)===value())return;
      const range=localRange(node);renderInline(node,raw);select(node,...range);
    },
    destroy(){
      node.removeEventListener('beforeinput',yank);node.removeEventListener('input',carry);
      for(const key of ['value','selectionStart','selectionEnd','setSelectionRange','setRangeText','toggleFormat'])delete node[key];
    }
  };
}
