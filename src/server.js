const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

// Middleware
app.use(express.json());

// CORS headers for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// SSE clients registry
const sseClients = [];

// Helper: get claims file path
const getClaimsPath = () => path.join(config.outputDir, 'claims.json');

// Helper: read claims
const readClaims = () => {
  const claimsPath = getClaimsPath();
  if (!fs.existsSync(claimsPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
  } catch {
    return {};
  }
};

// Helper: write claims
const writeClaims = (claims) => {
  const claimsPath = getClaimsPath();
  fs.writeFileSync(claimsPath, JSON.stringify(claims, null, 2), 'utf8');
};

// Helper: broadcast SSE message to all clients
const broadcastSSE = (message) => {
  sseClients.forEach((client) => {
    client.write(`data: ${JSON.stringify(message)}\n\n`);
  });
};

// Serve dashboard HTML
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// API: latest scan data
app.get('/api/scan', (_req, res) => {
  const scanPath = path.join(config.outputDir, 'latest-scan.json');
  if (!fs.existsSync(scanPath)) {
    return res.json({ error: 'Aucun scan disponible. Lance npm start d\'abord.' });
  }
  const raw = fs.readFileSync(scanPath, 'utf8');
  res.json(JSON.parse(raw));
});

// API: config info
app.get('/api/config', (_req, res) => {
  res.json({
    searches: config.searches.map((s) => ({
      name: s.name,
      maxPrice: s.maxPrice,
      vintedQueries: s.vintedQueries,
      requiredAllTokens: s.requiredAllTokens,
      requiredAnyTokens: s.requiredAnyTokens,
      blockedTokens: s.blockedTokens
    })),
    minProfitEur: config.minProfitEur,
    minProfitPercent: config.minProfitPercent,
    maxItemsPerSearch: config.maxItemsPerSearch,
    ebayBaseUrls: config.ebayBaseUrls,
    vintedShippingEstimate: config.vintedShippingEstimate,
    ebayOutboundShippingEstimate: config.ebayOutboundShippingEstimate
  });
});

// API: claim an opportunity
app.post('/api/claim', (req, res) => {
  const { itemKey, username, vintedUrl } = req.body;
  if (!itemKey || !username) {
    return res.status(400).json({ error: 'itemKey and username required' });
  }

  const claims = readClaims();
  claims[itemKey] = {
    username,
    vintedUrl: vintedUrl || null,
    claimedAt: new Date().toISOString()
  };
  writeClaims(claims);

  broadcastSSE({
    type: 'claim',
    data: claims[itemKey]
  });

  res.json({ success: true, claim: claims[itemKey] });
});

// API: unclaim an opportunity
app.delete('/api/claim/:itemKey', (req, res) => {
  const { itemKey } = req.params;
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ error: 'username query param required' });
  }

  const claims = readClaims();
  const claim = claims[itemKey];

  if (!claim) {
    return res.status(404).json({ error: 'Claim not found' });
  }

  if (claim.username !== username) {
    return res.status(403).json({ error: 'Only the claiming user can unclaim' });
  }

  delete claims[itemKey];
  writeClaims(claims);

  broadcastSSE({
    type: 'unclaim',
    data: { itemKey }
  });

  res.json({ success: true });
});

// API: get all claims
app.get('/api/claims', (_req, res) => {
  const claims = readClaims();
  res.json(claims);
});

// SSE: Server-Sent Events endpoint
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Add client to registry
  sseClients.push(res);

  // Send initial message
  res.write('event: connected\ndata: {"message":"Connected to events"}\n\n');

  // Heartbeat every 30 seconds
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeatInterval);
    const index = sseClients.indexOf(res);
    if (index > -1) {
      sseClients.splice(index, 1);
    }
  });
});

// Export broadcastSSE so the scanner can notify the dashboard directly
module.exports = { broadcastSSE };

app.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
});
