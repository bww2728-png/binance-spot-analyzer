# خطة تقوية الأمان (AUD-008)

**الحالة:** المرحلة 1 **مطبَّقة في الكود** (خامدة حتى يُضاف السر). المرحلة 2 **جاهزة كملف
ترحيل غير مطبَّق**. المرحلة 3 (مصادقة الواجهة) **مخطَّطة فقط**.
**السبب:** تطبيق المرحلتين 2 و3 يغيّر نموذج الثقة في الإنتاج ويحتاج ترحيلاً على قاعدة حية
وإجراءً تشغيلياً — وكلاهما خارج تفويض المهمة (§3.2 من التكليف). الكود والملفات وخطة
التراجع جاهزة، والتنفيذ يحتاج قرار مالك.

---

## 0) قبل أي تنفيذ: قِس الحالة الحية (إلزامي)

**المشكلة:** لا يوجد `migrations ledger` في المستودع، وأرقام ملفات الترحيل متعارضة
(`001` ×2، `002` ×2، `003` ×2). فحالة قاعدة الإنتاج **لا تُستنتج من الكود**، وأي ترحيل
يُكتب بلا قياس قد يفترض جداول أو سياسات غير موجودة (أو العكس).

**الأداة:** `docs/diagnostics/live-db-readonly-audit.sql` — استعلام واحد، **قراءة فقط**
(`SELECT` صرف، لا DDL/DML ولا أقفال حصرية)، يُنتج 7 صفوف JSON:

| القسم | ما يجيب عنه |
|---|---|
| `meta` | إصدار Postgres، حجم القاعدة، عدد الجداول/السياسات/الدوال، وجود أدوار Supabase |
| `roles` | هل `anon`/`authenticated`/`service_role` موجودة؟ `bypassrls`؟ |
| `tables` | لكل جدول: RLS مفعّل؟ عدد السياسات؟ ماذا يملك `anon` (SELECT/INSERT/UPDATE/DELETE)؟ `service_role`؟ الحجم والتقدير |
| `policies` | كل سياسة: الأمر، الأدوار، شرط `USING`، شرط `CHECK` |
| `functions_executable_by_public` | الدوال التي يرث الجميع تنفيذها عبر `PUBLIC` |
| `default_acl` | الامتيازات الافتراضية — هل جدول جديد يرث منحاً لـ`anon`؟ |
| `fingerprint` | وجود كل جدول يفترضه المستودع + هل `analyses.id` صار `by default` (أي أن `001_identity_by_default` نُفِّذ) |

**التشغيل:** Supabase Dashboard → SQL Editor → الصق الملف → Run → انسخ الناتج.
لا يحتوي الناتج أي مفتاح أو سر — أسماء وأرقام فقط.

**التحقق من الأداة نفسها:** شُغّلت على Postgres حقيقي (PGlite/WASM) في ثلاثة سيناريوهات:
قاعدة فارغة (لا جداول ولا أدوار) · قاعدة مهيّأة بسياسات `anon` مفتوحة ومنح كاملة · قاعدة
نُفِّذ عليها `001_identity_by_default`. في الثلاثة: لا رمي، الأقسام السبعة تُرجع، وعدد
الجداول/السياسات قبل = بعد (إثبات أنها للقراءة فقط).

**لا تُنفّذ `013b`/`014` قبل لصق هذا الناتج** — `014` نفسه يفشل مغلقاً لو كانت منح
`service_role` ناقصة، لكن معرفة الواقع أولاً توفّر محاولة فاشلة على الإنتاج.

---

## 1) الوضع الحالي — حقائق مُتحقَّق منها

| الحقيقة | الدليل |
|---|---|
| كل مسارات `/api` بلا مصادقة | لا وسيط تحقّق في `server/index.js`؛ لا `Authorization` في أي مسار |
| لا حدّ معدل على المدخلات | لا middleware لحد الطلبات (المحدد الموجود يخص نداءات Binance الصادرة) |
| كل جدول مفعّل عليه RLS لكن بسياسة `anon` كاملة | `server/migrations/000_full_schema.sql` — `create policy "<t>_all" ... to anon using (true) with check (true)` |
| الخادم يستخدم مفتاحاً عاماً واحداً للقراءة والكتابة (Anon أو `VITE_`) افتراضياً | `server/db.js` — `selectStorageKey()`: لا يستخدم `SERVICE_ROLE` إلا بإقرار `SUPABASE_SERVICE_ROLE_CONFIRMED=1` |
| `service_role` **بلا منح** على الجداول الأساسية | منح `service_role` في المستودع محصور بجداول المختبر (`007:84-88`, `008:31`, `012:68-74`) — لذلك يلزم `013b_grant_service_role.sql` قبل التفعيل |
| `liquidityWorkbench` يكتب بـ`anon` **بالعقد** | `server/db.js` → `restWorkbench` + `WORKBENCH_KEY`؛ و`tests/liquidityWorkbenchDb.test.mjs` يفرضه حتى مع وجود مفتاح خدمة |
| المتصفح لا يتصل بـSupabase مباشرة | `client/src/lib/api.ts` — `useSupabase = false`، وكل النداءات عبر Express |
| مفتاح `anon` غير موجود في المستودع | لا `supabase.co` ولا `eyJ...` في أي ملف مصدر |

