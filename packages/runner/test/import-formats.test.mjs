import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseImport} from '../src/vault/imports.mjs';
import {read1PuxData} from '../src/vault/archive-import.mjs';
import {PasswordManager} from '../src/vault/manager.mjs';

// Every case here replays a fixture file through the real parser rather than a
// literal built in the test, so a mapping that only agrees with its author fails.
// The fixtures are synthetic: invented accounts on example.test domains.
const FIXTURES=path.join(path.dirname(fileURLToPath(import.meta.url)),'import-fixtures');
const read=name=>fs.readFileSync(path.join(FIXTURES,name),'utf8');
const shapeOf=e=>({name:e.name,kind:e.kind,origins:e.origins,groups:e.groups,archived:e.archived});
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tophat-import-'));
  fs.chmodSync(root,0o700);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,manager:new PasswordManager({directory:path.join(root,'vault'),keyFile:path.join(root,'key')})};
}

test('Chrome CSV: quoted commas, escaped quotes and a plain-HTTP row',()=>{
  const {entries,warnings}=parseImport('chrome',read('chrome-passwords.csv'));
  assert.deepEqual(entries.map(e=>e.name),['Bay Books','Tide Utility','Local Router']);
  assert.deepEqual(entries[0].origins,['https://books.example.test']);
  assert.equal(entries[0].value.username,'reader-42');
  assert.equal(entries[0].value.password,'quiet,anchor,walnut');
  assert.equal(entries[1].value.password,'hollow "brass" lantern','an escaped quote inside a quoted cell');
  assert.match(entries[1].notes,/^service address on file\nsecond line$/,'a newline inside a quoted cell');
  // A login whose site is not HTTPS cannot be autofilled safely, so it lands as a
  // secret with a warning rather than as an authorized login.
  assert.equal(entries[2].kind,'secret');
  assert.deepEqual(entries[2].origins,[]);
  assert.equal(warnings.length,1);
  assert.match(warnings[0],/no HTTPS website/);
});

