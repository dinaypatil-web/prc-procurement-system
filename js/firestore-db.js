// =========================================================
// FIRESTORE DATA LAYER — USER-SCOPED CRUD OPERATIONS
// All data is stored under users/{uid}/... in Firestore
// =========================================================

import { db, isFirebaseConfigured } from './firebase-config.js';

// Cache Firestore module imports
let _firestoreMod = null;

async function getFirestoreMod() {
  if (!_firestoreMod) {
    _firestoreMod = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  }
  return _firestoreMod;
}

// Collections that are synced per-user
const COLLECTIONS = ['prcs', 'allocations', 'rfqs', 'tcds', 'pods', 'vendors', 'notifications', 'activityLogs'];

// ═══════════════════════════════════════════════════════════
// LOAD ALL USER DATA
// ═══════════════════════════════════════════════════════════

/**
 * Load all collections for a given user UID from Firestore.
 * Returns an object keyed by collection name, or null if Firebase is not configured.
 */
export async function loadAllUserData(uid) {
  if (!isFirebaseConfigured() || !db) return null;

  try {
    const fs = await getFirestoreMod();
    const result = {};

    for (const colName of COLLECTIONS) {
      const colRef = fs.collection(db, `users/${uid}/${colName}`);
      const snapshot = await fs.getDocs(colRef);
      result[colName] = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }

    // Also load user profile
    const profileRef = fs.doc(db, `users/${uid}`);
    const profileSnap = await fs.getDoc(profileRef);
    result.profile = profileSnap.exists() ? profileSnap.data() : null;

    console.info(`✅ Loaded all data for user ${uid} from Firestore (${COLLECTIONS.map(c => `${c}: ${result[c].length}`).join(', ')})`);
    return result;
  } catch (err) {
    console.error('Failed to load user data from Firestore:', err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// SAVE ALL USER DATA (FULL SYNC)
// ═══════════════════════════════════════════════════════════

/**
 * Save all state collections to Firestore under users/{uid}/...
 * Uses batched writes for efficiency.
 */
export async function saveAllUserData(uid, stateData) {
  if (!isFirebaseConfigured() || !db) return false;

  try {
    const fs = await getFirestoreMod();

    // Save user profile document
    const profileRef = fs.doc(db, `users/${uid}`);
    await fs.setDoc(profileRef, {
      name: stateData.currentUser?.name || '',
      email: stateData.currentUser?.email || '',
      role: stateData.currentUser?.role || 'User',
      avatar: stateData.currentUser?.avatar || 'U',
      lastSyncedAt: new Date().toISOString()
    }, { merge: true });

    // Save each collection
    for (const colName of COLLECTIONS) {
      const items = stateData[colName] || [];
      await _syncCollection(uid, colName, items, fs);
    }

    console.info(`✅ Saved all data for user ${uid} to Firestore`);
    return true;
  } catch (err) {
    console.error('Failed to save user data to Firestore:', err);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// SAVE A SINGLE COLLECTION (INCREMENTAL SYNC)
// ═══════════════════════════════════════════════════════════

/**
 * Sync a single collection for a user. Replaces all docs in that collection.
 * Call this when only one collection changes (e.g., prcs updated).
 */
export async function saveCollection(uid, collectionName, items) {
  if (!isFirebaseConfigured() || !db) return false;

  try {
    const fs = await getFirestoreMod();
    await _syncCollection(uid, collectionName, items, fs);
    return true;
  } catch (err) {
    console.error(`Failed to save ${collectionName} to Firestore:`, err);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// SAVE / DELETE SINGLE DOCUMENT
// ═══════════════════════════════════════════════════════════

/**
 * Save a single document to a user's collection.
 */
export async function saveDocument(uid, collectionName, docId, data) {
  if (!isFirebaseConfigured() || !db) return false;

  try {
    const fs = await getFirestoreMod();
    const docRef = fs.doc(db, `users/${uid}/${collectionName}/${docId}`);
    await fs.setDoc(docRef, data);
    return true;
  } catch (err) {
    console.error(`Failed to save doc ${collectionName}/${docId}:`, err);
    return false;
  }
}

/**
 * Delete a single document from a user's collection.
 */
export async function deleteDocument(uid, collectionName, docId) {
  if (!isFirebaseConfigured() || !db) return false;

  try {
    const fs = await getFirestoreMod();
    const docRef = fs.doc(db, `users/${uid}/${collectionName}/${docId}`);
    await fs.deleteDoc(docRef);
    return true;
  } catch (err) {
    console.error(`Failed to delete doc ${collectionName}/${docId}:`, err);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════

/**
 * Sync a local array of items to a Firestore sub-collection.
 * Strategy: Write all current items (set with merge), delete removed items.
 * Uses batched writes (max 500 per batch).
 */
async function _syncCollection(uid, collectionName, items, fs) {
  const colPath = `users/${uid}/${collectionName}`;

  // Get existing doc IDs
  const colRef = fs.collection(db, colPath);
  const existingSnap = await fs.getDocs(colRef);
  const existingIds = new Set(existingSnap.docs.map(d => d.id));

  // Build set of current item IDs
  const currentIds = new Set(items.map(item => item.id));

  // Batch write: add/update current items + delete removed ones
  const MAX_BATCH = 450; // Stay under Firestore's 500-write limit per batch
  let batch = fs.writeBatch(db);
  let opCount = 0;

  // Set/update all current items
  for (const item of items) {
    const docRef = fs.doc(db, `${colPath}/${item.id}`);
    batch.set(docRef, _sanitize(item));
    opCount++;
    if (opCount >= MAX_BATCH) {
      await batch.commit();
      batch = fs.writeBatch(db);
      opCount = 0;
    }
  }

  // Delete removed items
  for (const existingId of existingIds) {
    if (!currentIds.has(existingId)) {
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

/**
 * Sanitize an object for Firestore — remove undefined values and
 * ensure all nested objects are plain objects (not class instances).
 */
function _sanitize(obj) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => _sanitize(item));

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue; // Firestore doesn't accept undefined
    clean[key] = _sanitize(value);
  }
  return clean;
}
