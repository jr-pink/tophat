"""Bounded in-memory archive/OOXML decoding. Never extracts archive names to disk."""
import sys,json,io,zipfile,tarfile,base64,stat,posixpath,itertools,gzip,xml.etree.ElementTree as ET
request=json.load(sys.stdin)
blob=open(request['file'],'rb').read(request['maxBytes']+1)
if len(blob)>request['maxBytes']: raise ValueError('input-limit')
mode=request['mode']; budget=request['expandedBytes']; max_entries=request['maxEntries']

def safe(name):
    return bool(name) and not name.startswith(('/', '\\')) and '\\' not in name and ':' not in name and '..' not in name.split('/')
def xml(data):
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper(): raise ValueError('unsafe-xml')
    return ET.fromstring(data)
def local(tag): return tag.split('}')[-1]
def texts(root): return ''.join(n.text or '' for n in root.iter() if local(n.tag)=='t')

if mode=='archive':
    entries=[]; consumed=0
    if zipfile.is_zipfile(io.BytesIO(blob)):
        archive=zipfile.ZipFile(io.BytesIO(blob)); members=archive.infolist()
        def read(m): return archive.open(m).read(min(m.file_size,budget)+1)
        facts=[(m,m.filename,m.file_size,m.is_dir(),bool(m.flag_bits&1),stat.S_ISLNK(m.external_attr>>16),m.compress_size) for m in members]
    else:
        # Bound compressed expansion before tar metadata iteration can skip a huge member.
        decoded=blob
        if blob.startswith(b'\x1f\x8b'):
            with gzip.GzipFile(fileobj=io.BytesIO(blob)) as stream: decoded=stream.read(budget+1)
            if len(decoded)>budget:
                print(json.dumps({'entries':[{'name':request.get('gzipName','content'),'size':len(decoded),
                    'status':'deferred','reason':'expanded-byte-limit'}],'omittedEntries':0,'expandedBytes':budget}));sys.exit(0)
        try:
            archive=tarfile.open(fileobj=io.BytesIO(decoded),mode='r:'); members=list(itertools.islice(archive,max_entries+1))
            def read(m): return archive.extractfile(m).read(min(m.size,budget)+1)
            facts=[(m,m.name,m.size,m.isdir(),False,not(m.isfile() or m.isdir()),None) for m in members]
        except tarfile.ReadError:
            if decoded is blob: raise ValueError('unsupported-archive-compression')
            data=decoded
            name=request.get('gzipName','content')
            if len(data)>budget: row={'name':name,'size':len(data),'status':'deferred','reason':'expanded-byte-limit'}
            else: row={'name':name,'size':len(data),'base64':base64.b64encode(data).decode()}
            print(json.dumps({'entries':[row],'omittedEntries':0,'expandedBytes':min(len(data),budget)}));sys.exit(0)
    for m,name,size,directory,encrypted,special,compressed in facts[:max_entries]:
        if directory: continue
        reason=None
        if not safe(name) or special: reason='unsafe-archive-entry'
        elif encrypted: reason='encrypted-entry'
        elif size>budget-consumed or (compressed is not None and size>max(compressed,1)*200): reason='expanded-byte-limit'
        row={'name':name,'size':size}
        if reason: row.update(status='encrypted' if encrypted else 'deferred',reason=reason)
        else:
            try:
                data=read(m)
                if len(data)!=size: raise ValueError('entry-size-mismatch')
                consumed+=len(data);row['base64']=base64.b64encode(data).decode()
            except Exception: row.update(status='unreadable',reason='archive-entry-read-failed')
        entries.append(row)
    print(json.dumps({'entries':entries,'omittedEntries':max(0,len(facts)-max_entries),'expandedBytes':consumed}))
