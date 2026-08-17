import { isFirebaseConfigured, getDB, initFirebase } from './firebase-config.js';

let _firestoreMod = null;

async function getFS() {
  if (!_firestoreMod) {
    _firestoreMod = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  }
  return _firestoreMod;
}

async function getDBInstance() {
  if (!isFirebaseConfigured()) return null;
  let dbInst = getDB();
  if (!dbInst) {
    await initFirebase();
    dbInst = getDB();
  }
  return dbInst;
}

const COLLECTIONS = ['prcs', 'allocations', 'rfqs', 'tcds', 'pods', 'vendors', 'users', 'notifications', 'activityLogs'];

// ── SAFE DOCUMENT ID ENCODING & DECODING ─────────────────
// In Firestore, document IDs cannot contain forward slashes '/' as they break path parsing.
function _encodeDocId(id) {
  if (id === null || id === undefined) return '';
  return String(id).trim().replace(/\//g, '__slash__');
}

function _decodeDocId(encodedId) {
  if (encodedId === null || encodedId === undefined) return '';
  return String(encodedId).replace(/__slash__/g, '/');
}

// ═══════════════════════════════════════════════════════════
// DIRECT DOCUMENT LEVEL WRITES (REAL-TIME IMMEDIATE PERSISTENCE)
// ═══════════════════════════════════════════════════════════

/**
 * Save / Update a single document directly to Firestore
 */
export async function directSaveDoc(uid, collectionName, docId, docData) {
  if (!docId) return false;
  const db = await getDBInstance();
  if (!db) return false;
  try {
    const fs = await getFS();
    const cleanDocId = _encodeDocId(docId);
    const targetPaths = [`workspaces/default/${collectionName}/${cleanDocId}`];
    if (uid && uid !== 'default') targetPaths.push(`users/${uid}/${collectionName}/${cleanDocId}`);
    
    for (const path of targetPaths) {
      const docRef = fs.doc(db, path);
      await fs.setDoc(docRef, _sanitize({ ...docData, id: docId }), { merge: true });
    }
    return true;
  } catch (err) {
    console.error(`Direct Firestore write error (${collectionName}/${docId}):`, err);
    return false;
  }
}

/**
 * Delete a single document directly from Firestore
 */
export async function directDeleteDoc(uid, collectionName, docId) {
  if (!docId) return false;
  const db = await getDBInstance();
  if (!db) return false;
  try {
    const fs = await getFS();
    const cleanDocId = _encodeDocId(docId);
    const targetPaths = [`workspaces/default/${collectionName}/${cleanDocId}`];
    if (uid && uid !== 'default') targetPaths.push(`users/${uid}/${collectionName}/${cleanDocId}`);

    for (const path of targetPaths) {
      const docRef = fs.doc(db, path);
      await fs.deleteDoc(docRef);
    }
    return true;
  } catch (err) {
    console.error(`Direct Firestore delete error (${collectionName}/${docId}):`, err);
    return false;
  }
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

export async function directSavePOD(uid, pod) {
  return directSaveDoc(uid, 'pods', pod.id || pod.poNumber, pod);
}

export async function directSaveActivityLog(uid, log) {
  return directSaveDoc(uid, 'activityLogs', log.id, log);
}

// ═══════════════════════════════════════════════════════════
// COLLECTION AND BULK DATA OPERATIONS
// ═══════════════════════════════════════════════════════════

/**
 * Load all collections for a given user UID directly from Firestore
 */
/**
 * Load all collections directly from Firestore
 */
export async function loadAllUserData(uid, forceServer = false) {
  const db = await getDBInstance();
  if (!db) return null;

  try {
    const fs = await getFS();
    const result = {};

    for (const colName of COLLECTIONS) {
      // 1. Try shared workspace collection first
      const sharedColRef = fs.collection(db, `workspaces/default/${colName}`);
      let snapshot;
      try {
        snapshot = (forceServer && fs.getDocsFromServer)
          ? await fs.getDocsFromServer(sharedColRef)
          : await fs.getDocs(sharedColRef);
      } catch (e) {
        snapshot = await fs.getDocs(sharedColRef);
      }

      let items = snapshot.docs.map(doc => {
        const data = doc.data();
        const rawId = data.id || _decodeDocId(doc.id);
        return { ...data, id: rawId };
      });

      // 2. Fallback to user-scoped collection if shared workspace collection is empty and uid is provided
      if (items.length === 0 && uid) {
        try {
          const userColRef = fs.collection(db, `users/${uid}/${colName}`);
          const userSnap = await fs.getDocs(userColRef);
          items = userSnap.docs.map(doc => {
            const data = doc.data();
            const rawId = data.id || _decodeDocId(doc.id);
            return { ...data, id: rawId };
          });
        } catch (e) {}
      }

      result[colName] = items;
    }

    // Load profile
    if (uid) {
      try {
        const profileRef = fs.doc(db, `users/${uid}`);
        const profileSnap = await fs.getDoc(profileRef);
        result.profile = profileSnap.exists() ? profileSnap.data() : null;
      } catch(e) {}
    }

    console.info(`🔥 Loaded data directly from Firebase Firestore (PRCs: ${result.prcs?.length || 0})`);
    return result;
  } catch (err) {
    console.error('Failed to load user data from Firestore:', err);
    return null;
  }
}

/**
 * Bulk save a collection using Batched Writes
 */
export async function saveCollection(uid, collectionName, items) {
  const db = await getDBInstance();
  if (!db) return false;

  try {
    const fs = await getFS();
    await _syncCollection(uid || 'default', collectionName, items, fs);
    return true;
  } catch (err) {
    console.error(`Failed to bulk save ${collectionName} to Firestore:`, err);
    return false;
  }
}

/**
 * Full state save to Firestore
 */
export async function saveAllUserData(uid, stateData) {
  const db = await getDBInstance();
  if (!db) return false;

  try {
    const fs = await getFS();
    const effectiveUid = uid || 'default';

    // User profile document
    if (uid) {
      try {
        const profileRef = fs.doc(db, `users/${uid}`);
        await fs.setDoc(profileRef, {
          name: stateData.currentUser?.name || '',
          email: stateData.currentUser?.email || '',
          role: stateData.currentUser?.role || 'User',
          avatar: stateData.currentUser?.avatar || 'U',
          lastSyncedAt: new Date().toISOString()
        }, { merge: true });
      } catch(e) {}
    }

    // Sync all collections to both shared workspace and user store
    for (const colName of COLLECTIONS) {
      const items = stateData[colName] || [];
      await _syncCollection(effectiveUid, colName, items, fs);
    }

    console.info(`🔥 Synced all collections to Firebase Firestore (PRCs: ${stateData.prcs?.length || 0})`);
    return true;
  } catch (err) {
    console.error('Failed to save all user data to Firestore:', err);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// REAL-TIME MULTI-DEVICE SYNCHRONIZATION
// ═══════════════════════════════════════════════════════════

let _unsubscribers = [];

/**
 * Subscribe to real-time Firestore updates across multiple devices/PCs
 */
export async function subscribeToRealtimeUserData(uid, onUpdate) {
  const db = await getDBInstance();
  if (!db) return () => {};

  unsubscribeRealtimeUserData();

  try {
    const fs = await getFS();

    COLLECTIONS.forEach(colName => {
      // Listen to shared workspace collection
      const colRef = fs.collection(db, `workspaces/default/${colName}`);
      const unsub = fs.onSnapshot(colRef, (snapshot) => {
        const items = snapshot.docs.map(doc => {
          const data = doc.data();
          const rawId = data.id || _decodeDocId(doc.id);
          return { ...data, id: rawId };
        });
        if (typeof onUpdate === 'function') {
          onUpdate(colName, items);
        }
      }, (err) => {
        console.warn(`Real-time listener notice for ${colName}:`, err);
      });
      _unsubscribers.push(unsub);
    });

    console.info(`🔥 Real-time multi-device Firestore synchronization active`);
    return unsubscribeRealtimeUserData;
  } catch (err) {
    console.error('Failed to start real-time Firestore subscription:', err);
    return () => {};
  }
}

export function unsubscribeRealtimeUserData() {
  if (_unsubscribers && _unsubscribers.length > 0) {
    _unsubscribers.forEach(unsub => {
      try { unsub(); } catch (e) {}
    });
    _unsubscribers = [];
  }
}

// ═══════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════

async function _syncCollection(uid, collectionName, items, fs) {
  const db = await getDBInstance();
  if (!db) return;

  const targetPaths = [`workspaces/default/${collectionName}`];
  if (uid && uid !== 'default') {
    targetPaths.push(`users/${uid}/${collectionName}`);
  }

  for (const colPath of targetPaths) {
    try {
      const colRef = fs.collection(db, colPath);
      const existingSnap = await fs.getDocs(colRef);
      const existingDocIds = new Set(existingSnap.docs.map(d => d.id));
      const currentDocIds = new Set();

      const MAX_BATCH = 450;
      let batch = fs.writeBatch(db);
      let opCount = 0;

      // Write all current items
      for (const item of (items || [])) {
        const rawId = item.id || item.prNumber || item.allocationNumber || item.rfqNumber || item.tcdNumber || item.poNumber;
        if (!rawId) continue;
        const cleanDocId = _encodeDocId(rawId);
        currentDocIds.add(cleanDocId);

        const docRef = fs.doc(db, `${colPath}/${cleanDocId}`);
        batch.set(docRef, _sanitize({ ...item, id: rawId }), { merge: true });
        opCount++;
        if (opCount >= MAX_BATCH) {
          await batch.commit();
          batch = fs.writeBatch(db);
          opCount = 0;
        }
      }

      // Delete removed items
      for (const existingId of existingDocIds) {
        if (!currentDocIds.has(existingId)) {
          const docRef = fs.doc(db, `${colPath}/${existingId}`);
          batch.delete(docRef);
          opCount++;
          if (opCount >= MAX_BATCH) {
            await batch.commit();
            batch = fs.writeBatch(db);
            opCount = 0;
          }
        }
      }

      if (opCount > 0) {
        await batch.commit();
      }
    } catch (colErr) {
      console.warn(`Could not sync ${colPath}:`, colErr);
    }
  }
}

function _sanitize(obj) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => _sanitize(item));

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    clean[key] = _sanitize(value);
  }
  return clean;
}
