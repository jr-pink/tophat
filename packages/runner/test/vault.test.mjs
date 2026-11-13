import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PasswordManager,totp} from '../src/vault/manager.mjs';
import {parseImport} from '../src/vault/imports.mjs';
function fixture(t) {const root=fs.mkdtempSync(path.join(os.tmpdir(),'tophat-vault-test-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return new PasswordManager({directory:path.join(root,'vault'),keyFile:path.join(root,'key')});}
test('wrapped master key requires unlock after restart, rejects wrong password, locks and expires',t=>{
  const m=fixture(t);m.write('test-value','synthetic');const original=fs.readFileSync(m.keyFile);
  assert.equal(m.protect('a synthetic long passphrase').locked,true);
  assert(!fs.readFileSync(m.keyFile).includes(original));
  assert.throws(()=>m.read('test-value'));
  const fresh=new PasswordManager({directory:m.directory,keyFile:m.keyFile});
  assert.throws(()=>fresh.unlock('incorrect password'),/unlock failed/);
  assert.equal(fresh.status().locked,true);
  fresh.unlock('a synthetic long passphrase');assert.equal(fresh.read('test-value'),'synthetic');
  fresh.unlockExpires=Date.now()-1;assert.throws(()=>fresh.read('test-value'));assert.equal(fresh.status().locked,true);
  fresh.unlock('a synthetic long passphrase');fresh.lock();assert.throws(()=>fresh.write('test-value','no'));
});
test('vault encrypts metadata and secrets; origin restrictions and archive survive restart',async t=>{
  const m=fixture(t);m.save({id:'example',name:'Private title',kind:'login',origins:['https://example.test/login'],value:{username:'person',password:'synthetic-password'},groups:['work']});
  for(const f of fs.readdirSync(m.directory)) {const bytes=fs.readFileSync(path.join(m.directory,f));assert(!bytes.includes('synthetic-password'));assert(!bytes.includes('Private title'));}
  assert.equal(m.list()[0].groups[0],'work');assert(!JSON.stringify(m.list()).includes('synthetic-password'));
  await assert.rejects(m.use('example','https://other.test',()=>{}));
  assert.equal(await m.use('example','https://example.test',x=>x.usernames[0]),'person');
  m.archive('example');assert.equal(m.list().length,0);await assert.rejects(m.use('example','https://example.test',()=>{}));
  const again=new PasswordManager({directory:m.directory,keyFile:m.keyFile});assert.equal(again.list({archived:true}).length,1);
});
test('tampering and symlinked key are refused',t=>{const m=fixture(t);m.save({id:'sample',name:'Example',kind:'secret',value:'test-only'});const file=m.file('catalog');const b=fs.readFileSync(file);b[b.length-1]^=1;fs.writeFileSync(file,b);assert.throws(()=>m.list());fs.unlinkSync(m.keyFile);fs.symlinkSync(file,m.keyFile);assert.throws(()=>m.key());});
test('TOTP matches RFC 6238 known SHA1 vector and recovery codes consume once',t=>{assert.equal(totp({secret:'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',digits:8},59000).code,'94287082');const m=fixture(t);m.save({id:'recovery',name:'Example',kind:'recovery-codes',value:['one','two']});
  // How many are left is the one thing the owner needs before a trip; it is
  // carried as a count so listing never decrypts the codes to find out.
  const left=()=>m.list().find(e=>e.id==='recovery').remaining;
  assert.equal(left(),2);assert.equal(m.takeRecoveryCode('recovery'),'one');assert.equal(left(),1);
  assert(!JSON.stringify(m.list()).includes('two'));
  assert.equal(m.takeRecoveryCode('recovery'),'two');assert.equal(left(),0);
  assert.throws(()=>m.takeRecoveryCode('recovery'));assert.equal(left(),0);});
test('CSV preserves quoted commas/newlines and repeated import is idempotent',t=>{const m=fixture(t);const text='name,url,username,password,note\n"Example, site",https://example.test,user,"a,b","line1\nline2"\n';assert.equal(m.import('chrome',text).imported,1);assert.equal(m.import('chrome',text).skipped,1);assert.equal(m.list()[0].notes,'line1\nline2');});
test('Bitwarden and 1Password preserve folders, archives, OTP; passkey limits explicit',()=>{
  const bw=parseImport('bitwarden',JSON.stringify({folders:[{id:'f',name:'Team'}],items:[{id:'i',type:1,name:'Site',folderId:'f',login:{uris:[{uri:'https://example.test'}],username:'u',password:'p',totp:'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',fido2Credentials:[{}]}}]}));assert.equal(bw.entries.length,2);assert.deepEqual(bw.entries[0].groups,['Team']);assert(bw.warnings.some(w=>w.includes('passkey')));
  const op=parseImport('1pux',JSON.stringify({accounts:[{attrs:{uuid:'a'},vaults:[{attrs:{uuid:'v',name:'Personal'},items:[{uuid:'i',state:'archived',overview:{title:'Site',url:'https://example.test'},details:{loginFields:[{designation:'password',value:'p'}]}}]}]}]}));assert(op.entries[0].archived);assert.equal(op.entries[0].groups[0],'Personal');
});
test('failed import validation never changes catalog',t=>{const m=fixture(t);m.save({id:'original',name:'Original',kind:'secret',value:'x'});const revision=m.catalog().revision;assert.throws(()=>m.import('apple','bad,headers\n"unterminated'));assert.equal(m.catalog().revision,revision);assert.equal(m.list().length,1);});
