# =============================================================================
# Pronghorn API - Multi-stage Dockerfile
# =============================================================================
# Production-optimized container for Azure Container Apps
# =============================================================================

# Stage 1: Dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Stage 2: Production
FROM node:20-alpine AS production
WORKDIR /app

# Security: Create non-root user
RUN addgroup -S nodejs && \
  adduser -S -G nodejs nodeuser

# Copy production dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy compiled application
COPY dist/ ./dist/
COPY package.json ./

# Copy database migration files
COPY migrations/ ./migrations/

# Set ownership
RUN chown -R nodeuser:nodejs /app

# Switch to non-root user
USER nodeuser

# Environment variables (defaults, can be overridden)
ENV NODE_ENV=production
ENV PORT=8080

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start the application
CMD ["node", "dist/index.js"]
