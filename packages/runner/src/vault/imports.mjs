import {createHash} from 'node:crypto';
import {parseTotp} from './values.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,24);
const fail=()=>{throw new Error('Invalid or unsupported credential export');};
const NO_WEBSITE='A login with no HTTPS website was imported as a secret; assign an authorized website before autofill.';
const HAS_PASSKEYS='This export contains passkey material. It was not imported as a usable authenticator; retain the original manager.';
const NOT_MAPPED='Non-login/non-note item was not fully mapped; retain the original export.';
const ATTACHMENTS='Attachments require separate import; the original archive was not modified.';
const NOTHING_IMPORTED='Some items carried no password, note or readable verification code and were skipped; retain the original export.';
const UNREADABLE_TOTP='A verification-code secret could not be read and was skipped; any login on the same item was still imported.';
const NO_PUX_PASSKEYS='1PUX does not provide usable exported passkeys; retain the original authenticator or register replacements.';
const SHORT_TITLE='An overlong credential title was shortened to fit the vault; its secret value was unchanged.';
const OTP_SUFFIX=' verification code';
const MAX_TITLE=200;
export function csvRows(text) {
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(quoted||cell==='')quoted=!quoted;else fail();}
    else if(!quoted&&(c===','||c==='\n'||c==='\r')){row.push(cell);cell='';if(c!==','){if(row.some(Boolean))rows.push(row);row=[];if(c==='\r'&&text[i+1]==='\n')i++;}}
    else cell+=c;
  }
  if(quoted)fail();row.push(cell);if(row.some(Boolean))rows.push(row);
  const headers=(rows.shift()||[]).map(s=>s.replace(/^﻿/,'').trim().toLowerCase());
  if(!headers.length||new Set(headers).size!==headers.length)fail();
  return rows.map(r=>{if(r.length!==headers.length)fail();return Object.fromEntries(headers.map((h,i)=>[h,r[i]]));});
}
function origin(value) {try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.origin:null;}catch{return null;}}
// Exporters disagree on column names and several ship more than one spelling,
// so every field takes the first spelling actually present in the row.
const CSV_FORMATS=['chrome','apple','safari','csv','keepass','bitwarden-csv','1password-csv'];
const first=(...values)=>values.find(v=>typeof v==='string'&&v.trim())||'';
const listOf=(value,separator)=>String(value||'').split(separator).map(s=>s.trim()).filter(Boolean);
function csvLogin(row) {
  const website=first(row.url,row.website,row.login_uri,row.urls);
  const username=first(row.username,row.login_username);
  const folder=first(row.folder,row.group,row.grouping);
  const name=first(row.name,row.title);
  return {
    name,
    urls:listOf(website,/\r?\n/),                                        // Bitwarden puts extra URIs on their own lines
    username,
    password:first(row.password,row.login_password),
    totp:first(row.otp,row['otp auth'],row.otpauth,row.totp,row.login_totp),
    notes:first(row.notes,row.note).replace(/\r\n/g,'\n'),   // a note is display text; CRLF rows leave a stray CR inside it
    groups:[...listOf(folder,/\r?\n/),...listOf(row.tags,/[,;]/)],
    archived:/^(true|yes|1)$/i.test(String(row.archived||'').trim()),
    key:`${website}:${username}:${name}`,
  };
}
function readableTotp(value) {
  try {
    parseTotp(value);
    return true;
  } catch {
    return false;
  }
}
export function parseImport(format,input) {
  if(typeof input!=='string'||Buffer.byteLength(input)>20*1024*1024)fail();
  const entries=[],warnings=[];
  function login(item,key) {
    const before=entries.length;
    const origins=[...new Set((item.urls||[]).map(origin).filter(Boolean))];
    const originalName=String(item.name||'Imported credential');
    if(originalName.length>MAX_TITLE)warnings.push(SHORT_TITLE);
    const common={id:'import-'+hash(`${format}:${key}`),name:originalName.slice(0,MAX_TITLE),
      origins,groups:item.groups||[],archived:Boolean(item.archived),notes:item.notes||''};
    if(item.password&&origins.length)entries.push({...common,kind:'login',value:{username:item.username||'',password:item.password}});
    else if(item.password) {entries.push({...common,kind:'secret',value:item.password});warnings.push(NO_WEBSITE);}
    else if(item.notes)entries.push({...common,kind:'secret',value:item.notes});
    if(item.totp&&origins.length) {
      if(readableTotp(item.totp))entries.push({...common,id:common.id+'-otp',name:common.name.slice(0,MAX_TITLE-OTP_SUFFIX.length)+OTP_SUFFIX,kind:'totp',value:item.totp});
      else warnings.push(UNREADABLE_TOTP);
    }
    if(item.passkeys?.length)warnings.push(HAS_PASSKEYS);
    if(entries.length===before)warnings.push(NOTHING_IMPORTED);
  }
  if(CSV_FORMATS.includes(format)) {
    // A row's identity must not move when the export gains a row or is
    // re-ordered, or re-importing it duplicates the vault instead of skipping
    // it. Rows identical on website, username and name get an occurrence
    // number, the only thing left to tell them apart.
    const occurrences=new Map();
    for(const row of csvRows(input)) {
      const item=csvLogin(row);
      const seen=occurrences.get(item.key)||0;
      occurrences.set(item.key,seen+1);
      login(item,seen?`${item.key}#${seen}`:item.key);
    }
  } else {
    let data;try{data=JSON.parse(input);}catch{fail();}
    if(format==='bitwarden') {
      if(data.encrypted===true||!Array.isArray(data.items))fail();
      const folders=new Map((data.folders||[]).map(f=>[f.id,f.name]));
      for(const item of data.items) {
        const groups=[folders.get(item.folderId)].filter(Boolean);
        const urls=(item.login?.uris||[]).map(u=>u.uri).filter(Boolean);
        login({name:item.name,urls,username:item.login?.username,password:item.login?.password,
          totp:item.login?.totp,notes:item.notes||'',groups,archived:Boolean(item.deletedDate),
          passkeys:item.login?.fido2Credentials},item.id);
        if(item.type!==1&&item.type!==2)warnings.push(NOT_MAPPED);
      }
    } else if(format==='1password'||format==='1pux') {
      if(!Array.isArray(data.accounts))fail();
      for(const account of data.accounts)for(const vault of account.vaults||[])for(const item of vault.items||[]) {
        const fields=item.details?.loginFields||[];
        const field=designation=>fields.find(f=>f.designation===designation)?.value;
        const sections=(item.details?.sections||[]).flatMap(s=>s.fields||[]);
        const urls=[item.overview?.url,...(item.overview?.urls||[]).map(u=>u.url)].filter(Boolean);
        const groups=[vault.attrs?.name,...(item.overview?.tags||[])].filter(Boolean);
        login({name:item.overview?.title,urls,username:field('username'),password:field('password'),
          totp:sections.find(f=>f.value?.totp)?.value?.totp,notes:item.details?.notesPlain||'',
          groups,archived:item.state==='archived'},`${account.attrs?.uuid}:${vault.attrs?.uuid}:${item.uuid}`);
        if(item.file||item.details?.documentAttributes)warnings.push(ATTACHMENTS);
      }
      warnings.push(NO_PUX_PASSKEYS);
    } else fail();
  }
  if(entries.length>100000)fail();
  return {entries,warnings:[...new Set(warnings)]};
}
