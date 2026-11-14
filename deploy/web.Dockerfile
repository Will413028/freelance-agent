# The application image (plan step 2): the whole web/ with node_modules and tsx, built on the VM from
# a git checkout. Build context is web/:  docker build -f deploy/web.Dockerfile -t "$APP_IMAGE" web
# It holds no credentials; DATABASE_URL and the rest arrive at run time from the compose env file.
FROM node:24.22.3-bookworm-slim
ENV NEXT_TELEMETRY_DISABLED=1 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app/web
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && chown -R node:node /app/web/.next
USER node
EXPOSE 3000
# The web service; the daily service and one-off commands override it with `pnpm exec tsx scripts/<name>.ts`.
CMD ["pnpm", "exec", "next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
