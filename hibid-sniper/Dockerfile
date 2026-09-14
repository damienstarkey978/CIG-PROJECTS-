# Pinned to match the Playwright version in package-lock.json so the
# preinstalled Chromium build is guaranteed compatible.
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV PORT=4310
EXPOSE 4310
CMD ["npm", "start"]
