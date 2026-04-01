FROM node:18

# Install Python and pip
RUN apt-get update && apt-get install -y python3 python3-pip

# Install yt-dlp (bypass Debian's external‑managed protection)
RUN pip3 install yt-dlp --break-system-packages

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
