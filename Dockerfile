# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
COPY package.json ./
COPY bun.lockb* ./

# Install dependencies
RUN bun install

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Production stage
FROM oven/bun:1-slim

# Install Traefik
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Download and install Traefik (supports amd64 and arm64)
ARG TRAEFIK_VERSION=v3.0.0
ARG TARGETARCH
RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") && \
    curl -L "https://github.com/traefik/traefik/releases/download/${TRAEFIK_VERSION}/traefik_${TRAEFIK_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin traefik \
    && chmod +x /usr/local/bin/traefik

WORKDIR /app

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./

# Create data directory
RUN mkdir -p /data

# Expose ports
EXPOSE 80 443

# Environment variables
ENV SITEIO_DATA_DIR=/data
ENV SITEIO_HTTP_PORT=80
ENV SITEIO_HTTPS_PORT=443
ENV SITEIO_MAX_UPLOAD_SIZE=50MB

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Run the agent
ENTRYPOINT ["bun", "run", "src/cli.ts", "agent", "start"]
