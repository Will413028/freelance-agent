# Shadow job for the Next.js migration (plan step 4e3). Reads the product SQLite file through a
# read-only mount; writes only its own copies and reports, and the D1 shadow (the one-time import).
FROM node:24-slim
RUN npm install -g pnpm@11.2.2
WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/drizzle ./drizzle
COPY web/src ./src
COPY web/scripts ./scripts
COPY web/tsconfig.json ./
RUN chmod -R a+rX /app
USER node
ENTRYPOINT ["sh", "scripts/shadow-job.sh"]
