# The browser tier (plan step 8d): Crawlee with Playwright Chromium, the setup spikes.md §2 measured on
# the VM (arm64; Apify's own image has no arm64 build). Build context is browser/:
#   docker build -f deploy/browser.Dockerfile -t "$APP_IMAGE-browser" browser
# deploy.sh tags it after the app image, so a rollback of APP_IMAGE moves both.
FROM mcr.microsoft.com/playwright:v1.56.1-noble
ENV NODE_ENV=production
WORKDIR /app/browser
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.mjs render.mjs ./
USER pwuser
EXPOSE 3100
CMD ["node", "server.mjs"]
