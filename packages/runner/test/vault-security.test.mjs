import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {PasswordManager,generatePassword} from '../src/vault/manager.mjs';
const SECRET='ORPHAN-CANARY-8f31';
function fixture(t) {const root=fs.mkdtempSync(path.join(os.tmpdir(),'tophat-vault-sec-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return new PasswordManager({directory:path.join(root,'vault'),keyFile:path.join(root,'key')});}
function valueFiles(m) {return fs.readdirSync(m.directory).filter(n=>/^value-[0-9a-f]{32}\.enc$/.test(n));}
function grepDirectory(m,needle) {return fs.readdirSync(m.directory).filter(n=>fs.readFileSync(path.join(m.directory,n)).includes(needle));}

test('a rotated password leaves no decryptable copy of the old one',t=>{
  const m=fixture(t);
  m.save({id:'rotating',name:'Rotating account',kind:'login',origins:['https://rotate.example.test'],value:{username:'someone',password:SECRET}});
  m.save({id:'rotating',name:'Rotating account',kind:'login',origins:['https://rotate.example.test'],value:{username:'someone',password:'REPLACEMENT-b7'}},{overwrite:true});
  assert.equal(valueFiles(m).length,1,'the superseded ciphertext is still on disk');
  assert.deepEqual(grepDirectory(m,SECRET),[],'old password ciphertext survives');
  assert.equal(m.value(m.entry(m.catalog(),m.list()[0].id)).password,'REPLACEMENT-b7');
});

test('a consumed recovery code cannot be read back off disk',t=>{
  const m=fixture(t);
  const {id}=m.save({id:'backup-codes',name:'Backup codes',kind:'recovery-codes',value:[SECRET,'CODE-TWO-c4']});
  assert.equal(m.takeRecoveryCode(id),SECRET);
  assert.deepEqual(grepDirectory(m,SECRET),[],'spent recovery code ciphertext survives');
  assert.deepEqual(m.value(m.entry(m.catalog(),id)),['CODE-TWO-c4']);
});

test('lookup answers by website, skips archived entries and leaves them recoverable',t=>{
  const m=fixture(t);
  const live=m.save({id:'shop',name:'Shop',kind:'login',origins:['https://shop.example.test'],value:{username:'a',password:'pw-live-1'}});
  const old=m.save({id:'shop-old',name:'Shop old',kind:'login',origins:['https://shop.example.test/login'],value:{username:'b',password:'pw-old-2'}});
  m.save({id:'other',name:'Other',kind:'login',origins:['https://other.example.test'],value:{username:'c',password:'pw-other-3'}});
  m.archive(old.id,true);
  assert.deepEqual(m.lookup('https://shop.example.test/account').map(e=>e.id),[live.id]);
  assert.deepEqual(m.lookup('https://shop.example.test',{archived:true}).map(e=>e.id).sort(),[live.id,old.id].sort());
  assert.deepEqual(m.lookup('https://absent.example.test'),[]);
  assert.equal(m.value(m.entry(m.catalog(),old.id)).password,'pw-old-2');
  assert.equal(m.archive(old.id,false).archived,false);
  assert.equal(m.lookup('https://shop.example.test').length,2);
});

test('forget removes the entry and its ciphertext',t=>{
  const m=fixture(t);
  const {id}=m.save({id:'disposable',name:'Disposable',kind:'secret',value:SECRET});
  assert.equal(m.forget(id).forgotten,true);
  assert.equal(m.catalog().entries[id],undefined);
  assert.deepEqual(valueFiles(m),[]);
  assert.deepEqual(grepDirectory(m,SECRET),[]);
  assert.throws(()=>m.forget(id),/Unknown credential/);
});

test('no secret reaches an error message, an inspect dump or a JSON dump',t=>{
  const m=fixture(t);
  const passphrase=`passphrase ${SECRET} synthetic`;
  m.save({id:'inspected',name:'Inspected',kind:'login',origins:['https://inspect.example.test'],value:{username:'u',password:SECRET}});
  m.protect(passphrase);m.unlock(passphrase);
  for(const dump of [util.inspect(m,{depth:6}),JSON.stringify(m),String(m),util.inspect(m.status())]) {
    assert(!dump.includes(SECRET),'a dump of the manager carried a secret');
    assert(!dump.includes('unlockedKey'),'a dump of the manager named the master key');
  }
  const failures=[
    ()=>m.save({id:'bad-site',name:'Bad site',kind:'login',origins:[`https://u:${SECRET}@bad.example.test`],value:{username:'u',password:SECRET}}),
    ()=>m.save({id:'bad-kind',name:'Bad kind',kind:'nonsense',value:SECRET}),
    ()=>m.save({id:'bad-login',name:'Bad login',kind:'login',value:{username:'u'}}),
    ()=>m.save({id:'bad-codes',name:'Bad codes',kind:'recovery-codes',value:[SECRET,SECRET]}),
    ()=>m.save({id:'bad-totp',name:'Bad totp',kind:'totp',value:{secret:`${SECRET}!!`}}),
    ()=>m.unlock(`wrong ${SECRET} passphrase`),
    ()=>m.value({kind:'login',keyringName:'value-'+'0'.repeat(32)}),
  ];
  for(const run of failures) {
    const error=(()=>{try{run();return null;}catch(e){return e;}})();
    assert(error,'expected a failure');
    assert(!util.inspect(error,{depth:6}).includes(SECRET),`error carried the secret: ${error.message.replaceAll(SECRET,'<redacted>')}`);
  }
});

test('the store is owner-only on disk and the ciphertext holds no plaintext',t=>{
  const m=fixture(t);
  m.save({id:'mode-check',name:'Mode check',kind:'login',origins:['https://modes.example.test'],value:{username:'u',password:SECRET}});
  assert.equal(fs.statSync(m.directory).mode&0o777,0o700);
  for(const name of fs.readdirSync(m.directory))assert.equal(fs.statSync(path.join(m.directory,name)).mode&0o777,0o600,name);
  assert.equal(fs.statSync(m.keyFile).mode&0o777,0o600);
  assert.deepEqual(grepDirectory(m,SECRET),[]);
  assert.deepEqual(grepDirectory(m,'Mode check'),[],'the entry name is stored in cleartext');
});

test('a timed unlock expires on the clock rather than on a poked field',async t=>{
  const m=fixture(t);const passphrase='another synthetic passphrase';
  m.save({id:'timed',name:'Timed',kind:'secret',value:'timed-value-9'});
  m.protect(passphrase);
  assert.throws(()=>m.key(),/locked/i);
  assert.throws(()=>m.catalog(),/locked/i);
  m.unlock(passphrase,{ttlMs:25});
  assert.equal(m.list().length,1);
  await sleep(60);
  assert.equal(m.status().locked,true);
  assert.throws(()=>m.key(),/locked/i);
  assert.throws(()=>m.catalog(),/locked/i);
  m.unlock(passphrase);
  assert.equal(m.list().length,1);
});

test('an entry without a real id is refused rather than written as the string undefined',t=>{
  const m=fixture(t);m.initialize();
  for(const id of [undefined,null,7,{},'Bad Id','']) 
    assert.throws(()=>m.save({id,name:'Coerced',kind:'secret',value:'coerced-1'}),/Credential ID and name required/,String(id));
  assert.deepEqual(m.list(),[]);
  assert.deepEqual(valueFiles(m),[]);
  const {id}=m.save({id:'coerced-ok',name:'Coerced',kind:'secret',value:'coerced-1'});
  assert.equal(id,'coerced-ok');
  assert.throws(()=>m.entry(m.catalog(),undefined),/Unknown credential/);
});

test('generated passwords are long, unique and bounded',()=>{
  const sample=Array.from({length:200},()=>generatePassword());
  assert.equal(new Set(sample).size,200);
  assert(sample.every(p=>/^[A-Za-z0-9]{6}-[A-Za-z0-9]{6}-[A-Za-z0-9]{6}$/.test(p)&&(p.match(/[A-Z]/g)||[]).length===1&&(p.match(/[2-9]/g)||[]).length===1));
  // a bare length never silently changes the shape (2026-11-17: --length 24 made a symbol password)
  assert.throws(()=>generatePassword(24),/Apple style/);
  assert.throws(()=>generatePassword({length:24}),/Apple style/);
  assert(Array.from({length:50},()=>generatePassword({dense:24})).every(p=>p.length===24&&/^[\x21-\x7e]+$/.test(p)));
  assert.equal(generatePassword({dense:64}).length,64);
  assert.throws(()=>generatePassword({dense:8}),/12 to 128/);
  assert.throws(()=>generatePassword({dense:1.5}),/12 to 128/);
});

test('an expired unlock zeroes the master key without waiting for the next call',async t=>{
  const m=fixture(t);m.write('kept','synthetic');m.protect('a synthetic long passphrase');
  const fresh=new PasswordManager({directory:m.directory,keyFile:m.keyFile});
  fresh.unlock('a synthetic long passphrase',{ttlMs:60});
  assert.notEqual(fresh.unlockedKey,null);
  await new Promise(resolve=>setTimeout(resolve,200));
  // Nothing touches the manager in between. Expiring lazily would leave the
  // key in this process's memory for as long as the process idles.
  assert.equal(fresh.unlockedKey,null);
  assert.equal(fresh.unlockExpires,0);
  assert.throws(()=>fresh.read('kept'),/locked/i);
});

// A wifi network or a door code is a login with no website; requiring one would refuse it. A login with none saves, cannot be autofilled anywhere, and a
// validation failure is marked safe to show without carrying the value.
test('a login with no website saves but is never autofilled; validation errors are exposable and value-free',async t=>{
  const m=fixture(t);
  const saved=m.save({id:'wifi-test',name:'Wifi test',kind:'login',origins:[],value:{username:'Test SSID',password:SECRET}});
  assert.deepEqual(saved.origins,[]);
  assert.equal(m.value(m.entry(m.catalog(),'wifi-test')).password,SECRET);
  await assert.rejects(m.use('wifi-test','https://example.test',()=>null),/not authorized/);
  const error=(()=>{try{m.save({id:'wifi-test',name:'Wifi test',kind:'login',origins:[],value:{username:'x',password:SECRET}});}catch(e){return e;}})();
  assert.equal(error.expose,true);
  assert.match(error.message,/explicit replacement required/);
  assert(!error.message.includes(SECRET));
});
