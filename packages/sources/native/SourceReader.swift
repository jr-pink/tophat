import Foundation
import Contacts
import EventKit
import AppKit
import ApplicationServices
import Darwin
let args=CommandLine.arguments
if args.count != 5 { exit(2) }
let kind=args[1], operation=args[2], configURL=URL(fileURLWithPath:args[3]), outputURL=URL(fileURLWithPath:args[4])
let options=(try? JSONSerialization.jsonObject(with:Data(contentsOf:configURL))) as? [String:Any] ?? [:]
let iso=ISO8601DateFormatter()
func date(_ value:String)->Date? {
 if let parsed=iso.date(from:value) { return parsed }
 let fractional=ISO8601DateFormatter()
 fractional.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
 return fractional.date(from:value)
}
DispatchQueue.global().asyncAfter(deadline:.now()+110){exit(1)}
func output(_ value:Any) { do { let data=try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]);try data.write(to:outputURL,options:.atomic) } catch { exit(2) } }
func denied(_ code:String) -> Never { output(["status":"unavailable","code":code]);exit(1) }
func wait(_ request: (@escaping (Bool)->Void)->Void)->Bool {
 var finished=false,allowed=false
 request { value in allowed=value;finished=true }
 while !finished {RunLoop.current.run(until:Date(timeIntervalSinceNow:0.05))}
 return allowed
}
if kind=="apple-contacts" {
 let store=CNContactStore(); var status=CNContactStore.authorizationStatus(for:.contacts)
 if operation=="authorize" && status == .notDetermined { _=wait { done in store.requestAccess(for:.contacts){ granted,_ in done(granted) } };status=CNContactStore.authorizationStatus(for:.contacts) }
 guard status == .authorized else { denied(status == .notDetermined ? "permission-required":"permission-denied") }
 if operation=="status" || operation=="authorize" { output(["status":"authorized"]);exit(0) }
 if operation=="discover" { do { output(["status":"ok","sources":try store.containers(matching:nil).map{["id":$0.identifier,"name":$0.name]}]);exit(0) } catch { denied("contacts-discovery-failed") } }
 let keys:[CNKeyDescriptor]=[
  CNContactIdentifierKey,CNContactGivenNameKey,CNContactFamilyNameKey,
  CNContactOrganizationNameKey,CNContactEmailAddressesKey,CNContactPhoneNumbersKey
 ].map{$0 as CNKeyDescriptor}
 var rows:[[String:Any]]=[]
 let request=CNContactFetchRequest(keysToFetch:keys)
 do {
  try store.enumerateContacts(with:request){ contact,_ in
   let name=[contact.givenName,contact.familyName].filter{ !$0.isEmpty }.joined(separator:" ")
   let emails=contact.emailAddresses.map{String($0.value)}
   let phones=contact.phoneNumbers.map{$0.value.stringValue}
   rows.append(["id":contact.identifier,"name":name,"organization":contact.organizationName,"emails":emails,"phones":phones])
  }
  output(["status":"ok","records":rows,"coverage":"current-snapshot"])
 } catch { denied("contacts-read-failed") }
} else if kind=="apple-calendar" {
 let store=EKEventStore();var status=EKEventStore.authorizationStatus(for:.event)
 if operation=="authorize" && status == .notDetermined {
  if #available(macOS 14.0,*) { _=wait { done in store.requestFullAccessToEvents { allowed,_ in done(allowed) } } }
  else { _=wait { done in store.requestAccess(to:.event){ allowed,_ in done(allowed) } } }
  status=EKEventStore.authorizationStatus(for:.event)
 }
 var allowed=status == .authorized
 if #available(macOS 14.0,*) { allowed=status == .fullAccess }
 guard allowed else { denied(status == .notDetermined ? "permission-required":"permission-denied") }
 if operation=="status" || operation=="authorize" { output(["status":"authorized"]);exit(0) }
 if operation=="discover" { output(["status":"ok","sources":store.calendars(for:.event).map{["id":$0.calendarIdentifier,"name":$0.title]}]);exit(0) }
 guard
  let from=options["start"] as? String,
  let to=options["end"] as? String,
  let start=date(from),
  let end=date(to),
  end>start,
  end.timeIntervalSince(start)<=370*86400
 else { denied("calendar-window-required") }
 let ids=options["calendarIds"] as? [String] ?? []
 let calendars=store.calendars(for:.event).filter{ids.isEmpty || ids.contains($0.calendarIdentifier)}
 let events=calendars.isEmpty ? [] : store.events(matching:store.predicateForEvents(withStart:start,end:end,calendars:calendars))
 let rows:[[String:Any]]=events.map { event in
  [
   "id":event.calendarItemIdentifier,
   "externalId":event.calendarItemExternalIdentifier ?? "",
   "calendarId":event.calendar.calendarIdentifier,
   "title":event.title ?? "",
   "notes":event.notes ?? "",
   "location":event.location ?? "",
   "start":iso.string(from:event.startDate),
   "end":iso.string(from:event.endDate),
   "modified":iso.string(from:event.lastModifiedDate ?? event.startDate),
   "allDay":event.isAllDay,
   "timezone":event.timeZone?.identifier ?? "",
   "recurring":event.hasRecurrenceRules,
   "status":event.status.rawValue
  ]
 }
 output(["status":"ok","records":rows,"coverage":"bounded-window","start":from,"end":to])
} else if kind=="apple-notes" {
 let target=NSAppleEventDescriptor(bundleIdentifier:"com.apple.Notes")
 let status=AEDeterminePermissionToAutomateTarget(target.aeDesc,0x636f7265,0x67657464,operation=="authorize")
 guard status == noErr else { denied(status == errAEEventWouldRequireUserConsent ? "permission-required":"permission-denied") }
 if operation=="status" || operation=="authorize" { output(["status":"authorized"]);exit(0) }
 guard let script=options["readerScript"] as? String else { denied("notes-reader-required") }
 let process=Process()
 process.executableURL=URL(fileURLWithPath:"/usr/bin/osascript")
 process.arguments=["-l","JavaScript",script,configURL.path]
 let stdout=Pipe()
 process.standardOutput=stdout
 process.standardError=FileHandle.nullDevice
 do {
  try process.run()
  DispatchQueue.global().asyncAfter(deadline:.now()+90){if process.isRunning {kill(process.processIdentifier,SIGKILL)}}
  let data=stdout.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  guard process.terminationStatus==0,let parsed=try JSONSerialization.jsonObject(with:data) as? [[String:Any]] else {denied("notes-read-failed")}
  output(["status":"ok","records":parsed,"coverage":"selected-folders"])
 } catch {denied("notes-read-failed")}
} else { denied("unsupported-native-kind") }
