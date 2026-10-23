FROM node:24-slim AS build
RUN npm install -g pnpm@11.2.2
WORKDIR /app/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
COPY frontend/tools ./tools
RUN pnpm install --frozen-lockfile
COPY frontend .
COPY contracts /app/contracts
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm run build && chmod -R a+rX /app
USER node
CMD ["pnpm", "exec", "next", "start", "--hostname", "0.0.0.0", "--port", "3327"]
