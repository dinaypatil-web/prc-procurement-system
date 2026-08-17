// =========================================================
// FIRESTORE DATA LAYER — DIRECT USER-SCOPED PERSISTENCE
// Data is saved directly in Firebase Cloud Firestore under users/{uid}/...
// Supports Real-Time Multi-Device Synchronization & Safe ID Escaping
// =========================================================

import { db, isFirebaseConfigured } from './firebase-config.js';

let _firestoreMod = null;

async function getFS() {
  if (!_firestoreMod) {
    _firestoreMod = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  }
  return _firestoreMod;
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
  if (!isFirebaseConfigured() || !db || !uid || !docId) return false;
  try {
    const fs = await getFS();
    const cleanDocId = _encodeDocId(docId);
    const docRef = fs.doc(db, `users/${uid}/${collectionName}/${cleanDocId}`);
    await fs.setDoc(docRef, _sanitize({ ...docData, id: docId }), { merge: true });
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
  if (!isFirebaseConfigured() || !db || !uid || !docId) return false;
  try {
    const fs = await getFS();
    const cleanDocId = _encodeDocId(docId);
    const docRef = fs.doc(db, `users/${uid}/${collectionName}/${cleanDocId}`);
    await fs.deleteDoc(docRef);
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
export async function loadAllUserData(uid, forceServer = false) {
  if (!isFirebaseConfigured() || !db || !uid) return null;

  try {
    const fs = await getFS();
    const result = {};

    for (const colName of COLLECTIONS) {
      const colRef = fs.collection(db, `users/${uid}/${colName}`);
      let snapshot;
      if (forceServer && fs.getDocsFromServer) {
        try {
          snapshot = await fs.getDocsFromServer(colRef);
        } catch (e) {
          snapshot = await fs.getDocs(colRef);
        }
      } else {
        snapshot = await fs.getDocs(colRef);
      }
      result[colName] = snapshot.docs.map(doc => {
        const data = doc.data();
        const rawId = data.id || _decodeDocId(doc.id);
        return { ...data, id: rawId };
      });
    }

    // Load profile
    const profileRef = fs.doc(db, `users/${uid}`);
    const profileSnap = await fs.getDoc(profileRef);
    result.profile = profileSnap.exists() ? profileSnap.data() : null;

    console.info(`🔥 Loaded data directly from Firebase Firestore for user ${uid} (PRCs: ${result.prcs?.length || 0})`);
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
  if (!isFirebaseConfigured() || !db || !uid) return false;

  try {
    const fs = await getFS();
    await _syncCollection(uid, collectionName, items, fs);
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
  if (!isFirebaseConfigured() || !db || !uid) return false;

  try {
    const fs = await getFS();

    // User profile document
    const profileRef = fs.doc(db, `users/${uid}`);
    await fs.setDoc(profileRef, {
      name: stateData.currentUser?.name || '',
      email: stateData.currentUser?.email || '',
      role: stateData.currentUser?.role || 'User',
      avatar: stateData.currentUser?.avatar || 'U',
      lastSyncedAt: new Date().toISOString()
    }, { merge: true });

    // Sync all collections
    for (const colName of COLLECTIONS) {
      const items = stateData[colName] || [];
      await _syncCollection(uid, colName, items, fs);
    }

    console.info(`🔥 Synced all collections to Firebase Firestore for user ${uid}`);
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
  if (!isFirebaseConfigured() || !db || !uid) return () => {};

  unsubscribeRealtimeUserData();

  try {
    const fs = await getFS();

    COLLECTIONS.forEach(colName => {
      const colRef = fs.collection(db, `users/${uid}/${colName}`);
      const unsub = fs.onSnapshot(colRef, (snapshot) => {
        // Skip empty snapshot on initial load if pending
        if (snapshot.metadata.hasPendingWrites) {
          // Local optimistic write
        }
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

    console.info(`🔥 Real-time multi-device Firestore synchronization active for user ${uid}`);
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
  const colPath = `users/${uid}/${collectionName}`;
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
