// Turns files Kelvin shares (Slack or Telegram) into something the agents can read.
//   PDF            → native document block (Claude reads text, tables and layout)
//   PNG/JPG/GIF/WebP → native image block
//   DOCX           → plain text (mammoth)
//   XLSX           → CSV per sheet (exceljs)
//   text / code / CSV / JSON / Markdown → plain text
// Every file is also saved under workspace/uploads/<thread>/ so Kai can open it with his tools.
// The platform adapter does the actual download (Slack needs files:read; Telegram caps bots at 20 MB).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { log } from './log.js';

const workspace = path.resolve(process.env.WORKSPACE_DIR || './workspace');
const MAX_BYTES = 20 * 1024 * 1024;   // skip anything bigger than 20 MB
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 80_000;              // characters of extracted text per file

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx',
  'py', 'java', 'kt', 'swift', 'go', 'rs', 'rb', 'php', 'c', 'cpp', 'h', 'cs', 'sh', 'sql', 'env.example', 'log', 'ini', 'toml']);

const ext = (f) => (f.filetype || path.extname(f.name || '').slice(1) || '').toLowerCase();
const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n…[truncated, ${s.length - MAX_TEXT} more characters]` : s);
const safe = (s) => String(s).replace(/[^\w.\-]+/g, '_').slice(0, 120);

async function xlsxToText(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const out = [];
  wb.eachSheet((sheet) => {
    out.push(`## Sheet: ${sheet.name}`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = row.values.slice(1).map((v) => {
        if (v == null) return '';
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === 'object') {
          if (v.result != null) return String(typeof v.result === 'object' ? v.result.error ?? '' : v.result);
          if (v.formula || v.sharedFormula) return `=${v.formula || v.sharedFormula}`;
          if (v.richText) return v.richText.map((r) => r.text).join('');
          if (v.text) return String(v.text);
          return '';
        }
        return String(v);
      });
      out.push(cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','));
    });
  });
  return out.join('\n');
}

/**
 * Downloads and converts Slack files.
 * Returns { blocks: content blocks for Claude, notes: lines to add to the prompt }.
 */
export async function prepareFiles(files, threadKey, download) {
  const blocks = [];
  const notes = [];
  if (!files?.length) return { blocks, notes };

  const dir = path.join(workspace, 'uploads', safe(threadKey));
  // Files are normalised by the adapter to { name, filetype, mimetype, size, ... }.
  fs.mkdirSync(dir, { recursive: true });

  for (const f of files) {
    const name = f.name || f.title || f.id;
    const e = ext(f);
    try {
      if (f.size > MAX_BYTES) { notes.push(`- ${name}: too large to read (${(f.size / 1e6).toFixed(1)} MB, limit 20 MB)`); continue; }
      const buf = await download(f);
      const saved = path.join(dir, safe(name));
      fs.writeFileSync(saved, buf);
      const rel = path.relative(workspace, saved);

      if (e === 'pdf' || f.mimetype === 'application/pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') }, title: name });
        notes.push(`- ${name} (PDF, attached below; saved at ${rel})`);
      } else if (IMAGE_TYPES[e] || f.mimetype?.startsWith('image/')) {
        if (buf.length > MAX_IMAGE_BYTES) { notes.push(`- ${name}: image too large to view (limit 5 MB); saved at ${rel}`); continue; }
        blocks.push({ type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[e] || f.mimetype, data: buf.toString('base64') } });
        notes.push(`- ${name} (image, attached below; saved at ${rel})`);
      } else if (e === 'docx') {
        const { value } = await mammoth.extractRawText({ buffer: buf });
        blocks.push({ type: 'text', text: `<file name="${name}">\n${clip(value)}\n</file>` });
        notes.push(`- ${name} (Word document, text below; saved at ${rel})`);
      } else if (e === 'xlsx') {
        blocks.push({ type: 'text', text: `<file name="${name}" format="csv per sheet">\n${clip(await xlsxToText(buf))}\n</file>` });
        notes.push(`- ${name} (spreadsheet, sheets as CSV below; saved at ${rel})`);
      } else if (TEXT_EXT.has(e) || f.mimetype?.startsWith('text/') || f.mimetype === 'application/json') {
        blocks.push({ type: 'text', text: `<file name="${name}">\n${clip(buf.toString('utf8'))}\n</file>` });
        notes.push(`- ${name} (text, below; saved at ${rel})`);
      } else {
        notes.push(`- ${name}: format .${e || '?'} isn't supported for reading, but it's saved at ${rel}`);
      }
      log.info('file ready', { name, type: e, kb: Math.round(buf.length / 1024), thread: threadKey });
    } catch (err) {
      notes.push(`- ${name}: couldn't open it (${err.message})`);
      log.warn('file failed', { name, err, thread: threadKey });
    }
  }
  return { blocks, notes };
}
