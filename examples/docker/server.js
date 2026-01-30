const http = require('http');

const PORT = process.env.PORT || 3000;
const HOSTNAME = process.env.HOSTNAME || 'unknown';

const server = http.createServer((req, res) => {
  const now = new Date().toISOString();

  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: now }));
    return;
  }

  // Main page
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>siteio Docker Example</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
    }
    .container {
      text-align: center;
      padding: 2rem;
      max-width: 600px;
    }
    h1 { font-size: 2.5rem; margin-bottom: 1rem; }
    p { font-size: 1.1rem; opacity: 0.9; line-height: 1.6; margin-bottom: 1.5rem; }
    .info {
      background: rgba(255,255,255,0.15);
      padding: 1.5rem;
      border-radius: 12px;
      margin-top: 1rem;
      backdrop-filter: blur(10px);
    }
    .info-item {
      display: flex;
      justify-content: space-between;
      padding: 0.5rem 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .info-item:last-child { border-bottom: none; }
    .label { opacity: 0.8; }
    code {
      background: rgba(0,0,0,0.2);
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-family: 'SF Mono', Monaco, monospace;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Container is running!</h1>
    <p>
      This app was built from a <code>Dockerfile</code> and deployed with <code>siteio</code>.
    </p>
    <div class="info">
      <div class="info-item">
        <span class="label">Hostname</span>
        <span>${HOSTNAME}</span>
      </div>
      <div class="info-item">
        <span class="label">Port</span>
        <span>${PORT}</span>
      </div>
      <div class="info-item">
        <span class="label">Node.js</span>
        <span>${process.version}</span>
      </div>
      <div class="info-item">
        <span class="label">Timestamp</span>
        <span>${now}</span>
      </div>
    </div>
  </div>
</body>
</html>
  `);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}/`);
});
