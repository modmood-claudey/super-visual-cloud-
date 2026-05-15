FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY server/package*.json ./server/

# Install dependencies
RUN cd server && npm install --production

# Copy all server files
COPY server/ ./server/
COPY Procfile .
COPY .railway.toml .

EXPOSE 3000

CMD ["node", "server/index.js"]