else:
    archive=zipfile.ZipFile(io.BytesIO(blob)); members=archive.infolist()
    if len(members)>4096 or sum(m.file_size for m in members)>budget or any(m.flag_bits&1 for m in members):
        raise ValueError('ooxml-expanded-or-encrypted')
    if any(not safe(m.filename) or stat.S_ISLNK(m.external_attr>>16) or m.file_size>max(m.compress_size,1)*200 for m in members):
        raise ValueError('unsafe-ooxml')
    def part(name): return xml(archive.read(name))
    spans=[]; omitted=0; notes=[]; sections=[]
    if mode=='docx':
        root=part('word/document.xml')
        for index,p in enumerate(n for n in root.iter() if local(n.tag)=='p'):
            text=texts(p)
            if text.strip(): spans.append({'locator':{'paragraph':index+1},'text':text})
        if any(name.startswith('word/media/') for name in archive.namelist()): notes.append('embedded-images-not-interpreted')
        if any(name.startswith(('word/header','word/footer','word/footnotes','word/endnotes','word/comments')) for name in archive.namelist()):
            notes.append('auxiliary-document-parts-not-read')
    elif mode=='xlsx':
        shared=[]
        if 'xl/sharedStrings.xml' in archive.namelist(): shared=[texts(n) for n in part('xl/sharedStrings.xml') if local(n.tag)=='si']
        relations={n.attrib['Id']:n.attrib.get('Target','') for n in part('xl/_rels/workbook.xml.rels')}
        selection=request.get('selection') or {}; selected_sheets=selection.get('sheets')
        row_start=selection.get('rowStart',1); row_limit=selection.get('rowLimit',2000)
        details=[]
        # Index every native sheet before spending any content budget on rows.
        for sn,sheet in enumerate(n for n in part('xl/workbook.xml').iter() if local(n.tag)=='sheet'):
            name=sheet.attrib.get('name',''); index=sn+1
            rid=next((v for k,v in sheet.attrib.items() if local(k)=='id'),None)
            target=relations.get(rid,'')
            filename=target.lstrip('/') if target.startswith('/xl/') else posixpath.normpath('xl/'+target)
            selected=selected_sheets is None or index in selected_sheets or name in selected_sheets
            section={'id':'sheet:'+str(index),'kind':'sheet','index':index,'name':name,'part':filename,
                'visibility':sheet.attrib.get('state','visible'),'selected':selected,'rowCount':None,'rowsInWindow':0,
                'status':'deferred' if selected else 'not-selected','rowStart':row_start,'rowLimit':row_limit}
            sections.append(section)
            if not selected: continue
            if len(details)>=20: section['reason']='sheet-detail-limit';omitted+=1;continue
            if not safe(filename) or not filename.startswith('xl/'):
                section.update(status='unreadable',reason='unsafe-sheet-reference');continue
            try: sheet_root=part(filename)
            except Exception: section.update(status='unreadable',reason='sheet-part-unreadable');continue
            rows=[]; count=0
            for rn,row in enumerate(n for n in sheet_root.iter() if local(n.tag)=='row'):
                cells=[]; addresses=[]
                for cell in row:
                    if local(cell.tag)!='c': continue
                    values={local(n.tag):n.text or '' for n in cell}; value=values.get('v','')
                    if cell.attrib.get('t')=='s': value=shared[int(value)] if value else ''
                    elif cell.attrib.get('t')=='inlineStr': value=texts(cell)
                    # Empty formatting cells are not content and must not starve later sheets.
                    if value=='' and 'f' not in values: continue
                    if 'f' in values: value='formula='+values['f']+'; cached='+value
                    address=cell.attrib.get('r','?');addresses.append(address);cells.append(address+': '+value)
                if not cells: continue
                count+=1; number=int(row.attrib.get('r',str(rn+1)))
                if number<row_start or number>=row_start+row_limit: continue
                rows.append({'locator':{'sectionId':section['id'],'sheet':name,'sheetIndex':index,
                    'row':str(number),'cells':addresses},'text':' | '.join(cells)})
            section.update(rowCount=count,rowsInWindow=len(rows),status='read')
            details.append(rows)
        if selected_sheets is not None:
            unknown=[choice for choice in selected_sheets if not any(choice in (s['index'],s['name']) for s in sections)]
            if unknown: notes.append('requested-sheet-not-found');omitted+=len(unknown)
        # Breadth-first detail: no early sheet consumes all text before a later sheet appears.
        used=0; maximum=request.get('maxChars',160000)
        for row_group in itertools.zip_longest(*details):
            for row in row_group:
                if row is None: continue
                if used>=maximum: omitted+=1;continue
                text=row['text'];room=maximum-used
                if len(text)>room: row={**row,'text':text[:room]};notes.append('row-text-truncated')
                spans.append(row);used+=len(row['text'])
        notes.append('formulas-not-recalculated; charts-images-formatting-not-interpreted')
    elif mode=='pptx':
        slides=sorted(n for n in archive.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml'))
        for index,name in enumerate(slides[:40]):
            spans.append({'locator':{'slidePart':name},'text':'\n'.join(texts(p) for p in part(name).iter() if local(p.tag)=='p')})
        omitted=max(0,len(slides)-40);notes.append('slide-graphics-and-notes-not-interpreted')
    else: raise ValueError('unsupported-container')
    print(json.dumps({'spans':spans,'omitted':omitted,'notes':notes,'sections':sections}))
