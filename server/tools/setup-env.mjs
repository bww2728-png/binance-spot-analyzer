/**
 * تهيئة `.env` لأي جهاز — بلا طباعة أي قيمة سرية.
 *
 * سبب الوجود: النظام يحتاج ثلاثة قيم من Supabase، و`service_role` مفتاح خطير لا يجوز
 * دفعه إلى المستودع. هذا السكربت هو الطريق الوحيد المقصود لتوليد `.env` على جهاز جديد:
 *
 *   npm run env:init -- --url https://<ref>.supabase.co \
 *                      --publishable sb_publishable_... \
 *                      --secret sb_secret_...
 *
 * أو بلا وسائط فيسأل تفاعلياً (والسطر السري يُكتب بلا صدى على الشاشة).
 * أو من البيئة مباشرة: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.
 *
 * السلوك:
 *  - لا يستبدل `.env` الموجود إلا بـ`--force`؛ بدونه يحدّث المفاتيح الخمسة فقط ويُبقي بقية الأسطر.
 *  - `.env` مُستثنى في `.gitignore` — ويتحقق من ذلك ويرفض المتابعة إن لم يكن كذلك.
 *  - يتحقق من شكل URL ومن بادئة كل مفتاح، ويطبع ملخّصاً بالبادئة والطول فقط.
 *
 * `--check`: يعرض حالة `.env` الحالية (المفاتيح المضبوطة/الناقصة) بلا قيم.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envPath = path.join(repoRoot, '.env');
const gitignorePath = path.join(repoRoot, '.gitignore');

export const KEYS = Object.freeze([
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_ROLE_CONFIRMED',
  'LIGHT_MODE'
]);

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
};

/** يقرأ الملف إن وُجد ويرجع خريطة المفاتيح + قائمة الأسطر غير المعروفة (لحفظها). */
export function parseEnvFile(text) {
  const map = new Map();
  const other = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) map.set(m[1], m[2]);
    else other.push(raw);
  }
  return { map, other };
}

/** يتحقق من شكل المدخلات ويرجع قائمة أخطاء عربية (فارغة = سليم). */
export function validate({ url, publishable, secret }) {
  const errors = [];
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url.replace(/\/+$/, ''))) {
    errors.push('SUPABASE_URL يجب أن يكون https://<project-ref>.supabase.co');
  }
  if (!publishable.startsWith('sb_publishable_') && !/^ey[A-Za-z0-9._-]{20,}$/.test(publishable)) {
    errors.push('مفتاح anon/publishable يجب أن يبدأ بـ sb_publishable_ (أو JWT قديم eyJ...)');
  }
  if (!secret.startsWith('sb_secret_') && !/^ey[A-Za-z0-9._-]{20,}$/.test(secret)) {
    errors.push('المفتاح السري يجب أن يبدأ بـ sb_secret_ (أو JWT قديم eyJ...)');
  }
  if (publishable && secret && publishable === secret) errors.push('المفتاحان متطابقان — تأكد أنهما مختلفان');
  return errors;
}

/** يبني نص `.env` النهائي: يحفظ الأسطر الأخرى ويُحدّث مفاتيح KEYS. */
export function buildEnvText(existingText, values) {
  const { map, other } = parseEnvFile(existingText);
  for (const [k, v] of Object.entries(values)) if (v) map.set(k, v);
  const header = [
    '# توليد آلي بـ `npm run env:init` — لا يُدفع إلى Git (مُستثنى في .gitignore).',
    '# المفاتيح السرية هنا محلية فقط؛ أي جهاز جديد يحتاج تشغيل `npm run env:init` مرة واحدة.'
  ].join('\n');
  const known = [...map.entries()].map(([k, v]) => `${k}=${v}`);
  const rest = other.map((l) => l).filter((l) => l.trim() !== '' && !l.startsWith('# توليد آلي') && !l.startsWith('# المفاتيح السرية'));
  // نُبقي تعليقات المستخدم: نحوّل أسطر التعليق القديمة كما هي في النهاية.
  const body = [...known, ...rest.filter((l) => l.startsWith('#'))].join('\n');
  return `${header}\n${body}\n`;
}