### ما هو السطح المكشوف فعلياً؟

1. **واجهة API العامة** — 87 مساراً بلا مصادقة، منها كتابة وحذف (تحليلات، إعدادات،
   حالات، صور، تعديل مناطق). أي طرف يستطيع الوصول إلى العنوان يمكنه تغيير بيانات النظام.
2. **قاعدة البيانات عبر المفتاح** — لو تسرّب `anon` (أو ضُبط كـ`VITE_` في بناء الواجهة)
   فالتجاوز كامل: قراءة/كتابة/حذف على كل الجداول بلا المرور بالتطبيق.

الخطر الأول هو **الفعلي اليوم**. الثاني **مشروط بالتسريب**.

---

## 2) لماذا لا يُصلح بإصلاح واحد

تضييق RLS وحده **يكسر الخادم** (لأنه يكتب بمفتاح `anon`). وإضافة مصادقة وحده **لا تحمي
قاعدة البيانات** من تجاوز مباشر. لذلك الترتيب إلزامي: سرّ الخادم أولاً، ثم RLS، ثم
المصادقة على الواجهة.

---

## 3) المرحلة 1 — مفتاح الخادم (بلا كسر شيء) — ✅ **مطبَّقة في الكود / تحتاج 3 خطوات تشغيلية**

**الهدف:** فصل هوية الخادم عن هوية العميل.

**الترتيب إلزامي — لا تُقدّم خطوة على أخرى:**

| # | الخطوة | لماذا هذا الترتيب |
|---|---|---|
| 1 | نفّذ `server/migrations/013b_grant_service_role.sql` | المنح في هذا المشروع صريحة لا تلقائية (`011:1-2`)، و`service_role` بلا منح يُرجع 401/403 |
| 2 | اضبط `SUPABASE_SERVICE_ROLE_KEY` **و** `SUPABASE_SERVICE_ROLE_CONFIRMED=1` في بيئة الخادم | الكود لا يفعّل الهوية بمجرد وجود المفتاح — لتفادي انقطاع صامت |
| 3 | أعد النشر وتحقّق: `/readyz` → `checks.storage.serviceRole = true` | إثبات أن الهوية مُفعَّلة فعلاً |

1. أنشئ مفتاح `service_role` من لوحة Supabase (Project Settings → API).
2. اضبطه في بيئة الخادم فقط مع الإقرار. **لا قيم في `.env.example`** — يُذكر الاسم فقط، والقيمة تُدار في مدير أسرار المنصة.
3. **الكود جاهز** في `server/db.js`:

```js
export function selectPublicKey(env = process.env) {
  return env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
}
export function selectStorageKey(env = process.env) {
  const service = String(env.SUPABASE_SERVICE_ROLE_CONFIRMED ?? '') === '1'
    ? (env.SUPABASE_SERVICE_ROLE_KEY || '') : '';
  return service || selectPublicKey(env);
}
export function isUsingServiceRole(env = process.env) { /* إقرار + مفتاح + اختلاف الهوية */ }
```

   مُختبَر في `server/tests/storageKey.test.mjs` (12 حالة): بلا الإقرار **لا يتغيّر شيء
   إطلاقاً**، ومفتاح عام موضوع في متغيّرة الخدمة لا يُعتبر هوية خدمة.
4. تحقّق: `checks.storage.serviceRole` تصبح `true`، و`checks.storage.publicKey` تبقى `true`
   (مفتاح المختبر منفصل)، وسجل الإقلاع لا يطبع أي مفتاح.

**التراجع:** احذف `SUPABASE_SERVICE_ROLE_CONFIRMED` (وحده يكفي) وأعد النشر — يعود النظام
إلى المفتاح العام فوراً بلا تغيير كود. المنح المضافة في الخطوة 1 غير ضارة ويمكن إبقاؤها.

---

## 4) المرحلة 2 — تضييق RLS

**بعد** نجاح المرحلة 1 فقط. المبدأ (PostgreSQL 18 §5.9): عند تفعيل RLS بلا سياسة مطابقة
يكون المنع افتراضياً؛ والسياسات المتعددة تُجمع بـ`OR` إن كانت permissive وبـ`AND` إن كانت
restrictive.

### 4.1 الجداول التي يقرأها العميل عبر الخادم فقط

بما أن الواجهة لا تصل إلى Supabase مباشرة، **لا حاجة لأي صلاحية `anon` على أي جدول**.

