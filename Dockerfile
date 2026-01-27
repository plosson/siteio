# Optional: Run siteio agent in a container
# Preferred deployment: install binary directly on host with `curl -LsSf https://siteio.me/install | sh`
#
# If using this Dockerfile, you must mount the Docker socket so siteio can manage the Traefik container:
#   docker run -v /var/run/docker.sock:/var/run/docker.sock -v /data:/data ...

FROM debian:bookworm-slim

# Install dependencies (curl for install script, docker-cli for managing Traefik container)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

# Install siteio from web installer
RUN curl -LsSf https://siteio.me/install | SITEIO_INSTALL_DIR=/usr/local/bin sh

# Create data directory
RUN mkdir -p /data

# Environment variables
ENV SITEIO_DATA_DIR=/data
ENV SITEIO_HTTP_PORT=80
ENV SITEIO_HTTPS_PORT=443
ENV SITEIO_MAX_UPLOAD_SIZE=50MB

# Health check (agent listens on port 3000 by default)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Run the agent
ENTRYPOINT ["siteio", "agent", "start"]
