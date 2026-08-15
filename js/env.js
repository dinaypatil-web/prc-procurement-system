// =========================================================
// ENVIRONMENT CONFIGURATION LOADER
// Reads environment variables from .env file or window.__ENV__
// =========================================================

const _envCache = {};
let _isLoaded = false;

/**
 * Parse a standard .env formatted string into key-value pairs
 */
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
      // Strip surrounding quotes if present
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  }
  return result;
}

/**
 * Initialize and load environment variables from .env or window.__ENV__
 */
export async function loadEnv() {
  if (_isLoaded) return _envCache;

  // 1. Check window.__ENV__ if injected by server
  if (typeof window !== 'undefined' && window.__ENV__) {
    Object.assign(_envCache, window.__ENV__);
  }

  // 2. Try fetching .env file from root
  if (typeof fetch !== 'undefined') {
    try {
      const res = await fetch('.env');
      if (res.ok) {
        const text = await res.text();
        // Make sure it didn't just return index.html (SPA fallback)
        if (!text.includes('<!DOCTYPE html>') && !text.includes('<html')) {
          const parsed = parseEnv(text);
          Object.assign(_envCache, parsed);
        }
      }
    } catch (e) {
      // .env fetch is optional (e.g. in some production static hosts)
    }
  }

  _isLoaded = true;
  return _envCache;
}

/**
 * Get an environment variable value by key
 */
export function getEnv(key, defaultValue = '') {
  if (typeof window !== 'undefined' && window.__ENV__ && window.__ENV__[key] !== undefined) {
    return window.__ENV__[key];
  }
  return _envCache[key] !== undefined ? _envCache[key] : defaultValue;
}

/**
 * Synchronous environment dictionary getter
 */
export function getAllEnv() {
  return { ..._envCache, ...(typeof window !== 'undefined' ? window.__ENV__ || {} : {}) };
}
