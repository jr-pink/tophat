import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {homedir} from 'node:os';
import path from 'node:path';
import {PasswordManager, originOf} from '../../../src/vault/manager.mjs';
import { cut } from '../../base/text.mjs';

const fromModule=createRequire(import.meta.url);
const require=(()=>{try{fromModule.resolve('playwright-core');return fromModule;}catch{return createRequire(new URL('../../../../webchat/package.json',import.meta.url));}})();
const MAX_TABS = 4;
const check = (ok, reason) => { if (!ok) throw new Error(reason); };
const selector = value => {
  check(typeof value === 'string' && value.length > 0 && value.length <= 300, 'Invalid selector');
  return value;
};
const fieldTypes={username:new Set(['text','email']),password:new Set(['password']),otp:new Set(['text','tel','number'])};

export function createBrowserTools({sessionId, endpoint = process.env.TOPHAT_CDP_ENDPOINT || '', connect,
  backend = process.env.TOPHAT_RUNNER_BROWSER_BACKEND || 'cdp', mcpClientFactory} = {}) {
  if(backend==='chrome-devtools-mcp')return createChromeMcpBrowserTools({sessionId,enabled:true,clientFactory:mcpClientFactory});
  check(backend==='cdp','Unsupported browser backend');
  check(typeof sessionId === 'string' && sessionId.length > 0, 'Session required');
  const leases = new Map();
  let browser;
  const open = async () => {
    if (browser?.isConnected?.()) return browser;
    leases.clear();
    const bridge = connect || (target => require('playwright-core').chromium.connectOverCDP(target,{noDefaults:true}));
    browser = await bridge(endpoint);
    check(browser.contexts().length > 0, 'Chrome default context unavailable');
    return browser;
  };
  const pageFor = lease => {
    const held = leases.get(lease);
    check(browser?.isConnected?.() && held?.sessionId === sessionId && !held.page.isClosed(), 'Tab lease unavailable');
    return held.page;
  };
  return {
    pageFor,
    async origin(lease) {return originOf(pageFor(lease).url());},
    async fillFixedField({lease, selector:css, kind, value, expectedOrigin}) {
      check(fieldTypes[kind] && typeof value==='string','Credential field unavailable');
      const page=pageFor(lease), matches=page.locator(selector(css));
      check(await matches.count()===1,'Credential field unavailable');
      const element=await matches.elementHandle();
      check(element && (await element.ownerFrame())===page.mainFrame(),'Credential field unavailable');
      const shape=await element.evaluate(node=>({tag:node.tagName,type:node.getAttribute('type')||'text',disabled:node.disabled,readOnly:node.readOnly}));
      check(shape.tag==='INPUT'&&fieldTypes[kind].has(shape.type.toLowerCase())&&!shape.disabled&&!shape.readOnly,'Credential field unavailable');
      check(originOf(page.url())===expectedOrigin,'Credential page changed');
      await element.fill(value);
      check(originOf(page.url())===expectedOrigin,'Credential page changed');
      return {ok:true};
    },
    async acquire({isolated = false} = {}) {
      check(typeof isolated === 'boolean', 'Invalid tab isolation option');
      const connection = await open();
      check(leases.size < MAX_TABS, 'Tab limit reached');
      const context = isolated ? await connection.newContext() : connection.contexts()[0];
      let page;
      try { page = await context.newPage(); }
      catch (error) { if (isolated) await context.close(); throw error; }
      const lease = randomUUID();
      leases.set(lease, {sessionId, page, context:isolated ? context : null, protectedValues:new Set()});
      return {lease, isolated};
    },
    protect(lease, values) {
      pageFor(lease);
      const held = leases.get(lease);
      for (const value of values) if (typeof value === 'string' && value) held.protectedValues.add(value);
    },
    async navigate({lease, url}) {
      originOf(url);
      const page = pageFor(lease);
      await page.goto(url, {waitUntil:'domcontentloaded'});
      return {ok:true, origin:originOf(page.url())};
    },
    async read({lease}) {
      const page = pageFor(lease);
      const origin = originOf(page.url());
      let body = await page.locator('body').innerText({timeout:10000});
      check(originOf(page.url()) === origin, 'Page changed during read');
      for (const value of leases.get(lease).protectedValues) body = body.replaceAll(value,'[credential redacted]');
      return {origin, text:cut(body, 20000)};
    },
    async click({lease, selector:target}) {
      const page = pageFor(lease), before = page.url();
      originOf(before);
      await page.locator(selector(target)).click({timeout:10000});
      return {ok:true, origin:originOf(page.url()), navigated:page.url() !== before};
    },
    async type({lease, selector:target, text}) {
      check(typeof text === 'string' && text.length <= 10000, 'Invalid text');
      const page = pageFor(lease), origin = originOf(page.url());
      await page.locator(selector(target)).fill(text, {timeout:10000});
      check(originOf(page.url()) === origin, 'Page changed during fill');
      return {ok:true};
    },
    async release({lease}) {
      const page = pageFor(lease);
      const held = leases.get(lease);
      leases.delete(lease);
      await page.close();
      if (held.context) await held.context.close();
      return {ok:true};
    },
    async close() {
      for (const [lease, held] of leases) {
        leases.delete(lease);
        if (!held.page.isClosed()) await held.page.close();
        if (held.context) await held.context.close();
      }
      await browser?.close?.();
      browser = undefined;
    }
  };
}

