# Skill: Deploy Static Sites with siteio

Use this skill when the user asks to deploy a static site, website, or HTML files to a URL.

## IMPORTANT

- **siteio deploys STATIC websites only** - HTML, CSS, JS, images, fonts, etc.
- **NOT for backends, APIs, or server-side applications** - no Node.js, Python, PHP, databases, etc.
- **You deploy a FOLDER** - the entire folder contents are uploaded and served as-is
- The folder must contain an `index.html` at the root (or appropriate entry point)

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
3. The site must be a **folder** containing static files only (HTML, CSS, JS, images, fonts, etc.)
4. The folder should have an `index.html` file at the root

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

1. Ensure you have a folder with static files (HTML, CSS, JS, images)
2. If using a framework (React, Vue, etc.), build first: `npm run build`
3. Deploy the **output folder** (e.g., `dist`, `build`, `out`): `siteio sites deploy ./dist -s mysite`
4. Access at `https://<subdomain>.<domain>`

**The entire folder is uploaded** - all files and subfolders within it will be served.

## Notes

- Sites are served over HTTPS with automatic Let's Encrypt certificates
- Deploying to the same subdomain replaces the existing site
- The subdomain must be lowercase alphanumeric (hyphens allowed)
- Maximum upload size is typically 50MB
