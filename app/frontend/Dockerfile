# =============================================================================
# Pronghorn Frontend - Simple Dockerfile
# =============================================================================
# Production container - just copies pre-built dist into nginx
# Build the app locally first with: npm run build
# =============================================================================

FROM nginx:alpine

# Copy custom nginx config
COPY nginx.conf /etc/nginx/nginx.conf

# Copy pre-built dist folder
COPY dist/ /usr/share/nginx/html/

# Expose port
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:80/health || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
