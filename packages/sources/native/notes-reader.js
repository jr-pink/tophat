ObjC.import('Foundation');
function run(argv) {
 const config=JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(argv[0],$.NSUTF8StringEncoding,null)));
 const selected=config.folderIds || [];
 if(!selected.length && !config.discover) throw new Error('Select note folder IDs before reading');
 const app=Application('Notes'), out=[];
 function walk(folder){
  if(config.discover) out.push({id:folder.id(),name:folder.name()});
  if(!config.discover && selected.indexOf(folder.id())>=0){
   const notes=folder.notes,ids=notes.id(),titles=notes.name(),modified=notes.modificationDate(),locked=notes.passwordProtected();
   // Locked notes stay untouched. Read only authorized, unlocked note bodies.
   for(let i=0;i<ids.length;i++) if(!locked[i]) out.push({id:ids[i],title:titles[i],modified:modified[i].toISOString(),body:notes[i].body(),folderId:folder.id()});
  }
  for(const child of folder.folders())walk(child);
 }
 for(const account of app.accounts())for(const folder of account.folders())walk(folder);
 return JSON.stringify(out);
}
