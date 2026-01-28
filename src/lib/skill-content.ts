// Embedded SKILL.md content for installation
// This is included in the binary so it can be installed without network access

export const SKILL_CONTENT = `# Skill: Deploy Static Sites with siteio

Use this skill when the user asks to deploy a static site, website, or HTML files to a URL.

## IMPORTANT

- **siteio deploys STATIC websites only** - HTML, CSS, JS, images, fonts, etc.
- **NOT for backends, APIs, or server-side applications** - no Node.js, Python, PHP, databases, etc.
- **You deploy a FOLDER** - the entire folder contents are uploaded and served as-is
- The folder must contain an \`index.html\` at the root (or appropriate entry point)

## Installation

\`\`\`sh
curl -LsSf https://siteio.me/install | sh
\`\`\`

## Check for Updates

Before deploying, ensure you have the latest version:

\`\`\`sh
siteio update
\`\`\`

## Setup

Before deploying, the user needs to login with a connection token. If they don't have one, ask them to get it from their siteio administrator.

\`\`\`sh
siteio login -t <token>
\`\`\`

The token is provided by the siteio agent administrator and contains the API URL and key.

## Prerequisites

1. siteio must be installed (see above)
2. User must be logged in with a valid token
3. The site must be a **folder** containing static files only (HTML, CSS, JS, images, fonts, etc.)
4. The folder should have an \`index.html\` file at the root

## Deploying a Site

\`\`\`sh
siteio sites deploy <folder> [-s <subdomain>]
\`\`\`

- \`<folder>\`: Path to the folder containing the static site
- \`-s, --subdomain <name>\`: Optional subdomain (defaults to folder name)

### Examples

\`\`\`sh
# Deploy ./dist folder as "myapp"
siteio sites deploy ./dist -s myapp

# Deploy current directory using folder name as subdomain
siteio sites deploy .

# Deploy a specific folder
siteio sites deploy ./build -s dashboard
\`\`\`

## Authentication

Sites can be protected with Google OAuth authentication. Only users with allowed emails, domains, or group membership can access protected sites.

### Adding Auth During Deployment

\`\`\`sh
# Restrict to specific email addresses
siteio sites deploy ./dist -s mysite --allowed-emails "user1@gmail.com,user2@gmail.com"

# Restrict to an email domain (all @company.com addresses)
siteio sites deploy ./dist -s mysite --allowed-domain "company.com"

# Combine both
siteio sites deploy ./dist -s mysite --allowed-emails "external@gmail.com" --allowed-domain "company.com"
\`\`\`

### Managing Auth After Deployment

Use \`siteio sites auth\` to add, modify, or remove authentication on existing sites.

\`\`\`sh
# Set allowed emails (replaces existing)
siteio sites auth mysite --allowed-emails "user1@gmail.com,user2@gmail.com"

# Set allowed domain
siteio sites auth mysite --allowed-domain "company.com"

# Set allowed groups (users must be members of the group)
siteio sites auth mysite --allowed-groups "engineering,design"

# Incremental changes - add/remove without replacing
siteio sites auth mysite --add-email "newuser@gmail.com"
siteio sites auth mysite --remove-email "olduser@gmail.com"
siteio sites auth mysite --add-group "marketing"
siteio sites auth mysite --remove-group "design"

# Remove all authentication (make site public)
siteio sites auth mysite --remove
\`\`\`

### Notes

- OAuth must be configured on the server (\`siteio agent oauth\`) before auth can be used
- Multiple emails/groups are comma-separated
- All values are case-insensitive
- A user needs to match ANY of the criteria (emails OR domain OR groups)

## Other Commands

\`\`\`sh
# List all deployed sites
siteio sites list

# Remove a deployed site
siteio sites undeploy <subdomain>
\`\`\`

## Workflow

1. Ensure you have a folder with static files (HTML, CSS, JS, images)
2. If using a framework (React, Vue, etc.), build first: \`npm run build\`
3. Deploy the **output folder** (e.g., \`dist\`, \`build\`, \`out\`): \`siteio sites deploy ./dist -s mysite\`
4. Access at \`https://<subdomain>.<domain>\`

**The entire folder is uploaded** - all files and subfolders within it will be served.

## Notes

- Sites are served over HTTPS with automatic Let's Encrypt certificates
- Deploying to the same subdomain replaces the existing site
- The subdomain must be lowercase alphanumeric (hyphens allowed)
- Maximum upload size is typically 50MB
`
