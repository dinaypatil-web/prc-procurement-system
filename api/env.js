// =========================================================
// VERCEL SERVERLESS FUNCTION: /api/env
// Exposes public environment variables from Vercel to frontend
// =========================================================

export default function handler(req, res) {
  // Set CORS and caching headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const getEnvVar = (keys) => {
    for (const key of keys) {
      if (process.env[key]) return process.env[key];
    }
    return '';
  };

  const projectId = getEnvVar([
    'FIREBASE_PROJECT_ID',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
    'VITE_FIREBASE_PROJECT_ID',
    'REACT_APP_FIREBASE_PROJECT_ID'
  ]);

  const envData = {
    FIREBASE_API_KEY: getEnvVar([
      'FIREBASE_API_KEY',
      'NEXT_PUBLIC_FIREBASE_API_KEY',
      'VITE_FIREBASE_API_KEY',
      'REACT_APP_FIREBASE_API_KEY'
    ]),
    FIREBASE_AUTH_DOMAIN: getEnvVar([
      'FIREBASE_AUTH_DOMAIN',
      'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
      'VITE_FIREBASE_AUTH_DOMAIN',
      'REACT_APP_FIREBASE_AUTH_DOMAIN'
    ]) || (projectId ? `${projectId}.firebaseapp.com` : ''),
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_STORAGE_BUCKET: getEnvVar([
      'FIREBASE_STORAGE_BUCKET',
      'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
      'VITE_FIREBASE_STORAGE_BUCKET',
      'REACT_APP_FIREBASE_STORAGE_BUCKET'
    ]) || (projectId ? `${projectId}.appspot.com` : ''),
    FIREBASE_MESSAGING_SENDER_ID: getEnvVar([
      'FIREBASE_MESSAGING_SENDER_ID',
      'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
      'VITE_FIREBASE_MESSAGING_SENDER_ID',
      'REACT_APP_FIREBASE_MESSAGING_SENDER_ID'
    ]),
    FIREBASE_APP_ID: getEnvVar([
      'FIREBASE_APP_ID',
      'NEXT_PUBLIC_FIREBASE_APP_ID',
      'VITE_FIREBASE_APP_ID',
      'REACT_APP_FIREBASE_APP_ID'
    ]),
    FIREBASE_MEASUREMENT_ID: getEnvVar([
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
    ])
  };

  res.status(200).json(envData);
}
