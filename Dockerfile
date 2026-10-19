# مرحلة بناء الواجهة
FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
# الوحدة المشتركة (منطق التصنيف الشرعي) تقرأها الواجهة من خارج مجلدها
COPY shared/ /app/shared/
COPY client/ ./
RUN npm run build

# المرحلة النهائية
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# سقف heap صريح: بدونه يتضخّم الـ heap حتى حد الحاوية فيُقتل الخادم بـOOM بلا سبب ظاهر.
# قياس على التشغيل الحقيقي: الـ heap بلغ 512MB مع الشموع المخزّنة كنصوص (237K شمعة)،
# وكان السقف السابق 460MB أي أن الخادم كان يُقتل عند أول حمل حقيقي.
# بعد تخزين الشموع كأرقام وإزاحة الفحص الثقيل إلى worker صارت الذاكرة مستقرة
# (heapUsed 118–187MB). لكن القيمة 900 كانت تفوق 88% من حدّ الحاوية المنشورة فعلاً
# (1024MB، مقيسة من memory.max داخل النشر)، فيقتل الـcgroup العملية قبل أن يضغط V8
# نفسه — وهو نمط الانهيار التاريخي. 640 يترك ~380MB لغير الـheap.
ENV NODE_OPTIONS=--max-old-space-size=640

# نسخ كامل مجلد الخادم (index/db/research/cases/archive/liquidity/...)
# مهم: أي ملف جديد يضاف إلى server/ يُلتقط تلقائياً — القوائم الجزئية كانت تُسقط ملفات وتُسقط العقدة
COPY server/ /app/server/
RUN cd /app/server && npm ci --omit=dev
# الوحدة المشتركة: يستوردها الخادم لحساب الحكم الشرعي بلا متصفح
COPY shared/ /app/shared/
COPY --from=client-build /app/client/dist ./client/dist

EXPOSE 8080

# منفذ حتمي يطابق EXPOSE (Railway/المنصات توجّه إلى 8080)
ENV PORT=8080

CMD ["node", "server/index.js"]
