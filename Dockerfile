# siteio agent Docker image
# For container deployments (Kubernetes, Docker Compose, etc.)
# For bare metal, use: siteio agent install

FROM debian:bookworm-slim

# Install dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

# Install siteio
RUN curl -LsSf https://siteio.me/install | SITEIO_INSTALL_DIR=/usr/local/bin sh

# Create data directory
RUN mkdir -p /data

# Environment variables
ENV SITEIO_DATA_DIR=/data
ENV SITEIO_HTTP_PORT=80
ENV SITEIO_HTTPS_PORT=443

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Run agent directly (not via systemd)
ENTRYPOINT ["siteio", "agent", "start"]
