// =========================================================
// TURSO DATABASE CLIENT (libSQL on Edge)
// High performance, unlimited-write SQL storage for Procurement System
// =========================================================

import { getEnv, loadEnv } from './env.js';

let _tursoUrl = null;
let _tursoToken = null;
let _isConfigured = false;
let _initPromise = null;

const COLLECTION_TABLE_MAP = {
  'prcs': 'prcs',
  'allocations': 'allocations',
  'rfqs': 'rfqs',
  'tcds': 'tcds',
  'pods': 'pods',
  'vendors': 'vendors',
  'users': 'users',
  'notifications': 'notifications',
  'activityLogs': 'activity_logs',
  'activity_logs': 'activity_logs'
};

const COLLECTIONS = ['prcs', 'allocations', 'rfqs', 'tcds', 'pods', 'vendors', 'users', 'notifications', 'activityLogs'];

/**
 * Initialize Turso Configuration from env
 */
export async function initTurso() {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    await loadEnv();
    let url = getEnv('TURSO_DATABASE_URL');
    let token = getEnv('TURSO_AUTH_TOKEN');

    if (url && token) {
      if (url.startsWith('libsql://')) {
        url = url.replace('libsql://', 'https://');
      }
      if (!url.endsWith('/v2/pipeline')) {
        url = url.replace(/\/+$/, '') + '/v2/pipeline';
      }
      _tursoUrl = url;
      _tursoToken = token;
      _isConfigured = true;
      console.info('⚡ Turso Database Client initialized successfully');
    } else {
      _isConfigured = false;
    }
    return _isConfigured;
  })();

  return _initPromise;
}

export function isTursoConfigured() {
  return _isConfigured || Boolean(getEnv('TURSO_DATABASE_URL') && getEnv('TURSO_AUTH_TOKEN'));
}

/**
 * Execute an array of SQL statements in a single Turso HTTP pipeline request
 */
