/**
 * تصدير نسخة أمان (CSV) من بيانات الأرشيف والسجل الآلي — قراءة فقط.
 * يُشغَّل مرة واحدة قبل إغلاق واجهتي الأرشيف والسجل: يقرأ جدول القرارات
 * والسجل التاريخي للتحديد الآلي من القاعدة ويكتب ملفاً واحداً في exports/.
 * لا يكتب ولا يحذف أي صف في قاعدة البيانات إطلاقاً.
 *
 * الاستخدام: SUPABASE_URL=… SUPABASE_ANON_KEY=… node server/tools/exportArchiveCsv.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllPagesComplete } from '../services/readAllPages.mjs';
import db from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', '..', 'exports');
const OUT_FILE = path.join(OUT_DIR, 'archive-history.csv');

const csvCell = (v) => {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const writeCsv = (rows, headers) => {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map(h => csvCell(r[h])).join(','));
  return lines.join('\n') + '\n';
};

const ts = (v) => (Number(v) ? new Date(Number(v)).toISOString() : '');

async function main() {
  if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY)) {
    console.error('[export] لا يمكن التنفيذ: متغيرات الاتصال بقاعدة البيانات غير متاحة في هذه البيئة.');
    console.error('[export] البيانات نفسها محفوظة وآمنة في القاعدة ولم يُمسّ شيء. أعِد التشغيل من بيئة تتصل بالقاعدة.');
    process.exitCode = 2;
    return;
  }

  // 1) الأرشيف الكامل (القرارات المحفوظة) — قراءة صفحات كاملة
  const cases = await readAllPagesComplete(
    ({ beforeId, limit }) => db.cases.list({ beforeId, limit, orderById: true }),
    { pageSize: 1000, maxRows: 50_000 }
  );
  const caseRows = cases.map(c => ({
    id: c.id,
    symbol: c.symbol,
    actor: c.actor,
    decided_at: ts(c.decided_at),
    payload: c.payload
  }));

  // 2) السجل الآلي (لقطات التحديد الآلي الخام من events_log)
  const snapshots = await readAllPagesComplete(
    ({ beforeId, limit }) => db.zones.autoHistory({ beforeId, limit, orderById: true }),
    { pageSize: 500, maxRows: 50_000 }
  );
  const snapRows = snapshots.map(s => {
    let zones = null;
    try {
      const meta = JSON.parse(s.meta || 'null');
      zones = Array.isArray(meta?.zones) ? meta.zones.length : null;
    } catch { /* صف تالف يُصدَّر كما هو */ }
    return { id: s.id, symbol: s.symbol, ts: ts(s.ts), zones_count: zones, meta: s.meta };
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const body = writeCsv([
    ...caseRows.map(row => ({ dataset: 'cases', id: row.id, symbol: row.symbol, event_type: row.actor, recorded_at: row.decided_at, zones_count: '', details: row.payload })),
    ...snapRows.map(row => ({ dataset: 'auto_history', id: row.id, symbol: row.symbol, event_type: 'auto_zones_snapshot', recorded_at: row.ts, zones_count: row.zones_count, details: row.meta }))
  ], ['dataset', 'id', 'symbol', 'event_type', 'recorded_at', 'zones_count', 'details']);
  fs.writeFileSync(OUT_FILE, body, { encoding: 'utf8', flag: 'wx' });
  console.log(`[export] تم: ${caseRows.length} قراراً و${snapRows.length} لقطة → ${OUT_FILE}`);
}

main().catch((e) => {
  console.error('[export] فشل التصدير:', e?.message ?? e);
  process.exitCode = 1;
});