// ---- chrome-devtools-mcp backend (rev5/chrome-mcp.mjs) ----
export const CHROME_MCP_PACKAGE='chrome-devtools-mcp@1.9.0';
const uidOf=value=>{
  check(typeof value==='string'&&/^(?:uid=)?\d+_\d+$/.test(value),'Element UID required');
  return value.replace(/^uid=/,'');
};
const textOf=result=>(result.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
const jsonResult=result=>{
  const block=textOf(result).match(/```json\s*([\s\S]*?)\s*```/);
  check(block,'Chrome MCP field check unavailable');
  try{return JSON.parse(block[1]);}catch{throw new Error('Chrome MCP field check unavailable');}
};

export async function startChromeMcp({spawnImpl=spawn,binary,envSource=globalThis.process?.env||{}}={}) {
  const installed=binary||envSource.TOPHAT_RUNNER_CHROME_MCP_BIN;
  const command=installed||'npx';
  const args=[...(installed?[]:['--yes',CHROME_MCP_PACKAGE]),'--autoConnect','--experimental-structured-content=true','--no-usage-statistics'];
  const env={HOME:envSource.HOME||homedir(),PATH:envSource.PATH||'/usr/bin:/bin',LANG:envSource.LANG||'en_US.UTF-8',
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS:'1'};
  if(envSource.TMPDIR)env.TMPDIR=envSource.TMPDIR;
  const child=spawnImpl(command,args,{
    stdio:['pipe','pipe','ignore'],env
  });
  const pending=new Map();let serial=0,closed=false;
  const fail=()=>{closed=true;for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('Chrome MCP unavailable'));}pending.clear();};
  child.once('exit',fail);child.once('error',fail);
  createInterface({input:child.stdout}).on('line',line=>{
    let message;try{message=JSON.parse(line);}catch{return;}
    const request=pending.get(message.id);if(!request)return;
    pending.delete(message.id);clearTimeout(request.timer);
    if(message.error)request.reject(new Error('Chrome MCP request failed'));
    else request.resolve(message.result);
  });
  const request=(method,params)=>{
    check(!closed,'Chrome MCP unavailable');
    const id=++serial;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Chrome MCP timeout'));},60000);
      pending.set(id,{resolve,reject,timer});
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
  };
  try {
    await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'tophat-rev5-browser',version:'1.0.0'}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  } catch(error) {child.kill();throw error;}
  return {
    async call(name,args={}) {
      const result=await request('tools/call',{name,arguments:args});
      check(result&&!result.isError,'Chrome MCP tool unavailable');
      return result;
    },
    async close() {closed=true;child.kill();fail();}
  };
}

