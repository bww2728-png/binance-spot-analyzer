# دليل النشر الشامل — Binance Spot Analyzer

تطبيق ويب لتحليل العملات الرقمية السبوت في بينانس: أعمدة إدخال أفقية وفق الاستراتيجية، ترتيب تلقائي، شارتات مصغرة حقيقية، تصنيف شرعي آلي بالأدلة، تحديث دوري للقائمة عبر WebSocket، فلتر "سبوت حلال فقط" قطعي.

> **التدفق الجديد (إعادة التشكيل):** إدراج أي عملة يتم عبر **تقرير فحص ثم تأكيد المستخدم**:
> 1) التحقق أنه زوج سبوت متداول — 2) حكم المحرك الشرعي مع الأسباب والأدلة — 3) اقتراح الاتجاهين آلياً
> (قابل للتعديل). المحرّم الموثق يُقفل إدراجه، وغير الموثق يُدرج بوسم برتقالي «قيد التوثيق» — لا يُغفل أي عملة.
> أزرار «حلال/باركود» اليدوية أزيلت كلياً؛ حكم المحرك هو المرجع، ووسم «باركود» أصبح تحذيراً على الشارت
> (رسالة + زر «فهمت») بلا أي استبعاد. تحوّل حكم عملة متابَعة إلى «حرام» يولّد تنبيهاً مع اقتراح إزالة بضغطة واحدة.
> ترحيل التنظيف: `server/migrations/003_cleanup_manual_flags.sql`.

- **الواجهة**: React 19 + Vite + TypeScript + Zustand (`client/`)
- **الخادم**: Node 22 + Express 5 + WebSocket (`server/`)
- **قاعدة البيانات**: Supabase (PostgreSQL) — القيم الافتراضية مدمجة في `server/db.js`
- **المنفذ**: الخادم يستمع على `process.env.PORT || 8787` — الحاوية تضبط `PORT=8080`

---

## 1) متطلبات التشغيل

- Node.js 22 (البناء والاختبارات)
- npm (استخدام `npm ci` مع الـ lockfiles المرفقة)

## 2) التشغيل المحلي

```bash
npm ci
cd client && npm ci
npm run build        # يبني العميل إلى client/dist
npm run server       # يشغّل الخادم (أو: npm run dev للتطوير المتزامن)
npm test             # 20 اختباراً
```

ثم افتح `http://localhost:8787` (الخادم يخدم العميل المبني).

## 3) التشغيل عبر Docker (أي منصة)

```bash
docker build -t binance-spot-analyzer .
docker run -p 8080:8080 binance-spot-analyzer
```

الـ Dockerfile متعدد المراحل: يبني العميل ثم يشغّل الخادم على 8080 (`EXPOSE 8080` + `ENV PORT=8080`).

## 4) النشر على Railway

### الطريقة أ — Account Token (لمشروع جديد)

1. تثبيت CLI: `npm i -g @railway/cli`
2. إنشاء Account Token: railway.com ← صورة الحساب ← **Account Settings** ← **API Tokens** ← Create
3. التنفيذ:
```bash
set RAILWAY_API_TOKEN=<account-token>
railway init --name binance-spot-analyzer
railway up
```
4. توليد نطاق علني: `railway domain` (أو من لوحة Railway ← Settings ← Networking ← Generate Domain)

### الطريقة ب — Project Token (مشروع قائم)

1. من لوحة المشروع: Settings ← **Generate Token** (Project Token)
2. التنفيذ:
```bash
set RAILWAY_TOKEN=<project-token>
railway up
```

> ملاحظات: Railway يدعم WebSocket. لا توجد متغيرات بيئة مطلوبة (الافتراضيات مدمجة في `server/db.js`)؛ لضبطها: `railway variables --set "KEY=value"`.

## 5) رفع الكود إلى GitHub

```bash
git init && git add . && git commit -m "initial deployment snapshot"
git remote add origin https://github.com/<user>/binance-spot-analyzer.git
git push -u origin main
```

`.gitignore` يستثني `node_modules/ dist/ .env *.db client/dist/` — لا تُرفع أسرار أو مخرجات بناء.

## 6) قاعدة البيانات (Supabase)

المخطط الكامل موجود في `server/migrations/` و`.verdent/supabase/migrations/`:
جداول: `analyses`, `symbols`, `coin_flags`, `coin_shariah`, `settings`, `events_log`, `cases`, `case_images` (RLS مفعّل).

## 7) التحقق بعد النشر

| الفحص | المسار/الأمر |
| --- | --- |
| الصفحة | `GET /` |
| حالة القائمة | `GET /api/symbols/meta` (عدّاد الأصول + `last_updated`) |
| مزامنة يدوية | `POST /api/symbols/sync` |
| WebSocket | الاتصال بـ `wss(s)://<host>/ws` ← رسالة `hello` |
| التصنيف الشرعي | `GET /api/shariah` |

## 8) أمان (مهم)

- `.env.example` في هذه الحزمة **منقّى** (قيم placeholder)؛ القيم الفعلية افتراضيات مدمجة في `server/db.js` وتظهر في التطبيق العلني أصلًا.
- **أنصح بمراجعة سياسات RLS** لأنها تمنح anon وصولاً كاملاً — قرار الصلاحيات مسؤولية مالك القاعدة.
- لا تضع أي مفتاح GitHub/Railway داخل ملفات المشروع.
