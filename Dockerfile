FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js lotteryEngine.js geminiOcr.js seedData.js ./
COPY public ./public

RUN mkdir -p /app/data /app/public/uploads

ENV NODE_ENV=production
ENV PORT=3088

EXPOSE 3088

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3088/api/health || exit 1

CMD ["node", "server.js"]
