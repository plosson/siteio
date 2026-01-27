# Skill: Deploy Static Sites with siteio

Use this skill when the user asks to deploy a static site, website, HTML files, or web application to a URL.

## Installation

```sh
curl -LsSf https://siteio.me/install | sh
```

## Setup

Before deploying, the user needs to login with a connection token. If they don't have one, ask them to get it from their siteio administrator.

```sh
siteio login -t <token>
```

The token is provided by the siteio agent administrator and contains the API URL and key.

## Prerequisites

1. siteio must be installed (see above)
2. User must be logged in with a valid token
3. The site must be a folder containing static files (HTML, CSS, JS, images, etc.)

## Deploying a Site

```sh
siteio sites deploy <folder> [-s <subdomain>]
```

- `<folder>`: Path to the folder containing the static site
- `-s, --subdomain <name>`: Optional subdomain (defaults to folder name)

### Examples

```sh
# Deploy ./dist folder as "myapp"
siteio sites deploy ./dist -s myapp

# Deploy current directory using folder name as subdomain
siteio sites deploy .

# Deploy a specific folder
siteio sites deploy ./build -s dashboard
```

## Other Commands

```sh
# List all deployed sites
siteio sites list

# Remove a deployed site
siteio sites undeploy <subdomain>
```

## Workflow

1. Build the static site if needed (e.g., `npm run build`)
2. Deploy with `siteio sites deploy <build-folder> -s <subdomain>`
3. Access at `https://<subdomain>.<domain>`

## Notes

- Sites are served over HTTPS with automatic Let's Encrypt certificates
- Deploying to the same subdomain replaces the existing site
- The subdomain must be lowercase alphanumeric (hyphens allowed)
- Maximum upload size is typically 50MB
