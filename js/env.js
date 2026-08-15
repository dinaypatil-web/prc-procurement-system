// =========================================================
// ENVIRONMENT CONFIGURATION LOADER
// Supports Vercel (/api/env), .env files, and window.__ENV__
// =========================================================

const _envCache = {};
let _isLoaded = false;

function parseEnv(text) {
  const result = {};
  if (!text) return result;

  const lines = text.split('\n');
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1) {
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  }
  return result;
}

/**
 * Initialize and load environment variables
 * Priority: /api/env (Vercel) -> .env (Local) -> window.__ENV__
 */
export async function loadEnv() {
  if (_isLoaded && Object.keys(_envCache).length > 0) return _envCache;

  // 1. Check window.__ENV__ if injected
  if (typeof window !== 'undefined' && window.__ENV__) {
    Object.assign(_envCache, window.__ENV__);
  }

  // 2. Try fetching from Vercel serverless function /api/env
  if (typeof fetch !== 'undefined') {
    try {
      const apiRes = await fetch('/api/env');
      if (apiRes.ok) {
        const data = await apiRes.json();
        if (data && typeof data === 'object') {
          for (const [k, v] of Object.entries(data)) {
            if (v && !_envCache[k]) {
              _envCache[k] = v;
            }
          }
        }
      }
    } catch (e) {
      // /api/env might not exist in non-Vercel local environment
    }
  }

  // 3. Try fetching local .env file (for local python/node servers)
  if (typeof fetch !== 'undefined') {
    try {
      const res = await fetch('.env');
      if (res.ok) {
        const text = await res.text();
        if (!text.includes('<!DOCTYPE html>') && !text.includes('<html')) {
          const parsed = parseEnv(text);
          for (const [k, v] of Object.entries(parsed)) {
            if (v && !_envCache[k]) {
              _envCache[k] = v;
            }
          }
        }
      }
    } catch (e) {
      // .env fetch is optional
    }
  }

  _isLoaded = true;
  return _envCache;
}

export function getEnv(key, defaultValue = '') {
  if (typeof window !== 'undefined' && window.__ENV__ && window.__ENV__[key] !== undefined) {
    return window.__ENV__[key];
  }
  return _envCache[key] !== undefined && _envCache[key] !== '' ? _envCache[key] : defaultValue;
}

export function getAllEnv() {
  return { ..._envCache, ...(typeof window !== 'undefined' ? window.__ENV__ || {} : {}) };
}
