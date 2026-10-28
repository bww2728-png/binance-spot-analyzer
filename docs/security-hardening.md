# خطة تقوية الأمان (AUD-008)

**الحالة:** خطة جاهزة للتنفيذ — **لم تُطبَّق** في هذا التدقيق.
**السبب:** التطبيق يحتاج سرّاً جديداً (`service_role`) وترحيلاً على قاعدة بيانات حية،
وكلاهما خارج تفويض المهمة (§3.2 من التكليف). تنفيذها يتطلب قرار مالك وإجراءً تشغيلياً
منفصلاً وقابلاً للتراجع.

---

## 1) الوضع الحالي — حقائق مُتحقَّق منها

| الحقيقة | الدليل |
|---|---|
| كل مسارات `/api` بلا مصادقة | لا وسيط تحقّق في `server/index.js`؛ لا `Authorization` في أي مسار |
| لا حدّ معدل على المدخلات | لا middleware لحد الطلبات (المحدد الموجود يخص نداءات Binance الصادرة) |
| كل جدول مفعّل عليه RLS لكن بسياسة `anon` كاملة | `server/migrations/000_full_schema.sql` — `create policy "<t>_all" ... to anon using (true) with check (true)` |
| الخادم يستخدم مفتاحاً واحداً للقراءة والكتابة (Anon أو `VITE_`) | `server/db.js` — `SUPABASE_KEY = process.env.SUPABASE_ANON_KEY \|\| process.env.VITE_SUPABASE_PUBLISHABLE_KEY \|\| ''` (لا `service_role`) |
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

## 3) المرحلة 1 — مفتاح الخادم (بلا كسر شيء)

**الهدف:** فصل هوية الخادم عن هوية العميل.

1. أنشئ مفتاح `service_role` من لوحة Supabase (Project Settings → API).
2. اضبطه في بيئة الخادم فقط: `SUPABASE_SERVICE_ROLE_KEY=...` (لا يُضاف إلى `.env.example`
   بقيمة، فقط اسم المتغيّر).
3. عدّل `server/db.js` ليُفضّله مع الاحتفاظ بالاحتياط:

```js
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  '';
export const usingServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
// storageConfigured() قائمة بالفعل وتقرأ SUPABASE_KEY — لا تحتاج تعديلاً بعد هذه الخطوة.
```

4. أعد النشر. **لا تغيير سلوكي**: السياسات الحالية تسمح للمفتاحين بالشيء نفسه.
5. تحقّق: `/readyz` تبقى 200، وسجل الإقلاع يبيّن أن الخادم يستخدم service role (رسالة
   واحدة بلا طباعة المفتاح).

**التراجع:** احذف المتغيّر وأعد النشر — النظام يعود إلى `anon` فوراً.

---

## 4) المرحلة 2 — تضييق RLS

**بعد** نجاح المرحلة 1 فقط. المبدأ (PostgreSQL 18 §5.9): عند تفعيل RLS بلا سياسة مطابقة
يكون المنع افتراضياً؛ والسياسات المتعددة تُجمع بـ`OR` إن كانت permissive وبـ`AND` إن كانت
restrictive.

### 4.1 الجداول التي يقرأها العميل عبر الخادم فقط

بما أن الواجهة لا تصل إلى Supabase مباشرة، **لا حاجة لأي صلاحية `anon` على أي جدول**.
الحد الأدنى الآمن:

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
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- 3) (اختياري) قراءة عامة محدودة إن أراد المالك لوحة قراءة بلا خادم
-- grant select on public.symbols, public.coin_shariah to anon;
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
- [ ] كل الاختبارات ناجحة (660) بعد كل مرحلة.
- [ ] لا انحدار في مسارات القراءة العامة.
