import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);

// An iOS Shortcut, built here so the token is already inside it and he installs it by tapping a
// link. Three actions: POST the shared url to /api/reader/share, pull the title out of the answer,
// show a notification. The share sheet is the only way into an installed web app on iOS, because
// WebKit does not implement the manifest's share_target, and a Shortcut is the only thing the
// share sheet will show that can reach us.
//
// The file format is a plist; the shapes below (WFTextTokenString with an attachment at a
// character range, ActionOutput referring to an earlier action's UUID) are how Shortcuts stores a
// variable inside a text field. The object replacement character is the variable's placeholder,
// and the range in attachmentsByRange is its offset in the string.
const OBJECT_REPLACEMENT = '\uFFFC';

const xml = (value) => {
  if (Array.isArray(value)) return `<array>${value.map(xml).join('')}</array>`;
  if (value && typeof value === 'object') {
    return `<dict>${Object.entries(value).map(([k, v]) => `<key>${esc(k)}</key>${xml(v)}`).join('')}</dict>`;
  }
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (typeof value === 'number') return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`;
  return `<string>${esc(String(value))}</string>`;
};

const esc = (s) => s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

const text = (string) => ({ Value: { string }, WFSerializationType: 'WFTextTokenString' });

export function shortcutPlist({ endpoint, token }) {
  const fetchId = randomUUID().toUpperCase();
  const titleId = randomUUID().toUpperCase();
  const url = `${endpoint}?token=${encodeURIComponent(token)}`;
  const body = {
    WFWorkflowClientVersion: '2605.0.5',
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowIcon: { WFWorkflowIconStartColor: 463140863, WFWorkflowIconGlyphNumber: 59511 },
    WFWorkflowImportQuestions: [],
    // ActionExtension is what puts it in the share sheet of every app, Chrome included.
    WFWorkflowTypes: ['ActionExtension'],
    WFWorkflowInputContentItemClasses: [
      'WFURLContentItem', 'WFSafariWebPageContentItem', 'WFStringContentItem', 'WFArticleContentItem'
    ],
    WFQuickActionSurfaces: [],
    WFWorkflowHasShortcutInputVariables: true,
    WFWorkflowHasOutputFallback: false,
    WFWorkflowActions: [
      {
        WFWorkflowActionIdentifier: 'is.workflow.actions.downloadurl',
        WFWorkflowActionParameters: {
          UUID: fetchId,
          WFURL: url,
          WFHTTPMethod: 'POST',
          WFHTTPBodyType: 'JSON',
          WFJSONValues: {
            Value: {
              WFDictionaryFieldValueItems: [{
                WFItemType: 0,
                WFKey: text('url'),
                WFValue: {
                  Value: {
                    string: OBJECT_REPLACEMENT,
                    attachmentsByRange: { '{0, 1}': { Type: 'ExtensionInput' } }
                  },
                  WFSerializationType: 'WFTextTokenString'
                }
              }]
            },
            WFSerializationType: 'WFDictionaryFieldValue'
          }
        }
      },
      {
        WFWorkflowActionIdentifier: 'is.workflow.actions.getvalueforkey',
        WFWorkflowActionParameters: {
          UUID: titleId,
          WFDictionaryKey: 'title',
          WFInput: {
            Value: { Type: 'ActionOutput', OutputUUID: fetchId, OutputName: 'Contents of URL' },
            WFSerializationType: 'WFTextTokenAttachment'
          }
        }
      },
      {
        WFWorkflowActionIdentifier: 'is.workflow.actions.notification',
        WFWorkflowActionParameters: {
          WFNotificationActionTitle: 'Reader',
          WFNotificationActionBody: {
            Value: {
              string: `Saved ${OBJECT_REPLACEMENT}`,
              attachmentsByRange: {
                '{6, 1}': { Type: 'ActionOutput', OutputUUID: titleId, OutputName: 'Dictionary Value' }
              }
            },
            WFSerializationType: 'WFTextTokenString'
          }
        }
      }
    ]
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${xml(body)}</plist>\n`;
}

/**
 * The signed file. An unsigned shortcut makes iOS demand the Allow Untrusted Shortcuts setting
 * before it will import anything; `shortcuts sign` on this Mac removes that step. If signing is
 * unavailable the unsigned plist is still a working shortcut, so it is returned rather than an
 * error, with signed:false so the caller can say which one it handed over.
 */
export async function shortcutFile({ endpoint, token }) {
  const plist = shortcutPlist({ endpoint, token });
  const dir = mkdtempSync(join(tmpdir(), 'reader-shortcut-'));
  try {
    const input = join(dir, 'in.shortcut');
    const output = join(dir, 'out.shortcut');
    writeFileSync(input, plist, 'utf8');
    await run('/usr/bin/shortcuts', ['sign', '-m', 'anyone', '-i', input, '-o', output], { timeout: 20_000 });
    return { bytes: readFileSync(output), signed: true };
  } catch {
    return { bytes: Buffer.from(plist, 'utf8'), signed: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