> **الملف الجاهز:** `server/migrations/014_restrict_anon_privileges.sql` (معاملة واحدة،
> يشمل `alter default privileges` لمنع عودة الثقب عند إنشاء جدول جديد)، والتراجع في
> `014a_rollback_anon_privileges.sql`. **لم يُطبَّق** — التشغيل قرار مالك بعد المرحلة 1.
> المقتطف التالي هو شرحه المُختصر:

```sql
-- 1) إسقاط السياسات المفتوحة
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- 2) إلغاء صلاحيات anon على الجداول (تُمنح للـservice_role فقط)
--    ملاحظة: الملف الفعلي 014 يستثني جداول liquidity_workbench% لأن db.js يكتبها بـanon عقداً
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
-- 3) الدوال ترث EXECUTE من PUBLIC — السحب من anon وحده لا يغلق شيئاً
revoke execute on all routines in schema public from public;
```

> `service_role` يتجاوز RLS بحكم صلاحياته، فلا يحتاج سياسات.

### 4.2 ما يجب التحقق منه قبل التطبيق

- [ ] لا استدعاء `supabase.from(...)` من المتصفح في الإنتاج (`useSupabase === false`).
- [ ] لا سكربت خارجي (باك تيست/بريد) يستخدم `anon`.
- [ ] نسخة احتياطية من المخطط قبل التنفيذ (`pg_dump --schema-only`).

### 4.3 التحقق بعد التطبيق

```sql
select count(*) from pg_policies where schemaname = 'public';  -- المتوقع 0 (أو سياسات مقصودة فقط)
select has_table_privilege('anon', 'public.events_log', 'insert'); -- المتوقع false
```

ثم اختبار حي: `POST /api/symbols/sync` يجب أن ينجح (الخادم بمفتاحه)، ومحاولة كتابة
مباشرة بمفتاح `anon` يجب أن تُرفض بـ`401/403`.

**التراجع:** أعد إنشاء السياسات الأصلية من `000_full_schema.sql` وأعد المنح:

```sql
grant all on all tables in schema public to anon;
grant all on all sequences in schema public to anon;
```

---

## 5) المرحلة 3 — مصادقة الواجهة وحدّ المعدل

**الهدف:** منع أي طرف غير مصرّح من استدعاء المسارات المتغيّرة.

### الخيارات

| الخيار | التعقيد | يلائم | ملاحظات |
|---|---|---|---|
| رمز وصول واحد (`API_TOKEN`) في ترويسة | منخفض | نشر شخصي/فريق صغير | يجب أن يصل إلى الواجهة عبر `VITE_API_TOKEN` أو جلسة |
| جلسة موقّعة (cookie + HMAC) | متوسط | عدة مستخدمين | يحتاج صفحة دخول وإدارة انتهاء |
| مزوّد هوية (Supabase Auth / OIDC) | مرتفع | منتج متعدد المستخدمين | تكامل مع RLS عبر `auth.uid()` |

**التوصية:** ابدأ بالخيار الأول على المسارات غير الآمنة فقط (POST/PUT/PATCH/DELETE)،
مع إبقاء `GET` عاماً للقراءة، واستثناء `/healthz` و`/readyz`.

```js
// مقتطف توجيهي — غير مطبَّق
const token = process.env.API_TOKEN;
app.use('/api', (req, res, next) => {
  if (!token) return next();                       // معطّل افتراضياً
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const got = Buffer.from(String(req.get('x-api-token') ?? ''));
  const want = Buffer.from(token);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});
```

**تحذير ترتيب:** يجب تسجيل الوسيط **قبل** أي مسار، وأيضاً قبل
`/api/liquidity-workbench` (المثبَّت في `index.js`).

### حدّ المعدل

الحد الأدنى: 60 طلباً/دقيقة لكل IP على `/api`، مع تخفيف على مسارات القراءة الثقيلة
(`/api/live/history`, `/api/health/deep`). لا يُنصح بإضافة اعتمادية جديدة: عدّاد
`Map<ip, {count, resetAt}>` مع تنظيف دوري يكفي لهذا الحجم.

---

## 6) ترويسات وممارسات إضافية (منخفضة التكلفة)

- `Content-Security-Policy` صارم بعد التحقق من مصادر Vite/CDN (غير مطبَّق حالياً بقصد
  تجنّب كسر الواجهة).
- مراجعة المسارات التي تُرجع `e.message` في جسم الخطأ (مثل `/api/shadow/report`) لتفادي
  تسريب تفاصيل داخلية.
- تدوير `service_role` عند أي شك، وإبقاؤه في مدير أسرار لا في ملف `.env` محلي.

---

## 7) معايير الإغلاق

- [ ] `has_table_privilege('anon', <كل جدول>, 'insert'|'update'|'delete')` = false للجميع.
- [ ] الخادم يعمل بمفتاح `service_role` و`/readyz` = 200 بعد إعادة النشر.
- [ ] طلب كتابة بلا رمز يُرجع 401 (إن فُعّلت المرحلة 3).
- [ ] كل الاختبارات ناجحة (674) بعد كل مرحلة.
- [ ] لا انحدار في مسارات القراءة العامة.