export async function executeTursoPipeline(statements) {
  if (!_isConfigured) {
    await initTurso();
  }
  if (!_tursoUrl || !_tursoToken) {
    // Try fallback to serverless proxy /api/turso
    try {
      const proxyRes = await fetch('/api/turso', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: statements.map(s => typeof s === 'string' ? { type: 'execute', stmt: { sql: s } } : { type: 'execute', stmt: s })
        })
      });
      if (proxyRes.ok) {
        return await proxyRes.json();
      }
    } catch (e) {}
    console.warn('Turso is not configured.');
    return null;
  }

  const requests = statements.map(s => {
    if (typeof s === 'string') {
      return { type: 'execute', stmt: { sql: s } };
    }
    return {
      type: 'execute',
      stmt: {
        sql: s.sql,
        args: s.args ? s.args.map(_formatArg) : []
      }
    };
  });

  try {
    const res = await fetch(_tursoUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${_tursoToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ requests })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Turso HTTP ${res.status}: ${errText}`);
    }

    return await res.json();
  } catch (err) {
    console.error('Turso pipeline execution failed:', err);
    return null;
  }
}

function _formatArg(val) {
  if (val === null || val === undefined) {
    return { type: 'null' };
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      return { type: 'integer', value: String(val) };
    }
    return { type: 'float', value: val };
  }
  if (typeof val === 'boolean') {
    return { type: 'integer', value: val ? '1' : '0' };
  }
  return { type: 'text', value: String(val) };
}

function _getTableName(collectionName) {
  return COLLECTION_TABLE_MAP[collectionName] || collectionName.toLowerCase();
}

// ═══════════════════════════════════════════════════════════
// DIRECT DOCUMENT LEVEL WRITES
// ═══════════════════════════════════════════════════════════

/**
 * Save / Update a single document directly to Turso
 */
export async function directSaveDoc(uid, collectionName, docId, docData) {
  if (!docId) return false;
  const table = _getTableName(collectionName);
  const effectiveUid = (uid && uid !== 'default') ? uid : 'guest';
  const now = new Date().toISOString();
  const cleanData = _sanitize({ ...docData, id: docId, userId: effectiveUid });
  const dataJson = JSON.stringify(cleanData);

  const stmt = {
    sql: `INSERT INTO ${table} (id, user_id, data, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            user_id = excluded.user_id,
            data = excluded.data,
            updated_at = excluded.updated_at;`,
    args: [String(docId), String(effectiveUid), dataJson, now]
  };

  const result = await executeTursoPipeline([stmt]);
  return result && result.results && result.results[0] && result.results[0].type === 'ok';
}

/**
 * Delete a single document directly from Turso
 */
export async function directDeleteDoc(uid, collectionName, docId) {
  if (!docId) return false;
  const table = _getTableName(collectionName);
  const effectiveUid = (uid && uid !== 'default') ? uid : 'guest';

  const stmt = {
    sql: `DELETE FROM ${table} WHERE id = ? AND (user_id = ? OR user_id = 'guest');`,
    args: [String(docId), String(effectiveUid)]
  };

  const result = await executeTursoPipeline([stmt]);
  return result && result.results && result.results[0] && result.results[0].type === 'ok';
}

/**
 * Direct helpers for specific business entities
 */
export async function directSavePRC(uid, prc) {
  return directSaveDoc(uid, 'prcs', prc.id || prc.prNumber, prc);
}

export async function directDeletePRC(uid, prcId) {
  return directDeleteDoc(uid, 'prcs', prcId);
}

export async function directSaveAllocation(uid, allocation) {
  return directSaveDoc(uid, 'allocations', allocation.id || allocation.allocationNumber, allocation);
}

export async function directDeleteAllocation(uid, allocId) {
  return directDeleteDoc(uid, 'allocations', allocId);
}

export async function directSaveRFQ(uid, rfq) {
  return directSaveDoc(uid, 'rfqs', rfq.id || rfq.rfqNumber, rfq);
}

export async function directDeleteRFQ(uid, rfqId) {
  return directDeleteDoc(uid, 'rfqs', rfqId);
}

export async function directSaveTCD(uid, tcd) {
  return directSaveDoc(uid, 'tcds', tcd.id || tcd.tcdNumber, tcd);
}

export async function directDeleteTCD(uid, tcdId) {
  return directDeleteDoc(uid, 'tcds', tcdId);
}

export async function directSavePOD(uid, pod) {
  return directSaveDoc(uid, 'pods', pod.id || pod.poNumber, pod);
}

export async function directDeletePOD(uid, podId) {
  return directDeleteDoc(uid, 'pods', podId);
}

export async function directSaveActivityLog(uid, log) {
  return directSaveDoc(uid, 'activityLogs', log.id, log);
}

// ═══════════════════════════════════════════════════════════
// COLLECTION AND BULK DATA OPERATIONS
// ═══════════════════════════════════════════════════════════

/**
 * Load all collections for a given user UID from Turso
 */
export async function loadAllUserData(uid, forceServer = false) {
  if (!_isConfigured) {
    await initTurso();
  }
  if (!_isConfigured) return null;

  const effectiveUid = (uid && uid !== 'default') ? uid : 'guest';
  const result = {};

  // Build select queries for each collection
  const queries = COLLECTIONS.map(col => {
    const table = _getTableName(col);
    return {
      sql: `SELECT id, user_id, data, updated_at FROM ${table} WHERE user_id = ? OR user_id = 'guest' ORDER BY rowid ASC;`,
      args: [effectiveUid]
    };
  });

  // Query profile
  queries.push({
    sql: `SELECT data FROM user_profiles WHERE user_id = ?;`,
    args: [effectiveUid]
  });

  const response = await executeTursoPipeline(queries);
  if (!response || !response.results) {
    console.warn('Could not load user data from Turso');
    return null;
  }

  COLLECTIONS.forEach((col, idx) => {
    const resObj = response.results[idx];
    if (resObj && resObj.type === 'ok' && resObj.response && resObj.response.result) {
      const rows = resObj.response.result.rows || [];
      result[col] = rows.map(r => {
        try {
          // Row structure: [id, user_id, data, updated_at]
          const dataJson = r[2]?.value;
          const parsed = JSON.parse(dataJson);
          return { ...parsed, id: parsed.id || r[0]?.value };
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
    } else {
      result[col] = [];
    }
  });

  // Profile
  const profileRes = response.results[COLLECTIONS.length];
  if (profileRes && profileRes.type === 'ok' && profileRes.response?.result?.rows?.length > 0) {
    try {
      result.profile = JSON.parse(profileRes.response.result.rows[0][0]?.value);
    } catch(e) {
      result.profile = null;
    }
  }

  console.info(`⚡ Loaded user data for '${effectiveUid}' from Turso Database (PRCs: ${result.prcs?.length || 0})`);
  return result;
}

/**
 * Bulk save a collection using single batched Turso HTTP pipeline
 */
export async function saveCollection(uid, collectionName, items) {
  if (!items || items.length === 0) return true;
  const table = _getTableName(collectionName);
  const effectiveUid = (uid && uid !== 'default') ? uid : 'guest';
  const now = new Date().toISOString();

  const statements = items.map(item => {
    const rawId = item.id || item.prNumber || item.allocationNumber || item.rfqNumber || item.tcdNumber || item.poNumber;
    if (!rawId) return null;
    const cleanData = _sanitize({ ...item, id: rawId, userId: effectiveUid });
    return {
      sql: `INSERT INTO ${table} (id, user_id, data, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              user_id = excluded.user_id,
              data = excluded.data,
              updated_at = excluded.updated_at;`,
      args: [String(rawId), String(effectiveUid), JSON.stringify(cleanData), now]
    };
  }).filter(Boolean);

  if (statements.length === 0) return true;

  const result = await executeTursoPipeline(statements);
  console.info(`⚡ Turso synced ${statements.length} items to table: ${table}`);
  return Boolean(result);
}

/**
 * Full state save to Turso Database
 */
export async function saveAllUserData(uid, stateData) {
  if (!_isConfigured) {
    await initTurso();
  }
  if (!_isConfigured) return false;

  const effectiveUid = (uid && uid !== 'default') ? uid : 'guest';
  const now = new Date().toISOString();
  const allStatements = [];

  // User profile
  if (effectiveUid !== 'guest' && stateData.currentUser) {
    const profileData = {
      name: stateData.currentUser?.name || '',
      email: stateData.currentUser?.email || '',
      role: stateData.currentUser?.role || 'User',
      avatar: stateData.currentUser?.avatar || 'U',
      lastSyncedAt: now
    };
    allStatements.push({
      sql: `INSERT INTO user_profiles (user_id, data, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              data = excluded.data,
              updated_at = excluded.updated_at;`,
      args: [effectiveUid, JSON.stringify(profileData), now]
    });
  }

  // All collections
  for (const colName of COLLECTIONS) {
    const table = _getTableName(colName);
    const items = stateData[colName] || [];
    for (const item of items) {
      const rawId = item.id || item.prNumber || item.allocationNumber || item.rfqNumber || item.tcdNumber || item.poNumber;
      if (!rawId) continue;
      const cleanData = _sanitize({ ...item, id: rawId, userId: effectiveUid });
      allStatements.push({
        sql: `INSERT INTO ${table} (id, user_id, data, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                user_id = excluded.user_id,
                data = excluded.data,
                updated_at = excluded.updated_at;`,
        args: [String(rawId), String(effectiveUid), JSON.stringify(cleanData), now]
      });
    }
  }

  if (allStatements.length === 0) return true;

  const result = await executeTursoPipeline(allStatements);
  console.info(`⚡ Synced all collections to Turso Database for user '${effectiveUid}' (${allStatements.length} statements)`);
  return Boolean(result);
}

// ═══════════════════════════════════════════════════════════
// REAL-TIME / POLLING SYNCHRONIZATION
// ═══════════════════════════════════════════════════════════

let _pollTimer = null;

export async function subscribeToRealtimeUserData(uid, onUpdate) {
  unsubscribeRealtimeUserData();

  const effectiveUid = (uid && uid !== 'default') ? uid : 'guest';
  let lastChecked = new Date().toISOString();

  // Poll for updates every 15 seconds
  _pollTimer = setInterval(async () => {
    try {
      const queries = COLLECTIONS.map(col => {
        const table = _getTableName(col);
        return {
          sql: `SELECT id, data, updated_at FROM ${table} WHERE (user_id = ? OR user_id = 'guest') AND updated_at > ?;`,
          args: [effectiveUid, lastChecked]
        };
      });

      const response = await executeTursoPipeline(queries);
      if (response && response.results) {
        lastChecked = new Date().toISOString();
        COLLECTIONS.forEach((col, idx) => {
          const resObj = response.results[idx];
          if (resObj && resObj.type === 'ok' && resObj.response?.result?.rows?.length > 0) {
            const updatedItems = resObj.response.result.rows.map(r => {
              try { return JSON.parse(r[1]?.value); } catch(e) { return null; }
            }).filter(Boolean);

            if (updatedItems.length > 0 && typeof onUpdate === 'function') {
              onUpdate(col, updatedItems);
            }
          }
        });
      }
    } catch (e) {
      console.warn('Turso sync poll error:', e);
    }
  }, 15000);

  return unsubscribeRealtimeUserData;
}

export function unsubscribeRealtimeUserData() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════
// INTERNAL SANITIZER
// ═══════════════════════════════════════════════════════════

function _sanitize(obj) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj === 'number') {
    if (isNaN(obj) || !isFinite(obj)) return 0;
    return obj;
  }
  if (typeof obj === 'boolean' || typeof obj === 'string') return obj;
  if (obj instanceof Date) return obj.toISOString();
  if (Array.isArray(obj)) return obj.map(item => _sanitize(item));
  if (typeof obj !== 'object') return null;

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || typeof value === 'function') continue;
    clean[key] = _sanitize(value);
  }
  return clean;
}
