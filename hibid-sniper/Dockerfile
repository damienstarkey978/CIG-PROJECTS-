# Build stage: just needs Node + TypeScript, no browser.
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: Microsoft's Playwright image ships a matching Chromium
# already baked in for the pinned playwright version below — we never run
# `playwright install` here, which is what caused the chromium revision
# mismatch (chromium_headless_shell-1243 not found) in the earlier build.
# PLAYWRIGHT_BROWSERS_PATH points at where this base image actually keeps
# its preinstalled browsers.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PORT=8080

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY public ./public

EXPOSE 8080
CMD ["node", "dist/server.js"]
