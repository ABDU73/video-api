# Dockerfile.cron
FROM node:18-slim

# Install Chromium + dependencies for Puppeteer
RUN apt-get update && \
    apt-get install -y chromium libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libasound2 libpangocairo-1.0-0 libpango-1.0-0 libcups2 libatspi2.0-0 && \
    rm -rf /var/lib/apt/lists/*

# Tell Puppeteer where Chromium lives
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY package.json .
RUN npm install

COPY cron-refresh-cookies.js .

CMD ["node", "cron-refresh-cookies.js"]
