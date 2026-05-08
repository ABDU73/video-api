FROM node:18

# Install Python, pip, Chromium dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    chromium \
    libatk-bridge2.0-0 \
    libnss3 \
    libnspr4 \
    libdrm2 \
    libgbm1 \
    libasound2 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libpango-1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libatspi2.0-0 \
    --no-install-recommends

# Install yt-dlp
RUN pip3 install yt-dlp --break-system-packages

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
