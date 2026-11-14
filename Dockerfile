# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund          # postinstall runs `prisma generate` into src/db/generated
COPY . .
RUN npx prisma generate && npm run build # tsc → dist/, copies grammars/prompts/rubric

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# Prisma's migrate engine (release_command) needs OpenSSL.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# Scripts must run here: they fetch Prisma's engines for `prisma migrate deploy`.
# (postinstall also regenerates the client into src/; the app uses the compiled copy in dist/.)
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
