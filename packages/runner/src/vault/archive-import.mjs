import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Read only the structured export; never extract archive filenames onto disk.
// macOS ships unzip. Input/output bounds and a timeout limit malformed archives.
export function read1PuxData(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > 32 * 1024 * 1024
    || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid credential archive');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-import-'));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'input.zip');
  try {
    fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
    const options = { timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
    const names = execFileSync('/usr/bin/unzip', ['-Z1', file], options).toString('utf8').split(/\r?\n/).filter(Boolean);
    if (names.filter(name => name === 'export.data').length !== 1) throw new Error('Missing structured export');
    const data = execFileSync('/usr/bin/unzip', ['-p', file, 'export.data'], options).toString('utf8');
    JSON.parse(data);
    return data;
  } catch { throw new Error('Could not read credential archive'); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
