import { WORK_ROOTS } from '$lib/server/files.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
export function load() {
 const home=homedir();
 return { roots:[...WORK_ROOTS.map((path,i)=>({name:i===0?'Workspace':'Attachments',path})),{name:'Documents',path:join(home,'Documents')},{name:'Downloads',path:join(home,'Downloads')},] };
}
