# Shadow copy/compare job for the Next.js migration (plan steps 4c/4d). Reads the product SQLite
# file through a read-only mount; writes only its own copies, reports and the Neon shadow branch.
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
