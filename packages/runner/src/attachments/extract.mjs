import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {extractPdfText} from '../automation/pdf-text.mjs';
const run = promisify(execFile);
export const EXTRACTOR_VERSION = 'attachment-text-v2';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const LIMITS = {fileBytes: 20000000, expandedBytes: 40000000, files: 64, depth: 3, pages: 40, ocrPages: 4, chars: 160000, spans: 4000};
const worker = path.join(import.meta.dirname, 'containers.py');
async function python(input) {
  // execFile has no stdin argument, so use the existing bounded command protocol.
  const {spawn} = await import('node:child_process');
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(worker)) return reject(Error('container-extractor-unavailable'));
    const child = spawn(process.env.TOPHAT_CONTAINER_PYTHON || 'python3', [worker], {stdio: ['pipe', 'pipe', 'pipe']});
    let text = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(Error('container-timeout')); }, 20000);
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { text += chunk; if (text.length > 60000000) { child.kill('SIGKILL'); finish(Error('container-output-limit')); } });
    child.on('error', () => finish(Error('container-extractor-unavailable')));
    child.on('close', code => { try { if (code) throw Error('container-unreadable-or-encrypted'); finish(null, JSON.parse(text)); }
      catch { finish(Error('container-unreadable-or-encrypted')); } });
    child.stdin.end(JSON.stringify(input));
  });
}
async function ocr(file, work) {
  if (process.platform !== 'darwin') throw Error('local-ocr-unavailable');
  const code = await fsp.readFile(path.join(import.meta.dirname, 'OCR.swift'));
  const binary = path.join(work, `ocr-${digest(code).slice(0, 16)}`);
  if (!fs.existsSync(binary)) await run('xcrun', ['swiftc', path.join(import.meta.dirname, 'OCR.swift'), '-o', binary], {timeout: 30000});
  const {stdout} = await run(binary, [file], {timeout: 20000, maxBuffer: 2000000});
  return JSON.parse(stdout);
}
function kind(bytes, name) {
  const ext = path.extname(name).toLowerCase();
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (ext === '.odt') return 'legacy-document';
  if (bytes.subarray(0, 2).toString() === 'PK') return ['.docx', '.xlsx', '.pptx'].includes(ext) ? ext.slice(1) : 'archive';
  if (['.tar', '.tgz', '.gz'].includes(ext) || name.toLowerCase().endsWith('.tar.gz')) return 'archive';
  if (['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.heic', '.bmp', '.webp'].includes(ext)) return 'image';
  if (['.doc', '.rtf', '.odt'].includes(ext)) return 'legacy-document';
  if (['.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.log'].includes(ext)) return 'text';
  return 'unsupported';
}
export async function extractTree({bytes, name, work, limits = LIMITS, selection = null}) {
  const files = [], spans = []; let expanded = 0, characters = 0, omittedFiles = 0, ocrCount = 0;
  function add(file, text, locator, method) {
    if (!text?.trim()) return;
    if (text.length > 6000) {
      for (let offset = 0; offset < text.length; offset += 6000) add(file, text.slice(offset, offset + 6000),
        {...locator, characterStart: offset, characterEnd: Math.min(offset + 6000, text.length)}, method);
      return;
    }
    if (spans.length >= limits.spans || characters >= limits.chars) { file.status = 'partial'; file.notes.push('text-limit'); return; }
    const kept = text.slice(0, limits.chars - characters); characters += kept.length;
    if (kept.length !== text.length) { file.status = 'partial'; file.notes.push('text-limit'); }
    const id = digest(JSON.stringify([file.id, locator, kept])).slice(0, 32);
    spans.push({id, fileId: file.id, text: kept, locator, method}); file.spans.push(id);
  }
  async function visit(data, filename, nestedPath, depth, parentId = null, failure = null) {
    if (files.length >= limits.files) { omittedFiles++; return; }
    const sha256 = data ? digest(data) : null;
    const file = {id: digest(JSON.stringify([nestedPath, sha256, files.length])).slice(0, 32), parentId, name: filename,
      nestedPath, sha256, bytes: data?.length ?? null, status: 'read', notes: [], spans: []}; files.push(file);
    if (failure) { Object.assign(file, failure); return; }
    if (data.length > limits.fileBytes || expanded + data.length > limits.expandedBytes) {
      file.status = 'deferred'; file.notes.push('expanded-byte-limit'); return;
    }
    expanded += data.length;
    const local = path.join(work, sha256); if (!fs.existsSync(local)) fs.writeFileSync(local, data, {mode: 0o600, flag: 'wx'});
    file.blob = sha256;
    const format = kind(data, filename); file.format = format;
    try {
      if (format === 'archive') {
        if (depth >= limits.depth) { file.status = 'deferred'; file.notes.push('archive-depth-limit'); return; }
        const unpacked = await python({file: local, mode: 'archive', gzipName: filename.replace(/\.gz$/i, ''), maxBytes: limits.fileBytes,
          expandedBytes: limits.expandedBytes - expanded, maxEntries: limits.files - files.length});
        for (const entry of unpacked.entries) {
          await visit(typeof entry.base64 === 'string' ? Buffer.from(entry.base64, 'base64') : null, entry.name,
            [...nestedPath, entry.name], depth + 1, file.id,
            entry.status ? {status: entry.status, notes: [entry.reason]} : null);
        }
        if (unpacked.omittedEntries) { omittedFiles += unpacked.omittedEntries; file.status = 'partial'; file.notes.push('archive-entry-limit'); }
      } else if (['docx', 'xlsx', 'pptx'].includes(format)) {
        const extracted = await python({file: local, mode: format, maxBytes: limits.fileBytes,
          expandedBytes: limits.expandedBytes - expanded, maxEntries: limits.files, selection, maxChars: limits.chars - characters});
        for (const span of extracted.spans) add(file, span.text, span.locator, 'ooxml-text');
        file.sections = (extracted.sections || []).map(section => {
          const rows = new Set(spans.filter(span => span.fileId === file.id && span.locator.sectionId === section.id).map(span => span.locator.row));
          return {...section, rowsExtracted: rows.size,
            omittedRows: section.rowCount === null ? null : section.rowCount - rows.size,
            status: section.status === 'read' && (rows.size < section.rowCount || extracted.notes.includes('row-text-truncated')) ? 'partial' : section.status};
        });
        file.notes.push(...extracted.notes);
        if (extracted.omitted || extracted.notes.length) { file.status = 'partial'; if (extracted.omitted) file.notes.push('document-span-limit'); }
      } else if (format === 'pdf') {
        let info;
        try { info = (await run('pdfinfo', [local], {timeout: 20000, maxBuffer: 100000})).stdout; }
        catch (error) { throw Error(/password|encrypt/i.test(error.stderr || '') ? 'encrypted-pdf' : 'pdf-info-unavailable'); }
        const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
        if (!Number.isInteger(pages) || pages < 1) throw Error('pdf-page-count-unavailable');
        file.pages = pages;
        const extracted = await extractPdfText(data, {maxBytes: limits.fileBytes, maxPages: limits.pages, maxChars: limits.chars + 1});
        const texts = extracted.split('\f');
        for (let page = 1; page <= Math.min(pages, limits.pages); page++) {
          if (texts[page - 1]?.trim()) add(file, texts[page - 1], {page}, 'pdf-text-layer');
          else if (ocrCount < limits.ocrPages) {
            ocrCount++;
            const image = path.join(work, `${sha256}-page-${page}`);
            try {
              await run('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '1800', '-png', local, image], {timeout: 20000});
              for (const [index, row] of (await ocr(image + '.png', work)).entries()) add(file, row.text, {page, line: index + 1, box: row.box}, 'local-ocr');
              file.notes.push(`page-${page}-ocr-not-visual-interpretation`);
            } catch { file.notes.push(`page-${page}-ocr-unavailable`); }
            file.status = 'partial';
          } else { file.status = 'partial'; file.notes.push(`page-${page}-ocr-deferred`); }
        }
        if (pages > limits.pages) { file.status = 'partial'; file.notes.push('page-limit'); }
        file.status = 'partial'; file.notes.push('pdf-graphics-not-interpreted');
        if (extracted.length > limits.chars) file.notes.push('text-limit');
      } else if (format === 'image') {
        const reduced = path.join(work, sha256 + '.png');
        await run('/usr/bin/sips', ['-Z', '1800', '-s', 'format', 'png', local, '--out', reduced], {timeout: 20000});
        for (const [index, row] of (await ocr(reduced, work)).entries()) add(file, row.text, {line: index + 1, box: row.box}, 'local-ocr');
        file.status = 'partial'; file.notes.push('image-ocr-only; visual-content-not-interpreted');
      } else if (format === 'text') {
        const text = new TextDecoder('utf-8', {fatal: true}).decode(data);
        if (text.includes('\0')) throw Error('binary-text-refused');
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 20) add(file, lines.slice(i, i + 20).join('\n'), {lineStart: i + 1, lineEnd: Math.min(i + 20, lines.length)}, 'utf8-text');
      } else if (format === 'legacy-document') {
        const {documentText} = await import('../core/corpora/spotlight.mjs');
        const convertedInput = local + path.extname(filename);
        if (!fs.existsSync(convertedInput)) fs.copyFileSync(local, convertedInput, fs.constants.COPYFILE_EXCL);
        const text = await documentText(convertedInput).catch(() => null);
        // Preserve original extension for the existing macOS converter.
        if (text === null) { file.status = 'unsupported'; file.notes.push('legacy-converter-unavailable'); }
        else { add(file, text, {section: 'document'}, 'textutil'); file.status = 'partial'; file.notes.push('layout-not-preserved'); }
      } else { file.status = 'unsupported'; file.notes.push('unsupported-content-type'); }
      if (format !== 'archive' && !file.spans.length && file.status === 'read') { file.status = 'unreadable'; file.notes.push('no-readable-content'); }
    } catch (error) {
      file.status = error.message === 'encrypted-pdf' ? 'encrypted' : 'unreadable';
      file.notes.push(['encrypted-pdf', 'pdf-info-unavailable', 'container-unreadable-or-encrypted'].includes(error.message) ? error.message : 'extraction-unavailable');
    }
  }
  await visit(bytes, name, [name], 0);
  return {files, spans, omittedFiles, expandedBytes: expanded, extractorVersion: EXTRACTOR_VERSION};
}
