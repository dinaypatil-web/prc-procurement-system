// =========================================================
// VERCEL SERVERLESS FUNCTION: /api/env
// Exposes public environment variables from Vercel to frontend
// =========================================================

export default function handler(req, res) {
  // Set CORS and strict NO-CACHE headers so frontend always receives live Vercel env vars
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Flexible variable resolution matching exact or prefix variants
  const getEnvVar = (keys) => {
    for (const key of keys) {
      if (process.env[key]) return process.env[key];
      // Case-insensitive fallback
      const found = Object.keys(process.env).find(k => k.toUpperCase() === key.toUpperCase());
      if (found && process.env[found]) return process.env[found];
    }
    return '';
  };

  // Support single JSON object string in FIREBASE_CONFIG or FIREBASE_WEB_CONFIG
  let jsonConfig = {};
  const rawJson = process.env.FIREBASE_CONFIG || process.env.FIREBASE_WEB_CONFIG;
  if (rawJson) {
    try {
      jsonConfig = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
    } catch(e) {}
  }

  const projectId = jsonConfig.projectId || getEnvVar([
    'FIREBASE_PROJECT_ID',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
    'VITE_FIREBASE_PROJECT_ID',
    'REACT_APP_FIREBASE_PROJECT_ID'
  ]);

  const envData = {
    FIREBASE_API_KEY: jsonConfig.apiKey || getEnvVar([
      'FIREBASE_API_KEY',
      'NEXT_PUBLIC_FIREBASE_API_KEY',
      'VITE_FIREBASE_API_KEY',
      'REACT_APP_FIREBASE_API_KEY'
    ]),
    FIREBASE_AUTH_DOMAIN: jsonConfig.authDomain || getEnvVar([
      'FIREBASE_AUTH_DOMAIN',
      'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
      'VITE_FIREBASE_AUTH_DOMAIN',
      'REACT_APP_FIREBASE_AUTH_DOMAIN'
    ]) || (projectId ? `${projectId}.firebaseapp.com` : ''),
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_STORAGE_BUCKET: jsonConfig.storageBucket || getEnvVar([
      'FIREBASE_STORAGE_BUCKET',
      'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
      'VITE_FIREBASE_STORAGE_BUCKET',
      'REACT_APP_FIREBASE_STORAGE_BUCKET'
    ]) || (projectId ? `${projectId}.firebasestorage.app` : ''),
    FIREBASE_MESSAGING_SENDER_ID: jsonConfig.messagingSenderId || getEnvVar([
      'FIREBASE_MESSAGING_SENDER_ID',
      'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
      'VITE_FIREBASE_MESSAGING_SENDER_ID',
      'REACT_APP_FIREBASE_MESSAGING_SENDER_ID'
    ]),
    FIREBASE_APP_ID: jsonConfig.appId || getEnvVar([
      'FIREBASE_APP_ID',
      'NEXT_PUBLIC_FIREBASE_APP_ID',
      'VITE_FIREBASE_APP_ID',
      'REACT_APP_FIREBASE_APP_ID'
    ]),
    FIREBASE_MEASUREMENT_ID: jsonConfig.measurementId || getEnvVar([
      'FIREBASE_MEASUREMENT_ID',
      'NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID',
      'VITE_FIREBASE_MEASUREMENT_ID',
      'REACT_APP_FIREBASE_MEASUREMENT_ID'
    ]),
    GEMINI_API_KEY: getEnvVar([
      'GEMINI_API_KEY',
      'NEXT_PUBLIC_GEMINI_API_KEY',
      'VITE_GEMINI_API_KEY',
      'REACT_APP_GEMINI_API_KEY'
    ]),
    _SOURCE: 'vercel-api-env'
  };

  res.status(200).json(envData);
}
