# تركيب وتشغيل النظام على أي جهاز

هذا الملف يصف **الطريق الوحيد المقصود** لتشغيل النظام محلياً على أي جهاز متصلاً بمشروع
Supabase نفسه. يُكمل `README.md` (الذي يصف الميزات) ولا يغيّر أي منطق.

> **ملاحظة مهمة عن السرية:** المستودع عام. مفتاح `service_role` (الشكل `sb_secret_...`)
> يمنح وصولاً كاملاً لكل بيانات القاعدة، ودفعه إلى المستودع يعني أن أي شخص يستطيع محو
> قاعدة بياناتك. لذلك يعيش **محلياً في `.env` فقط** (مُستثنى في `.gitignore`)، والمستودع
> يحمل هذا الدليل والسكربت الذي يولّد الملف على كل جهاز.

---

## 1) ما يحتاجه الجهاز

| المتطلب | السبب |
|---|---|
| Node.js **22.9+** (مُجرَّب على 24.18) | سكربتات التشغيل تستخدم `--env-file-if-exists` |
| Git | جلب المستودع |
| اتصال إنترنت | بينانس (بيانات السوق) + Supabase (التخزين) |

---

## 2) تركيب على جهاز جديد (4 أوامر)

```powershell
git clone https://github.com/bww2728-png/binance-spot-analyzer.git
cd binance-spot-analyzer
npm install
npm run build                  # يبني الواجهة إلى client/dist + يثبّت تبعيات الخادم
```

ثم اكتب ملف البيئة — إما تفاعلياً (السطر السري لا يظهر على الشاشة):

```powershell
npm run env:init
```

أو بتمرير القيم مباشرة:

```powershell
npm run env:init -- --url https://<ref>.supabase.co --publishable sb_publishable_... --secret sb_secret_...
```

القيم الثلاث من: Supabase ← Settings ← **API Keys** (وليس من صفحة JWT).

ثم:

```powershell
npm start
```

افتح <http://localhost:8787>.

### ماذا يكتب `env:init`؟

| المتغير | المعنى |
|---|---|
| `SUPABASE_URL` | عنوان المشروع `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | مفتاح النشر العام (Publishable) — يستخدمه **مختبر السيولة** بعقد موثّق في `010`/`013` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | نفس المفتاح، باسم تقرأه الواجهة |
| `SUPABASE_SERVICE_ROLE_KEY` | المفتاح السري (Secret) — كل الجداول الأساسية بعد ترحيل التضييق `014` |
| `SUPABASE_SERVICE_ROLE_CONFIRMED=1` | إقرار صريح إلزامي؛ بدونه لا يفعّل الكود هوية الخدمة إطلاقاً |

للتحقق بلا كشف أي قيمة: `npm run env:init -- --check`.

---

## 3) تركيب قاعدة البيانات (مرة واحدة لكل مشروع Supabase)

المخطط موزّع على ترحيلات متعددة، وتوليدها بترتيبها اليدوي عرضة للخطأ. لذلك يوجد ملف
واحد مُولَّد:

```powershell
npm run db:bundle      # يعيد توليد server/migrations/fresh-install.sql
```

**التنفيذ:** Supabase Dashboard ← SQL Editor ← New query ← الصق كامل
`server/migrations/fresh-install.sql` ← **Run**.

الملف يضم 12 ترحيلاً بالترتيب:

```
000_full_schema → 001_identity_by_default → 002_health_samples →
007..013 (مختبر السيولة) → 013b (منح service_role) → 014 (تضييق anon)
```

وهو **idempotent**: إعادة لصقه لا تُفسد شيئاً (`create table if not exists`، ومنح متكررة).

### لماذا `013b` قبل `014`؟

`014` يسحب صلاحيات `anon` من الجداول الأساسية. لو نُفِّذ قبل `013b` يصبح الخادم بلا أي
مسار للقراءة/الكتابة. `014` نفسه يحتوي حاجزاً يمنع ذلك: يتوقف إن كان `service_role` بلا منح.
جداول `liquidity_workbench_*` **مستثناة** عمداً وتبقى على `anon` بعقد موثّق.

---

## 4) التحقق بعد التركيب

```powershell
# جاهزية الخادم: 200 = سليم (503 = تخزين غير مهيأ أو جدول ناقص)
Invoke-WebRequest http://localhost:8787/readyz -UseBasicParsing

# يجب أن يعيد صفاً واحداً (يُنشأ تلقائياً عند أول طلب)
Invoke-WebRequest http://localhost:8787/api/settings -UseBasicParsing
```

ومن SQL Editor:

```sql
select count(*) from pg_tables where schemaname = 'public';                    -- 16
select has_table_privilege('anon','public.events_log','insert');               -- false
select has_table_privilege('service_role','public.events_log','insert');       -- true
select has_table_privilege('anon','public.liquidity_workbench_candles','insert'); -- true
```

---

## 5) أعطال شائعة ومعناها

| العرض | السبب | الحل |
|---|---|---|
| `Failed to parse URL from /rest/v1/...` | `.env` غير محمّل أو `SUPABASE_URL` فارغ | تأكد أن التشغيل عبر `npm start` (يحمل `--env-file-if-exists=.env`)، ثم `npm run env:init -- --check` |
| `PGRST205 Could not find the table 'public.x'` | المخطط غير مُطبَّق في هذا المشروع | نفّذ `fresh-install.sql` |
| `permission denied for table x` والمفتاح السري مضبوط | `SUPABASE_SERVICE_ROLE_CONFIRMED` غير مضبوط على `1` | أضفه في `.env` وأعد التشغيل |
| `/readyz` = 503 مع رسالة `storage_unconfigured` | `SUPABASE_URL` أو مفتاح ناقص | `npm run env:init` |
| الواجهة تفتح لكن `client/dist/index.html` غير موجود | لم يُبنَ بعد | `npm run build` |

---

## 6) الأمان

- `.env` **مُستثنى** في `.gitignore`، والسكربت يرفض الكتابة إن لم يكن كذلك.
- بعد أي تسريب عرضي للمفتاح السري: Supabase ← Settings ← API Keys ← **Rotate** للمفتاح،
  ثم حدّث `.env` على كل جهاز.
- `013b`/`014` غير مُطبَّقين على مشاريع قديمة؛ نفّذهما فقط بعد التأكد من مضبوطية
  المفتاح السري، وإلا توقف الحفظ بلا إشارة في `/readyz`.