/** ملخّص بلا قيمة: البادئة + الطول فقط. */
const describe = (v) => (v ? `${v.slice(0, 14)}… (len=${v.length})` : '(فارغ)');

function askHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        if (c === '\u0003') process.exit(130); // Ctrl+C
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function askVisible(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    const onData = (ch) => {
      const s = String(ch);
      if (s.includes('\n')) {
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(s.split('\n')[0].trim());
      }
    };
    process.stdin.on('data', onData);
  });
}

const check = () => {
  const exists = fs.existsSync(envPath);
  console.log(`.env موجود: ${exists}`);
  if (!exists) return 0;
  const { map } = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_CONFIRMED'];
  let missing = 0;
  for (const k of required) {
    const ok = Boolean(map.get(k));
    if (!ok) missing += 1;
    console.log(`${k.padEnd(32)} ${ok ? 'مضبوط' : 'ناقص'}  ${ok && k === 'SUPABASE_SERVICE_ROLE_CONFIRMED' ? `(${map.get(k)})` : ''}`);
  }
  const ignored = fs.readFileSync(gitignorePath, 'utf8').split(/\r?\n/).map((l) => l.trim()).includes('.env');
  console.log(`.gitignore يشمل .env: ${ignored}`);
  return missing === 0 && ignored ? 0 : 1;
};

const main = async () => {
  if (has('--check')) process.exit(check());

  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const { map: cur } = parseEnvFile(existing);

  let url = valueOf('--url') || process.env.SUPABASE_URL || cur.get('SUPABASE_URL') || '';
  let publishable = valueOf('--publishable') || process.env.SUPABASE_ANON_KEY || cur.get('SUPABASE_ANON_KEY') || '';
  let secret = valueOf('--secret') || process.env.SUPABASE_SERVICE_ROLE_KEY || cur.get('SUPABASE_SERVICE_ROLE_KEY') || '';

  const interactive = !valueOf('--url') && !process.env.SUPABASE_URL
    && !valueOf('--publishable') && !process.env.SUPABASE_ANON_KEY;

  if (interactive) {
    console.log('أدخل قيم مشروع Supabase (تُقرأ من Supabase ← Settings ← API Keys):');
    url = await askVisible(`Project URL${url ? ` [${url}]` : ''}: `) || url;
    publishable = await askVisible(`Publishable key${publishable ? ' [مضبوط مسبقاً]' : ''}: `) || publishable;
    secret = await askHidden('Secret key (لن يظهر على الشاشة): ') || secret;
  }

  url = url.replace(/\/+$/, '');
  const errors = validate({ url, publishable, secret });
  if (errors.length) {
    console.error('مدخلات غير صالحة:');
    for (const e of errors) console.error(` - ${e}`);
    process.exit(1);
  }

  if (!fs.readFileSync(gitignorePath, 'utf8').split(/\r?\n/).map((l) => l.trim()).includes('.env')) {
    console.error('يرفض السكربت الكتابة: `.env` غير مُستثنى في .gitignore.');
    process.exit(1);
  }

  if (existing && !has('--force') && !interactive) {
    console.log('‏.env موجود — يُحدَّث بالمفاتيح الخمسة فقط ويُبقي بقية الأسطر (استخدم --force لإعادة الكتابة كاملة).');
  }

  const text = buildEnvText(existing, {
    SUPABASE_URL: url,
    SUPABASE_ANON_KEY: publishable,
    VITE_SUPABASE_PUBLISHABLE_KEY: publishable,
    SUPABASE_SERVICE_ROLE_KEY: secret,
    SUPABASE_SERVICE_ROLE_CONFIRMED: '1',
    ...(cur.get('LIGHT_MODE') ? { LIGHT_MODE: cur.get('LIGHT_MODE') } : {})
  });

  fs.writeFileSync(envPath, text, 'utf8');
  console.log(`كُتب ${path.relative(repoRoot, envPath)}:`);
  console.log(`  SUPABASE_URL                 ${url}`);
  console.log(`  SUPABASE_ANON_KEY            ${describe(publishable)}`);
  console.log(`  SUPABASE_SERVICE_ROLE_KEY    ${describe(secret)}`);
  console.log('الخطوة التالية: تأكّد أن مخطط القاعدة مُطبَّق (server/migrations/fresh-install.sql)، ثم npm start');
};

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
