# ── Backend Dockerfile ─────────────────────────────────────────
FROM node:20-alpine AS base

# Install build tools for better-sqlite3 (native module)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install production deps
RUN npm ci --omit=dev

# Copy source
COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

# Expose API port
EXPOSE 3001

# Run migrations then start server
CMD ["sh", "-c", "node src/db/migrate.js && node src/index.js"]