test('Safari CSV: an otpauth URI becomes its own TOTP entry',()=>{
  const {entries,warnings}=parseImport('apple',read('safari-passwords.csv'));
  assert.deepEqual(entries.map(shapeOf),[
    {name:'Harbor Mail',kind:'login',origins:['https://mail.example.test'],groups:[],archived:false},
    {name:'Harbor Mail verification code',kind:'totp',origins:['https://mail.example.test'],groups:[],archived:false},
    {name:'Ferry Pass',kind:'login',origins:['https://ferry.example.test'],groups:[],archived:false},
  ]);
  assert.match(entries[1].value,/^otpauth:\/\/totp\//);
  assert.deepEqual(warnings,[]);
});

test('an overlong Apple title does not discard its password or verification code',t=>{
  const {manager}=fixture(t);
  manager.initialize();
  const title='L'.repeat(251);
  const csv=`Title,URL,Username,Password,Notes,OTPAuth\n${title},https://long.example.test,fixture-user,fixture-password,,JBSWY3DPEHPK3PXP\n`;
  const first=manager.import('apple',csv);
  assert.equal(first.imported,2);
  assert.match(first.warnings.join(' '),/title was shortened/);
  assert(manager.list().every(entry=>entry.name.length<=200));
  const second=manager.import('apple',csv);
  assert.equal(second.imported,0);
  assert.equal(second.skipped,2);
  const login=manager.list().find(entry=>entry.kind==='login');
  const otp=manager.list().find(entry=>entry.kind==='totp');
  assert.equal(manager.value(manager.entry(manager.catalog(),login.id)).password,'fixture-password');
  assert.equal(manager.value(manager.entry(manager.catalog(),otp.id)).secret,'JBSWY3DPEHPK3PXP');
});

test('Bitwarden CSV: newline-separated URIs split, and a note row is a secret',()=>{
  const {entries}=parseImport('bitwarden-csv',read('bitwarden-export.csv'));
  assert.deepEqual(entries[0].origins,['https://forum.example.test','https://www.forum.example.test']);
  assert.deepEqual(entries[0].groups,['Personal']);
  assert.deepEqual(entries.filter(e=>e.kind==='totp').map(e=>e.name),['Depot Portal verification code']);
  const note=entries.at(-1);
  assert.equal(note.kind,'secret');
  assert.match(note.value,/across lines/);
});

test('KeePassXC CSV: the group path is kept and the TOTP column is separated',()=>{
  const {entries}=parseImport('keepass',read('keepassxc-export.csv'));
  assert.deepEqual(entries.map(e=>e.groups),[['Root/Internet'],['Root/Internet'],['Root/Archive']]);
  assert.equal(entries[0].value.username,'press-admin');
  assert.equal(entries[1].kind,'totp');
  assert.match(entries[1].value,/^otpauth:\/\/totp\//);
});

test('1Password CSV: semicolon tags become groups and Archived is honoured',()=>{
  const {entries}=parseImport('1password-csv',read('1password-export.csv'));
  assert.deepEqual(entries.map(shapeOf),[
    {name:'Kiln Studio',kind:'login',origins:['https://kiln.example.test'],groups:['studio','supplies'],archived:false},
    {name:'Old Kiln Login',kind:'login',origins:['https://kiln.example.test'],groups:['studio'],archived:true},
  ]);
});

test('Bitwarden JSON: folders, soft delete, passkey and unmapped-type warnings',()=>{
  const {entries,warnings}=parseImport('bitwarden',read('bitwarden-export.json'));
  assert.deepEqual(entries[0].groups,['Shared']);
  assert.deepEqual(entries[0].origins,['https://loom.example.test','https://console.loom.example.test']);
  // deletedDate is Bitwarden's trash, which is our archive rather than a deletion.
  assert.equal(entries.at(-1).archived,true);
  assert.equal(warnings.length,3);
  assert.match(warnings.join(' '),/passkey material/);
  assert.match(warnings.join(' '),/not fully mapped/);
  // The card item carries no password, note or code, so it is reported as
  // skipped rather than dropped without a word.
  assert.match(warnings.join(' '),/were skipped/);
});

test('Bitwarden JSON: an encrypted export is refused rather than half-read',()=>{
  const encrypted=JSON.stringify({encrypted:true,items:[]});
  assert.throws(()=>parseImport('bitwarden',encrypted),/unsupported credential export/);
});

test('1PUX: the real unzip path reads export.data out of the archive',t=>{
  const {root,manager}=fixture(t);
  const archive=path.join(root,'export.1pux');
  fs.copyFileSync(path.join(FIXTURES,'1password-export.data'),path.join(root,'export.data'));
  execFileSync('/usr/bin/zip',['-q','-j',archive,path.join(root,'export.data')]);
  const data=read1PuxData(fs.readFileSync(archive));
  const {entries,warnings}=parseImport('1pux',data);
  assert.deepEqual(entries.map(shapeOf),[
    {name:'Aster Bank',kind:'login',origins:['https://aster.example.test','https://m.aster.example.test'],
      groups:['Private','finance'],archived:false},
    {name:'Aster Bank verification code',kind:'totp',origins:['https://aster.example.test','https://m.aster.example.test'],
      groups:['Private','finance'],archived:false},
    {name:'Aster Legacy',kind:'login',origins:['https://aster.example.test'],groups:['Private'],archived:true},
  ]);
  assert.equal(warnings.length,2);
  assert.match(warnings.join(' '),/Attachments require separate import/);
  assert.match(warnings.join(' '),/does not provide usable exported passkeys/);
  manager.initialize();
  const imported=manager.importArchive(fs.readFileSync(archive));
  assert.equal(imported.imported,3);
});

test('1PUX: bytes that are not a zip are refused before unzip runs',()=>{
  assert.throws(()=>read1PuxData(Buffer.from('{"accounts":[]}')),/Invalid credential archive/);
});

test('an imported credential decrypts and its plaintext is not in the vault files',t=>{
  const {manager}=fixture(t);
  manager.initialize();
  const {imported,skipped,warnings}=manager.import('keepass',read('keepassxc-export.csv'));
  assert.equal(imported,3);
  assert.equal(skipped,0);
  assert.deepEqual(warnings,[]);
  const entry=manager.list().find(e=>e.name==='Cider Press');
  assert.equal(manager.value(manager.entry(manager.catalog(),entry.id)).password,'maple-ledger-25');
  const files=fs.readdirSync(manager.directory);
  const leaking=files.filter(n=>fs.readFileSync(path.join(manager.directory,n)).includes('maple-ledger-25'));
  assert.deepEqual(leaking,[],'an imported password is readable in the vault files');
});

test('a second import of the same export is skipped rather than duplicated',t=>{
  const {manager}=fixture(t);
  manager.initialize();
  manager.import('chrome',read('chrome-passwords.csv'));
  const again=manager.import('chrome',read('chrome-passwords.csv'));
  assert.deepEqual([again.imported,again.skipped],[0,3]);
  assert.equal(manager.list({archived:true}).length,3,'archived:true lists every entry');
});

test('Chrome CSV: a re-export that gained a row keeps every surviving id',()=>{
  const before=parseImport('chrome',read('chrome-passwords.csv')).entries;
  const after=parseImport('chrome',read('chrome-passwords-grown.csv')).entries;
  // chrome-passwords-grown.csv is the same export a week later: one new row at
  // the top and the survivors re-ordered. Position must not be part of a row's
  // identity, or a re-import duplicates the vault instead of skipping it.
  const kept=new Set(after.map(e=>e.id));
  for(const entry of before)
    assert.ok(kept.has(entry.id),`${entry.name} changed id when the export grew a row`);
  assert.equal(after.length,before.length+1);
});

test('Chrome CSV: re-importing a grown export adds only the new row',t=>{
  const {manager}=fixture(t);
  manager.initialize();
  assert.equal(manager.import('chrome',read('chrome-passwords.csv')).imported,3);
  const again=manager.import('chrome',read('chrome-passwords-grown.csv'));
  assert.deepEqual([again.imported,again.skipped],[1,3]);
  assert.equal(manager.list({archived:true}).length,4,'a re-ordered re-export duplicated the vault');
});

test('Chrome CSV: rows alike on site and user stay distinct and keep their ids',()=>{
  const first=parseImport('chrome',read('chrome-duplicate-rows.csv')).entries;
  const again=parseImport('chrome',read('chrome-duplicate-rows.csv')).entries;
  assert.equal(new Set(first.map(e=>e.id)).size,4,'two rows collapsed onto one id');
  assert.deepEqual(again.map(e=>e.id),first.map(e=>e.id),'the same file produced different ids twice');
});

test('Chrome CSV: a BOM, CRLF rows and a CRLF break inside a quoted cell',()=>{
  const {entries,warnings}=parseImport('chrome',read('chrome-windows-crlf.csv'));
  assert.deepEqual(entries.map(e=>e.name),['Kiln Supply','Mesa Water'],'the BOM or CRLF broke the header or the rows');
  assert.deepEqual(entries[0].origins,['https://kiln.example.test']);
  // The quoted cell's own line break must not end the row, and must not leave a
  // carriage return inside the stored note.
  assert.equal(entries[0].notes,'order desk\nsecond line');
  assert.deepEqual(warnings,[]);
});

test('Bitwarden JSON: a folderId naming no folder imports without a group',()=>{
  const {entries,warnings}=parseImport('bitwarden',read('bitwarden-implicit-folder.json'));
  assert.deepEqual(entries.map(e=>[e.name,e.groups]),[['Filed Login',['Known Folder']],['Orphan Login',[]]]);
  assert.deepEqual(warnings,[],'an absent folder name is not in the export to recover');
});

test('Bitwarden CSV: a Steam code is skipped and its login still imports',t=>{
  const {entries,warnings}=parseImport('bitwarden-csv',read('bitwarden-steam-totp.csv'));
  // Bitwarden's TOTP cell holds anything its own client renders, including Steam
  // codes, which are not RFC 6238. One of those must not abandon the import.
  assert.deepEqual(entries.filter(e=>e.kind==='login').map(e=>e.name),
    ['Valve Account','Legacy Account','Plain Account']);
  assert.deepEqual(entries.filter(e=>e.kind==='totp').map(e=>e.name),['Plain Account verification code']);
  assert.equal(warnings.length,1);
  assert.match(warnings[0],/could not be read and was skipped/);
  const {manager}=fixture(t);
  manager.initialize();
  const result=manager.import('bitwarden-csv',read('bitwarden-steam-totp.csv'));
  assert.equal(result.imported,4,'an unreadable code stopped the whole import');
  assert.match(result.warnings.join(' '),/could not be read and was skipped/);
});

test('Bitwarden CSV: card and identity rows are reported, not dropped in silence',()=>{
  const {entries,warnings}=parseImport('bitwarden-csv',read('bitwarden-unmapped.csv'));
  assert.deepEqual(entries.map(e=>e.name),['Real Login']);
  assert.equal(warnings.length,1);
  assert.match(warnings[0],/were skipped/);
});
