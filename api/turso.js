// =========================================================
// VERCEL SERVERLESS FUNCTION: /api/turso
// Secure gateway to Turso Database via libSQL HTTP pipeline
// =========================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const tursoUrl = process.env.TURSO_DATABASE_URL || '';
  const tursoToken = process.env.TURSO_AUTH_TOKEN || '';

  if (!tursoUrl || !tursoToken) {
    return res.status(500).json({ error: 'TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is not configured on the server.' });
  }

  let endpoint = tursoUrl;
  if (endpoint.startsWith('libsql://')) {
    endpoint = endpoint.replace('libsql://', 'https://');
  }
  if (!endpoint.endsWith('/v2/pipeline')) {
    endpoint = endpoint.replace(/\/+$/, '') + '/v2/pipeline';
  }

  try {
    const { requests } = req.body || {};
    if (!requests || !Array.isArray(requests)) {
      return res.status(400).json({ error: 'Invalid payload: "requests" array is required.' });
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tursoToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ requests })
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    console.error('Turso proxy error:', err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
}
