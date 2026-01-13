# ===== BUILD STAGE =====
FROM node:20-alpine AS builder

WORKDIR /app

# Install system dependencies required for native module compilation (sqlite3)
RUN apk add --no-cache python3 make g++

# Copy package manifests to install dependencies
COPY package*.json ./

# Install all dependencies (including devDependencies) using npm
RUN npm ci

# Copy source code and build the application
COPY src/ ./src/
COPY tsconfig.json ./

# Increase Node.js heap size for TypeScript compilation
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN npm run build

# Remove devDependencies to reduce image size
RUN npm prune --omit=dev


# ===== PRODUCTION STAGE =====
FROM node:20-alpine AS production

WORKDIR /app

# Install timezone data for proper TZ support
RUN apk add --no-cache tzdata

# Create a dedicated non-root user for security
RUN addgroup -g 1001 -S appgroup \
 && adduser -u 1001 -S appuser -G appgroup

# Copy only production artifacts from the builder stage
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/dist ./dist/
COPY package.json ./

# Create a directory for persistent data and secure file permissions
RUN mkdir -p /data \
 && chown -R appuser:appgroup /data /app \
 && chmod -R go-w /app

# Switch to non-root user
USER appuser

# Expose the application port
EXPOSE 8080

# Define a lightweight health check that verifies the /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start the application using npm
ENTRYPOINT ["npm", "start"]
