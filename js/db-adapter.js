// =========================================================
// UNIFIED DATABASE ADAPTER (TURSO + FIRESTORE HYBRID)
// Routes reads/writes to Turso (Primary, 25M writes/mo) or Firestore (Fallback)
// =========================================================

import * as turso from './turso-db.js';
import * as firestore from './firestore-db.js';
import { isFirebaseConfigured } from './firebase-config.js';

let _activeProvider = null; // 'turso' | 'firestore' | 'local'

export function getActiveDbProvider() {
  if (_activeProvider) return _activeProvider;
  if (turso.isTursoConfigured()) {
    _activeProvider = 'turso';
  } else if (isFirebaseConfigured()) {
    _activeProvider = 'firestore';
  } else {
    _activeProvider = 'local';
  }
  return _activeProvider;
}

export function setActiveDbProvider(provider) {
  if (['turso', 'firestore', 'local'].includes(provider)) {
    _activeProvider = provider;
    console.info(`🔄 Active Database Provider switched to: ${provider.toUpperCase()}`);
  }
}

// ── DIRECT SAVES ──────────────────────────────────────────

export async function directSaveDoc(uid, collectionName, docId, docData) {
  const provider = getActiveDbProvider();
  if (provider === 'turso') {
    return turso.directSaveDoc(uid, collectionName, docId, docData);
  } else if (provider === 'firestore') {
    return firestore.directSaveDoc(uid, collectionName, docId, docData);
  }
  return true;
}

export async function directDeleteDoc(uid, collectionName, docId) {
  const provider = getActiveDbProvider();
  if (provider === 'turso') {
    return turso.directDeleteDoc(uid, collectionName, docId);
  } else if (provider === 'firestore') {
    return firestore.directDeleteDoc(uid, collectionName, docId);
  }
  return true;
}

export async function directSavePRC(uid, prc) {
  const provider = getActiveDbProvider();
  return provider === 'turso' ? turso.directSavePRC(uid, prc) : firestore.directSavePRC(uid, prc);
}

export async function directDeletePRC(uid, prcId) {
  const provider = getActiveDbProvider();
  return provider === 'turso' ? turso.directDeletePRC(uid, prcId) : firestore.directDeletePRC(uid, prcId);
}

export async function directSaveAllocation(uid, allocation) {
  const provider = getActiveDbProvider();
  return provider === 'turso' ? turso.directSaveAllocation(uid, allocation) : firestore.directSaveAllocation(uid, allocation);
}

export async function directDeleteAllocation(uid, allocId) {
  const provider = getActiveDbProvider();
  return provider === 'turso' ? turso.directDeleteAllocation(uid, allocId) : firestore.directDeleteAllocation(uid, allocId);
}

export async function directSaveRFQ(uid, rfq) {
  const provider = getActiveDbProvider();
  return provider === 'turso' ? turso.directSaveRFQ(uid, rfq) : firestore.directSaveRFQ(uid, rfq);
}

export async function directDeleteRFQ(uid, rfqId) {
  const provider = getActiveDbProvider();
  return provider === 'turso' ? turso.directDeleteRFQ(uid, rfqId) : firestore.directDeleteRFQ(uid, rfqId);
}

export async function directSaveTCD(uid, tcd) {
  const provider = getActiveDbProvider();
  return provider === 'turso' ? turso.directSaveTCD(uid, tcd) : firestore.directSaveTCD(uid, tcd);
}

export async function directDeleteTCD(uid, tcdId) {
  const provider = getActiveDbProvider();
  return provider === 'turso' ? turso.directDeleteTCD(uid, tcdId) : firestore.directDeleteTCD(uid, tcdId);
}

export async function directSavePOD(uid, pod) {
  const provider = getActiveDbProvider();
  return provider === 'turso' ? turso.directSavePOD(uid, pod) : firestore.directSavePOD(uid, pod);
}

export async function directDeletePOD(uid, podId) {
  const provider = getActiveDbProvider();
  return provider === 'turso' ? turso.directDeletePOD(uid, podId) : firestore.directDeletePOD(uid, podId);
}

export async function directSaveActivityLog(uid, log) {
  const provider = getActiveDbProvider();
  return provider === 'turso' ? turso.directSaveActivityLog(uid, log) : firestore.directSaveActivityLog(uid, log);
}

// ── BULK & FULL STATE OPERATIONS ──────────────────────────

export async function loadAllUserData(uid, forceServer = false) {
  const provider = getActiveDbProvider();
  if (provider === 'turso') {
    const data = await turso.loadAllUserData(uid, forceServer);
    if (data && (data.prcs?.length > 0 || data.allocations?.length > 0)) {
      return data;
    }
    // If Turso is configured but has 0 records, try loading from Firestore once for auto-migration
    if (isFirebaseConfigured()) {
      try {
        const firestoreData = await firestore.loadAllUserData(uid, forceServer);
        if (firestoreData && (firestoreData.prcs?.length > 0 || firestoreData.allocations?.length > 0)) {
          console.info(`🔄 Auto-migrating data from Firestore to Turso (${firestoreData.prcs?.length || 0} PRCs)...`);
          await turso.saveAllUserData(uid, firestoreData);
          return firestoreData;
        }
      } catch (e) {
        console.warn('Firestore fallback fetch warning:', e);
      }
    }
    return data;
  } else if (provider === 'firestore') {
    return firestore.loadAllUserData(uid, forceServer);
  }
  return null;
}

export async function saveCollection(uid, collectionName, items) {
  const provider = getActiveDbProvider();
  if (provider === 'turso') {
    return turso.saveCollection(uid, collectionName, items);
  } else if (provider === 'firestore') {
    return firestore.saveCollection(uid, collectionName, items);
  }
  return true;
}

export async function saveAllUserData(uid, stateData) {
  const provider = getActiveDbProvider();
  if (provider === 'turso') {
    return turso.saveAllUserData(uid, stateData);
  } else if (provider === 'firestore') {
    return firestore.saveAllUserData(uid, stateData);
  }
  return true;
}

// ── REALTIME SUBSCRIPTION ─────────────────────────────────

export async function subscribeToRealtimeUserData(uid, onUpdate) {
  const provider = getActiveDbProvider();
  if (provider === 'turso') {
    return turso.subscribeToRealtimeUserData(uid, onUpdate);
  } else if (provider === 'firestore') {
    return firestore.subscribeToRealtimeUserData(uid, onUpdate);
  }
  return () => {};
}

export function unsubscribeRealtimeUserData() {
  turso.unsubscribeRealtimeUserData();
  firestore.unsubscribeRealtimeUserData();
}
