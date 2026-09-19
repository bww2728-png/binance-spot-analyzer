# مرحلة بناء الواجهة
FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# المرحلة النهائية
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# نسخ كامل مجلد الخادم (index/db/research/cases/archive/liquidity/...)
# مهم: أي ملف جديد يضاف إلى server/ يُلتقط تلقائياً — القوائم الجزئية كانت تُسقط ملفات وتُسقط العقدة
COPY server/ /app/server/
RUN cd /app/server && npm ci --omit=dev
COPY --from=client-build /app/client/dist ./client/dist

EXPOSE 8080

# منفذ حتمي يطابق EXPOSE (Railway/المنصات توجّه إلى 8080)
ENV PORT=8080

CMD ["node", "server/index.js"]
