FROM node:18-slim

# Install Python, ffmpeg, curl (needed by yt-dlp)
RUN apt-get update && \
    apt-get install -y python3 ffmpeg curl && \
    rm -rf /var/lib/apt/lists/*

# Download yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

COPY . .

RUN npm install

EXPOSE 3000
CMD ["node", "server.js"]