export function createChromeMcpBrowserTools({sessionId,enabled=false,clientFactory=startChromeMcp}={}) {
  check(enabled,'Chrome MCP backend is disabled');
  check(typeof sessionId==='string'&&sessionId,'Session required');
  let clientPromise;
  const client=()=>clientPromise??=(clientFactory());
  const leases=new Map();
  const held=lease=>{const item=leases.get(lease);check(item,'Tab lease unavailable');return item;};
  const pages=async()=>{
    const result=await (await client()).call('list_pages');
    const rows=result.structuredContent?.pages;
    check(Array.isArray(rows),'Chrome MCP page metadata unavailable');
    return rows;
  };
  const page=async lease=>{
    const item=held(lease),row=(await pages()).find(p=>p.id===item.pageId);
    check(row && (item.context ? row.isolatedContext===item.context : !row.isolatedContext),'Owned tab unavailable');
    return row;
  };
  const api={
    async acquire({isolated=false}={}) {
      check(typeof isolated==='boolean','Invalid tab isolation option');
      check(leases.size<4,'Tab limit reached');
      const context=isolated?`rev5-${randomUUID()}`:null;
      const before=new Set((await pages()).map(p=>p.id));
      const result=await (await client()).call('new_page',{
        url:'about:blank',background:true,...(context?{isolatedContext:context}:{})
      });
      const own=result.structuredContent?.pages?.filter(p=>!before.has(p.id)&&
        (context?p.isolatedContext===context:!p.isolatedContext));
      check(own?.length===1&&Number.isInteger(own[0].id),'Owned tab not confirmed');
      const lease=randomUUID();leases.set(lease,{pageId:own[0].id,context,protectedValues:new Set()});
      return {lease,isolated};
    },
    async origin(lease) {return originOf((await page(lease)).url);},
    protect(lease,values) {for(const value of values)if(typeof value==='string'&&value)held(lease).protectedValues.add(value);},
    async navigate({lease,url}) {
      originOf(url);
      const item=held(lease);
      await (await client()).call('navigate_page',{pageId:item.pageId,type:'url',url});
      return {ok:true,origin:await api.origin(lease)};
    },
    async read({lease}) {
      const origin=await api.origin(lease),item=held(lease);
      let body=textOf(await (await client()).call('take_snapshot',{pageId:item.pageId}));
      check(await api.origin(lease)===origin,'Page changed during read');
      body=body.replace(/\bvalue=("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,'value="[redacted]"');
      for(const value of item.protectedValues)body=body.replaceAll(value,'[credential redacted]');
      return {origin,text:cut(body, 20000)};
    },
    async fillFixedField({lease,selector,kind,value,expectedOrigin}) {
      check(['username','password','otp'].includes(kind)&&typeof value==='string','Credential field unavailable');
      const item=held(lease),uid=uidOf(selector);
      check(await api.origin(lease)===expectedOrigin,'Credential page changed');
      const snapshot=textOf(await (await client()).call('take_snapshot',{pageId:item.pageId}));
      const line=snapshot.split('\n').find(s=>s.includes(`uid=${uid} `));
      check(line&&/\btextbox\b/.test(line),'Credential field unavailable');
      const shape=jsonResult(await (await client()).call('evaluate_script',{
        pageId:item.pageId,args:[uid],
        function:'(el) => ({tag:el.tagName,type:el.getAttribute("type")||"text",disabled:Boolean(el.disabled),readOnly:Boolean(el.readOnly),origin:location.origin})'
      }));
      check(shape?.tag==='INPUT'&&fieldTypes[kind].has(String(shape.type).toLowerCase())&&
        !shape.disabled&&!shape.readOnly&&shape.origin===expectedOrigin,'Credential field unavailable');
      check(await api.origin(lease)===expectedOrigin,'Credential page changed');
      await (await client()).call('fill',{pageId:item.pageId,uid,value,includeSnapshot:false});
      check(await api.origin(lease)===expectedOrigin,'Credential page changed');
      return {ok:true};
    },
    async click({lease,selector}) {
      const item=held(lease),uid=uidOf(selector),before=(await page(lease)).url;
      originOf(before);
      await (await client()).call('click',{pageId:item.pageId,uid,includeSnapshot:false});
      const after=(await page(lease)).url;
      return {ok:true,origin:originOf(after),navigated:after!==before};
    },
    async type({lease,selector,text}) {
      check(typeof text==='string'&&text.length<=10000,'Invalid text');
      const item=held(lease),origin=await api.origin(lease);
      await (await client()).call('fill',{pageId:item.pageId,uid:uidOf(selector),value:text,includeSnapshot:false});
      check(await api.origin(lease)===origin,'Page changed during fill');
      return {ok:true};
    },
    async release({lease}) {
      const item=held(lease);leases.delete(lease);
      await (await client()).call('close_page',{pageId:item.pageId});
      return {ok:true};
    },
    async close() {
      for(const lease of [...leases.keys()])await api.release({lease}).catch(()=>{});
      if(clientPromise)await (await clientPromise).close();
      clientPromise=undefined;
    }
  };
  return api;
}

// ---- vault fill into a leased tab (rev5/credentials.mjs) ----
export function createCredentialTools({browser, configDir, managerFactory} = {}) {
  check(browser?.origin && browser?.fillFixedField && browser?.protect && (managerFactory || typeof configDir === 'string'), 'Credential configuration unavailable');
  const makeManager = managerFactory || (() => new PasswordManager({
    directory:path.join(configDir,'vault'), keyFile:path.join(configDir,'vault-master-key')
  }));
  const onPage = async lease => originOf(await browser.origin(lease));
  const withManager = async fn => {
    const manager = makeManager();
    try { return await fn(manager); }
    finally { manager.lock(); }
  };
  return {
    async list({lease}) {
      const origin = await onPage(lease);
      return withManager(async manager => {
        const status = manager.status();
        if (!status.initialized || status.locked) return {origin, available:false, reason:'vault-unavailable', entries:[]};
        const entries = manager.lookup(origin)
          .filter(item => ['login','totp'].includes(item.kind))
          .map(({id, name, kind}) => ({handle:id, name, kind}));
        check(await onPage(lease) === origin, 'Credential page changed');
        return {origin, available:true, entries};
      });
    },
    async fillLogin({lease, handle, usernameSelector, passwordSelector}) {
      const origin = await onPage(lease);
      return withManager(async manager => {
        const entry = manager.lookup(origin).find(item => item.id === handle && item.kind === 'login');
        check(entry, 'Credential unavailable for this origin');
        try {
          return await manager.use(handle, origin, async value => {
            check(value && typeof value.username === 'string' && typeof value.password === 'string', 'Login unavailable');
            browser.protect(lease,[value.username,value.password]);
            await browser.fillFixedField({lease,selector:usernameSelector,kind:'username',value:value.username,expectedOrigin:origin});
            await browser.fillFixedField({lease,selector:passwordSelector,kind:'password',value:value.password,expectedOrigin:origin});
            return {ok:true};
          });
        } catch { throw new Error('Credential fill failed'); }
      });
    },
    async fillTotp({lease, handle, otpSelector}) {
      const origin = await onPage(lease);
      return withManager(async manager => {
        const entry = manager.lookup(origin).find(item => item.id === handle && item.kind === 'totp');
        check(entry, 'Credential unavailable for this origin');
        try {
          return await manager.use(handle, origin, async value => {
            check(value && typeof value.code === 'string', 'Code unavailable');
            browser.protect(lease,[value.code]);
            await browser.fillFixedField({lease,selector:otpSelector,kind:'otp',value:value.code,expectedOrigin:origin});
            return {ok:true, expiresAt:value.expiresAt};
          });
        } catch { throw new Error('Credential fill failed'); }
      });
    }
  };
}
