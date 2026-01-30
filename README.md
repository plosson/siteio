# siteio

A self-hosted deployment platform for static websites and Docker containers with automatic HTTPS via Traefik.

## Installation

```bash
# Using npm
npm install -g siteio

# Or download binary from releases
```

## Quick Start

Configure your client to connect to the siteio agent server:

```bash
siteio login --api-url https://api.yourdomain.com --api-key your-api-key
```

Or use a connection token:

```bash
siteio login --token <connection-token>
```

---

## Static Site Examples

### Example 1: Deploy a Public Static Site

Deploy a folder as a public website:

```bash
siteio sites deploy ./my-website --subdomain blog
```

This deploys your static files to `https://blog.yourdomain.com`.

### Example 2: Deploy a Protected Static Site with OAuth

Deploy a site that requires Google authentication, restricted to specific users:

```bash
siteio sites deploy ./internal-docs --subdomain docs --allowed-emails "alice@company.com,bob@company.com"
```

Or restrict access to an entire domain:

```bash
siteio sites deploy ./team-portal --subdomain portal --allowed-domain company.com
```

---

## Docker Container Examples

### Example 1: Simple Nginx Web Server

Deploy a basic Nginx container:

```bash
# Create the app
siteio apps create mysite --image nginx:alpine --port 80

# Deploy it
siteio apps deploy mysite
```

Available at `https://mysite.yourdomain.com`.

### Example 2: Deploy from Git Repository

Build and deploy directly from a Git repository:

```bash
# Create app from GitHub repo
siteio apps create myapi --git https://github.com/user/myapi --port 3000

# Deploy (clones repo, builds image, runs container)
siteio apps deploy myapi
```

With custom options:

```bash
# Specify branch and Dockerfile
siteio apps create myapi --git https://github.com/user/myapi \
  --branch develop \
  --dockerfile Dockerfile.prod \
  --port 3000

# Force rebuild without Docker cache
siteio apps deploy myapi --no-cache
```

### Example 3: Monorepo Deployment

Deploy a service from a monorepo by specifying the build context:

```bash
# Deploy backend service from monorepo
siteio apps create backend --git https://github.com/user/monorepo \
  --context services/backend \
  --dockerfile Dockerfile \
  --port 8080

siteio apps deploy backend
```

### Example 4: Node.js API with Environment Variables

Deploy a Node.js application with configuration:

```bash
# Create the app
siteio apps create nodeapi --image node:20-alpine --port 3000

# Configure environment variables
siteio apps set nodeapi \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgres://user:pass@db.example.com:5432/mydb" \
  -e JWT_SECRET="your-secret-key"

# Set restart policy
siteio apps set nodeapi -r unless-stopped

# Deploy
siteio apps deploy nodeapi
```

### Example 5: PostgreSQL Database with Persistent Storage

Deploy PostgreSQL with a persistent volume:

```bash
# Create the app
siteio apps create postgres --image postgres:16-alpine --port 5432

# Configure with environment and volume
siteio apps set postgres \
  -e POSTGRES_USER=myuser \
  -e POSTGRES_PASSWORD=mysecretpassword \
  -e POSTGRES_DB=myapp \
  -v pgdata:/var/lib/postgresql/data \
  -r always

# Deploy
siteio apps deploy postgres
```

### Example 6: Redis Cache with Custom Domain

Deploy Redis with a custom domain:

```bash
# Create the app
siteio apps create redis --image redis:7-alpine --port 6379

# Configure volume and custom domain
siteio apps set redis \
  -v redis-data:/data \
  -d cache.example.com \
  -r unless-stopped

# Deploy
siteio apps deploy redis
```

### Example 7: Full-Stack Application (Multiple Services)

Deploy a complete application stack:

```bash
# Backend API
siteio apps create backend --image myregistry/backend:latest --port 8080
siteio apps set backend \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgres://user:pass@postgres.yourdomain.com:5432/app" \
  -e REDIS_URL="redis://redis.yourdomain.com:6379" \
  -v uploads:/app/uploads \
  -d api.example.com \
  -r unless-stopped
siteio apps deploy backend

# Background worker
siteio apps create worker --image myregistry/worker:latest --port 9000
siteio apps set worker \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgres://user:pass@postgres.yourdomain.com:5432/app" \
  -e REDIS_URL="redis://redis.yourdomain.com:6379" \
  -r unless-stopped
siteio apps deploy worker
```

---

## Common Commands

```bash
# List all sites
siteio sites list

# List all apps
siteio apps list

# View app logs
siteio apps logs myapp --tail 100

# Stop an app
siteio apps stop myapp

# Restart an app
siteio apps restart myapp

# Remove an app
siteio apps rm myapp

# Undeploy a site
siteio sites undeploy mysite
```

## JSON Output

All commands support `--json` for scripting:

```bash
siteio --json sites list
siteio --json apps info myapp
```
