// =========================================================
// GLOBAL STATE MANAGER (DIRECT FIRESTORE PERSISTENCE)
// Data is saved directly to Firebase Cloud Firestore per-user
// Supports Real-Time Multi-Device Synchronization & Safe ID Escaping
// =========================================================
import { calculateStatus, calculateMaterialStatus, buildStatusSummary, isPRCOrMaterialInactive, getRFQStatus, getAllocationStatus } from './status-engine.js';
export { isPRCOrMaterialInactive, getRFQStatus, getAllocationStatus };
import {
  loadAllUserData,
  saveAllUserData,
  saveCollection as firestoreSaveCollection,
  subscribeToRealtimeUserData,
  unsubscribeRealtimeUserData,
  directSavePRC,
  directDeletePRC,
  directSaveAllocation,
  directDeleteAllocation,
  directSaveRFQ,
  directDeleteRFQ,
  directSaveTCD,
  directDeleteTCD,
  directSavePOD,
  directDeletePOD,
  directSaveActivityLog,
  getActiveDbProvider,
  setActiveDbProvider
} from './db-adapter.js';
import { isFirebaseConfigured } from './firebase-config.js';
import { isTursoConfigured } from './turso-db.js';

import { clone } from './utils.js';

export const LOCAL_CACHE_KEY = 'PRC_PROCUREMENT_USER_CACHE';

export const DEFAULT_USER = {
  id: 'P3u4iJahurPp9xlULcHcowlwkS13',
  uid: 'P3u4iJahurPp9xlULcHcowlwkS13',
  name: 'Patil Dinay Dilip',
  email: 'dinay.patil@gmail.com',
  role: 'Super Admin',
  avatar: 'DP',
  department: 'Procurement & Sourcing',
  title: 'Chief Procurement Officer / Lead Admin'
};

const _listeners = {};

let _syncTimer = null;
const SYNC_DEBOUNCE_MS = 1000;

const state = {
  // Auth
  currentUser: { ...DEFAULT_USER },
  isAuthenticated: false,
  firebaseUser: null,
  theme: (typeof localStorage !== 'undefined' ? localStorage.getItem('theme') : 'light') || 'light',

  // Core Data Collections
  prcs: [],
  allocations: [],   // Allocation documents
  rfqs: [],          // RFQ documents
  tcds: [],          // TCD (Techno-Commercial Document)
  pods: [],          // Purchase Order Documents
  vendors: [],
  users: [],
  notifications: [],
  activityLogs: [],
  recordUndoHistory: [],

  // UI
  sidebarCollapsed: false,
  currentPage: 'dashboard',
  viewLevel: 'prc',
  expandedPRCIds: [],
  searchQuery: '',
  filters: {},
  columnFilters: {},
  tableColumnFilters: {},
  sortField: 'createdAt',
  sortDir: 'desc',
  allocSortField: 'prNumber',
  allocSortDir: 'desc',
  rfqSortField: 'allocationNumber',
  rfqSortDir: 'desc',
  tcdSortField: 'rfqNumber',
  tcdSortDir: 'desc',
  poSortField: 'poNumber',
  poSortDir: 'desc',
  vendorSortField: 'name',
  vendorSortDir: 'desc',
  currentPage_num: 1,
  pageSize: 25,

  // Computed
  statusSummary: {},
  totalMaterials: 0,
  poToday: 0,
  overdueCount: 0,
  avgProcurementDays: 0
};

export function getState() { return state; }

// ── LOCALSTORAGE CACHE ────────────────────────────────────

function _getCacheKey() {
  const uid = state.firebaseUser?.uid || state.currentUser?.uid || state.currentUser?.id || 'guest';
  return `${LOCAL_CACHE_KEY}_${uid}`;
}

function saveToLocalCache() {
  try {
    const dataToSave = {
      meta: {
        lastSavedAt: new Date().toISOString(),
        lastSavedBy: state.currentUser?.name || 'Unknown',
        uid: state.firebaseUser?.uid || state.currentUser?.uid || 'guest'
      },
      currentUser: state.currentUser,
      prcs: state.prcs,
      allocations: state.allocations,
      rfqs: state.rfqs,
      tcds: state.tcds,
      pods: state.pods,
      vendors: state.vendors,
      users: state.users,
      notifications: state.notifications,
      activityLogs: state.activityLogs,
      recordUndoHistory: state.recordUndoHistory || []
    };
    // Save ONLY to current user-scoped key to prevent cross-user data leakage
    localStorage.setItem(_getCacheKey(), JSON.stringify(dataToSave));
  } catch (err) {
    console.error('Failed to save local cache:', err);
  }
}

export function loadFromLocalCache() {
  try {
    const uidKey = _getCacheKey();
    const uidRaw = localStorage.getItem(uidKey);
    if (uidRaw) {
      try {
        const parsed = JSON.parse(uidRaw);
        if (parsed && Array.isArray(parsed.prcs)) {
          if (Array.isArray(parsed.recordUndoHistory)) {
            state.recordUndoHistory = parsed.recordUndoHistory;
          }
          console.info(`📦 Local cache loaded for current user key (${uidKey}): ${parsed.prcs?.length || 0} PRCs`);
          return parsed;
        }
      } catch(e) {}
    }
    return null;
  } catch (err) {
    console.error('Failed to load from local cache:', err);
    return null;
  }
}

export async function pushLocalDataToFirestore() {
  return pushLocalDataToDatabase();
}

export async function pushLocalDataToDatabase() {
  const { ensureFirebaseAuth } = await import('./firebase-config.js');
  let authUser = null;
  try {
    authUser = await ensureFirebaseAuth();
  } catch (e) {}

  if (authUser && (!state.firebaseUser || !state.firebaseUser.uid)) {
    await setAuthenticatedUser(authUser);
  }

  const uid = state.firebaseUser?.uid || authUser?.uid || 'default';
  const provider = getActiveDbProvider();

  try {
    console.info(`⚡ Pushing ${state.prcs.length} local records to ${provider.toUpperCase()} (uid: ${uid})...`);
    const { saveAllUserData } = await import('./db-adapter.js');
    const success = await saveAllUserData(uid, state);
    if (success) {
      saveToLocalCache();
      emit('*');
    }
    return { success, count: state.prcs.length, provider };
  } catch (err) {
    console.error(`Failed to push local data to ${provider}:`, err);
    return { success: false, reason: err.message };
  }
}

// ── FIRESTORE ASYNC SYNC ──────────────────────────────────

function _getEffectiveUid() {
  return state.firebaseUser?.uid || state.currentUser?.id || state.currentUser?.uid || 'default';
}

const _pendingCollections = new Set();

function scheduleFirestoreSync(changedCollections) {
  changedCollections.forEach(c => _pendingCollections.add(c));

  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(async () => {
    const { ensureFirebaseAuth, isFirebaseConfigured } = await import('./firebase-config.js');
    const authUser = await ensureFirebaseAuth();
    const uid = _getEffectiveUid() || authUser?.uid || 'default';

    const toSync = [..._pendingCollections];
    _pendingCollections.clear();

    for (const colName of toSync) {
      try {
        console.info(`☁️ Auto-syncing collection '${colName}' to Cloud Firestore (${(state[colName]||[]).length} items, uid: ${uid})...`);
        await firestoreSaveCollection(uid, colName, state[colName] || []);
      } catch (err) {
        console.error(`Firestore sync failed for ${colName}:`, err);
      }
    }
  }, 200);
}

// ── EXPORT / RESET ────────────────────────────────────────

export function exportDatabaseBackup() {
  const data = {
    meta: {
      exportedAt: new Date().toISOString(),
      exportedBy: state.currentUser?.name || 'Unknown',
      uid: state.firebaseUser?.uid || null
    },
    prcs: state.prcs,
    allocations: state.allocations,
    rfqs: state.rfqs,
    tcds: state.tcds,
    pods: state.pods,
    vendors: state.vendors,
    users: state.users
  };
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ProcureTrack_Firestore_Backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const exportCreatorDatabase = exportDatabaseBackup;

export async function restoreDatabaseBackup(jsonData) {
  if (!jsonData || typeof jsonData !== 'object') {
    throw new Error('Invalid JSON backup file format.');
  }

  // Handle both standard backup object { meta, prcs, allocations... } and direct PRC array
  const prcs = Array.isArray(jsonData.prcs) ? jsonData.prcs : (Array.isArray(jsonData) ? jsonData : []);
  const allocations = Array.isArray(jsonData.allocations) ? jsonData.allocations : [];
  const rfqs = Array.isArray(jsonData.rfqs) ? jsonData.rfqs : [];
  const tcds = Array.isArray(jsonData.tcds) ? jsonData.tcds : [];
  const pods = Array.isArray(jsonData.pods) ? jsonData.pods : [];
  const vendors = Array.isArray(jsonData.vendors) ? jsonData.vendors : [];
  const users = Array.isArray(jsonData.users) ? jsonData.users : [];
  const notifications = Array.isArray(jsonData.notifications) ? jsonData.notifications : [];
  const activityLogs = Array.isArray(jsonData.activityLogs) ? jsonData.activityLogs : [];

  if (prcs.length === 0 && Object.keys(jsonData).length === 0) {
    throw new Error('Backup file is empty or missing data collections.');
  }

  state.prcs = prcs;
  if (allocations.length) state.allocations = consolidateAllocations(allocations);
  else state.allocations = [];
  if (rfqs.length) state.rfqs = consolidateRFQs(rfqs);
  else state.rfqs = [];
  if (tcds.length) state.tcds = consolidateTCDs(tcds);
  else state.tcds = [];
  if (pods.length) state.pods = pods;
  else state.pods = [];
  if (vendors.length) state.vendors = vendors;
  if (users.length) state.users = users;
  if (notifications.length) state.notifications = notifications;
  if (activityLogs.length) state.activityLogs = activityLogs;

  // Recalculate status and summary
  state.prcs.forEach(prc => {
    prc.status = calculateStatus(prc);
    (prc.materials || []).forEach(mat => {
      mat.status = calculateMaterialStatus(mat, prc);
    });
  });
  state.statusSummary = buildStatusSummary(state.prcs);
  state.totalMaterials = state.prcs.reduce((acc, p) => acc + (p.materials ? p.materials.length : 0), 0);

  saveToLocalCache();

  // Sync restored data to Database (Turso & Firestore)
  const uid = _getEffectiveUid();
  const provider = getActiveDbProvider();

  try {
    const { saveAllUserData } = await import('./db-adapter.js');
    await saveAllUserData(uid, state);
    console.info(`⚡ Restored database successfully saved to ${provider.toUpperCase()}`);
  } catch (err) {
    console.warn(`Failed to push restored data to ${provider}:`, err);
  }

  // Also sync to Cloud Firestore collections
  const collectionsToSave = ['prcs', 'allocations', 'rfqs', 'tcds', 'pods', 'vendors', 'notifications', 'activityLogs'];
  for (const col of collectionsToSave) {
    if (state[col] && state[col].length > 0) {
      try {
        await firestoreSaveCollection(uid, col, state[col]);
      } catch (err) {
        console.warn(`Failed to sync restored collection '${col}' to Firestore:`, err);
      }
    }
  }

  addAuditLog({
    action: 'restore_json_backup',
    collection: 'Database',
    docId: 'full_restore',
    changes: {
      summary: `Database restored from JSON backup: ${prcs.length} PRCs, ${state.totalMaterials} materials, ${state.allocations.length} allocations, ${state.rfqs.length} RFQs, ${state.tcds.length} TCDs, ${state.pods.length} POs.`
    }
  });

  emit('*');
  return {
    success: true,
    prcCount: state.prcs.length,
    materialsCount: state.totalMaterials,
    allocationsCount: state.allocations.length,
    rfqCount: state.rfqs.length,
    tcdCount: state.tcds.length,
    podCount: state.pods.length,
    vendorCount: state.vendors.length
  };
}

export const restoreCreatorDatabase = restoreDatabaseBackup;


export async function resetDatabase() {
  const uid = state.firebaseUser?.uid || 'default';
  state.prcs = [];
  state.allocations = [];
  state.rfqs = [];
  state.tcds = [];
  state.pods = [];
  state.vendors = [];
  state.users = [];
  state.notifications = [];
  state.activityLogs = [];
  state.statusSummary = {};
  state.totalMaterials = 0;

  saveToLocalCache();
  const collections = ['prcs', 'allocations', 'rfqs', 'tcds', 'pods', 'vendors', 'notifications', 'activityLogs'];
  for (const col of collections) {
    await firestoreSaveCollection(uid, col, []);
  }
  emit('*');
}

export const resetCreatorDatabase = resetDatabase;

// ── STATE DISPATCH ────────────────────────────────────────

/**
 * Scans available PRCs and materials in state to enforce allocation document routing:
 * 1. If PRC/material data has ALL 3 allocation fields (Allocation number, Allocation date, Buyer Name),
 *    ensure an Allocation Document exists in state.allocations.
 * 2. If PRC has authorization metadata or is pending allocation, ensure its prStatus is set to 'Authorised'.
 */
export function reconcileAllocationRouting(prcs = state.prcs, allocations = state.allocations) {
  if (!Array.isArray(prcs) || !Array.isArray(allocations)) {
    return { prcs: prcs || [], allocations: allocations || [], prcChanged: false, allocChanged: false };
  }

  let prcChanged = false;
  let allocChanged = false;

  const existingAllocMap = new Map();
  allocations.forEach((a, idx) => {
    if (a && a.allocationNumber) {
      existingAllocMap.set(String(a.allocationNumber).trim().toUpperCase(), idx);
    }
  });

  const allocGroups = {};

  const updatedPrcs = prcs.map(prc => {
    if (!prc) return prc;
    let prcCopy = { ...prc };
    let prcModified = false;

    // Check authorization metadata
    const hasAuthMeta = !!(
      (prcCopy.authorizedBy && String(prcCopy.authorizedBy).trim()) ||
      (prcCopy.authorizedOn && String(prcCopy.authorizedOn).trim()) ||
      (prcCopy.authorisedBy && String(prcCopy.authorisedBy).trim()) ||
      (prcCopy.authorisedOn && String(prcCopy.authorisedOn).trim()) ||
      (prcCopy.authorizedDate && String(prcCopy.authorizedDate).trim()) ||
      (prcCopy.authorisedDate && String(prcCopy.authorisedDate).trim())
    );

    const s = String(prcCopy.prStatus || prcCopy.status || '').trim().toLowerCase();
    if (hasAuthMeta && (!s || s === 'pending')) {
      prcCopy.prStatus = 'Authorised';
      prcCopy.status = calculateStatus(prcCopy, prcCopy.materials || []);
      prcModified = true;
    }

    const mats = prcCopy.materials || [];

    // Reconcile top-level PRC workflow fields from materials if missing on PRC
    if (!prcCopy.allocationNumber) { const val = mats.find(m => m.allocationNumber)?.allocationNumber; if (val) { prcCopy.allocationNumber = val; prcModified = true; } }
    if (!prcCopy.allocationDate)   { const val = mats.find(m => m.allocationDate)?.allocationDate; if (val) { prcCopy.allocationDate = val; prcModified = true; } }
    if (!prcCopy.buyerName)        { const val = mats.find(m => m.buyerName || m.allocatedBy)?.buyerName || mats.find(m => m.buyerName || m.allocatedBy)?.allocatedBy; if (val) { prcCopy.buyerName = val; prcCopy.allocatedBy = val; prcModified = true; } }

    if (!prcCopy.rfqNumber) { const val = mats.find(m => m.rfqNumber)?.rfqNumber; if (val) { prcCopy.rfqNumber = val; prcModified = true; } }
    if (!prcCopy.rfqDate)   { const val = mats.find(m => m.rfqDate)?.rfqDate; if (val) { prcCopy.rfqDate = val; prcModified = true; } }

    if (!prcCopy.tcdNumber) { const val = mats.find(m => m.tcdNumber)?.tcdNumber; if (val) { prcCopy.tcdNumber = val; prcModified = true; } }
    if (!prcCopy.tcdDate)   { const val = mats.find(m => m.tcdDate)?.tcdDate; if (val) { prcCopy.tcdDate = val; prcModified = true; } }

    if (!prcCopy.tcdApproved && mats.some(m => m.tcdApproved)) {
      prcCopy.tcdApproved = true;
      prcCopy.tcdApprovedDate = mats.find(m => m.tcdApprovedDate)?.tcdApprovedDate || prcCopy.tcdDate;
      prcModified = true;
    }

    if (!prcCopy.poNumber) { const val = mats.find(m => m.poNumber)?.poNumber; if (val) { prcCopy.poNumber = val; prcModified = true; } }
    if (!prcCopy.poDate)   { const val = mats.find(m => m.poDate)?.poDate; if (val) { prcCopy.poDate = val; prcModified = true; } }
    if (!prcCopy.vendorName) { const val = mats.find(m => m.vendor || m.vendorName)?.vendor || mats.find(m => m.vendor || m.vendorName)?.vendorName; if (val) { prcCopy.vendorName = val; prcModified = true; } }

    // If TCD is generated / approved or PO issued, Offers are Received!
    if (prcCopy.tcdNumber || prcCopy.tcdApproved || prcCopy.poNumber || mats.some(m => m.tcdNumber || m.tcdApproved || m.poNumber)) {
      if (!prcCopy.offersReceived) {
        prcCopy.offersReceived = true;
        prcCopy.offersReceivedDate = prcCopy.tcdDate || prcCopy.tcdApprovedDate || prcCopy.rfqDate || prcCopy.createdAt;
        prcModified = true;
      }
    }

    mats.forEach(m => {
      const allocNum = String(m.allocationNumber || prcCopy.allocationNumber || '').trim();
      const allocDate = String(m.allocationDate || prcCopy.allocationDate || '').trim();
      const buyerName = String(m.buyerName || m.allocatedBy || prcCopy.buyerName || prcCopy.allocatedBy || '').trim();

      if (allocNum && allocDate && buyerName) {
        const groupKey = allocNum.toUpperCase();
        if (!allocGroups[groupKey]) {
          allocGroups[groupKey] = {
            allocationNumber: allocNum,
            allocationDate: allocDate,
            buyerName: buyerName,
            items: []
          };
        }
        allocGroups[groupKey].items.push({
          prcId: prcCopy.id,
          materialId: m.id,
          quantity: parseFloat(m.quantity) || 0,
          matCode: m.matCode,
          description: m.description,
          unit: m.unit || '',
          prNumber: prcCopy.prNumber
        });
      }
    });

    if (prcModified) {
      prcCopy.status = calculateStatus(prcCopy, prcCopy.materials || []);
      prcChanged = true;
    }
    return prcCopy;
  });

  const updatedAllocations = [...allocations];

  Object.values(allocGroups).forEach(group => {
    if (!group.items.length) return;
    const groupKey = group.allocationNumber.toUpperCase();

    if (existingAllocMap.has(groupKey)) {
      const idx = existingAllocMap.get(groupKey);
      const existingAlloc = updatedAllocations[idx];
      const existingItems = existingAlloc.items || [];
      const itemKeySet = new Set(existingItems.map(i => `${i.prcId}::${i.materialId}`));

      let itemsAdded = false;
      const mergedItems = [...existingItems];

      group.items.forEach(it => {
        const key = `${it.prcId}::${it.materialId}`;
        if (!itemKeySet.has(key)) {
          mergedItems.push(it);
          itemKeySet.add(key);
          itemsAdded = true;
        }
      });

      if (itemsAdded) {
        updatedAllocations[idx] = {
          ...existingAlloc,
          items: mergedItems
        };
        allocChanged = true;
      }
    } else {
      // Create new allocation document
      const newAlloc = {
        id: `alloc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        allocationNumber: group.allocationNumber,
        allocationDate: group.allocationDate,
        buyerName: group.buyerName,
        allocatedBy: group.buyerName,
        items: group.items,
        createdAt: new Date().toISOString()
      };
      updatedAllocations.push(newAlloc);
      existingAllocMap.set(groupKey, updatedAllocations.length - 1);
      allocChanged = true;
    }
  });

  return {
    prcs: updatedPrcs,
    allocations: consolidateAllocations(updatedAllocations),
    prcChanged,
    allocChanged
  };
}

/** Consolidate multiple allocation records with the same allocationNumber into a single master allocation */
export function consolidateAllocations(allocations = []) {
  if (!Array.isArray(allocations) || allocations.length <= 1) return allocations || [];

  const groupMap = new Map();
  const result = [];

  allocations.forEach(alloc => {
    if (!alloc) return;
    const num = String(alloc.allocationNumber || '').trim();
    if (!num) {
      result.push(alloc);
      return;
    }
    const key = num.toUpperCase();
    if (!groupMap.has(key)) {
      groupMap.set(key, []);
    }
    groupMap.get(key).push(alloc);
  });

  groupMap.forEach(group => {
    if (group.length === 1) {
      result.push(group[0]);
      return;
    }

    // Merge multiple allocation records with same number
    const master = { ...group[0] };
    const itemMap = new Map();

    group.forEach(record => {
      if (!master.allocationDate && record.allocationDate) master.allocationDate = record.allocationDate;
      if (!master.buyerName && record.buyerName) master.buyerName = record.buyerName;
      if (!master.allocatedBy && record.allocatedBy) master.allocatedBy = record.allocatedBy;
      if (record.createdAt && (!master.createdAt || new Date(record.createdAt) < new Date(master.createdAt))) {
        master.createdAt = record.createdAt;
      }
      if (record.updatedAt && (!master.updatedAt || new Date(record.updatedAt) > new Date(master.updatedAt))) {
        master.updatedAt = record.updatedAt;
        if (record.updatedBy) master.updatedBy = record.updatedBy;
      }

      (record.items || []).forEach(item => {
        const itemKey = `${item.prcId || ''}::${item.materialId || item.matCode || ''}`;
        if (!itemMap.has(itemKey)) {
          itemMap.set(itemKey, { ...item, allocationId: master.id, allocationNumber: master.allocationNumber });
        } else {
          const existingItem = itemMap.get(itemKey);
          existingItem.quantity = Math.max(parseFloat(existingItem.quantity) || 0, parseFloat(item.quantity) || 0);
          if (!existingItem.description && item.description) existingItem.description = item.description;
          if (!existingItem.unit && item.unit) existingItem.unit = item.unit;
          if (!existingItem.prNumber && item.prNumber) existingItem.prNumber = item.prNumber;
        }
      });
    });

    master.items = Array.from(itemMap.values());
    result.push(master);
  });

  return result;
}

/** Consolidate multiple RFQ records with the same rfqNumber into a single master RFQ */
export function consolidateRFQs(rfqs = []) {
  if (!Array.isArray(rfqs) || rfqs.length <= 1) return rfqs || [];

  const groupMap = new Map();
  const result = [];

  rfqs.forEach(rfq => {
    if (!rfq) return;
    const num = String(rfq.rfqNumber || '').trim();
    if (!num) {
      result.push(rfq);
      return;
    }
    const key = num.toUpperCase();
    if (!groupMap.has(key)) {
      groupMap.set(key, []);
    }
    groupMap.get(key).push(rfq);
  });

  groupMap.forEach(group => {
    if (group.length === 1) {
      result.push(group[0]);
      return;
    }

    // Merge multiple RFQ records with same number
    const master = { ...group[0] };
    const itemMap = new Map();

    group.forEach(record => {
      if (!master.rfqDate && record.rfqDate) master.rfqDate = record.rfqDate;
      if (record.isClosed || String(record.status || '').trim().toLowerCase() === 'closed') {
        master.isClosed = true;
        master.status = 'Closed';
      }
      if (record.offersReceived) master.offersReceived = true;
      if (record.createdAt && (!master.createdAt || new Date(record.createdAt) < new Date(master.createdAt))) {
        master.createdAt = record.createdAt;
      }
      if (record.updatedAt && (!master.updatedAt || new Date(record.updatedAt) > new Date(master.updatedAt))) {
        master.updatedAt = record.updatedAt;
        if (record.updatedBy) master.updatedBy = record.updatedBy;
      }

      (record.items || []).forEach(item => {
        const itemKey = `${item.prcId || ''}::${item.materialId || item.matCode || ''}`;
        if (!itemMap.has(itemKey)) {
          itemMap.set(itemKey, { ...item });
        } else {
          const existingItem = itemMap.get(itemKey);
          existingItem.quantity = Math.max(parseFloat(existingItem.quantity) || 0, parseFloat(item.quantity) || 0);
          if (!existingItem.description && item.description) existingItem.description = item.description;
          if (!existingItem.unit && item.unit) existingItem.unit = item.unit;
          if (!existingItem.prNumber && item.prNumber) existingItem.prNumber = item.prNumber;
        }
      });
    });

    master.items = Array.from(itemMap.values());
    result.push(master);
  });

  return result;
}

/** Consolidate multiple TCD records with the same tcdNumber into a single master TCD */
export function consolidateTCDs(tcds = []) {
  if (!Array.isArray(tcds) || tcds.length <= 1) return tcds || [];

  const groupMap = new Map();
  const result = [];

  tcds.forEach(tcd => {
    if (!tcd) return;
    const num = String(tcd.tcdNumber || '').trim();
    if (!num) {
      result.push(tcd);
      return;
    }
    const key = num.toUpperCase();
    if (!groupMap.has(key)) {
      groupMap.set(key, []);
    }
    groupMap.get(key).push(tcd);
  });

  groupMap.forEach(group => {
    if (group.length === 1) {
      result.push(group[0]);
      return;
    }

    // Merge multiple TCD records with same number
    const master = { ...group[0] };
    const vendorMap = new Map();

    group.forEach(record => {
      if (!master.tcdDate && record.tcdDate) master.tcdDate = record.tcdDate;
      if (!master.rfqNumber && record.rfqNumber) master.rfqNumber = record.rfqNumber;
      if (!master.rfqId && record.rfqId) master.rfqId = record.rfqId;
      if (record.approved) {
        master.approved = true;
        master.approvedDate = master.approvedDate || record.approvedDate;
        master.approvedBy = master.approvedBy || record.approvedBy;
        master.status = 'Approved';
      }
      if (record.createdAt && (!master.createdAt || new Date(record.createdAt) < new Date(master.createdAt))) {
        master.createdAt = record.createdAt;
      }
      if (record.updatedAt && (!master.updatedAt || new Date(record.updatedAt) > new Date(master.updatedAt))) {
        master.updatedAt = record.updatedAt;
        if (record.updatedBy) master.updatedBy = record.updatedBy;
      }

      const vas = record.vendorAllocations || record.vendors || [];
      vas.forEach(va => {
        const vKey = String(va.vendorName || '').trim().toUpperCase();
        if (!vendorMap.has(vKey)) {
          vendorMap.set(vKey, {
            ...va,
            items: [...(va.items || [])]
          });
        } else {
          const existingVA = vendorMap.get(vKey);
          const existingItemKeys = new Set(existingVA.items.map(i => `${i.prcId}::${i.materialId}`));
          (va.items || []).forEach(it => {
            const iKey = `${it.prcId}::${it.materialId}`;
            if (!existingItemKeys.has(iKey)) {
              existingVA.items.push({ ...it });
              existingItemKeys.add(iKey);
            } else {
              const exIt = existingVA.items.find(i => `${i.prcId}::${i.materialId}` === iKey);
              if (exIt) {
                exIt.quantity = Math.max(parseFloat(exIt.quantity) || 0, parseFloat(it.quantity) || 0);
                if (it.unitPrice) exIt.unitPrice = it.unitPrice;
                if (it.totalPrice) exIt.totalPrice = it.totalPrice;
              }
            }
          });
          if (va.quotedAmount) existingVA.quotedAmount = Math.max(existingVA.quotedAmount || 0, va.quotedAmount);
        }
      });
    });

    master.vendorAllocations = Array.from(vendorMap.values());
    master.vendors = master.vendorAllocations;
    result.push(master);
  });

  return result;
}

/** Consolidate multiple POD records with the same poNumber or (tcdNumber + vendor) into a single master POD */
export function consolidatePODs(pods = []) {
  if (!Array.isArray(pods) || pods.length === 0) return pods || [];

  const groupMap = new Map();
  const result = [];

  pods.forEach(pod => {
    if (!pod) return;
    const poNum = String(pod.poNumber || '').trim().toUpperCase();
    const tcdNum = String(pod.tcdNumber || '').trim().toUpperCase();
    const vendor = String(pod.vendorName || '').trim().toUpperCase();

    const groupKey = poNum ? `PO::${poNum}` : (tcdNum && vendor ? `TCD::${tcdNum}::${vendor}` : `ID::${pod.id || Math.random()}`);
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, []);
    }
    groupMap.get(groupKey).push(pod);
  });

  groupMap.forEach(group => {
    if (group.length === 1) {
      result.push(group[0]);
      return;
    }

    const master = { ...group[0] };
    const itemMap = new Map();

    group.forEach(record => {
      if (!master.poNumber && record.poNumber) master.poNumber = record.poNumber;
      if (!master.poDate && record.poDate) master.poDate = record.poDate;
      if (!master.vendorName && record.vendorName) master.vendorName = record.vendorName;
      if (!master.tcdNumber && record.tcdNumber) master.tcdNumber = record.tcdNumber;
      if (!master.tcdId && record.tcdId) master.tcdId = record.tcdId;
      if (master.poNumber) master.status = 'Issued';

      if (record.createdAt && (!master.createdAt || new Date(record.createdAt) < new Date(master.createdAt))) {
        master.createdAt = record.createdAt;
      }
      if (record.updatedAt && (!master.updatedAt || new Date(record.updatedAt) > new Date(master.updatedAt))) {
        master.updatedAt = record.updatedAt;
        if (record.updatedBy) master.updatedBy = record.updatedBy;
      }

      (record.items || []).forEach(item => {
        const itemKey = `${item.prcId || item.prNumber || ''}::${item.materialId || item.matCode || ''}`;
        if (!itemMap.has(itemKey)) {
          itemMap.set(itemKey, { ...item });
        } else {
          const ex = itemMap.get(itemKey);
          ex.quantity = Math.max(parseFloat(ex.quantity) || 0, parseFloat(item.quantity) || 0);
          if (!ex.description && item.description) ex.description = item.description;
          if (!ex.unit && item.unit) ex.unit = item.unit;
          if (!ex.prNumber && item.prNumber) ex.prNumber = item.prNumber;
          if (!ex.matCode && item.matCode) ex.matCode = item.matCode;
        }
      });
    });

    master.items = Array.from(itemMap.values());
    result.push(master);
  });

  return result;
}

/** Get all material items for a POD document (resolving from PRCs/TCDs if items array is empty) */
export function getPODItems(pod, prcs = state.prcs, tcds = state.tcds) {
  if (!pod) return [];
  if (Array.isArray(pod.items) && pod.items.length > 0) {
    return pod.items;
  }

  const items = [];
  const poNum = String(pod.poNumber || '').trim().toUpperCase();
  const tcdNum = String(pod.tcdNumber || '').trim().toUpperCase();
  const vendor = String(pod.vendorName || '').trim().toUpperCase();

  if (poNum) {
    (prcs || []).forEach(p => {
      (p.materials || []).forEach(m => {
        if (String(m.poNumber || p.poNumber || '').trim().toUpperCase() === poNum) {
          items.push({
            prcId: p.id,
            prNumber: p.prNumber,
            materialId: m.id,
            matCode: m.matCode,
            description: m.description,
            quantity: parseFloat(m.quantity) || 0,
            unit: m.unit || '',
            vendorName: m.vendorName || m.vendor || p.vendorName || p.vendor || pod.vendorName
          });
        }
      });
    });
  } else if (tcdNum) {
    const matchingTCD = (tcds || []).find(t => String(t.tcdNumber || '').trim().toUpperCase() === tcdNum);
    if (matchingTCD) {
      const va = (matchingTCD.vendorAllocations || matchingTCD.vendors || []).find(v => String(v.vendorName || v.name || '').trim().toUpperCase() === vendor);
      if (va && Array.isArray(va.items) && va.items.length > 0) {
        return va.items;
      }
    }
    (prcs || []).forEach(p => {
      (p.materials || []).forEach(m => {
        const matTcd = String(m.tcdNumber || p.tcdNumber || '').trim().toUpperCase();
        const matVendor = String(m.vendorName || m.vendor || p.vendorName || p.vendor || '').trim().toUpperCase();
        if (matTcd === tcdNum && (!vendor || matVendor === vendor)) {
          items.push({
            prcId: p.id,
            prNumber: p.prNumber,
            materialId: m.id,
            matCode: m.matCode,
            description: m.description,
            quantity: parseFloat(m.quantity) || 0,
            unit: m.unit || '',
            vendorName: m.vendorName || m.vendor || p.vendorName || p.vendor || pod.vendorName
          });
        }
      });
    });
  }

  return items;
}

/** Reconcile POD routing across all PRCs, TCDs, and POD records */
export function reconcilePODRouting(prcs = state.prcs, pods = state.pods, tcds = state.tcds) {
  if (!Array.isArray(prcs) || !Array.isArray(pods)) {
    return { prcs: prcs || [], pods: pods || [], changed: false };
  }

  let changed = false;
  const updatedPods = [...pods];

  // 1. Fill items on existing PODs if items are empty or missing
  updatedPods.forEach((pod, idx) => {
    const currentItems = pod.items || [];
    const resolvedItems = getPODItems(pod, prcs, tcds);
    if (resolvedItems.length > currentItems.length) {
      updatedPods[idx] = {
        ...pod,
        items: resolvedItems
      };
      changed = true;
    }
  });

  // 2. Synthesize PODs for materials with PO Numbers that don't have a POD record yet
  const poGroups = {};
  prcs.forEach(p => {
    (p.materials || []).forEach(m => {
      const poNum = String(m.poNumber || p.poNumber || '').trim();
      const vendorName = String(m.vendorName || m.vendor || p.vendorName || p.vendor || '').trim();
      const poDate = String(m.poDate || p.poDate || '').trim();
      const tcdNum = String(m.tcdNumber || p.tcdNumber || '').trim();

      if (poNum) {
        const key = poNum.toUpperCase();
        if (!poGroups[key]) {
          poGroups[key] = {
            poNumber: poNum,
            poDate: poDate,
            vendorName: vendorName,
            tcdNumber: tcdNum,
            items: []
          };
        }
        poGroups[key].items.push({
          prcId: p.id,
          materialId: m.id,
          prNumber: p.prNumber,
          matCode: m.matCode,
          description: m.description,
          quantity: parseFloat(m.quantity) || 0,
          unit: m.unit || '',
          vendorName: vendorName
        });
      }
    });
  });

  Object.values(poGroups).forEach(group => {
    const existing = updatedPods.find(p => String(p.poNumber || '').trim().toUpperCase() === group.poNumber.toUpperCase());
    if (!existing) {
      updatedPods.push({
        id: `pod-auto-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        poNumber: group.poNumber,
        poDate: group.poDate || '',
        vendorName: group.vendorName || '',
        tcdId: '',
        tcdNumber: group.tcdNumber || '',
        items: group.items,
        status: 'Issued',
        createdAt: new Date().toISOString(),
        createdBy: 'System'
      });
      changed = true;
    }
  });

  return {
    prcs,
    pods: consolidatePODs(updatedPods),
    changed
  };
}

export function setState(patch) {
  if (patch.allocations) {
    patch.allocations = consolidateAllocations(patch.allocations);
  }
  if (patch.rfqs) {
    patch.rfqs = consolidateRFQs(patch.rfqs);
  }
  if (patch.tcds) {
    patch.tcds = consolidateTCDs(patch.tcds);
  }
  if (patch.pods) {
    patch.pods = consolidatePODs(patch.pods);
  }

  Object.assign(state, patch);

  if (patch.prcs || patch.allocations) {
    const reconciled = reconcileAllocationRouting(state.prcs, state.allocations);
    if (reconciled.allocChanged || reconciled.prcChanged) {
      state.prcs = reconciled.prcs;
      state.allocations = consolidateAllocations(reconciled.allocations);
    }
  }

  if (patch.prcs || patch.pods || patch.tcds) {
    const podRec = reconcilePODRouting(state.prcs, state.pods, state.tcds);
    if (podRec.changed) {
      state.pods = podRec.pods;
    }
  }

  Object.keys(patch).forEach(key => emit(key));
  emit('*');

  const dataKeys = ['prcs', 'allocations', 'rfqs', 'tcds', 'pods', 'vendors', 'users', 'notifications', 'activityLogs'];
  const changedDataKeys = Object.keys(patch).filter(k => dataKeys.includes(k));

  if (changedDataKeys.length > 0) {
    saveToLocalCache();
    scheduleFirestoreSync(changedDataKeys);
  }
}

export function on(event, fn) {
  if (!_listeners[event]) _listeners[event] = [];
  _listeners[event].push(fn);
}

export function off(event, fn) {
  if (!_listeners[event]) return;
  _listeners[event] = _listeners[event].filter(f => f !== fn);
}

function emit(event) {
  (_listeners[event] || []).forEach(fn => {
    try { fn(state); } catch(e) { console.error('State listener error:', e); }
  });
}

// ── INITIALISE APP DATA (AUTOMATIC BIDIRECTIONAL SYNC) ────

export async function initAppData(forceClean = false) {
  let prcs = [], allocations = [], rfqs = [], tcds = [], pods = [];
  let vendors = [], users = [], notifications = [], activityLogs = [];
  let loadedFrom = 'empty';

  // Load local cache FIRST (before auth potentially changes the UID)
  const cached = loadFromLocalCache();

  const { ensureFirebaseAuth, isFirebaseConfigured } = await import('./firebase-config.js');
  const authUser = await ensureFirebaseAuth();
  if (authUser && (!state.firebaseUser || !state.firebaseUser.uid)) {
    await setAuthenticatedUser(authUser);
  }
  const uid = state.firebaseUser?.uid || authUser?.uid || 'default';

  if (!forceClean) {
    // 1. Direct Firestore fetch
    try {
      const firestoreData = await loadAllUserData(uid, true);
      if (firestoreData) {
        prcs = firestoreData.prcs || [];
        allocations = firestoreData.allocations || [];
        rfqs = firestoreData.rfqs || [];
        tcds = firestoreData.tcds || [];
        pods = firestoreData.pods || [];
        vendors = firestoreData.vendors || [];
        users = firestoreData.users || [];
        notifications = firestoreData.notifications || [];
        activityLogs = firestoreData.activityLogs || [];
        loadedFrom = 'firestore';

        // AUTOMATIC BACKGROUND SYNC / MIGRATION:
        // If Firestore is empty (0 PRCs) but local cache on this PC has PRCs:
        // Automatically sync all local cache records to Cloud Firestore in background!
        if (cached && Array.isArray(cached.prcs) && cached.prcs.length > 0) {
          if (prcs.length === 0) {
            console.info(`☁️ Auto-syncing ${cached.prcs.length} local records to Cloud Firestore in background...`);
            prcs = cached.prcs;
            allocations = cached.allocations || allocations;
            rfqs = cached.rfqs || rfqs;
            tcds = cached.tcds || tcds;
            pods = cached.pods || pods;
            vendors = cached.vendors || vendors;
            users = cached.users || users;
            notifications = cached.notifications || notifications;
            activityLogs = cached.activityLogs || activityLogs;
            loadedFrom = 'local-migrated-to-firestore';

            // Push automatically in background
            setTimeout(() => {
              pushLocalDataToFirestore();
            }, 100);
          } else {
            // Check if there are local PRCs missing in Firestore
            const firestorePrcIds = new Set(prcs.map(p => p.id || p.prNumber));
            const missingLocalPrcs = cached.prcs.filter(p => !firestorePrcIds.has(p.id || p.prNumber));
            if (missingLocalPrcs.length > 0) {
              console.info(`☁️ Auto-merging ${missingLocalPrcs.length} local records missing in Firestore...`);
              prcs = [...prcs, ...missingLocalPrcs];
              setTimeout(() => {
                pushLocalDataToFirestore();
              }, 100);
            }
          }
        }
      }
    } catch (err) {
      console.warn('Firestore load failed, falling back to cache:', err);
    }

    // 2. Cache fallback if offline
    if (loadedFrom === 'empty' && cached && Array.isArray(cached.prcs)) {
      prcs = cached.prcs;
      allocations = consolidateAllocations(cached.allocations || []);
      rfqs = consolidateRFQs(cached.rfqs || []);
      tcds = consolidateTCDs(cached.tcds || []);
      pods = cached.pods || [];
      vendors = cached.vendors || [];
      users = cached.users || [];
      notifications = cached.notifications || [];
      activityLogs = cached.activityLogs || [];
      loadedFrom = 'local-cache';
    }
  }

  // Reconcile allocation & POD document routing for all available data
  const reconciled = reconcileAllocationRouting(prcs, allocations);
  prcs = reconciled.prcs;
  allocations = consolidateAllocations(reconciled.allocations);
  rfqs = consolidateRFQs(rfqs);
  tcds = consolidateTCDs(tcds);
  const podRec = reconcilePODRouting(prcs, pods, tcds);
  pods = podRec.pods;

  const summary = buildStatusSummary(prcs);
  const totalMats = prcs.reduce((acc, p) => acc + (p.materials || []).length, 0);

  state.prcs = prcs;
  state.allocations = allocations;
  state.rfqs = rfqs;
  state.tcds = tcds;
  state.pods = pods;
  state.vendors = vendors;
  state.users = users;
  state.notifications = notifications;
  state.activityLogs = activityLogs;
  state.statusSummary = summary;
  state.totalMaterials = totalMats;
  state.poToday = prcs.filter(p => p.poDate === new Date().toISOString().split('T')[0]).length;
  state.overdueCount = 0;
  state.avgProcurementDays = 0;

  // 1. Check if a specific user session was saved on this browser
  let sessionRestored = false;
  try {
    const savedUserJson = localStorage.getItem('PRC_LOGGED_IN_USER');
    if (savedUserJson) {
      const savedUser = JSON.parse(savedUserJson);
      if (savedUser && (savedUser.email || savedUser.name)) {
        // Find latest fresh version in users roster if possible
        const freshUser = users.find(u =>
          (u.email && u.email.toLowerCase() === (savedUser.email || '').toLowerCase()) ||
          (u.id && u.id === savedUser.id)
        );
        state.currentUser = {
          ...DEFAULT_USER,
          ...savedUser,
          ...(freshUser || {}),
          uid: (freshUser || savedUser).id || (freshUser || savedUser).uid || 'default'
        };
        state.isAuthenticated = true;
        sessionRestored = true;
      }
    }
  } catch (e) {
    console.warn("Session restore warning:", e);
  }

  // 2. If no saved session, default to primary Super Admin from database
  if (!sessionRestored && users.length > 0) {
    const primaryUser = users.find(u => u.role === 'Super Admin' || (u.email && u.email.includes('dinay'))) || users[0];
    if (primaryUser) {
      state.currentUser = {
        ...DEFAULT_USER,
        ...primaryUser,
        uid: primaryUser.id || primaryUser.uid || 'default'
      };
      state.isAuthenticated = true;
    }
  }

  saveToLocalCache();
  emit('*');

  // Start Real-Time continuous live subscription across all PCs
  subscribeToRealtimeUserData(uid, (colName, items) => {
    handleRealtimeUpdate(colName, items);
  });
}

export const initDemoData = initAppData;

// ── AUTH STATE SETTERS ────────────────────────────────────

export async function loginUser(emailOrId, password) {
  if (!emailOrId) return { success: false, reason: 'Email or User ID is required.' };
  if (!password || !String(password).trim()) {
    return { success: false, reason: 'Password is required to sign in.' };
  }

  const norm = String(emailOrId).trim().toLowerCase();
  // Match in state.users roster
  let user = state.users.find(u =>
    (u.email && u.email.toLowerCase() === norm) ||
    (u.id && String(u.id).toLowerCase() === norm) ||
    (u.uid && String(u.uid).toLowerCase() === norm) ||
    (u.name && u.name.toLowerCase() === norm)
  );

  if (!user) {
    // If not in state.users yet, query Turso directly
    try {
      const { executeTursoPipeline, isTursoConfigured } = await import('./turso-db.js');
      if (isTursoConfigured()) {
        const res = await executeTursoPipeline([
          {
            sql: "SELECT data FROM users WHERE LOWER(email) = ? OR id = ? LIMIT 1;",
            args: [norm, norm]
          }
        ]);
        const row = res.results[0]?.response?.result?.rows?.[0];
        if (row && row[0]?.value) {
          user = JSON.parse(row[0].value);
        }
      }
    } catch (e) {
      console.warn("Turso direct user lookup warning:", e);
    }
  }

  if (!user) {
    return {
      success: false,
      reason: 'No account found with this email address. Please check your email or click "Create User".'
    };
  }

  // Strictly check password
  const expectedPassword = user.password || '123456';
  if (String(password).trim() !== String(expectedPassword).trim()) {
    return {
      success: false,
      reason: 'Incorrect password. Please enter the valid password for this account.'
    };
  }

  state.currentUser = {
    ...DEFAULT_USER,
    ...user,
    uid: user.id || user.uid || 'user-default'
  };
  state.isAuthenticated = true;

  try {
    localStorage.setItem('PRC_LOGGED_IN_USER', JSON.stringify(state.currentUser));
  } catch (e) {}

  saveToLocalCache();
  emit('currentUser');
  emit('*');

  return { success: true, user: state.currentUser };
}

export function logoutUser() {
  try {
    localStorage.removeItem('PRC_LOGGED_IN_USER');
  } catch (e) {}
  state.isAuthenticated = false;
  state.currentUser = { ...DEFAULT_USER };
  saveToLocalCache();
  emit('currentUser');
  emit('*');
}

export async function setAuthenticatedUser(firebaseUser) {
  if (!firebaseUser) return;
  
  if (state.firebaseUser?.uid !== firebaseUser.uid) {
    // Clear previous user's in-memory data arrays when switching accounts
    state.prcs = [];
    state.allocations = [];
    state.rfqs = [];
    state.tcds = [];
    state.pods = [];
    state.vendors = [];
    state.users = [];
    state.notifications = [];
    state.activityLogs = [];
  }

  // Attempt to load cached data for this user
  const cached = loadFromLocalCache();
  const cachedUser = cached?.currentUser || {};

  state.firebaseUser = firebaseUser;
  state.isAuthenticated = true;
  state.currentUser = {
    id: firebaseUser.uid,
    uid: firebaseUser.uid,
    name: firebaseUser.name || firebaseUser.displayName || cachedUser.name || firebaseUser.email?.split('@')[0] || 'User',
    email: firebaseUser.email || cachedUser.email || '',
    role: firebaseUser.role || cachedUser.role || 'User',
    avatar: firebaseUser.avatar || cachedUser.avatar || (firebaseUser.name || firebaseUser.email || 'U').slice(0, 2).toUpperCase(),
    department: firebaseUser.department || cachedUser.department || '',
    title: firebaseUser.title || cachedUser.title || '',
    phone: firebaseUser.phone || cachedUser.phone || ''
  };
  if (cached) {
    state.prcs = cached.prcs || [];
    state.allocations = consolidateAllocations(cached.allocations || []);
    state.rfqs = consolidateRFQs(cached.rfqs || []);
    state.tcds = consolidateTCDs(cached.tcds || []);
    state.pods = consolidatePODs(cached.pods || []);
    const podRec = reconcilePODRouting(state.prcs, state.pods, state.tcds);
    state.pods = podRec.pods;
    state.vendors = cached.vendors || [];
    state.users = cached.users || [];
    state.notifications = cached.notifications || [];
    state.activityLogs = cached.activityLogs || [];
    state.statusSummary = buildStatusSummary(state.prcs);
    state.totalMaterials = state.prcs.reduce((acc, p) => acc + (p.materials || []).length, 0);
  }

  emit('currentUser');
  emit('isAuthenticated');
  emit('*');

  // Start Real-Time Multi-Device Sync with Firestore for THIS user
  if (isFirebaseConfigured() && firebaseUser.uid) {
    subscribeToRealtimeUserData(firebaseUser.uid, (colName, items) => {
      handleRealtimeUpdate(colName, items);
    });
  }
}

function handleRealtimeUpdate(colName, items) {
  if (state[colName] !== undefined && Array.isArray(items)) {
    let processedItems = items;
    if (colName === 'allocations') processedItems = consolidateAllocations(items);
    if (colName === 'rfqs') processedItems = consolidateRFQs(items);
    if (colName === 'tcds') processedItems = consolidateTCDs(items);
    if (colName === 'pods') processedItems = consolidatePODs(items);

    // Only update if incoming items differ from current local state
    const currentList = state[colName] || [];
    const isDifferent = processedItems.length !== currentList.length ||
      JSON.stringify(processedItems.map(i => i.id).sort()) !== JSON.stringify(currentList.map(i => i.id).sort());

    if (isDifferent || colName === 'prcs') {
      state[colName] = processedItems;
      if (colName === 'prcs') {
        state.statusSummary = buildStatusSummary(items);
        state.totalMaterials = items.reduce((acc, p) => acc + (p.materials || []).length, 0);
        state.poToday = items.filter(p => p.poDate === new Date().toISOString().split('T')[0]).length;
        const podRec = reconcilePODRouting(state.prcs, state.pods, state.tcds);
        if (podRec.changed) state.pods = podRec.pods;
      }
      saveToLocalCache();
      emit(colName);
      emit('*');
    }
  }
}

export async function forceSyncWithFirestore() {
  const { ensureFirebaseAuth, isFirebaseConfigured } = await import('./firebase-config.js');
  const authUser = await ensureFirebaseAuth();
  if (authUser && (!state.firebaseUser || !state.firebaseUser.uid)) {
    await setAuthenticatedUser(authUser);
  }
  const uid = state.firebaseUser?.uid || authUser?.uid || 'default';

  try {
    const firestoreData = await loadAllUserData(uid, true);
    if (firestoreData) {
      state.prcs = firestoreData.prcs || [];
      state.allocations = consolidateAllocations(firestoreData.allocations || []);
      state.rfqs = consolidateRFQs(firestoreData.rfqs || []);
      state.tcds = consolidateTCDs(firestoreData.tcds || []);
      state.pods = consolidatePODs(firestoreData.pods || []);
      const podRec = reconcilePODRouting(state.prcs, state.pods, state.tcds);
      state.pods = podRec.pods;
      state.vendors = firestoreData.vendors || [];
      state.users = firestoreData.users || [];
      state.notifications = firestoreData.notifications || [];
      state.activityLogs = firestoreData.activityLogs || [];
      state.statusSummary = buildStatusSummary(state.prcs);
      state.totalMaterials = state.prcs.reduce((acc, p) => acc + (p.materials || []).length, 0);
      saveToLocalCache();
      emit('*');
      return { success: true, count: state.prcs.length };
    }
  } catch (err) {
    console.error('Force Firestore sync failed:', err);
    return { success: false, reason: err.message };
  }
  return { success: false, reason: 'Cloud Firestore database returned no data.' };
}

export function clearAuthenticatedUser() {
  unsubscribeRealtimeUserData();
  state.firebaseUser = null;
  state.isAuthenticated = false;
  state.currentUser = { ...DEFAULT_USER };
  state.prcs = [];
  state.allocations = [];
  state.rfqs = [];
  state.tcds = [];
  state.pods = [];
  state.vendors = [];
  state.users = [];
  state.notifications = [];
  state.activityLogs = [];
  state.statusSummary = {};
  state.totalMaterials = 0;
  emit('*');
}

// ── ROLE & PERMISSION HELPERS ──────────────────────────────

export function isSuperAdmin(user = state.currentUser) {
  if (!user) return false;
  const role = String(user.role || '').trim().toLowerCase();
  return role === 'super admin' || role === 'admin' || user.email === 'dinay.patil@gmail.com' || user.email === 'admin@company.com';
}

export function doesRecordPertainToCurrentUser(record, user = state.currentUser) {
  if (isSuperAdmin(user)) return true;
  if (!record || !user) return true;

  const uName = (user.name || '').trim().toLowerCase();
  const uEmail = (user.email || '').trim().toLowerCase();
  const uId = String(user.id || user.uid || '').trim().toLowerCase();

  const matches = (val) => {
    if (!val || typeof val !== 'string') return false;
    const v = val.trim().toLowerCase();
    if (!v) return false;
    if (v === uName || v === uEmail || v === uId) return true;
    if (uName && (v.includes(uName) || uName.includes(v))) return true;
    if (uEmail && v.includes(uEmail)) return true;
    return false;
  };

  // 1. Direct fields on PRC / Allocation / RFQ / TCD / POD / ActivityLog
  if (
    matches(record.buyerName) ||
    matches(record.allocatedBy) ||
    matches(record.requestedBy) ||
    matches(record.createdBy) ||
    matches(record.engineer) ||
    matches(record.userId) ||
    matches(record.userEmail) ||
    matches(record.user) ||
    matches(record.authorizedBy) ||
    matches(record.authorisedBy) ||
    matches(record.buyer) ||
    matches(record.poBy) ||
    matches(record.tcdBy) ||
    matches(record.rfqBy) ||
    matches(record.preparedBy) ||
    matches(record.approvedBy)
  ) {
    return true;
  }

  // 2. Material lines on PRC
  if (Array.isArray(record.materials)) {
    if (record.materials.some(m =>
      matches(m.buyerName) ||
      matches(m.engineer) ||
      matches(m.allocatedBy) ||
      matches(m.requestedBy) ||
      matches(m.createdBy) ||
      matches(m.buyer)
    )) {
      return true;
    }
  }

  // 3. Items inside Allocation / RFQ / POD
  if (Array.isArray(record.items)) {
    // Check item-level fields
    if (record.items.some(i =>
      matches(i.buyerName) ||
      matches(i.engineer) ||
      matches(i.allocatedBy) ||
      matches(i.requestedBy) ||
      matches(i.createdBy) ||
      matches(i.buyer)
    )) {
      return true;
    }
    // Check if item links to a PRC in state.prcs that pertains to the user
    if (record.items.some(i => {
      const parentPRC = (state.prcs || []).find(p => p.id === i.prcId || p.prNumber === i.prNumber);
      return parentPRC && doesRecordPertainToCurrentUser(parentPRC, user);
    })) {
      return true;
    }
  }

  // 4. Vendor allocations in TCD
  if (Array.isArray(record.vendorAllocations) || Array.isArray(record.vendors)) {
    const vas = record.vendorAllocations || record.vendors || [];
    for (const va of vas) {
      if (Array.isArray(va.items)) {
        if (va.items.some(i => {
          const parentPRC = (state.prcs || []).find(p => p.id === i.prcId || p.prNumber === i.prNumber);
          return parentPRC && doesRecordPertainToCurrentUser(parentPRC, user);
        })) {
          return true;
        }
      }
    }
  }

  return false;
}

// ── UNIVERSAL CRITERIA & WORD FILTER MATCHING ENGINE ─────────
export function matchCellFilter(cellValues, filterSpec) {
  if (!filterSpec) return true;

  const vals = Array.isArray(cellValues) ? cellValues : [cellValues];
  const cleanVals = vals.map(v => (v !== undefined && v !== null ? String(v).trim() : '')).filter(Boolean);
  const cleanValsLower = cleanVals.map(v => v.toLowerCase());

  // 1. Array of values (Excel checkbox list)
  if (Array.isArray(filterSpec)) {
    if (filterSpec.length === 0) return false;
    const valSet = new Set(filterSpec.map(v => String(v).trim().toLowerCase()));
    const allowsBlank = valSet.has('(blanks)');

    if (allowsBlank && cleanVals.length === 0) return true;
    if (cleanVals.length === 0) return false;
    return cleanValsLower.some(v => valSet.has(v));
  }

  // 2. Criteria object (Text Filter rules e.g. contains, starts_with, etc.)
  if (typeof filterSpec === 'object') {
    const rule = filterSpec.rule || 'contains';
    const targetVal = String(filterSpec.value || '').trim().toLowerCase();

    if (rule === 'empty' || rule === 'is_empty') {
      return cleanVals.length === 0;
    }
    if (rule === 'not_empty' || rule === 'is_not_empty') {
      return cleanVals.length > 0;
    }
    if (!targetVal) return true;

    // Multi-word search tokenization
    const words = targetVal.split(/\s+/).filter(Boolean);
    const combinedStr = cleanValsLower.join(' ');

    if (rule === 'contains') {
      return words.every(w => combinedStr.includes(w)) || cleanValsLower.some(v => v.includes(targetVal));
    }
    if (rule === 'not_contains') {
      return !words.some(w => combinedStr.includes(w)) && !cleanValsLower.some(v => v.includes(targetVal));
    }
    if (rule === 'equals' || rule === 'exact') {
      return cleanValsLower.some(v => v === targetVal);
    }
    if (rule === 'not_equals') {
      return !cleanValsLower.some(v => v === targetVal);
    }
    if (rule === 'starts_with' || rule === 'begins_with') {
      return cleanValsLower.some(v => v.startsWith(targetVal));
    }
    if (rule === 'ends_with') {
      return cleanValsLower.some(v => v.endsWith(targetVal));
    }
  }

  // 3. String value fallback
  const strFilter = String(filterSpec).trim().toLowerCase();
  if (strFilter === '(blanks)') return cleanVals.length === 0;
  return cleanValsLower.some(v => v.includes(strFilter));
}

// ── TABLE-AWARE ENTITY QUERY FUNCTIONS WITH EXCEL FILTERS ───

export function getFilteredAllocations(user = state.currentUser, bypassField = null) {
  let list = (state.allocations || []);
  if (!isSuperAdmin(user)) {
    list = list.filter(a => doesRecordPertainToCurrentUser(a, user));
  }

  // Search query
  const q = (state.searchQuery || '').trim().toLowerCase();
  if (q) {
    list = list.filter(a =>
      (a.allocationNumber || '').toLowerCase().includes(q) ||
      (a.buyerName || a.allocatedBy || '').toLowerCase().includes(q) ||
      (a.allocationDate || '').toLowerCase().includes(q) ||
      (a.items || []).some(i => (i.prNumber || '').toLowerCase().includes(q) || (i.matCode || '').toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q))
    );
  }

  // Table column filters
  const colFilters = getTableColumnFilters('allocations');
  if (colFilters && Object.keys(colFilters).length > 0) {
    Object.entries(colFilters).forEach(([colField, filterSpec]) => {
      if (bypassField === colField || bypassField === true) return;
      if (!filterSpec) return;

      list = list.filter(a => {
        if (colField === 'allocationNumber') return matchCellFilter(a.allocationNumber, filterSpec);
        if (colField === 'allocationDate') return matchCellFilter(a.allocationDate, filterSpec);
        if (colField === 'buyerName' || colField === 'allocatedBy') return matchCellFilter([a.buyerName, a.allocatedBy], filterSpec);
        if (colField === 'materials' || colField === 'itemCount') return matchCellFilter(String((a.items || []).length), filterSpec);
        if (colField === 'status') {
          const st = getAllocationStatus(a, state.prcs);
          return matchCellFilter(st, filterSpec);
        }
        if (colField === 'createdAt') return matchCellFilter(a.createdAt, filterSpec);
        return matchCellFilter(a[colField], filterSpec);
      });
    });
  }

  return list;
}

export function getFilteredRFQs(user = state.currentUser, bypassField = null) {
  let list = (state.rfqs || []);
  if (!isSuperAdmin(user)) {
    list = list.filter(r => doesRecordPertainToCurrentUser(r, user));
  }

  // Search query
  const q = (state.searchQuery || '').trim().toLowerCase();
  if (q) {
    list = list.filter(r =>
      (r.rfqNumber || '').toLowerCase().includes(q) ||
      (r.rfqDate || '').toLowerCase().includes(q) ||
      (r.buyerName || r.createdBy || '').toLowerCase().includes(q) ||
      (r.items || []).some(i => (i.prNumber || '').toLowerCase().includes(q) || (i.matCode || '').toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q))
    );
  }

  // Table column filters
  const colFilters = getTableColumnFilters('rfqs');
  if (colFilters && Object.keys(colFilters).length > 0) {
    Object.entries(colFilters).forEach(([colField, filterSpec]) => {
      if (bypassField === colField || bypassField === true) return;
      if (!filterSpec) return;

      list = list.filter(r => {
        if (colField === 'rfqNumber') return matchCellFilter(r.rfqNumber, filterSpec);
        if (colField === 'rfqDate') return matchCellFilter(r.rfqDate, filterSpec);
        if (colField === 'buyerName' || colField === 'createdBy') return matchCellFilter([r.buyerName, r.createdBy, r.rfqBy], filterSpec);
        if (colField === 'materials' || colField === 'itemCount') return matchCellFilter(String((r.items || []).length), filterSpec);
        if (colField === 'status') {
          const st = getRFQStatus(r, state.prcs);
          return matchCellFilter(st, filterSpec);
        }
        if (colField === 'createdAt') return matchCellFilter(r.createdAt, filterSpec);
        return matchCellFilter(r[colField], filterSpec);
      });
    });
  }

  return list;
}

export function getFilteredTCDs(user = state.currentUser, bypassField = null) {
  let list = (state.tcds || []);
  if (!isSuperAdmin(user)) {
    list = list.filter(t => doesRecordPertainToCurrentUser(t, user));
  }

  // Search query
  const q = (state.searchQuery || '').trim().toLowerCase();
  if (q) {
    list = list.filter(t =>
      (t.tcdNumber || '').toLowerCase().includes(q) ||
      (t.tcdDate || '').toLowerCase().includes(q) ||
      (t.buyerName || t.createdBy || '').toLowerCase().includes(q) ||
      (t.vendorAllocations || t.vendors || []).some(v => (v.vendorName || '').toLowerCase().includes(q))
    );
  }

  // Table column filters
  const colFilters = getTableColumnFilters('tcds');
  if (colFilters && Object.keys(colFilters).length > 0) {
    Object.entries(colFilters).forEach(([colField, filterSpec]) => {
      if (bypassField === colField || bypassField === true) return;
      if (!filterSpec) return;

      list = list.filter(t => {
        if (colField === 'tcdNumber') return matchCellFilter(t.tcdNumber, filterSpec);
        if (colField === 'tcdDate') return matchCellFilter(t.tcdDate, filterSpec);
        if (colField === 'buyerName' || colField === 'createdBy') return matchCellFilter([t.buyerName, t.createdBy], filterSpec);
        if (colField === 'vendorName' || colField === 'vendors') {
          const vNames = (t.vendorAllocations || t.vendors || []).map(v => v.vendorName || v.name || '').filter(Boolean);
          return matchCellFilter(vNames, filterSpec);
        }
        if (colField === 'status') {
          const st = t.approved ? 'Approved' : (t.status || 'Pending Approval');
          return matchCellFilter(st, filterSpec);
        }
        if (colField === 'createdAt') return matchCellFilter(t.createdAt, filterSpec);
        return matchCellFilter(t[colField], filterSpec);
      });
    });
  }

  return list;
}

export function getFilteredPODs(user = state.currentUser, bypassField = null) {
  let list = (state.pods || []);
  if (!isSuperAdmin(user)) {
    list = list.filter(p => doesRecordPertainToCurrentUser(p, user));
  }

  // Search query
  const q = (state.searchQuery || '').trim().toLowerCase();
  if (q) {
    list = list.filter(p =>
      (p.poNumber || '').toLowerCase().includes(q) ||
      (p.poDate || '').toLowerCase().includes(q) ||
      (p.vendorName || p.vendor || '').toLowerCase().includes(q) ||
      (p.tcdNumber || '').toLowerCase().includes(q) ||
      (p.status || '').toLowerCase().includes(q)
    );
  }

  // Table column filters
  const colFilters = getTableColumnFilters('pods');
  if (colFilters && Object.keys(colFilters).length > 0) {
    Object.entries(colFilters).forEach(([colField, filterSpec]) => {
      if (bypassField === colField || bypassField === true) return;
      if (!filterSpec) return;

      list = list.filter(p => {
        if (colField === 'poNumber') return matchCellFilter(p.poNumber, filterSpec);
        if (colField === 'poDate') return matchCellFilter(p.poDate, filterSpec);
        if (colField === 'vendorName' || colField === 'vendor') return matchCellFilter([p.vendorName, p.vendor], filterSpec);
        if (colField === 'buyerName' || colField === 'createdBy') return matchCellFilter([p.buyerName, p.createdBy], filterSpec);
        if (colField === 'tcdNumber') return matchCellFilter(p.tcdNumber, filterSpec);
        if (colField === 'status') return matchCellFilter(p.status, filterSpec);
        if (colField === 'createdAt') return matchCellFilter(p.createdAt, filterSpec);
        return matchCellFilter(p[colField], filterSpec);
      });
    });
  }

  return list;
}

export function getFilteredActivityLogs(user = state.currentUser, bypassField = null) {
  let list = (state.activityLogs || []);
  if (!isSuperAdmin(user)) {
    list = list.filter(l => doesRecordPertainToCurrentUser(l, user));
  }

  // Table column filters
  const colFilters = getTableColumnFilters('audit');
  if (colFilters && Object.keys(colFilters).length > 0) {
    Object.entries(colFilters).forEach(([colField, filterSpec]) => {
      if (bypassField === colField || bypassField === true) return;
      if (!filterSpec) return;

      list = list.filter(l => {
        if (colField === 'timestamp' || colField === 'date') return matchCellFilter(l.timestamp, filterSpec);
        if (colField === 'user') return matchCellFilter(l.user, filterSpec);
        if (colField === 'action') return matchCellFilter(l.action, filterSpec);
        if (colField === 'collection' || colField === 'record') return matchCellFilter([l.collection, l.docId], filterSpec);
        if (colField === 'changes') return matchCellFilter(JSON.stringify(l.changes || {}), filterSpec);
        return matchCellFilter(l[colField], filterSpec);
      });
    });
  }

  return list;
}

export function getFilteredVendors(bypassField = null) {
  let list = [...(state.vendors || [])];

  const colFilters = getTableColumnFilters('vendors');
  if (colFilters && Object.keys(colFilters).length > 0) {
    Object.entries(colFilters).forEach(([colField, filterSpec]) => {
      if (bypassField === colField || bypassField === true) return;
      if (!filterSpec) return;

      list = list.filter(v => {
        if (colField === 'name' || colField === 'vendorName') return matchCellFilter(v.name, filterSpec);
        if (colField === 'category') return matchCellFilter(v.category, filterSpec);
        if (colField === 'code') return matchCellFilter(v.code, filterSpec);
        if (colField === 'rating') return matchCellFilter(String(v.rating), filterSpec);
        if (colField === 'poCount') return matchCellFilter(String(v.poCount || 0), filterSpec);
        return matchCellFilter(v[colField], filterSpec);
      });
    });
  }

  return list;
}

export async function updateAnyUserProfile(targetIdOrEmail, patch) {
  if (!targetIdOrEmail || !patch) return { success: false, reason: 'Invalid parameters' };

  const isSelf = (state.currentUser.id && state.currentUser.id === targetIdOrEmail) ||
                 (state.currentUser.uid && state.currentUser.uid === targetIdOrEmail) ||
                 (state.currentUser.email && state.currentUser.email.toLowerCase() === String(targetIdOrEmail).toLowerCase());

  if (!isSuperAdmin() && !isSelf) {
    return { success: false, reason: 'Permission denied: Only Super Admin or the account owner can edit this user profile.' };
  }

  const userIdx = state.users.findIndex(u =>
    (u.id && u.id === targetIdOrEmail) ||
    (u.uid && u.uid === targetIdOrEmail) ||
    (u.email && u.email.toLowerCase() === String(targetIdOrEmail).toLowerCase())
  );

  if (userIdx === -1) {
    return { success: false, reason: 'User not found in roster.' };
  }

  // Non-super-admins cannot elevate their own role
  if (!isSuperAdmin() && patch.role && patch.role !== state.users[userIdx].role) {
    delete patch.role;
  }

  const updatedUser = {
    ...state.users[userIdx],
    ...patch
  };

  // Compute avatar initials if blank
  if (!updatedUser.avatar || updatedUser.avatar === 'GU' || updatedUser.avatar === 'U') {
    const fn = (updatedUser.name || updatedUser.email || 'U').trim();
    const parts = fn.split(' ');
    updatedUser.avatar = parts.length > 1
      ? (parts[0][0] + parts[1][0]).toUpperCase()
      : fn.slice(0, 2).toUpperCase();
  }

  state.users[userIdx] = updatedUser;

  if (isSelf) {
    state.currentUser = { ...state.currentUser, ...updatedUser };
  }

  saveToLocalCache();

  // Save directly to Turso users and user_profiles tables
  try {
    const { executeTursoPipeline, isTursoConfigured } = await import('./turso-db.js');
    if (isTursoConfigured()) {
      const now = new Date().toISOString();
      const userId = String(updatedUser.id || updatedUser.uid || targetIdOrEmail);
      await executeTursoPipeline([
        {
          sql: `INSERT INTO users (id, user_id, email, role, data, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  email = excluded.email,
                  role = excluded.role,
                  data = excluded.data,
                  updated_at = excluded.updated_at;`,
          args: [
            userId,
            userId,
            String(updatedUser.email || ''),
            String(updatedUser.role || ''),
            JSON.stringify(updatedUser),
            now
          ]
        },
        {
          sql: `INSERT INTO user_profiles (user_id, data, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                  data = excluded.data,
                  updated_at = excluded.updated_at;`,
          args: [
            userId,
            JSON.stringify(updatedUser),
            now
          ]
        }
      ]);
    }
  } catch (err) {
    console.warn('Failed to persist user profile to Turso:', err);
  }

  emit('currentUser');
  emit('users');
  emit('*');
  return { success: true, user: updatedUser };
}

export function updateUserProfile(patch) {
  if (!patch) return false;
  const target = state.currentUser?.id || state.currentUser?.email;
  updateAnyUserProfile(target, patch);
  return true;
}

// ── PRC OPERATIONS ────────────────────────────────────────

/**
 * Returns all PRCs accessible to the current user (role-based security partition),
 * without any UI-level temporary filters (search, status filter, column filter).
 */
export function getUserPRCs(user = state.currentUser) {
  let list = [...state.prcs];
  if (!isSuperAdmin(user)) {
    list = list.filter(p => doesRecordPertainToCurrentUser(p, user));
  }
  return list;
}

export function clearAllFilters() {
  state.filters = {};
  state.columnFilters = {};
  state.searchQuery = '';
  state.currentPage_num = 1;
  saveToLocalCache();
  emit('filters');
  emit('columnFilters');
  emit('searchQuery');
  emit('*');
}

export function getFilteredPRCs(bypassColumnField = null) {
  let list = [...state.prcs];

  // Role-based visibility filter: Only show data pertaining to current user if not Super Admin
  if (!isSuperAdmin()) {
    list = list.filter(p => doesRecordPertainToCurrentUser(p));
  }

  const q = state.searchQuery.toLowerCase();

  if (q) {
    list = list.filter(p =>
      p.prNumber?.toLowerCase().includes(q)       ||
      p.allocationNumber?.toLowerCase().includes(q)||
      p.buyerName?.toLowerCase().includes(q)       ||
      p.allocatedBy?.toLowerCase().includes(q)     ||
      p.rfqNumber?.toLowerCase().includes(q)      ||
      p.tcdNumber?.toLowerCase().includes(q)      ||
      p.poNumber?.toLowerCase().includes(q)       ||
      p.vendorName?.toLowerCase().includes(q)     ||
      p.department?.toLowerCase().includes(q)     ||
      p.job?.toLowerCase().includes(q)            ||
      p.remarks?.toLowerCase().includes(q)        ||
      (p.materials||[]).some(m =>
        m.matCode?.toLowerCase().includes(q) ||
        m.description?.toLowerCase().includes(q) ||
        m.buyerName?.toLowerCase().includes(q)
      )
    );
  }

  const f = state.filters;
  if (f.status) {
    const target = f.status.trim().toLowerCase();
    if (target === 'authorised' || target === 'authorized') {
      list = list.filter(p => isPRCAuthorised(p) || calculateStatus(p).toLowerCase() === 'authorised' || (p.status||'').toLowerCase() === 'authorised' || (p.prStatus||'').toLowerCase() === 'authorised');
    } else {
      list = list.filter(p =>
        calculateStatus(p).toLowerCase() === target ||
        (p.status || '').toLowerCase() === target ||
        (p.prStatus || '').toLowerCase() === target
      );
    }
  }
  if (f.isOverdue) {
    list = list.filter(p => {
      const st = calculateStatus(p);
      return getPRCAge(p) > 7 && !['Process Completed', 'Wrong PRC', 'PR Not Approved', 'Future PRC', 'System Issue', 'Short-Close'].includes(st);
    });
  }
  if (f.poToday) {
    const todayStr = new Date().toISOString().split('T')[0];
    list = list.filter(p => p.poDate === todayStr || (p.materials || []).some(m => m.poDate === todayStr));
  }
  if (f.department) list = list.filter(p => p.department === f.department);
  if (f.priority)   list = list.filter(p => p.priority === f.priority);
  if (f.engineer)   list = list.filter(p => p.engineer === f.engineer);
  if (f.dateFrom)   list = list.filter(p => p.createdAt >= f.dateFrom);
  if (f.dateTo)     list = list.filter(p => p.createdAt <= f.dateTo);

  // Apply Excel-style Column Filters on PRCs with word & criteria support
  const colFilters = getTableColumnFilters('prc');
  if (colFilters && Object.keys(colFilters).length > 0) {
    Object.entries(colFilters).forEach(([colField, filterSpec]) => {
      if (bypassColumnField === colField || bypassColumnField === true) return;
      if (!filterSpec) return;

      list = list.filter(p => {
        if (colField === 'status') {
          const st = calculateStatus(p);
          const prcSt = p.status || '';
          const prSt = p.prStatus || '';
          return matchCellFilter([st, prcSt, prSt], filterSpec);
        }
        if (colField === 'allocationNumber' || colField === 'allocationDate' || colField === 'allocation') {
          const pAlloc = p.allocationNumber || '';
          const matAllocs = (p.materials || []).map(m => m.allocationNumber || '').filter(Boolean);
          return matchCellFilter([pAlloc, ...matAllocs], filterSpec);
        }
        if (colField === 'rfqNumber' || colField === 'rfqDate' || colField === 'rfq') {
          const pRfq = p.rfqNumber || '';
          const matRfqs = (p.materials || []).map(m => m.rfqNumber || '').filter(Boolean);
          return matchCellFilter([pRfq, ...matRfqs], filterSpec);
        }
        if (colField === 'tcdNumber' || colField === 'tcdDate' || colField === 'tcd') {
          const pTcd = p.tcdNumber || '';
          const matTcds = (p.materials || []).map(m => m.tcdNumber || '').filter(Boolean);
          return matchCellFilter([pTcd, ...matTcds], filterSpec);
        }
        if (colField === 'poNumber' || colField === 'poDate' || colField === 'po') {
          const pPo = p.poNumber || '';
          const matPos = (p.materials || []).map(m => m.poNumber || '').filter(Boolean);
          return matchCellFilter([pPo, ...matPos], filterSpec);
        }
        if (colField === 'vendorName' || colField === 'vendor') {
          const pV = p.vendorName || p.vendor || '';
          const matVs = (p.materials || []).map(m => m.vendorName || m.vendor || '').filter(Boolean);
          return matchCellFilter([pV, ...matVs], filterSpec);
        }
        if (colField === 'buyerName' || colField === 'allocatedBy') {
          const b = p.buyerName || p.allocatedBy || '';
          const matBs = (p.materials || []).map(m => m.buyerName || m.allocatedBy || '').filter(Boolean);
          return matchCellFilter([b, ...matBs], filterSpec);
        }
        if (colField === 'matCode') {
          const matCodes = (p.materials || []).map(m => m.matCode || '').filter(Boolean);
          return matchCellFilter(matCodes, filterSpec);
        }
        if (colField === 'description') {
          const matDescs = (p.materials || []).map(m => m.description || '').filter(Boolean);
          return matchCellFilter(matDescs, filterSpec);
        }
        if (colField === 'deliveryDate' || colField === 'deliveryEndDate') {
          const pDeliv = p.deliveryDate || p.deliveryEndDate || '';
          const matDelivs = (p.materials || []).map(m => m.deliveryDate || m.deliveryEndDate || '').filter(Boolean);
          return matchCellFilter([pDeliv, ...matDelivs], filterSpec);
        }
        if (colField === 'age' || colField === 'createdAt') {
          const a = `${getPRCAge(p)}d`;
          return matchCellFilter([a, `${getPRCAge(p)}`], filterSpec);
        }

        return matchCellFilter(p[colField], filterSpec);
      });
    });
  }

  list.sort((a,b) => {
    let av = a[state.sortField] || (state.sortField === 'buyerName' ? a.allocatedBy : '') || '';
    let bv = b[state.sortField] || (state.sortField === 'buyerName' ? b.allocatedBy : '') || '';
    const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    return state.sortDir === 'asc' ? cmp : -cmp;
  });

  return list;
}

export function getPaginatedPRCs() {
  const filtered = getFilteredPRCs();
  const start = (state.currentPage_num - 1) * state.pageSize;
  return {
    total:    filtered.length,
    items:    filtered.slice(start, start + state.pageSize),
    pages:    Math.ceil(filtered.length / state.pageSize) || 1,
    page:     state.currentPage_num
  };
}

export function getFilteredMaterials(bypassColumnField = null) {
  // Use bypassColumnField = true when fetching parent PRCs to avoid dropping parent records before material extraction
  const prcs = getFilteredPRCs(true);
  const allMats = [];

  prcs.forEach(p => {
    (p.materials || []).forEach(m => {
      allMats.push({
        allocationNumber: m.allocationNumber || p.allocationNumber || '',
        allocationDate: m.allocationDate || p.allocationDate || '',
        buyerName: m.buyerName || m.allocatedBy || p.buyerName || p.allocatedBy || '',
        allocatedBy: m.allocatedBy || m.buyerName || p.allocatedBy || p.buyerName || '',
        rfqNumber: m.rfqNumber || p.rfqNumber || '',
        rfqDate: m.rfqDate || p.rfqDate || '',
        tcdNumber: m.tcdNumber || p.tcdNumber || '',
        tcdDate: m.tcdDate || p.tcdDate || '',
        poNumber: m.poNumber || p.poNumber || '',
        poDate: m.poDate || p.poDate || '',
        vendorName: m.vendorName || m.vendor || p.vendorName || p.vendor || '',
        vendor: m.vendorName || m.vendor || p.vendorName || p.vendor || '',
        deliveryDate: m.deliveryDate || m.deliveryEndDate || p.deliveryDate || p.deliveryEndDate || '',
        ...m,
        prcId: p.id,
        prNumber: p.prNumber,
        department: p.department,
        job: p.job || p.jobNumber,
        priority: p.priority,
        prcStatus: p.status,
        prcCreatedAt: p.createdAt
      });
    });
  });

  const q = (state.searchQuery || '').trim().toLowerCase();
  let list = allMats;
  if (q) {
    list = list.filter(m =>
      m.prNumber?.toLowerCase().includes(q) ||
      m.matCode?.toLowerCase().includes(q) ||
      m.description?.toLowerCase().includes(q) ||
      m.allocationNumber?.toLowerCase().includes(q) ||
      m.buyerName?.toLowerCase().includes(q) ||
      m.rfqNumber?.toLowerCase().includes(q) ||
      m.tcdNumber?.toLowerCase().includes(q) ||
      m.poNumber?.toLowerCase().includes(q) ||
      m.vendorName?.toLowerCase().includes(q) ||
      m.vendor?.toLowerCase().includes(q) ||
      m.department?.toLowerCase().includes(q) ||
      m.job?.toLowerCase().includes(q)
    );
  }

  const f = state.filters || {};
  if (f.status) {
    const target = f.status.trim().toLowerCase();
    list = list.filter(m =>
      (m.status || '').toLowerCase() === target ||
      (m.prcStatus || '').toLowerCase() === target ||
      calculateMaterialStatus(m).toLowerCase() === target
    );
  }

  // Apply Excel-style Column Filters on materials directly
  if (state.columnFilters && Object.keys(state.columnFilters).length > 0) {
    Object.entries(state.columnFilters).forEach(([colField, selectedVals]) => {
      if (bypassColumnField === colField || bypassColumnField === true) return;
      if (!selectedVals || !Array.isArray(selectedVals)) return;
      if (selectedVals.length === 0) {
        list = [];
        return;
      }
      const valSet = new Set(selectedVals.map(v => String(v).trim().toLowerCase()));
      const allowsBlank = valSet.has('(blanks)');

      list = list.filter(m => {
        if (colField === 'status') {
          const st = (m.status || calculateMaterialStatus(m) || '').trim().toLowerCase();
          const prcSt = (m.prcStatus || '').trim().toLowerCase();
          if (allowsBlank && !st && !prcSt) return true;
          return valSet.has(st) || valSet.has(prcSt);
        }
        if (colField === 'prNumber') {
          const pr = (m.prNumber || '').trim().toLowerCase();
          if (allowsBlank && !pr) return true;
          return valSet.has(pr);
        }
        if (colField === 'matCode') {
          const mc = (m.matCode || '').trim().toLowerCase();
          if (allowsBlank && !mc) return true;
          return valSet.has(mc);
        }
        if (colField === 'description') {
          const desc = (m.description || '').trim().toLowerCase();
          if (allowsBlank && !desc) return true;
          return valSet.has(desc);
        }
        if (colField === 'allocationNumber' || colField === 'allocationDate' || colField === 'allocation') {
          const a = (m.allocationNumber || '').trim().toLowerCase();
          if (allowsBlank && !a) return true;
          return valSet.has(a);
        }
        if (colField === 'rfqNumber' || colField === 'rfqDate' || colField === 'rfq') {
          const r = (m.rfqNumber || '').trim().toLowerCase();
          if (allowsBlank && !r) return true;
          return valSet.has(r);
        }
        if (colField === 'tcdNumber' || colField === 'tcdDate' || colField === 'tcd') {
          const t = (m.tcdNumber || '').trim().toLowerCase();
          if (allowsBlank && !t) return true;
          return valSet.has(t);
        }
        if (colField === 'poNumber' || colField === 'poDate' || colField === 'po') {
          const po = (m.poNumber || '').trim().toLowerCase();
          if (allowsBlank && !po) return true;
          return valSet.has(po);
        }
        if (colField === 'vendorName' || colField === 'vendor') {
          const v = (m.vendorName || m.vendor || '').trim().toLowerCase();
          if (allowsBlank && !v) return true;
          return valSet.has(v);
        }
        if (colField === 'buyerName' || colField === 'allocatedBy') {
          const b = (m.buyerName || m.allocatedBy || '').trim().toLowerCase();
          if (allowsBlank && !b) return true;
          return valSet.has(b);
        }
        if (colField === 'deliveryDate' || colField === 'deliveryEndDate') {
          const d = (m.deliveryDate || m.deliveryEndDate || '').trim().toLowerCase();
          if (allowsBlank && !d) return true;
          return valSet.has(d);
        }
        if (colField === 'department') {
          const dep = (m.department || '').trim().toLowerCase();
          if (allowsBlank && !dep) return true;
          return valSet.has(dep);
        }
        if (colField === 'priority') {
          const pri = (m.priority || '').trim().toLowerCase();
          if (allowsBlank && !pri) return true;
          return valSet.has(pri);
        }

        const raw = (m[colField] !== undefined && m[colField] !== null) ? String(m[colField]).trim().toLowerCase() : '';
        if (allowsBlank && !raw) return true;
        return valSet.has(raw);
      });
    });
  }

  list.sort((a, b) => {
    let av = a[state.sortField] || (state.sortField === 'buyerName' ? a.allocatedBy : '') || '';
    let bv = b[state.sortField] || (state.sortField === 'buyerName' ? b.allocatedBy : '') || '';
    const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    return state.sortDir === 'asc' ? cmp : -cmp;
  });

  return list;
}

export function getPaginatedMaterials() {
  const filtered = getFilteredMaterials();
  const start = (state.currentPage_num - 1) * state.pageSize;
  return {
    total: filtered.length,
    items: filtered.slice(start, start + state.pageSize),
    pages: Math.ceil(filtered.length / state.pageSize) || 1,
    page:  state.currentPage_num
  };
}

// ── EXCEL COLUMN FILTER HELPERS (UNIVERSAL MULTI-TABLE) ───

export function getTableColumnFilters(tableKey = 'prc') {
  state.tableColumnFilters = state.tableColumnFilters || {};
  if (tableKey === 'prc' || tableKey === 'material') {
    return { ...(state.columnFilters || {}), ...(state.tableColumnFilters[tableKey] || {}) };
  }
  return state.tableColumnFilters[tableKey] || {};
}

export function setTableColumnFilter(tableKey = 'prc', field, filterSpec) {
  state.tableColumnFilters = state.tableColumnFilters || {};
  state.tableColumnFilters[tableKey] = {
    ...(state.tableColumnFilters[tableKey] || {}),
    [field]: filterSpec
  };
  if (tableKey === 'prc' || tableKey === 'material') {
    state.columnFilters = {
      ...(state.columnFilters || {}),
      [field]: filterSpec
    };
  }
  state.currentPage_num = 1;
  saveToLocalCache();
  emit('columnFilters');
  emit('*');
}

export function clearTableColumnFilter(tableKey = 'prc', field) {
  state.tableColumnFilters = state.tableColumnFilters || {};
  if (state.tableColumnFilters[tableKey]) {
    const next = { ...state.tableColumnFilters[tableKey] };
    delete next[field];
    state.tableColumnFilters[tableKey] = next;
  }
  if (tableKey === 'prc' || tableKey === 'material') {
    const next = { ...(state.columnFilters || {}) };
    delete next[field];
    state.columnFilters = next;
  }
  state.currentPage_num = 1;
  saveToLocalCache();
  emit('columnFilters');
  emit('*');
}

export function clearAllTableColumnFilters(tableKey = 'prc') {
  state.tableColumnFilters = state.tableColumnFilters || {};
  state.tableColumnFilters[tableKey] = {};
  if (tableKey === 'prc' || tableKey === 'material') {
    state.columnFilters = {};
  }
  state.currentPage_num = 1;
  saveToLocalCache();
  emit('columnFilters');
  emit('*');
}

export function getTableActiveFilterCount(tableKey = 'prc') {
  const colFilters = getTableColumnFilters(tableKey);
  return Object.keys(colFilters || {}).filter(k => {
    const v = colFilters[k];
    if (Array.isArray(v)) return v.length > 0;
    if (v && typeof v === 'object') return !!v.value || v.rule === 'empty' || v.rule === 'not_empty';
    return !!v;
  }).length;
}

// Backward-compatible global helpers
export function setColumnFilter(field, values) {
  setTableColumnFilter('prc', field, values);
}

export function clearColumnFilter(field) {
  clearTableColumnFilter('prc', field);
}

export function clearAllColumnFilters() {
  clearAllTableColumnFilters('prc');
  clearAllTableColumnFilters('material');
}

export function getActiveColumnFilterCount() {
  return getTableActiveFilterCount('prc');
}

export function getDistinctTableColumnValues(tableKey, field, isMaterialView = false) {
  let list = [];
  if (tableKey === 'allocations') {
    list = getFilteredAllocations(state.currentUser, field);
  } else if (tableKey === 'rfqs') {
    list = getFilteredRFQs(state.currentUser, field);
  } else if (tableKey === 'tcds') {
    list = getFilteredTCDs(state.currentUser, field);
  } else if (tableKey === 'pods') {
    list = getFilteredPODs(state.currentUser, field);
  } else if (tableKey === 'vendors') {
    list = getFilteredVendors(field);
  } else if (tableKey === 'audit') {
    list = getFilteredActivityLogs(state.currentUser, field);
  } else if (tableKey === 'reports') {
    list = typeof getAgeingReport === 'function' ? getAgeingReport() : getFilteredPRCs(field);
  } else {
    list = isMaterialView ? getFilteredMaterials(field) : getFilteredPRCs(field);
  }

  const valCountMap = new Map();

  list.forEach(item => {
    let vals = [];

    // Allocations table
    if (tableKey === 'allocations') {
      if (field === 'allocationNumber') vals = [item.allocationNumber || '(Blanks)'];
      else if (field === 'allocationDate') vals = [item.allocationDate || '(Blanks)'];
      else if (field === 'buyerName') vals = [item.buyerName || item.allocatedBy || '(Blanks)'];
      else if (field === 'materials' || field === 'itemCount') vals = [`${(item.items || []).length} items`];
      else if (field === 'status') vals = [getAllocationStatus(item, state.prcs) || '(Blanks)'];
      else if (field === 'createdAt') vals = [item.createdAt ? fmtDate(item.createdAt) : '(Blanks)'];
      else vals = [item[field] !== undefined && item[field] !== null && String(item[field]).trim() ? String(item[field]).trim() : '(Blanks)'];
    }
    // RFQs table
    else if (tableKey === 'rfqs') {
      if (field === 'rfqNumber') vals = [item.rfqNumber || '(Blanks)'];
      else if (field === 'rfqDate') vals = [item.rfqDate || '(Blanks)'];
      else if (field === 'buyerName') vals = [item.buyerName || item.createdBy || '(Blanks)'];
      else if (field === 'materials' || field === 'itemCount') vals = [`${(item.items || []).length} items`];
      else if (field === 'status') vals = [getRFQStatus(item, state.prcs) || '(Blanks)'];
      else if (field === 'createdAt') vals = [item.createdAt ? fmtDate(item.createdAt) : '(Blanks)'];
      else vals = [item[field] !== undefined && item[field] !== null && String(item[field]).trim() ? String(item[field]).trim() : '(Blanks)'];
    }
    // TCDs table
    else if (tableKey === 'tcds') {
      if (field === 'tcdNumber') vals = [item.tcdNumber || '(Blanks)'];
      else if (field === 'tcdDate') vals = [item.tcdDate || '(Blanks)'];
      else if (field === 'vendorName' || field === 'vendors') {
        const vNames = (item.vendorAllocations || item.vendors || []).map(v => v.vendorName || v.name || '').filter(Boolean);
        vals = vNames.length ? vNames : ['(Blanks)'];
      }
      else if (field === 'materials' || field === 'itemCount') {
        const totalMats = (item.vendorAllocations || item.vendors || []).reduce((s, v) => s + (v.items || []).length, 0);
        vals = [`${totalMats} items`];
      }
      else if (field === 'status') vals = [item.approved ? 'Approved' : (item.status || 'Pending Approval')];
      else if (field === 'createdAt') vals = [item.createdAt ? fmtDate(item.createdAt) : '(Blanks)'];
      else vals = [item[field] !== undefined && item[field] !== null && String(item[field]).trim() ? String(item[field]).trim() : '(Blanks)'];
    }
    // PODs table
    else if (tableKey === 'pods') {
      if (field === 'poNumber') vals = [item.poNumber || '(Blanks)'];
      else if (field === 'poDate') vals = [item.poDate || '(Blanks)'];
      else if (field === 'vendorName' || field === 'vendor') vals = [item.vendorName || item.vendor || '(Blanks)'];
      else if (field === 'tcdNumber') vals = [item.tcdNumber || '(Blanks)'];
      else if (field === 'status') vals = [item.status || (item.poNumber ? 'Issued' : 'Pending PO Number')];
      else if (field === 'createdAt') vals = [item.createdAt ? fmtDate(item.createdAt) : '(Blanks)'];
      else vals = [item[field] !== undefined && item[field] !== null && String(item[field]).trim() ? String(item[field]).trim() : '(Blanks)'];
    }
    // Vendors table
    else if (tableKey === 'vendors') {
      if (field === 'name' || field === 'vendorName') vals = [item.name || '(Blanks)'];
      else if (field === 'category') vals = [item.category || '(Blanks)'];
      else if (field === 'code') vals = [item.code || '(Blanks)'];
      else if (field === 'rating') vals = [`${item.rating || 0} ★`];
      else if (field === 'poCount') vals = [`${item.poCount || 0} POs`];
      else vals = [item[field] !== undefined && item[field] !== null && String(item[field]).trim() ? String(item[field]).trim() : '(Blanks)'];
    }
    // Audit table
    else if (tableKey === 'audit') {
      if (field === 'user') vals = [item.user || '(Blanks)'];
      else if (field === 'action') vals = [item.action ? item.action.toUpperCase() : '(Blanks)'];
      else if (field === 'collection' || field === 'record') vals = [item.collection || '(Blanks)'];
      else vals = [item[field] !== undefined && item[field] !== null && String(item[field]).trim() ? String(item[field]).trim() : '(Blanks)'];
    }
    // Reports table
    else if (tableKey === 'reports') {
      if (field === 'prNumber') vals = [item.prNumber || '(Blanks)'];
      else if (field === 'status') vals = [item.status || '(Blanks)'];
      else if (field === 'department') vals = [item.department || '(Blanks)'];
      else if (field === 'ageDays' || field === 'age') vals = [`${item.ageDays || 0} days`];
      else vals = [item[field] !== undefined && item[field] !== null && String(item[field]).trim() ? String(item[field]).trim() : '(Blanks)'];
    }
    // PRC / Material view default
    else {
      if (field === 'status') {
        const st = isMaterialView ? (item.status || calculateMaterialStatus(item)) : calculateStatus(item);
        vals = [st || '(Blanks)'];
      } else if (field === 'allocationNumber' || field === 'allocationDate' || field === 'allocation') {
        if (item.materials && !isMaterialView) {
          const set = new Set();
          if (item.allocationNumber) set.add(item.allocationNumber);
          (item.materials || []).forEach(m => { if (m.allocationNumber) set.add(m.allocationNumber); });
          vals = set.size ? Array.from(set) : ['(Blanks)'];
        } else {
          vals = [item.allocationNumber || '(Blanks)'];
        }
      } else if (field === 'rfqNumber' || field === 'rfqDate' || field === 'rfq') {
        if (item.materials && !isMaterialView) {
          const set = new Set();
          if (item.rfqNumber) set.add(item.rfqNumber);
          (item.materials || []).forEach(m => { if (m.rfqNumber) set.add(m.rfqNumber); });
          vals = set.size ? Array.from(set) : ['(Blanks)'];
        } else {
          vals = [item.rfqNumber || '(Blanks)'];
        }
      } else if (field === 'tcdNumber' || field === 'tcdDate' || field === 'tcd') {
        if (item.materials && !isMaterialView) {
          const set = new Set();
          if (item.tcdNumber) set.add(item.tcdNumber);
          (item.materials || []).forEach(m => { if (m.tcdNumber) set.add(m.tcdNumber); });
          vals = set.size ? Array.from(set) : ['(Blanks)'];
        } else {
          vals = [item.tcdNumber || '(Blanks)'];
        }
      } else if (field === 'poNumber' || field === 'poDate' || field === 'po') {
        if (item.materials && !isMaterialView) {
          const set = new Set();
          if (item.poNumber) set.add(item.poNumber);
          (item.materials || []).forEach(m => { if (m.poNumber) set.add(m.poNumber); });
          vals = set.size ? Array.from(set) : ['(Blanks)'];
        } else {
          vals = [item.poNumber || '(Blanks)'];
        }
      } else if (field === 'vendorName' || field === 'vendor') {
        if (item.materials && !isMaterialView) {
          const set = new Set();
          if (item.vendorName || item.vendor) set.add(item.vendorName || item.vendor);
          (item.materials || []).forEach(m => { if (m.vendorName || m.vendor) set.add(m.vendorName || m.vendor); });
          vals = set.size ? Array.from(set) : ['(Blanks)'];
        } else {
          vals = [item.vendorName || item.vendor || '(Blanks)'];
        }
      } else if (field === 'buyerName' || field === 'allocatedBy') {
        if (item.materials && !isMaterialView) {
          const set = new Set();
          if (item.buyerName || item.allocatedBy) set.add(item.buyerName || item.allocatedBy);
          (item.materials || []).forEach(m => { if (m.buyerName || m.allocatedBy) set.add(m.buyerName || m.allocatedBy); });
          vals = set.size ? Array.from(set) : ['(Blanks)'];
        } else {
          vals = [item.buyerName || item.allocatedBy || '(Blanks)'];
        }
      } else if (field === 'matCode') {
        if (item.materials && !isMaterialView) {
          const set = new Set();
          (item.materials || []).forEach(m => { if (m.matCode) set.add(m.matCode); });
          vals = set.size ? Array.from(set) : ['(Blanks)'];
        } else {
          vals = [item.matCode || '(Blanks)'];
        }
      } else if (field === 'description') {
        if (item.materials && !isMaterialView) {
          const set = new Set();
          (item.materials || []).forEach(m => { if (m.description) set.add(m.description); });
          vals = set.size ? Array.from(set) : ['(Blanks)'];
        } else {
          vals = [item.description || '(Blanks)'];
        }
      } else if (field === 'deliveryDate' || field === 'deliveryEndDate') {
        if (item.materials && !isMaterialView) {
          const set = new Set();
          if (item.deliveryDate || item.deliveryEndDate) set.add(item.deliveryDate || item.deliveryEndDate);
          (item.materials || []).forEach(m => { if (m.deliveryDate || m.deliveryEndDate) set.add(m.deliveryDate || m.deliveryEndDate); });
          vals = set.size ? Array.from(set) : ['(Blanks)'];
        } else {
          vals = [item.deliveryDate || item.deliveryEndDate || '(Blanks)'];
        }
      } else if (field === 'prNumber') {
        vals = [item.prNumber || '(Blanks)'];
      } else if (field === 'department') {
        vals = [item.department || '(Blanks)'];
      } else if (field === 'priority') {
        vals = [item.priority || '(Blanks)'];
      } else if (field === 'age' || field === 'createdAt') {
        const ageDays = getPRCAge(item);
        vals = [`${ageDays}d`];
      } else {
        const raw = item[field];
        vals = [raw !== undefined && raw !== null && String(raw).trim() !== '' ? String(raw).trim() : '(Blanks)'];
      }
    }

    vals.forEach(v => {
      valCountMap.set(v, (valCountMap.get(v) || 0) + 1);
    });
  });

  const distinct = Array.from(valCountMap.entries()).map(([value, count]) => ({
    value,
    label: value,
    count
  }));

  distinct.sort((a, b) => {
    if (a.value === '(Blanks)') return 1;
    if (b.value === '(Blanks)') return -1;
    return String(a.value).localeCompare(String(b.value), undefined, { numeric: true, sensitivity: 'base' });
  });

  return distinct;
}

export function getDistinctColumnValues(field, isMaterialView = false) {
  return getDistinctTableColumnValues(isMaterialView ? 'material' : 'prc', field, isMaterialView);
}

export function updatePRC(id, patch, cascadeToMaterials = false) {
  const idx = state.prcs.findIndex(p => p.id === id);
  if (idx === -1) return;

  const current = state.prcs[idx];

  // Capture snapshot for undo stack
  recordUpdateSnapshot({
    type: 'UPDATE_PRC',
    targetType: 'PRC',
    targetId: id,
    targetName: current.prNumber || id,
    description: `Updated PRC "${current.prNumber || id}" (${Object.keys(patch).join(', ')})`,
    patch,
    previousState: {
      prc: clone(current)
    }
  });

  let materials = [...(current.materials || [])];

  if (cascadeToMaterials) {
    const cascadeFields = ['allocationNumber', 'allocationDate', 'buyerName', 'allocatedBy', 'rfqNumber', 'rfqDate', 'offersReceived', 'tcdNumber', 'tcdDate', 'tcdApproved', 'poNumber', 'poDate', 'vendorName', 'vendor', 'deliveryDate'];
    const cascadePatch = {};
    cascadeFields.forEach(key => {
      if (patch[key] !== undefined) cascadePatch[key] = patch[key];
    });

    if (Object.keys(cascadePatch).length > 0) {
      materials = materials.map(m => {
        const updatedM = { ...m, ...cascadePatch };
        const totalQty = parseFloat(updatedM.quantity) || 0;
        const procQty  = parseFloat(updatedM.processedQty) || 0;
        const clsQty   = parseFloat(updatedM.closedQty) || 0;
        updatedM.pendingQty = Math.max(0, totalQty - procQty - clsQty);
        updatedM.status = calculateMaterialStatus(updatedM);
        return updatedM;
      });
    }
  }

  const updated = { ...current, ...patch, materials };
  updated.status = calculateStatus(updated, materials);
  updated.updatedAt = new Date().toISOString();
  updated.updatedBy = state.currentUser.name;

  const prcs = [...state.prcs];
  prcs[idx] = updated;

  setState({ prcs, statusSummary: buildStatusSummary(prcs) });

  // Direct Firestore write
  directSavePRC(_getEffectiveUid(), updated);

  // If prNumber changed, propagate the new value to all downstream item records
  if (patch.prNumber !== undefined && patch.prNumber !== current.prNumber) {
    _syncPRCFieldsToDownstream(id, { prNumber: patch.prNumber });
  }

  addAuditLog({
    action: 'update_prc', collection: 'PRCs', docId: id,
    changes: { ...patch, cascaded: cascadeToMaterials }
  });
}

export function getPRCById(id) {
  return state.prcs.find(p => p.id === id) || null;
}

export function deletePRC(id, forceCascade = true) {
  const prc = state.prcs.find(p => p.id === id || p.prNumber === id);
  if (!prc) return { success: false, reason: 'PRC record not found.' };

  const prcId = prc.id;
  const prNumber = prc.prNumber;

  const hasAllocations = state.allocations.some(a => (a.items || []).some(i => i.prcId === prcId || i.prNumber === prNumber));
  const hasRFQs = state.rfqs.some(r => (r.items || []).some(i => i.prcId === prcId || i.prNumber === prNumber));
  const hasTCDs = state.tcds.some(t => (t.vendorAllocations || []).some(va => (va.items || []).some(i => i.prcId === prcId || i.prNumber === prNumber)));
  const hasPODs = state.pods.some(p => (p.items || []).some(i => i.prcId === prcId || i.prNumber === prNumber));
  const hasTrails = hasAllocations || hasRFQs || hasTCDs || hasPODs;

  const isAdmin = isSuperAdmin();

  if (hasTrails && !isAdmin && !forceCascade) {
    return { success: false, reason: 'Cannot delete PRC — it has downstream Allocation, RFQ, TCD, or PO documents. Only Super Admin has right to delete PRC and all its trails.' };
  }

  // Capture snapshot for undo stack before deletion
  recordUpdateSnapshot({
    type: 'DELETE_PRC',
    targetType: 'PRC',
    targetId: prcId,
    targetName: prNumber || prcId,
    description: `Deleted PRC "${prNumber || prcId}"`,
    patch: {},
    previousState: {
      prc: clone(prc),
      allocations: clone(state.allocations.filter(a => (a.items || []).some(i => i.prcId === prcId || i.prNumber === prNumber))),
      rfqs: clone(state.rfqs.filter(r => (r.items || []).some(i => i.prcId === prcId || i.prNumber === prNumber))),
      tcds: clone(state.tcds.filter(t => (t.vendorAllocations || []).some(va => (va.items || []).some(i => i.prcId === prcId || i.prNumber === prNumber)))),
      pods: clone(state.pods.filter(p => (p.items || []).some(i => i.prcId === prcId || i.prNumber === prNumber)))
    }
  });

  const effectiveUid = _getEffectiveUid();

  // If Super Admin or cascade requested, remove all downstream trails
  if (hasTrails && (isAdmin || forceCascade)) {
    // 1. Clean Allocations
    let updatedAllocs = [];
    state.allocations.forEach(a => {
      const remainingItems = (a.items || []).filter(i => i.prcId !== prcId && i.prNumber !== prNumber);
      if (remainingItems.length > 0) {
        const updatedAlloc = { ...a, items: remainingItems, updatedAt: new Date().toISOString() };
        updatedAllocs.push(updatedAlloc);
        directSaveAllocation(effectiveUid, updatedAlloc);
      } else {
        directDeleteAllocation(effectiveUid, a.id);
      }
    });
    state.allocations = updatedAllocs;

    // 2. Clean RFQs
    let updatedRFQs = [];
    state.rfqs.forEach(r => {
      const remainingItems = (r.items || []).filter(i => i.prcId !== prcId && i.prNumber !== prNumber);
      if (remainingItems.length > 0) {
        const updatedRfq = { ...r, items: remainingItems, updatedAt: new Date().toISOString() };
        updatedRFQs.push(updatedRfq);
        directSaveRFQ(effectiveUid, updatedRfq);
      } else {
        directDeleteRFQ(effectiveUid, r.id);
      }
    });
    state.rfqs = updatedRFQs;

    // 3. Clean TCDs
    let updatedTCDs = [];
    state.tcds.forEach(t => {
      let remainingVAs = [];
      (t.vendorAllocations || []).forEach(va => {
        const remainingItems = (va.items || []).filter(i => i.prcId !== prcId && i.prNumber !== prNumber);
        if (remainingItems.length > 0) {
          remainingVAs.push({ ...va, items: remainingItems });
        }
      });
      if (remainingVAs.length > 0) {
        const updatedTcd = { ...t, vendorAllocations: remainingVAs, updatedAt: new Date().toISOString() };
        updatedTCDs.push(updatedTcd);
        directSaveTCD(effectiveUid, updatedTcd);
      } else {
        directDeleteTCD(effectiveUid, t.id);
      }
    });
    state.tcds = updatedTCDs;

    // 4. Clean PODs
    let updatedPODs = [];
    state.pods.forEach(p => {
      const remainingItems = (p.items || []).filter(i => i.prcId !== prcId && i.prNumber !== prNumber);
      if (remainingItems.length > 0) {
        const updatedPod = { ...p, items: remainingItems, updatedAt: new Date().toISOString() };
        updatedPODs.push(updatedPod);
        directSavePOD(effectiveUid, updatedPod);
      } else {
        directDeletePOD(effectiveUid, p.id);
      }
    });
    state.pods = updatedPODs;
  }

  // Delete the PRC itself
  const prcs = state.prcs.filter(p => p.id !== prcId && p.prNumber !== prNumber);
  state.prcs = prcs;
  state.statusSummary = buildStatusSummary(prcs);
  state.totalMaterials = prcs.reduce((a, p) => a + (p.materials || []).length, 0);

  saveToLocalCache();

  // Direct Turso delete
  directDeletePRC(effectiveUid, prcId);
  directDeletePRC(effectiveUid, prNumber);

  addAuditLog({
    action: 'delete_prc_with_trails',
    collection: 'PRCs',
    docId: prNumber,
    changes: { prNumber, hadTrails: hasTrails, deletedBy: state.currentUser?.name || 'Super Admin' }
  });

  emit('*');
  return { success: true, prNumber, hadTrails: hasTrails };
}

function _syncPRCHeaderFromMaterials(prc) {
  const mats = prc.materials || [];
  const updated = { ...prc };

  const mAlloc = mats.find(m => m.allocationNumber);
  if (mAlloc) {
    updated.allocationNumber = mAlloc.allocationNumber;
    if (mAlloc.allocationDate) updated.allocationDate = mAlloc.allocationDate;
    if (mAlloc.buyerName || mAlloc.allocatedBy) {
      updated.buyerName = mAlloc.buyerName || mAlloc.allocatedBy;
      updated.allocatedBy = mAlloc.allocatedBy || mAlloc.buyerName;
    }
  }

  const mRfq = mats.find(m => m.rfqNumber);
  if (mRfq) {
    updated.rfqNumber = mRfq.rfqNumber;
    if (mRfq.rfqDate) updated.rfqDate = mRfq.rfqDate;
    if (mRfq.offersReceived !== undefined) updated.offersReceived = mRfq.offersReceived;
  }

  const mTcd = mats.find(m => m.tcdNumber);
  if (mTcd) {
    updated.tcdNumber = mTcd.tcdNumber;
    if (mTcd.tcdDate) updated.tcdDate = mTcd.tcdDate;
    if (mTcd.tcdApproved !== undefined) updated.tcdApproved = mTcd.tcdApproved;
    if (mTcd.vendorName || mTcd.vendor) updated.vendorName = mTcd.vendorName || mTcd.vendor;
  }

  const mPo = mats.find(m => m.poNumber);
  if (mPo) {
    updated.poNumber = mPo.poNumber;
    if (mPo.poDate) updated.poDate = mPo.poDate;
    if (mPo.vendorName || mPo.vendor) updated.vendorName = mPo.vendorName || mPo.vendor;
  }

  return updated;
}

export function updateMaterial(prcId, materialId, patch) {
  const prcIdx = state.prcs.findIndex(p => p.id === prcId || p.prNumber === prcId);
  if (prcIdx === -1) return;
  const prc = state.prcs[prcIdx];

  const currentMat = (prc.materials || []).find(m => m.id === materialId || (patch.matCode && m.matCode === patch.matCode));
  const matName = currentMat ? (currentMat.matCode || currentMat.description || materialId) : materialId;

  // Capture snapshot for undo stack
  recordUpdateSnapshot({
    type: 'UPDATE_MATERIAL',
    targetType: 'Material',
    targetId: `${prcId}/${materialId}`,
    targetName: matName,
    description: `Updated Material "${matName}" in PRC "${prc.prNumber || prcId}"`,
    patch,
    previousState: {
      prc: clone(prc)
    }
  });

  const materials = (prc.materials || []).map(m => {
    if (m.id === materialId || (patch.matCode && m.matCode === patch.matCode)) {
      const updatedMat = { ...m, ...patch };
      const totalQty = parseFloat(updatedMat.quantity) || 0;
      const procQty  = parseFloat(updatedMat.processedQty) || 0;
      const clsQty   = parseFloat(updatedMat.closedQty) || 0;
      updatedMat.pendingQty = Math.max(0, totalQty - procQty - clsQty);
      updatedMat.status = calculateMaterialStatus(updatedMat);
      return updatedMat;
    }
    return m;
  });

  let updatedPRC = {
    ...prc,
    materials,
    updatedAt: new Date().toISOString(),
    updatedBy: state.currentUser?.name || 'User'
  };

  updatedPRC = _syncPRCHeaderFromMaterials(updatedPRC);

  if (patch.allocationNumber) updatedPRC.allocationNumber = patch.allocationNumber;
  if (patch.allocationDate) updatedPRC.allocationDate = patch.allocationDate;
  if (patch.buyerName) { updatedPRC.buyerName = patch.buyerName; updatedPRC.allocatedBy = patch.buyerName; }
  if (patch.allocatedBy) { updatedPRC.allocatedBy = patch.allocatedBy; updatedPRC.buyerName = patch.allocatedBy; }
  if (patch.rfqNumber) updatedPRC.rfqNumber = patch.rfqNumber;
  if (patch.rfqDate) updatedPRC.rfqDate = patch.rfqDate;
  if (patch.offersReceived !== undefined) updatedPRC.offersReceived = patch.offersReceived;
  if (patch.tcdNumber) updatedPRC.tcdNumber = patch.tcdNumber;
  if (patch.tcdDate) updatedPRC.tcdDate = patch.tcdDate;
  if (patch.tcdApproved !== undefined) updatedPRC.tcdApproved = patch.tcdApproved;
  if (patch.vendorName || patch.vendor) updatedPRC.vendorName = patch.vendorName || patch.vendor;
  if (patch.poNumber) updatedPRC.poNumber = patch.poNumber;
  if (patch.poDate) updatedPRC.poDate = patch.poDate;

  updatedPRC.status = calculateStatus(updatedPRC, materials);

  const prcs = [...state.prcs];
  prcs[prcIdx] = updatedPRC;
  setState({ prcs, statusSummary: buildStatusSummary(prcs) });

  directSavePRC(_getEffectiveUid(), updatedPRC);

  // Propagate changed fields to Allocation / RFQ / TCD / POD item records
  _syncMaterialPatchToDownstream(prcId, materialId, patch);

  addAuditLog({
    action: 'update_material', collection: 'PRC Materials', docId: `${prcId}/${materialId}`,
    changes: patch
  });
}

export function bulkUpdateMaterials(prcId, materialIds, patch) {
  const prcIdx = state.prcs.findIndex(p => p.id === prcId || p.prNumber === prcId);
  if (prcIdx === -1) return;
  const prc = state.prcs[prcIdx];

  // Capture snapshot for undo stack
  recordUpdateSnapshot({
    type: 'BULK_UPDATE_MATERIALS',
    targetType: 'Material',
    targetId: prcId,
    targetName: prc.prNumber || prcId,
    description: `Bulk updated ${materialIds.length} materials in PRC "${prc.prNumber || prcId}"`,
    patch,
    previousState: {
      prc: clone(prc)
    }
  });

  const idSet = new Set(materialIds);
  const materials = (prc.materials || []).map(m => {
    if (idSet.has(m.id)) {
      const updatedMat = { ...m, ...patch };
      const totalQty = parseFloat(updatedMat.quantity) || 0;
      const procQty  = parseFloat(updatedMat.processedQty) || 0;
      const clsQty   = parseFloat(updatedMat.closedQty) || 0;
      updatedMat.pendingQty = Math.max(0, totalQty - procQty - clsQty);
      updatedMat.status = calculateMaterialStatus(updatedMat);
      return updatedMat;
    }
    return m;
  });

  let updatedPRC = {
    ...prc,
    materials,
    updatedAt: new Date().toISOString(),
    updatedBy: state.currentUser?.name || 'User'
  };

  updatedPRC = _syncPRCHeaderFromMaterials(updatedPRC);

  if (patch.allocationNumber) updatedPRC.allocationNumber = patch.allocationNumber;
  if (patch.allocationDate) updatedPRC.allocationDate = patch.allocationDate;
  if (patch.buyerName) { updatedPRC.buyerName = patch.buyerName; updatedPRC.allocatedBy = patch.buyerName; }
  if (patch.allocatedBy) { updatedPRC.allocatedBy = patch.allocatedBy; updatedPRC.buyerName = patch.allocatedBy; }
  if (patch.rfqNumber) updatedPRC.rfqNumber = patch.rfqNumber;
  if (patch.rfqDate) updatedPRC.rfqDate = patch.rfqDate;
  if (patch.offersReceived !== undefined) updatedPRC.offersReceived = patch.offersReceived;
  if (patch.tcdNumber) updatedPRC.tcdNumber = patch.tcdNumber;
  if (patch.tcdDate) updatedPRC.tcdDate = patch.tcdDate;
  if (patch.tcdApproved !== undefined) updatedPRC.tcdApproved = patch.tcdApproved;
  if (patch.vendorName || patch.vendor) updatedPRC.vendorName = patch.vendorName || patch.vendor;
  if (patch.poNumber) updatedPRC.poNumber = patch.poNumber;
  if (patch.poDate) updatedPRC.poDate = patch.poDate;

  updatedPRC.status = calculateStatus(updatedPRC, materials);

  const prcs = [...state.prcs];
  prcs[prcIdx] = updatedPRC;
  setState({ prcs, statusSummary: buildStatusSummary(prcs) });

  directSavePRC(_getEffectiveUid(), updatedPRC);

  // Propagate changed fields to Allocation / RFQ / TCD / POD item records for each material
  materialIds.forEach(matId => _syncMaterialPatchToDownstream(prcId, matId, patch));

  addAuditLog({
    action: 'bulk_update_materials', collection: 'PRC Materials', docId: prcId,
    changes: { materialCount: materialIds.length, patch }
  });
}

// ── DOWNSTREAM SYNC HELPERS ──────────────────────────────

/**
 * Fields that are considered descriptive/identity and should be mirrored
 * into ALL downstream document item records (Allocation, RFQ, TCD, POD).
 */
const _ITEM_IDENTITY_FIELDS = ['matCode', 'description', 'unit', 'prNumber'];

/**
 * Fields that are procurement-stage references. Each key maps to the
 * document type(s) whose items should receive the updated value.
 * 'alloc'  → Allocation items
 * 'rfq'    → RFQ items
 * 'tcd'    → TCD vendorAllocations[].items[]
 * 'pod'    → POD items
 */
const _STAGE_FIELDS = {
  allocationNumber: ['alloc'],
  allocationDate:   ['alloc'],
  buyerName:        ['alloc'],
  allocatedBy:      ['alloc'],
  rfqNumber:        ['rfq', 'tcd'],
  rfqDate:          ['rfq'],
  tcdNumber:        ['tcd', 'pod'],
  tcdDate:          ['tcd', 'pod'],
  tcdApproved:      ['tcd', 'pod'],
  poNumber:         ['pod'],
  poDate:           ['pod'],
  vendorName:       ['tcd', 'pod'],
  vendor:           ['tcd', 'pod'],
  deliveryDate:     ['alloc', 'rfq', 'tcd', 'pod'],
};

/**
 * Propagates a material-level patch to all Allocation / RFQ / TCD / POD
 * documents that contain an item for (prcId, materialId), creating or attaching
 * downstream document items where necessary.
 *
 * @param {string} prcId
 * @param {string} materialId
 * @param {Object} patch  - same patch object passed to updateMaterial / bulkUpdateMaterials
 */
function _syncMaterialPatchToDownstream(prcId, materialId, patch) {
  const uid = _getEffectiveUid();
  const prc = state.prcs.find(p => p.id === prcId || p.prNumber === prcId);
  const mat = prc?.materials?.find(m => m.id === materialId || (patch.matCode && m.matCode === patch.matCode));
  const prNumber = prc?.prNumber || patch.prNumber || '';
  const matCode = mat?.matCode || patch.matCode || '';
  const description = mat?.description || patch.description || '';
  const unit = mat?.unit || patch.unit || '';
  const quantity = parseFloat(patch.quantity !== undefined ? patch.quantity : (mat?.quantity || 0)) || 0;

  // Build per-stage sub-patches (identity fields always included)
  const identityPatch = {};
  _ITEM_IDENTITY_FIELDS.forEach(f => { if (patch[f] !== undefined) identityPatch[f] = patch[f]; });

  const stagePatch = { alloc: { ...identityPatch }, rfq: { ...identityPatch }, tcd: { ...identityPatch }, pod: { ...identityPatch } };
  Object.entries(_STAGE_FIELDS).forEach(([field, stages]) => {
    if (patch[field] !== undefined) {
      stages.forEach(s => { stagePatch[s][field] = patch[field]; });
    }
  });

  // 1. ALLOCATION
  const targetAllocNum = (patch.allocationNumber !== undefined ? patch.allocationNumber : (mat?.allocationNumber || '')).trim();
  if (targetAllocNum) {
    let allocations = [...state.allocations];
    let allocIdx = allocations.findIndex(a => String(a.allocationNumber || '').trim().toUpperCase() === targetAllocNum.toUpperCase());
    if (allocIdx !== -1) {
      const alloc = { ...allocations[allocIdx] };
      const items = [...(alloc.items || [])];
      const itemIdx = items.findIndex(i => (i.prcId === prcId || i.prNumber === prNumber) && (i.materialId === materialId || (matCode && i.matCode === matCode)));
      if (itemIdx !== -1) {
        items[itemIdx] = { ...items[itemIdx], ...stagePatch.alloc };
      } else {
        items.push({
          id: `alloc-item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          allocationId: alloc.id,
          prcId,
          materialId,
          prNumber,
          matCode,
          description,
          quantity,
          unit,
          ...stagePatch.alloc
        });
      }
      alloc.items = items;
      if (patch.allocationDate) alloc.allocationDate = patch.allocationDate;
      if (patch.buyerName || patch.allocatedBy) {
        alloc.buyerName = patch.buyerName || patch.allocatedBy;
        alloc.allocatedBy = patch.allocatedBy || patch.buyerName;
      }
      alloc.updatedAt = new Date().toISOString();
      allocations[allocIdx] = alloc;
      directSaveAllocation(uid, alloc);
      setState({ allocations });
    } else {
      const newAlloc = {
        id: `alloc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        allocationNumber: targetAllocNum,
        allocationDate: patch.allocationDate || new Date().toISOString().split('T')[0],
        buyerName: patch.buyerName || patch.allocatedBy || '',
        allocatedBy: patch.allocatedBy || patch.buyerName || '',
        status: 'Active',
        createdAt: new Date().toISOString(),
        createdBy: state.currentUser?.name || 'User',
        items: [{
          id: `alloc-item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          prcId,
          materialId,
          prNumber,
          matCode,
          description,
          quantity,
          unit,
          ...stagePatch.alloc
        }]
      };
      allocations = [newAlloc, ...allocations];
      directSaveAllocation(uid, newAlloc);
      setState({ allocations });
    }
  } else if (patch.allocationNumber === '') {
    let allocations = [...state.allocations];
    let allocChanged = false;
    allocations = allocations.map(a => {
      const remainingItems = (a.items || []).filter(i => !( (i.prcId === prcId || i.prNumber === prNumber) && (i.materialId === materialId || (matCode && i.matCode === matCode)) ));
      if (remainingItems.length !== (a.items || []).length) {
        allocChanged = true;
        return { ...a, items: remainingItems, updatedAt: new Date().toISOString() };
      }
      return a;
    }).filter(a => {
      if (a.items && a.items.length === 0) {
        directDeleteAllocation(uid, a.id);
        if (a.allocationNumber && a.allocationNumber !== a.id) directDeleteAllocation(uid, a.allocationNumber);
        return false;
      }
      if (allocChanged) directSaveAllocation(uid, a);
      return true;
    });
    if (allocChanged) {
      setState({ allocations });
    }
  }

  // 2. RFQ
  const targetRfqNum = (patch.rfqNumber || mat?.rfqNumber || '').trim();
  if (targetRfqNum) {
    let rfqs = [...state.rfqs];
    let rfqIdx = rfqs.findIndex(r => String(r.rfqNumber || '').trim().toUpperCase() === targetRfqNum.toUpperCase());
    if (rfqIdx !== -1) {
      const rfq = { ...rfqs[rfqIdx] };
      const items = [...(rfq.items || [])];
      const itemIdx = items.findIndex(i => (i.prcId === prcId || i.prNumber === prNumber) && (i.materialId === materialId || (matCode && i.matCode === matCode)));
      if (itemIdx !== -1) {
        items[itemIdx] = { ...items[itemIdx], ...stagePatch.rfq };
      } else {
        items.push({
          id: `rfq-item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          rfqId: rfq.id,
          prcId,
          materialId,
          allocationId: mat?.allocationNumber || '',
          prNumber,
          matCode,
          description,
          quantity,
          unit,
          ...stagePatch.rfq
        });
      }
      rfq.items = items;
      if (patch.rfqDate) rfq.rfqDate = patch.rfqDate;
      if (patch.offersReceived !== undefined) rfq.offersReceived = patch.offersReceived;
      rfq.updatedAt = new Date().toISOString();
      rfqs[rfqIdx] = rfq;
      directSaveRFQ(uid, rfq);
      setState({ rfqs });
    } else {
      const newRFQ = {
        id: `rfq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        rfqNumber: targetRfqNum,
        rfqDate: patch.rfqDate || new Date().toISOString().split('T')[0],
        status: 'Active',
        isClosed: false,
        offersReceived: patch.offersReceived || false,
        createdAt: new Date().toISOString(),
        createdBy: state.currentUser?.name || 'User',
        items: [{
          id: `rfq-item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          prcId,
          materialId,
          allocationId: mat?.allocationNumber || '',
          prNumber,
          matCode,
          description,
          quantity,
          unit,
          ...stagePatch.rfq
        }]
      };
      rfqs = [newRFQ, ...rfqs];
      directSaveRFQ(uid, newRFQ);
      setState({ rfqs });
    }
  }

  // 3. TCD
  const targetTcdNum = (patch.tcdNumber || mat?.tcdNumber || '').trim();
  if (targetTcdNum) {
    let tcds = [...state.tcds];
    let tcdIdx = tcds.findIndex(t => String(t.tcdNumber || '').trim().toUpperCase() === targetTcdNum.toUpperCase());
    const vendorName = patch.vendorName || patch.vendor || mat?.vendorName || mat?.vendor || 'Vendor';
    if (tcdIdx !== -1) {
      const tcd = { ...tcds[tcdIdx] };
      const vas = [...(tcd.vendorAllocations || tcd.vendors || [])];
      let vaIdx = vas.findIndex(v => String(v.vendorName || v.name || '').trim().toUpperCase() === vendorName.toUpperCase());
      if (vaIdx === -1) {
        vas.push({ vendorName, items: [] });
        vaIdx = vas.length - 1;
      }
      const va = { ...vas[vaIdx] };
      const items = [...(va.items || [])];
      const itemIdx = items.findIndex(i => (i.prcId === prcId || i.prNumber === prNumber) && (i.materialId === materialId || (matCode && i.matCode === matCode)));
      if (itemIdx !== -1) {
        items[itemIdx] = { ...items[itemIdx], ...stagePatch.tcd };
      } else {
        items.push({
          id: `tcd-item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          tcdId: tcd.id,
          vendorName,
          prcId,
          materialId,
          rfqId: mat?.rfqNumber || '',
          prNumber,
          matCode,
          description,
          quantity,
          unit,
          ...stagePatch.tcd
        });
      }
      va.items = items;
      vas[vaIdx] = va;
      tcd.vendorAllocations = vas;
      tcd.vendors = vas;
      if (patch.tcdDate) tcd.tcdDate = patch.tcdDate;
      if (patch.tcdApproved !== undefined) tcd.approved = patch.tcdApproved;
      tcd.updatedAt = new Date().toISOString();
      tcds[tcdIdx] = tcd;
      directSaveTCD(uid, tcd);
      setState({ tcds });
    } else {
      const newTCD = {
        id: `tcd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        tcdNumber: targetTcdNum,
        tcdDate: patch.tcdDate || new Date().toISOString().split('T')[0],
        status: patch.tcdApproved ? 'Approved' : 'Pending Approval',
        approved: patch.tcdApproved || false,
        approvedDate: patch.tcdApproved ? new Date().toISOString() : null,
        approvedBy: patch.tcdApproved ? (state.currentUser?.name || 'Admin') : null,
        createdAt: new Date().toISOString(),
        createdBy: state.currentUser?.name || 'User',
        vendorAllocations: [{
          vendorName,
          items: [{
            id: `tcd-item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            vendorName,
            prcId,
            materialId,
            rfqId: mat?.rfqNumber || '',
            prNumber,
            matCode,
            description,
            quantity,
            unit,
            ...stagePatch.tcd
          }]
        }]
      };
      newTCD.vendors = newTCD.vendorAllocations;
      tcds = [newTCD, ...tcds];
      directSaveTCD(uid, newTCD);
      setState({ tcds });
    }
  }

  // 4. POD
  const targetPoNum = (patch.poNumber || mat?.poNumber || '').trim();
  if (targetPoNum) {
    let pods = [...state.pods];
    let podIdx = pods.findIndex(p => String(p.poNumber || '').trim().toUpperCase() === targetPoNum.toUpperCase());
    const vendorName = patch.vendorName || patch.vendor || mat?.vendorName || mat?.vendor || '';
    if (podIdx !== -1) {
      const pod = { ...pods[podIdx] };
      const items = [...(pod.items || [])];
      const itemIdx = items.findIndex(i => (i.prcId === prcId || i.prNumber === prNumber) && (i.materialId === materialId || (matCode && i.matCode === matCode)));
      if (itemIdx !== -1) {
        items[itemIdx] = { ...items[itemIdx], ...stagePatch.pod };
      } else {
        items.push({
          id: `pod-item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          podId: pod.id,
          prcId,
          materialId,
          rfqId: mat?.rfqNumber || '',
          prNumber,
          matCode,
          description,
          quantity,
          unit,
          ...stagePatch.pod
        });
      }
      pod.items = items;
      if (patch.poDate) pod.poDate = patch.poDate;
      if (vendorName) pod.vendorName = vendorName;
      if (patch.tcdNumber) pod.tcdNumber = patch.tcdNumber;
      pod.status = 'Issued';
      pod.updatedAt = new Date().toISOString();
      pods[podIdx] = pod;
      directSavePOD(uid, pod);
      setState({ pods });
    } else {
      const newPOD = {
        id: `pod-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        poNumber: targetPoNum,
        poDate: patch.poDate || new Date().toISOString().split('T')[0],
        vendorName,
        tcdNumber: patch.tcdNumber || mat?.tcdNumber || '',
        status: 'Issued',
        createdAt: new Date().toISOString(),
        createdBy: state.currentUser?.name || 'User',
        items: [{
          id: `pod-item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          prcId,
          materialId,
          rfqId: mat?.rfqNumber || '',
          prNumber,
          matCode,
          description,
          quantity,
          unit,
          ...stagePatch.pod
        }]
      };
      pods = [newPOD, ...pods];
      directSavePOD(uid, newPOD);
      setState({ pods });
    }
  }
}

/**
 * Propagates PRC-level identity field changes (currently prNumber) to all
 * downstream documents that embed items keyed by prcId.
 *
 * @param {string} prcId
 * @param {Object} prcPatch  - subset of PRC fields to mirror onto item records
 */
function _syncPRCFieldsToDownstream(prcId, prcPatch) {
  const uid = _getEffectiveUid();
  const itemPatch = {};
  if (prcPatch.prNumber !== undefined) itemPatch.prNumber = prcPatch.prNumber;
  if (!Object.keys(itemPatch).length) return;

  // Allocations
  let allocations = [...state.allocations];
  let allocChanged = false;
  allocations = allocations.map(alloc => {
    const hasMatch = (alloc.items || []).some(i => i.prcId === prcId);
    if (!hasMatch) return alloc;
    const updatedItems = alloc.items.map(i => i.prcId === prcId ? { ...i, ...itemPatch } : i);
    allocChanged = true;
    const updated = { ...alloc, items: updatedItems, updatedAt: new Date().toISOString() };
    directSaveAllocation(uid, updated);
    return updated;
  });
  if (allocChanged) setState({ allocations });

  // RFQs
  let rfqs = [...state.rfqs];
  let rfqChanged = false;
  rfqs = rfqs.map(rfq => {
    const hasMatch = (rfq.items || []).some(i => i.prcId === prcId);
    if (!hasMatch) return rfq;
    const updatedItems = rfq.items.map(i => i.prcId === prcId ? { ...i, ...itemPatch } : i);
    rfqChanged = true;
    const updated = { ...rfq, items: updatedItems, updatedAt: new Date().toISOString() };
    directSaveRFQ(uid, updated);
    return updated;
  });
  if (rfqChanged) setState({ rfqs });

  // TCDs
  let tcds = [...state.tcds];
  let tcdChanged = false;
  tcds = tcds.map(tcd => {
    const vas = tcd.vendorAllocations || tcd.vendors || [];
    let tcdModified = false;
    const updatedVAs = vas.map(va => {
      const hasMatch = (va.items || []).some(i => i.prcId === prcId);
      if (!hasMatch) return va;
      tcdModified = true;
      return { ...va, items: va.items.map(i => i.prcId === prcId ? { ...i, ...itemPatch } : i) };
    });
    if (!tcdModified) return tcd;
    tcdChanged = true;
    const vaKey = tcd.vendorAllocations ? 'vendorAllocations' : 'vendors';
    const updated = { ...tcd, [vaKey]: updatedVAs, updatedAt: new Date().toISOString() };
    directSaveTCD(uid, updated);
    return updated;
  });
  if (tcdChanged) setState({ tcds });

  // PODs
  let pods = [...state.pods];
  let podChanged = false;
  pods = pods.map(pod => {
    const hasMatch = (pod.items || []).some(i => i.prcId === prcId);
    if (!hasMatch) return pod;
    const updatedItems = pod.items.map(i => i.prcId === prcId ? { ...i, ...itemPatch } : i);
    podChanged = true;
    const updated = { ...pod, items: updatedItems, updatedAt: new Date().toISOString() };
    directSavePOD(uid, updated);
    return updated;
  });
  if (podChanged) setState({ pods });
}

// ── ALLOCATION OPERATIONS ─────────────────────────────────

export function getAllocatedQty(prcId, materialId) {
  return state.allocations.reduce((sum, alloc) => {
    return sum + (alloc.items || [])
      .filter(i => i.prcId === prcId && i.materialId === materialId)
      .reduce((s, i) => s + (parseFloat(i.quantity) || 0), 0);
  }, 0);
}

export function isPRCShortClosed(p) {
  if (!p) return false;
  if (p.isShortClosed === true || p.shortClosed === true) return true;
  const s = String(p.status || '').trim().toLowerCase();
  const prs = String(p.prStatus || '').trim().toLowerCase();
  const shortKeywords = ['short-close', 'short-closed', 'short close', 'short closed', 'shortclose', 'shortclosed'];
  if (shortKeywords.includes(s) || shortKeywords.includes(prs)) return true;
  return false;
}

export function isMaterialShortClosed(m, prc) {
  if (!m) return false;
  if (prc && isPRCShortClosed(prc)) return true;
  if (m.isShortClosed === true || m.shortClosed === true) return true;
  const s = String(m.status || '').trim().toLowerCase();
  const prs = String(m.prStatus || '').trim().toLowerCase();
  const shortKeywords = ['short-close', 'short-closed', 'short close', 'short closed', 'shortclose', 'shortclosed'];
  if (shortKeywords.includes(s) || shortKeywords.includes(prs)) return true;
  return false;
}

export function isPRCAuthorised(p) {
  if (!p) return false;
  if (isPRCShortClosed(p)) return false;
  if (p.isPRNotApproved || p.isWrongPRC || p.isFuturePRC) return false;

  let s = String(p.prStatus || p.status || '').trim().toLowerCase();
  if (s === 'future prc' || s === 'wrong prc' || s === 'pr not approved' || s === 'rejected' ||
      s === 'short-close' || s === 'short close' || s === 'short closed' || s === 'shortclosed') return false;

  // If Authorised by or Authorised date/data is available, consider PRC as authorised even if prStatus shows Pending
  const hasAuthMeta = !!(
    (p.authorizedBy && String(p.authorizedBy).trim()) ||
    (p.authorizedOn && String(p.authorizedOn).trim()) ||
    (p.authorisedBy && String(p.authorisedBy).trim()) ||
    (p.authorisedOn && String(p.authorisedOn).trim()) ||
    (p.authorizedDate && String(p.authorizedDate).trim()) ||
    (p.authorisedDate && String(p.authorisedDate).trim())
  );

  if (hasAuthMeta) return true;

  return s === 'authorised' || s === 'authorized' || s === 'approved';
}

export function _isExcludedFromPending(item, prc) {
  const shortKeywords = ['short-close', 'short-closed', 'short close', 'short closed', 'shortclose', 'shortclosed'];
  const excludedPRCKeywords = ['future prc', 'wrong prc', 'pr not approved', 'system issue', ...shortKeywords];

  // 1. Check parent PRC short close & exception flags
  if (prc) {
    if (isPRCShortClosed(prc)) return true;
    if (prc.isPRNotApproved || prc.isWrongPRC || prc.isFuturePRC || prc.isSystemIssue) return true;
    const prcS = String(prc.status || prc.prStatus || '').toLowerCase().trim();
    if (excludedPRCKeywords.includes(prcS)) return true;

    // If whole PRC pendingQty is explicitly 0
    if (prc.pendingQty !== undefined && prc.pendingQty !== null && String(prc.pendingQty).trim() !== '' && parseFloat(prc.pendingQty) <= 0) {
      if (Array.isArray(prc.materials) && prc.materials.length > 0) {
        const anyMatPending = prc.materials.some(m => m.pendingQty === undefined || m.pendingQty === null || String(m.pendingQty).trim() === '' || parseFloat(m.pendingQty) > 0);
        if (!anyMatPending) return true;
      } else {
        return true;
      }
    }
  }

  // 2. Find corresponding material on PRC if item links to a material
  let mat = null;
  if (prc && Array.isArray(prc.materials) && item) {
    mat = prc.materials.find(m =>
      (item.materialId && m.id === item.materialId) ||
      (item.materialCode && (m.materialCode === item.materialCode || m.matCode === item.materialCode || m.itemCode === item.materialCode)) ||
      (item.matCode && (m.matCode === item.matCode || m.materialCode === item.matCode || m.itemCode === item.matCode)) ||
      (item.itemCode && (m.materialCode === item.itemCode || m.matCode === item.itemCode || m.itemCode === item.itemCode))
    );
  }

  // Check material-level short close & pending quantity = 0
  if (mat) {
    if (isMaterialShortClosed(mat, prc) || mat.isFuturePRC || mat.isWrongPRC || mat.isPRNotApproved || mat.isSystemIssue) return true;
    const matSt = String(mat.status || '').trim().toLowerCase();
    const matPr = String(mat.prStatus || '').trim().toLowerCase();
    if (excludedPRCKeywords.includes(matSt) || excludedPRCKeywords.includes(matPr)) return true;

    // Pending quantity is 0 on material
    if (mat.pendingQty !== undefined && mat.pendingQty !== null && String(mat.pendingQty).trim() !== '') {
      if (parseFloat(mat.pendingQty) <= 0) return true;
    }
    if (mat.pendingQuantity !== undefined && mat.pendingQuantity !== null && String(mat.pendingQuantity).trim() !== '') {
      if (parseFloat(mat.pendingQuantity) <= 0) return true;
    }
    if (mat.quantity !== undefined && mat.quantity !== null && String(mat.quantity).trim() !== '') {
      if (parseFloat(mat.quantity) <= 0) return true;
    }
  }

  // 3. Item-level checks (on allocation / RFQ / TCD item objects)
  if (item) {
    if (isMaterialShortClosed(item, prc) || isPRCShortClosed(item) || item.isFuturePRC || item.isWrongPRC || item.isPRNotApproved || item.isSystemIssue) return true;
    const itemSt = String(item.status || '').trim().toLowerCase();
    const itemPr = String(item.prStatus || '').trim().toLowerCase();
    if (excludedPRCKeywords.includes(itemSt) || excludedPRCKeywords.includes(itemPr)) return true;

    // Item-level pendingQty is 0
    if (item.pendingQty !== undefined && item.pendingQty !== null && String(item.pendingQty).trim() !== '') {
      if (parseFloat(item.pendingQty) <= 0) return true;
    }
    if (item.pendingQuantity !== undefined && item.pendingQuantity !== null && String(item.pendingQuantity).trim() !== '') {
      if (parseFloat(item.pendingQuantity) <= 0) return true;
    }
    if (item.quantity !== undefined && item.quantity !== null && String(item.quantity).trim() !== '') {
      if (parseFloat(item.quantity) <= 0) return true;
    }
  }

  return false;
}

export function getAvailablePRCsForAllocation() {
  const prcs = isSuperAdmin() ? (state.prcs || []) : (state.prcs || []).filter(p => doesRecordPertainToCurrentUser(p));
  return prcs.filter(p => {
    if (isPRCShortClosed(p)) return false;
    // Only PRCs in Authorised status are eligible for allocation
    if (!isPRCAuthorised(p)) return false;

    const mats = p.materials || [];
    if (!mats.length) return false;

    const availableMats = mats.filter(m => {
      if (isMaterialShortClosed(m, p)) return false;
      const allocd = getAllocatedQty(p.id, m.id);
      const totalQty = parseFloat(m.quantity) || 0;
      return allocd < totalQty || totalQty === 0;
    });

    return availableMats.length > 0;
  });
}

export function createAllocation(data) {
  const normNum = String(data.allocationNumber || '').trim();
  const existingIdx = state.allocations.findIndex(
    a => String(a.allocationNumber || '').trim().toUpperCase() === normNum.toUpperCase()
  );

  let allocation;
  let allocations;

  if (existingIdx !== -1) {
    // Merge into existing allocation
    const existing = state.allocations[existingIdx];
    const existingItems = [...(existing.items || [])];
    const itemKeySet = new Set(existingItems.map(i => `${i.prcId}::${i.materialId}`));

    (data.items || []).forEach(newItem => {
      const key = `${newItem.prcId}::${newItem.materialId}`;
      if (!itemKeySet.has(key)) {
        existingItems.push(newItem);
        itemKeySet.add(key);
      } else {
        const ex = existingItems.find(i => `${i.prcId}::${i.materialId}` === key);
        if (ex) ex.quantity = parseFloat(newItem.quantity) || ex.quantity;
      }
    });

    allocation = {
      ...existing,
      allocationNumber: normNum || existing.allocationNumber,
      allocationDate: data.allocationDate || existing.allocationDate,
      buyerName: data.buyerName || existing.buyerName,
      allocatedBy: data.buyerName || existing.allocatedBy,
      items: existingItems,
      updatedAt: new Date().toISOString(),
      updatedBy: state.currentUser?.name || 'User'
    };

    allocations = [...state.allocations];
    allocations[existingIdx] = allocation;
  } else {
    // Create fresh allocation
    allocation = {
      id: `alloc-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      allocationNumber: normNum,
      allocationDate: data.allocationDate,
      buyerName: data.buyerName || '',
      allocatedBy: data.buyerName || '',
      items: data.items || [],
      createdAt: new Date().toISOString(),
      createdBy: state.currentUser?.name || 'User',
      status: 'Active'
    };
    allocations = [allocation, ...state.allocations];
  }

  allocations = consolidateAllocations(allocations);

  const prcs = [...state.prcs];
  const affectedPrcIds = new Set((allocation.items || []).map(i => i.prcId));

  affectedPrcIds.forEach(prcId => {
    const prcIdx = prcs.findIndex(p => p.id === prcId);
    if (prcIdx === -1) return;
    const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };

    (allocation.items || []).filter(i => i.prcId === prcId).forEach(item => {
      const matIdx = prc.materials.findIndex(m => m.id === item.materialId);
      if (matIdx === -1) return;
      prc.materials[matIdx] = {
        ...prc.materials[matIdx],
        allocationNumber: allocation.allocationNumber,
        allocationDate: allocation.allocationDate,
        buyerName: allocation.buyerName,
        allocatedBy: allocation.buyerName
      };
      prc.materials[matIdx].status = calculateMaterialStatus(prc.materials[matIdx]);
    });

    prc.allocationNumber = prc.allocationNumber || allocation.allocationNumber;
    prc.allocationDate   = prc.allocationDate || allocation.allocationDate;
    prc.buyerName        = prc.buyerName || allocation.buyerName;
    prc.allocatedBy      = prc.allocatedBy || allocation.buyerName;

    prc.status = calculateStatus(prc, prc.materials);
    prc.updatedAt = new Date().toISOString();
    prcs[prcIdx] = prc;

    // Direct Firestore write for updated PRC
    directSavePRC(_getEffectiveUid(), prc);
  });

  setState({ allocations, prcs, statusSummary: buildStatusSummary(prcs) });

  // Direct Firestore write for allocation
  directSaveAllocation(_getEffectiveUid(), allocation);

  addAuditLog({
    action: existingIdx !== -1 ? 'merge_allocation' : 'create_allocation',
    collection: 'Allocations',
    docId: allocation.id,
    changes: { allocationNumber: allocation.allocationNumber, itemCount: allocation.items.length, prcCount: affectedPrcIds.size }
  });

  return allocation;
}

export function getAllocationById(id) {
  return state.allocations.find(a => a.id === id) || null;
}

export function updateAllocation(id, data) {
  const allocIdx = state.allocations.findIndex(a => a.id === id);
  if (allocIdx === -1) return { success: false, reason: 'Allocation document not found' };

  const existingAlloc = state.allocations[allocIdx];

  // Capture snapshot for undo stack
  const affectedPrcIdsBefore = new Set((existingAlloc.items || []).concat(data.items || []).map(i => i.prcId));
  const affectedPRCsBefore = state.prcs.filter(p => affectedPrcIdsBefore.has(p.id));
  recordUpdateSnapshot({
    type: 'UPDATE_ALLOCATION',
    targetType: 'Allocation',
    targetId: id,
    targetName: existingAlloc.allocationNumber || id,
    description: `Updated Allocation "${existingAlloc.allocationNumber || id}"`,
    patch: data,
    previousState: {
      allocation: clone(existingAlloc),
      prcs: clone(affectedPRCsBefore)
    }
  });

  const updatedAlloc = {
    ...existingAlloc,
    allocationNumber: data.allocationNumber || existingAlloc.allocationNumber,
    allocationDate: data.allocationDate || existingAlloc.allocationDate,
    buyerName: data.buyerName !== undefined ? data.buyerName : existingAlloc.buyerName,
    items: data.items !== undefined ? data.items : existingAlloc.items,
    updatedAt: new Date().toISOString(),
    updatedBy: state.currentUser?.name || 'User'
  };

  const allocations = [...state.allocations];
  allocations[allocIdx] = updatedAlloc;

  const prcs = [...state.prcs];
  const affectedPrcIds = new Set(updatedAlloc.items.map(i => i.prcId));

  affectedPrcIds.forEach(prcId => {
    const prcIdx = prcs.findIndex(p => p.id === prcId);
    if (prcIdx === -1) return;
    const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };

    updatedAlloc.items.filter(i => i.prcId === prcId).forEach(item => {
      const matIdx = prc.materials.findIndex(m => m.id === item.materialId);
      if (matIdx === -1) return;
      prc.materials[matIdx] = {
        ...prc.materials[matIdx],
        allocationNumber: updatedAlloc.allocationNumber,
        allocationDate: updatedAlloc.allocationDate,
        buyerName: updatedAlloc.buyerName,
        allocatedBy: updatedAlloc.buyerName
      };
      prc.materials[matIdx].status = calculateMaterialStatus(prc.materials[matIdx]);
    });

    prc.allocationNumber = updatedAlloc.allocationNumber;
    prc.allocationDate = updatedAlloc.allocationDate;
    prc.buyerName = updatedAlloc.buyerName;
    prc.allocatedBy = updatedAlloc.buyerName;

    prc.status = calculateStatus(prc, prc.materials);
    prc.updatedAt = new Date().toISOString();
    prcs[prcIdx] = prc;

    directSavePRC(_getEffectiveUid(), prc);
  });

  setState({ allocations, prcs, statusSummary: buildStatusSummary(prcs) });

  directSaveAllocation(_getEffectiveUid(), updatedAlloc);

  addAuditLog({
    action: 'update_allocation', collection: 'Allocations', docId: id,
    changes: { allocationNumber: updatedAlloc.allocationNumber, buyerName: updatedAlloc.buyerName }
  });

  return { success: true, allocation: updatedAlloc };
}

export function deleteAllocation(id, forceCascade = false) {
  const alloc = state.allocations.find(a => a.id === id || a.allocationNumber === id);
  if (!alloc) {
    return { success: false, reason: 'Allocation document not found.' };
  }

  const allocId = alloc.id;
  const allocNum = alloc.allocationNumber;

  // Check downstream RFQs referencing this allocation
  const downstreamRFQs = (state.rfqs || []).filter(r =>
    (r.items || []).some(i => i.allocationId === allocId || i.allocationId === allocNum || i.allocationNumber === allocNum)
  );

  if (downstreamRFQs.length > 0 && !isSuperAdmin() && !forceCascade) {
    return {
      success: false,
      reason: `Cannot delete Allocation "${allocNum}" — it has ${downstreamRFQs.length} downstream RFQ document(s). Please delete or unlink downstream RFQ documents first.`
    };
  }

  // Snapshot before deletion
  const affectedPrcsBeforeDelete = state.prcs.filter(p =>
    (alloc.items || []).some(i => i.prcId === p.id) ||
    p.allocationNumber === allocNum ||
    (p.materials || []).some(m => m.allocationNumber === allocNum)
  );
  recordUpdateSnapshot({
    type: 'DELETE_ALLOCATION',
    targetType: 'Allocation',
    targetId: allocId,
    targetName: allocNum || allocId,
    description: `Deleted Allocation "${allocNum || allocId}"`,
    patch: {},
    previousState: {
      allocation: clone(alloc),
      prcs: clone(affectedPrcsBeforeDelete),
      rfqs: clone(downstreamRFQs)
    }
  });

  const effectiveUid = _getEffectiveUid();

  // If superadmin or forceCascade, clean downstream RFQs
  if (downstreamRFQs.length > 0 && (isSuperAdmin() || forceCascade)) {
    let updatedRFQs = [];
    state.rfqs.forEach(r => {
      const remainingItems = (r.items || []).filter(i => i.allocationId !== allocId && i.allocationId !== allocNum && i.allocationNumber !== allocNum);
      if (remainingItems.length > 0) {
        const updatedRfq = { ...r, items: remainingItems, updatedAt: new Date().toISOString() };
        updatedRFQs.push(updatedRfq);
        directSaveRFQ(effectiveUid, updatedRfq);
      } else {
        directDeleteRFQ(effectiveUid, r.id);
      }
    });
    state.rfqs = updatedRFQs;
  }

  // 1. Remove from state.allocations
  const allocations = state.allocations.filter(a => a.id !== allocId && a.allocationNumber !== allocNum);

  // 2. Identify all affected PRCs & materials
  const affectedPrcIds = new Set((alloc.items || []).map(i => i.prcId).filter(Boolean));
  const affectedMatKeys = new Set((alloc.items || []).map(i => `${i.prcId}::${i.materialId}`));

  // Also include any PRCs currently referencing this allocationNumber
  state.prcs.forEach(p => {
    if (p.allocationNumber === allocNum || (p.materials || []).some(m => m.allocationNumber === allocNum)) {
      affectedPrcIds.add(p.id);
    }
  });

  const updatedPrcs = state.prcs.map(prc => {
    if (!affectedPrcIds.has(prc.id)) return prc;

    let prcCopy = { ...prc, materials: [...(prc.materials || [])] };
    let prcModified = false;

    prcCopy.materials = prcCopy.materials.map(m => {
      const matKey = `${prc.id}::${m.id}`;
      const isTargetMat = affectedMatKeys.has(matKey) || m.allocationNumber === allocNum;

      if (isTargetMat) {
        prcModified = true;
        const updatedM = {
          ...m,
          allocationNumber: '',
          allocationDate: '',
          buyerName: '',
          allocatedBy: ''
        };
        updatedM.status = calculateMaterialStatus(updatedM);
        return updatedM;
      }
      return m;
    });

    // Re-determine top-level PRC allocation fields from remaining materials
    const remainingAllocMat = prcCopy.materials.find(m => m.allocationNumber && m.allocationNumber !== allocNum);
    if (remainingAllocMat) {
      prcCopy.allocationNumber = remainingAllocMat.allocationNumber;
      prcCopy.allocationDate = remainingAllocMat.allocationDate || '';
      prcCopy.buyerName = remainingAllocMat.buyerName || remainingAllocMat.allocatedBy || '';
      prcCopy.allocatedBy = remainingAllocMat.allocatedBy || remainingAllocMat.buyerName || '';
      prcModified = true;
    } else if (prcCopy.allocationNumber === allocNum || !prcCopy.materials.some(m => m.allocationNumber)) {
      prcCopy.allocationNumber = '';
      prcCopy.allocationDate = '';
      prcCopy.buyerName = '';
      prcCopy.allocatedBy = '';
      prcModified = true;
    }

    if (prcModified) {
      prcCopy.status = calculateStatus(prcCopy, prcCopy.materials);
      prcCopy.updatedAt = new Date().toISOString();
      directSavePRC(effectiveUid, prcCopy);
    }

    return prcCopy;
  });

  state.allocations = allocations;
  state.prcs = updatedPrcs;
  state.statusSummary = buildStatusSummary(updatedPrcs);

  saveToLocalCache();

  // 3. Database direct delete
  directDeleteAllocation(effectiveUid, allocId);
  if (allocNum && allocNum !== allocId) {
    directDeleteAllocation(effectiveUid, allocNum);
  }

  addAuditLog({
    action: 'delete_allocation',
    collection: 'Allocations',
    docId: allocId,
    changes: { allocationNumber: allocNum, prcCount: affectedPrcIds.size }
  });

  return { success: true };
}

// ── RFQ OPERATIONS ────────────────────────────────────────

export function getRFQdQty(allocationId, prcId, materialId) {
  return state.rfqs.reduce((sum, rfq) => {
    return sum + rfq.items
      .filter(i => i.allocationId === allocationId && i.prcId === prcId && i.materialId === materialId)
      .reduce((s, i) => s + (parseFloat(i.quantity) || 0), 0);
  }, 0);
}

export function getAvailableForRFQ() {
  const result = [];
  state.allocations.forEach(alloc => {
    if (!isSuperAdmin() && !doesRecordPertainToCurrentUser(alloc)) return;
    alloc.items.forEach(item => {
      // Resolve the parent PRC so we can check its status and material-line flags
      const prc = state.prcs.find(p => p.id === item.prcId || p.prNumber === item.prNumber);

      // Wrong PRC, Future PRC, Short-Close PRC, or Short-Close material line → treat as completed
      if (_isExcludedFromPending(item, prc)) return;

      const rfqdQty = getRFQdQty(alloc.id, item.prcId, item.materialId);
      const available = (parseFloat(item.quantity) || 0) - rfqdQty;
      if (available > 0) {
        result.push({
          ...item,
          allocationId: alloc.id,
          allocationNumber: alloc.allocationNumber,
          allocationDate: alloc.allocationDate,
          buyerName: alloc.buyerName,
          availableQty: available,
          allocatedQty: parseFloat(item.quantity) || 0,
          rfqdQty
        });
      }
    });
  });
  return result;
}

export function createRFQ(data) {
  const normNum = String(data.rfqNumber || '').trim();
  const existingIdx = state.rfqs.findIndex(
    r => String(r.rfqNumber || '').trim().toUpperCase() === normNum.toUpperCase()
  );

  let rfq;
  let rfqs;

  if (existingIdx !== -1) {
    // Merge into existing RFQ
    const existing = state.rfqs[existingIdx];
    const existingItems = [...(existing.items || [])];
    const itemKeySet = new Set(existingItems.map(i => `${i.prcId}::${i.materialId}`));

    (data.items || []).forEach(newItem => {
      const key = `${newItem.prcId}::${newItem.materialId}`;
      if (!itemKeySet.has(key)) {
        existingItems.push(newItem);
        itemKeySet.add(key);
      } else {
        const ex = existingItems.find(i => `${i.prcId}::${i.materialId}` === key);
        if (ex) ex.quantity = parseFloat(newItem.quantity) || ex.quantity;
      }
    });

    rfq = {
      ...existing,
      rfqNumber: normNum || existing.rfqNumber,
      rfqDate: data.rfqDate || existing.rfqDate,
      items: existingItems,
      updatedAt: new Date().toISOString(),
      updatedBy: state.currentUser?.name || 'User'
    };

    rfqs = [...state.rfqs];
    rfqs[existingIdx] = rfq;
  } else {
    // Create fresh RFQ
    const newItems = data.items || [];
    const initialStatus = getRFQStatus({ items: newItems, isClosed: false }, state.prcs);
    rfq = {
      id: `rfq-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      rfqNumber: normNum,
      rfqDate: data.rfqDate,
      items: newItems,
      createdAt: new Date().toISOString(),
      createdBy: state.currentUser?.name || 'User',
      status: initialStatus,
      offersReceived: false
    };
    rfqs = [rfq, ...state.rfqs];
  }

  rfqs = consolidateRFQs(rfqs);

  const prcs = [...state.prcs];
  (rfq.items || []).forEach(item => {
    const prcIdx = prcs.findIndex(p => p.id === item.prcId);
    if (prcIdx === -1) return;
    const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };
    const matIdx = prc.materials.findIndex(m => m.id === item.materialId);
    if (matIdx === -1) return;
    prc.materials[matIdx] = {
      ...prc.materials[matIdx],
      rfqNumber: rfq.rfqNumber,
      rfqDate: rfq.rfqDate
    };
    prc.rfqNumber = rfq.rfqNumber;
    prc.rfqDate = rfq.rfqDate;
    prc.rfqBy = prc.rfqBy || state.currentUser?.name || 'App User';
    prc.materials[matIdx].status = calculateMaterialStatus(prc.materials[matIdx]);
    prc.status = calculateStatus(prc, prc.materials);
    prc.updatedAt = new Date().toISOString();
    prcs[prcIdx] = prc;

    directSavePRC(_getEffectiveUid(), prc);
  });

  setState({ rfqs, prcs, statusSummary: buildStatusSummary(prcs) });

  directSaveRFQ(_getEffectiveUid(), rfq);

  addAuditLog({
    action: existingIdx !== -1 ? 'merge_rfq' : 'create_rfq',
    collection: 'RFQs',
    docId: rfq.id,
    changes: { rfqNumber: rfq.rfqNumber, itemCount: rfq.items.length }
  });

  return rfq;
}

export function getRFQById(id) {
  return state.rfqs.find(r => r.id === id) || null;
}

export function updateRFQ(id, data) {
  const rfqIdx = state.rfqs.findIndex(r => r.id === id);
  if (rfqIdx === -1) return { success: false, reason: 'RFQ document not found' };

  const existingRFQ = state.rfqs[rfqIdx];
  const oldRfqNumber = existingRFQ.rfqNumber;
  const newRfqNumber = data.rfqNumber || existingRFQ.rfqNumber;
  const newRfqDate = data.rfqDate || existingRFQ.rfqDate;
  const newItems = data.items !== undefined ? data.items : existingRFQ.items;

  if (!newItems || !newItems.length) {
    return { success: false, reason: 'An RFQ must contain at least one material item.' };
  }

  // Detect removed items
  const newItemKeys = new Set(newItems.map(i => `${i.prcId}::${i.materialId}`));
  const removedItems = (existingRFQ.items || []).filter(i => !newItemKeys.has(`${i.prcId}::${i.materialId}`));

  // Check if any removed item has downstream TCDs
  for (const removed of removedItems) {
    const tcdQty = getTCDdQty(id, removed.prcId, removed.materialId);
    if (tcdQty > 0) {
      return {
        success: false,
        reason: `Cannot remove item (${removed.matCode}) — it has ${tcdQty} qty already allocated in downstream TCD documents.`
      };
    }
  }

  // Capture snapshot for undo stack
  const affectedPrcIdsBefore = new Set((existingRFQ.items || []).concat(newItems || []).map(i => i.prcId));
  const affectedPRCsBefore = state.prcs.filter(p => affectedPrcIdsBefore.has(p.id));
  recordUpdateSnapshot({
    type: 'UPDATE_RFQ',
    targetType: 'RFQ',
    targetId: id,
    targetName: existingRFQ.rfqNumber || id,
    description: `Updated RFQ "${existingRFQ.rfqNumber || id}"`,
    patch: data,
    previousState: {
      rfq: clone(existingRFQ),
      prcs: clone(affectedPRCsBefore)
    }
  });

  const updatedRFQ = {
    ...existingRFQ,
    rfqNumber: newRfqNumber,
    rfqDate: newRfqDate,
    items: newItems,
    updatedAt: new Date().toISOString(),
    updatedBy: state.currentUser?.name || 'User'
  };

  const rfqs = [...state.rfqs];
  rfqs[rfqIdx] = updatedRFQ;

  let prcs = [...state.prcs];

  // 1. Process Removed Items - reset RFQ fields on PRC and materials if no other RFQs link to them
  removedItems.forEach(removed => {
    const prcIdx = prcs.findIndex(p => p.id === removed.prcId);
    if (prcIdx === -1) return;
    const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };
    const matIdx = prc.materials.findIndex(m => m.id === removed.materialId);
    if (matIdx !== -1) {
      const otherRFQ = rfqs.find(r => r.id !== id && (r.items || []).some(i => i.prcId === removed.prcId && i.materialId === removed.materialId));
      if (otherRFQ) {
        prc.materials[matIdx] = {
          ...prc.materials[matIdx],
          rfqNumber: otherRFQ.rfqNumber,
          rfqDate: otherRFQ.rfqDate
        };
      } else {
        const matCopy = { ...prc.materials[matIdx] };
        delete matCopy.rfqNumber;
        delete matCopy.rfqDate;
        prc.materials[matIdx] = matCopy;
      }
      prc.materials[matIdx].status = calculateMaterialStatus(prc.materials[matIdx]);
    }

    const remainingMatWithRFQ = prc.materials.find(m => m.rfqNumber);
    if (remainingMatWithRFQ) {
      prc.rfqNumber = remainingMatWithRFQ.rfqNumber;
      prc.rfqDate = remainingMatWithRFQ.rfqDate;
    } else {
      const prcCopy = { ...prc };
      delete prcCopy.rfqNumber;
      delete prcCopy.rfqDate;
      delete prcCopy.rfqBy;
      Object.assign(prc, prcCopy);
    }
    prc.status = calculateStatus(prc, prc.materials);
    prc.updatedAt = new Date().toISOString();
    prcs[prcIdx] = prc;

    directSavePRC(_getEffectiveUid(), prc);
  });

  // 2. Process Current/Added Items - assign updated RFQ info
  const affectedPrcIds = new Set(updatedRFQ.items.map(i => i.prcId));
  affectedPrcIds.forEach(prcId => {
    const prcIdx = prcs.findIndex(p => p.id === prcId);
    if (prcIdx === -1) return;
    const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };

    updatedRFQ.items.filter(i => i.prcId === prcId).forEach(item => {
      const matIdx = prc.materials.findIndex(m => m.id === item.materialId);
      if (matIdx === -1) return;
      prc.materials[matIdx] = {
        ...prc.materials[matIdx],
        rfqNumber: newRfqNumber,
        rfqDate: newRfqDate
      };
      prc.materials[matIdx].status = calculateMaterialStatus(prc.materials[matIdx]);
    });

    prc.rfqNumber = newRfqNumber;
    prc.rfqDate = newRfqDate;
    prc.rfqBy = prc.rfqBy || state.currentUser?.name || 'App User';
    prc.status = calculateStatus(prc, prc.materials);
    prc.updatedAt = new Date().toISOString();
    prcs[prcIdx] = prc;

    directSavePRC(_getEffectiveUid(), prc);
  });

  // Cascade RFQ number changes to downstream TCDs if RFQ number changed
  let tcds = [...state.tcds];
  if (oldRfqNumber !== newRfqNumber) {
    let tcdsChanged = false;
    tcds = tcds.map(tcd => {
      let tcdModified = false;
      const updatedTcd = { ...tcd };
      if (updatedTcd.rfqId === id || updatedTcd.rfqNumber === oldRfqNumber) {
        updatedTcd.rfqNumber = newRfqNumber;
        tcdModified = true;
      }
      if (updatedTcd.vendorAllocations) {
        updatedTcd.vendorAllocations = updatedTcd.vendorAllocations.map(va => {
          let vaModified = false;
          const updatedItems = (va.items || []).map(it => {
            if (it.rfqId === id || it.rfqNumber === oldRfqNumber) {
              vaModified = true;
              return { ...it, rfqNumber: newRfqNumber };
            }
            return it;
          });
          return vaModified ? { ...va, items: updatedItems } : va;
        });
        if (updatedTcd.vendorAllocations.some(va => (va.items || []).some(it => it.rfqNumber === newRfqNumber))) {
          tcdModified = true;
        }
      }
      if (tcdModified) {
        tcdsChanged = true;
        directSaveTCD(_getEffectiveUid(), updatedTcd);
        return updatedTcd;
      }
      return tcd;
    });
    if (tcdsChanged) {
      setState({ tcds });
    }
  }

  setState({ rfqs, prcs, statusSummary: buildStatusSummary(prcs) });

  directSaveRFQ(_getEffectiveUid(), updatedRFQ);

  addAuditLog({
    action: 'update_rfq', collection: 'RFQs', docId: id,
    changes: { rfqNumber: updatedRFQ.rfqNumber, rfqDate: updatedRFQ.rfqDate, itemCount: updatedRFQ.items.length }
  });

  return { success: true, rfq: updatedRFQ };
}

export function deleteRFQ(id, forceCascade = false) {
  const rfq = state.rfqs.find(r => r.id === id || r.rfqNumber === id);
  if (!rfq) return { success: false, reason: 'RFQ not found.' };

  const rfqId = rfq.id;
  const rfqNum = rfq.rfqNumber;

  const hasTCDs = (state.tcds || []).some(t => (t.vendorAllocations || []).some(va => (va.items || []).some(i => i.rfqId === rfqId || i.rfqNumber === rfqNum)));
  if (hasTCDs && !isSuperAdmin() && !forceCascade) {
    return { success: false, reason: 'Cannot delete RFQ — it has downstream TCD documents. Please delete or unlink downstream TCD documents first.' };
  }

  // Capture snapshot for undo stack before deletion
  const affectedPrcsBeforeDelete = state.prcs.filter(p =>
    (rfq.items || []).some(i => i.prcId === p.id) ||
    p.rfqNumber === rfqNum ||
    (p.materials || []).some(m => m.rfqNumber === rfqNum)
  );
  recordUpdateSnapshot({
    type: 'DELETE_RFQ',
    targetType: 'RFQ',
    targetId: rfqId,
    targetName: rfqNum || rfqId,
    description: `Deleted RFQ "${rfqNum || rfqId}"`,
    patch: {},
    previousState: {
      rfq: clone(rfq),
      prcs: clone(affectedPrcsBeforeDelete),
      tcds: clone(state.tcds.filter(t => (t.vendorAllocations || []).some(va => (va.items || []).some(i => i.rfqId === rfqId || i.rfqNumber === rfqNum))))
    }
  });

  const effectiveUid = _getEffectiveUid();

  if (hasTCDs && (isSuperAdmin() || forceCascade)) {
    let updatedTcds = [];
    state.tcds.forEach(t => {
      let remainingVAs = [];
      (t.vendorAllocations || []).forEach(va => {
        const remainingItems = (va.items || []).filter(i => i.rfqId !== rfqId && i.rfqNumber !== rfqNum);
        if (remainingItems.length > 0) remainingVAs.push({ ...va, items: remainingItems });
      });
      if (remainingVAs.length > 0) {
        const updatedTcd = { ...t, vendorAllocations: remainingVAs, updatedAt: new Date().toISOString() };
        updatedTcds.push(updatedTcd);
        directSaveTCD(effectiveUid, updatedTcd);
      } else {
        directDeleteTCD(effectiveUid, t.id);
      }
    });
    state.tcds = updatedTcds;
  }

  const rfqs = state.rfqs.filter(r => r.id !== rfqId && r.rfqNumber !== rfqNum);

  // Revert RFQ fields on affected PRCs/materials
  const affectedPrcIds = new Set((rfq.items || []).map(i => i.prcId).filter(Boolean));
  const affectedMatKeys = new Set((rfq.items || []).map(i => `${i.prcId}::${i.materialId}`));

  state.prcs.forEach(p => {
    if (p.rfqNumber === rfqNum || (p.materials || []).some(m => m.rfqNumber === rfqNum)) {
      affectedPrcIds.add(p.id);
    }
  });

  const updatedPrcs = state.prcs.map(prc => {
    if (!affectedPrcIds.has(prc.id)) return prc;
    let prcCopy = { ...prc, materials: [...(prc.materials || [])] };
    let prcModified = false;

    prcCopy.materials = prcCopy.materials.map(m => {
      const matKey = `${prc.id}::${m.id}`;
      if (affectedMatKeys.has(matKey) || m.rfqNumber === rfqNum) {
        prcModified = true;
        const updatedM = { ...m, rfqNumber: '', rfqDate: '', rfqBy: '', offersReceived: false, offersReceivedDate: '' };
        updatedM.status = calculateMaterialStatus(updatedM);
        return updatedM;
      }
      return m;
    });

    const remainingRfqMat = prcCopy.materials.find(m => m.rfqNumber && m.rfqNumber !== rfqNum);
    if (remainingRfqMat) {
      prcCopy.rfqNumber = remainingRfqMat.rfqNumber;
      prcCopy.rfqDate = remainingRfqMat.rfqDate || '';
    } else if (prcCopy.rfqNumber === rfqNum || !prcCopy.materials.some(m => m.rfqNumber)) {
      prcCopy.rfqNumber = '';
      prcCopy.rfqDate = '';
      prcCopy.rfqBy = '';
      prcCopy.offersReceived = false;
      prcCopy.offersReceivedDate = '';
      prcModified = true;
    }

    if (prcModified) {
      prcCopy.status = calculateStatus(prcCopy, prcCopy.materials);
      prcCopy.updatedAt = new Date().toISOString();
      directSavePRC(effectiveUid, prcCopy);
    }
    return prcCopy;
  });

  state.rfqs = rfqs;
  state.prcs = updatedPrcs;
  state.statusSummary = buildStatusSummary(updatedPrcs);
  saveToLocalCache();

  directDeleteRFQ(effectiveUid, rfqId);
  if (rfqNum && rfqNum !== rfqId) directDeleteRFQ(effectiveUid, rfqNum);

  addAuditLog({ action: 'delete_rfq', collection: 'RFQs', docId: rfqId, changes: { rfqNumber: rfqNum } });
  return { success: true };
}

export function toggleRFQClose(id, isClosed) {
  const rfqIdx = state.rfqs.findIndex(r => r.id === id);
  if (rfqIdx === -1) return { success: false, reason: 'RFQ not found' };

  const rfq = { ...state.rfqs[rfqIdx] };
  rfq.isClosed = !!isClosed;
  rfq.status = isClosed ? 'Closed' : getRFQStatus({ ...rfq, isClosed: false }, state.prcs);
  rfq.updatedAt = new Date().toISOString();
  rfq.updatedBy = state.currentUser?.name || 'App User';

  const rfqs = [...state.rfqs];
  rfqs[rfqIdx] = rfq;
  setState({ rfqs });

  // Direct Firestore write for updated RFQ
  directSaveRFQ(_getEffectiveUid(), rfq);

  addAuditLog({
    action: 'toggle_rfq_close',
    collection: 'RFQs',
    docId: id,
    changes: { isClosed: rfq.isClosed, status: rfq.status }
  });

  return { success: true, isClosed: rfq.isClosed };
}

// ── TCD OPERATIONS ────────────────────────────────────────

export function getTCDdQty(rfqId, prcId, materialId) {
  return state.tcds.reduce((sum, tcd) => {
    return sum + (tcd.vendorAllocations || []).reduce((vaSum, va) => {
      return vaSum + va.items
        .filter(i => i.rfqId === rfqId && i.prcId === prcId && i.materialId === materialId)
        .reduce((s, i) => s + (parseFloat(i.quantity) || 0), 0);
    }, 0);
  }, 0);
}

export function getAvailableForTCD() {
  const result = [];
  state.rfqs.forEach(rfq => {
    if (!isSuperAdmin() && !doesRecordPertainToCurrentUser(rfq)) return;
    // RFQ itself marked Short-Close → skip entirely
    if (isPRCShortClosed(rfq) || rfq.isShortClosed ||
        String(rfq.status || '').toLowerCase() === 'short closed' ||
        String(rfq.status || '').toLowerCase() === 'short-close') return;

    // Closed RFQs ONLY are eligible for TCD creation
    const isClosed = !!(rfq.isClosed || String(rfq.status || '').trim().toLowerCase() === 'closed');
    if (!isClosed) return;

    rfq.items.forEach(item => {
      const prc = state.prcs.find(p => p.id === item.prcId || p.prNumber === item.prNumber);

      // Wrong PRC, Future PRC, Short-Close PRC, or Short-Close material line → treat as completed
      if (_isExcludedFromPending(item, prc)) return;

      const tcdQty = getTCDdQty(rfq.id, item.prcId, item.materialId);
      const available = (parseFloat(item.quantity) || 0) - tcdQty;
      if (available > 0) {
        result.push({
          ...item,
          rfqId: rfq.id,
          rfqNumber: rfq.rfqNumber,
          rfqDate: rfq.rfqDate,
          availableQty: available,
          rfqdQty: parseFloat(item.quantity) || 0,
          tcdQty
        });
      }
    });
  });
  return result;
}

export function createTCD(data) {
  const normNum = String(data.tcdNumber || '').trim();
  const existingIdx = state.tcds.findIndex(
    t => String(t.tcdNumber || '').trim().toUpperCase() === normNum.toUpperCase()
  );

  let tcd;
  let tcds;
  const newVAs = data.vendorAllocations || data.vendors || [];

  if (existingIdx !== -1) {
    // Merge into existing TCD
    const existing = state.tcds[existingIdx];
    const mergedVAs = [...(existing.vendorAllocations || existing.vendors || [])];
    const vendorMap = new Map();

    mergedVAs.forEach((va, vIdx) => {
      vendorMap.set(String(va.vendorName || '').trim().toUpperCase(), vIdx);
    });

    newVAs.forEach(va => {
      const vKey = String(va.vendorName || '').trim().toUpperCase();
      if (vendorMap.has(vKey)) {
        const vIdx = vendorMap.get(vKey);
        const existingVA = { ...mergedVAs[vIdx], items: [...(mergedVAs[vIdx].items || [])] };
        const itemKeySet = new Set(existingVA.items.map(i => `${i.prcId}::${i.materialId}`));

        (va.items || []).forEach(newItem => {
          const iKey = `${newItem.prcId}::${newItem.materialId}`;
          if (!itemKeySet.has(iKey)) {
            existingVA.items.push(newItem);
            itemKeySet.add(iKey);
          } else {
            const ex = existingVA.items.find(i => `${i.prcId}::${i.materialId}` === iKey);
            if (ex) {
              ex.quantity = parseFloat(newItem.quantity) || ex.quantity;
              if (newItem.unitPrice) ex.unitPrice = newItem.unitPrice;
              if (newItem.totalPrice) ex.totalPrice = newItem.totalPrice;
            }
          }
        });
        mergedVAs[vIdx] = existingVA;
      } else {
        mergedVAs.push(va);
        vendorMap.set(vKey, mergedVAs.length - 1);
      }
    });

    tcd = {
      ...existing,
      tcdNumber: normNum || existing.tcdNumber,
      tcdDate: data.tcdDate || existing.tcdDate,
      vendorAllocations: mergedVAs,
      vendors: mergedVAs,
      updatedAt: new Date().toISOString(),
      updatedBy: state.currentUser?.name || 'Admin'
    };

    tcds = [...state.tcds];
    tcds[existingIdx] = tcd;
  } else {
    // Create fresh TCD
    tcd = {
      id: `tcd-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      tcdNumber: normNum,
      tcdDate: data.tcdDate,
      vendorAllocations: newVAs,
      vendors: newVAs,
      createdAt: new Date().toISOString(),
      createdBy: state.currentUser?.name || 'Admin',
      status: 'Pending Approval',
      approved: false,
      approvedDate: null,
      approvedBy: null
    };
    tcds = [tcd, ...state.tcds];
  }

  tcds = consolidateTCDs(tcds);

  const prcs = [...state.prcs];
  (tcd.vendorAllocations || []).forEach(va => {
    (va.items || []).forEach(item => {
      const prcIdx = prcs.findIndex(p => p.id === item.prcId);
      if (prcIdx === -1) return;
      const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };
      const matIdx = prc.materials.findIndex(m => m.id === item.materialId);
      if (matIdx === -1) return;
      prc.materials[matIdx] = {
        ...prc.materials[matIdx],
        tcdNumber: tcd.tcdNumber,
        tcdDate: tcd.tcdDate
      };
      prc.tcdNumber = tcd.tcdNumber;
      prc.tcdDate = tcd.tcdDate;
      prc.tcdBy = prc.tcdBy || state.currentUser?.name || 'Admin';
      prc.prStatus = 'Process Completed';
      prc.materials[matIdx].status = calculateMaterialStatus(prc.materials[matIdx]);
      prc.status = calculateStatus(prc, prc.materials);
      prc.updatedAt = new Date().toISOString();
      prcs[prcIdx] = prc;

      directSavePRC(_getEffectiveUid(), prc);
    });
  });

  setState({ tcds, prcs, statusSummary: buildStatusSummary(prcs) });

  directSaveTCD(_getEffectiveUid(), tcd);

  addAuditLog({
    action: existingIdx !== -1 ? 'merge_tcd' : 'create_tcd',
    collection: 'TCDs',
    docId: tcd.id,
    changes: { tcdNumber: tcd.tcdNumber, vendorCount: tcd.vendorAllocations.length }
  });

  return tcd;
}

export function getTCDById(id) {
  return state.tcds.find(t => t.id === id) || null;
}

export function approveTCD(tcdId) {
  const tcdIdx = state.tcds.findIndex(t => t.id === tcdId);
  if (tcdIdx === -1) return { success: false, reason: 'TCD not found.' };

  const tcd = { ...state.tcds[tcdIdx] };
  if (tcd.approved) return { success: false, reason: 'TCD is already approved.' };

  tcd.approved = true;
  tcd.approvedDate = new Date().toISOString();
  tcd.approvedBy = state.currentUser?.name || 'Admin';
  tcd.status = 'Approved';

  const tcds = [...state.tcds];
  tcds[tcdIdx] = tcd;

  const generatedPODs = [];
  const prcs = [...state.prcs];

  (tcd.vendorAllocations || []).forEach(va => {
    const pod = {
      id: `pod-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      poNumber: '',
      poDate: '',
      vendorName: va.vendorName,
      tcdId: tcd.id,
      tcdNumber: tcd.tcdNumber,
      items: va.items.map(i => ({ ...i })),
      createdAt: new Date().toISOString(),
      createdBy: state.currentUser?.name || 'Admin',
      status: 'Pending PO Number'
    };
    generatedPODs.push(pod);

    directSavePOD(_getEffectiveUid(), pod);

    va.items.forEach(item => {
      const prcIdx = prcs.findIndex(p => p.id === item.prcId);
      if (prcIdx === -1) return;
      const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };
      const matIdx = prc.materials.findIndex(m => m.id === item.materialId);
      if (matIdx === -1) return;
      const mat = { ...prc.materials[matIdx] };
      mat.tcdApproved = true;
      mat.tcdApprovedDate = tcd.approvedDate;
      mat.vendorName = va.vendorName;
      mat.vendor = va.vendorName;
      mat.status = calculateMaterialStatus(mat);
      prc.materials[matIdx] = mat;
      prc.tcdApproved = true;
      prc.tcdApprovedDate = tcd.approvedDate;
      prc.tcdApprovedBy = tcd.approvedBy;
      prc.prStatus = 'Process Completed';
      prc.status = calculateStatus(prc, prc.materials);
      prc.updatedAt = new Date().toISOString();
      prcs[prcIdx] = prc;

      directSavePRC(_getEffectiveUid(), prc);
    });
  });

  const pods = [...generatedPODs, ...state.pods];
  setState({ tcds, pods, prcs, statusSummary: buildStatusSummary(prcs) });

  directSaveTCD(_getEffectiveUid(), tcd);

  addAuditLog({
    action: 'approve_tcd', collection: 'TCDs', docId: tcdId,
    changes: { tcdNumber: tcd.tcdNumber, podsGenerated: generatedPODs.length }
  });

  return { success: true, pods: generatedPODs };
}

export function deleteTCD(id, forceCascade = false) {
  const tcd = state.tcds.find(t => t.id === id || t.tcdNumber === id);
  if (!tcd) return { success: false, reason: 'TCD not found.' };

  const tcdId = tcd.id;
  const tcdNum = tcd.tcdNumber;

  const hasPODs = (state.pods || []).some(p => (p.tcdId === tcdId || p.tcdNumber === tcdNum) && p.poNumber);
  if (hasPODs && !isSuperAdmin() && !forceCascade) {
    return { success: false, reason: 'Cannot delete TCD — it has downstream issued Purchase Orders. Please delete or un-issue POs first.' };
  }

  const effectiveUid = _getEffectiveUid();
  const tcds = state.tcds.filter(t => t.id !== tcdId && t.tcdNumber !== tcdNum);
  const pods = state.pods.filter(p => p.tcdId !== tcdId && p.tcdNumber !== tcdNum);

  // Revert TCD fields on affected PRCs/materials
  const affectedPrcIds = new Set();
  const affectedMatKeys = new Set();
  (tcd.vendorAllocations || []).forEach(va => {
    (va.items || []).forEach(i => {
      if (i.prcId) affectedPrcIds.add(i.prcId);
      affectedMatKeys.add(`${i.prcId}::${i.materialId}`);
    });
  });

  state.prcs.forEach(p => {
    if (p.tcdNumber === tcdNum || (p.materials || []).some(m => m.tcdNumber === tcdNum)) {
      affectedPrcIds.add(p.id);
    }
  });

  const updatedPrcs = state.prcs.map(prc => {
    if (!affectedPrcIds.has(prc.id)) return prc;
    let prcCopy = { ...prc, materials: [...(prc.materials || [])] };
    let prcModified = false;

    prcCopy.materials = prcCopy.materials.map(m => {
      const matKey = `${prc.id}::${m.id}`;
      if (affectedMatKeys.has(matKey) || m.tcdNumber === tcdNum) {
        prcModified = true;
        const updatedM = {
          ...m,
          tcdNumber: '',
          tcdDate: '',
          tcdApproved: false,
          tcdApprovedDate: null,
          vendorName: '',
          vendor: ''
        };
        updatedM.status = calculateMaterialStatus(updatedM);
        return updatedM;
      }
      return m;
    });

    const remainingTcdMat = prcCopy.materials.find(m => m.tcdNumber && m.tcdNumber !== tcdNum);
    if (remainingTcdMat) {
      prcCopy.tcdNumber = remainingTcdMat.tcdNumber;
      prcCopy.tcdDate = remainingTcdMat.tcdDate || '';
    } else if (prcCopy.tcdNumber === tcdNum || !prcCopy.materials.some(m => m.tcdNumber)) {
      prcCopy.tcdNumber = '';
      prcCopy.tcdDate = '';
      prcCopy.tcdApproved = false;
      prcCopy.tcdApprovedDate = null;
      prcCopy.tcdApprovedBy = null;
      prcModified = true;
    }

    if (prcModified) {
      prcCopy.status = calculateStatus(prcCopy, prcCopy.materials);
      prcCopy.updatedAt = new Date().toISOString();
      directSavePRC(effectiveUid, prcCopy);
    }
    return prcCopy;
  });

  state.tcds = tcds;
  state.pods = pods;
  state.prcs = updatedPrcs;
  state.statusSummary = buildStatusSummary(updatedPrcs);
  saveToLocalCache();

  directDeleteTCD(effectiveUid, tcdId);
  if (tcdNum && tcdNum !== tcdId) directDeleteTCD(effectiveUid, tcdNum);

  addAuditLog({ action: 'delete_tcd', collection: 'TCDs', docId: tcdId, changes: { tcdNumber: tcdNum } });
  return { success: true };
}

// ── POD OPERATIONS ────────────────────────────────────────

export function getPODById(id) {
  return state.pods.find(p => p.id === id) || null;
}

export function getAvailableForPOD() {
  const result = [];
  state.tcds.forEach(tcd => {
    if (!isSuperAdmin() && !doesRecordPertainToCurrentUser(tcd)) return;
    if (!tcd.approved && String(tcd.status || '').trim().toLowerCase() !== 'approved') return;
    const allocations = tcd.vendorAllocations || tcd.vendors || [];
    allocations.forEach(va => {
      const vendorName = va.vendorName || va.name || '';
      (va.items || []).forEach(item => {
        const prc = state.prcs.find(p => p.id === item.prcId || p.prNumber === item.prNumber);

        // Wrong PRC, Future PRC, Short-Close PRC, or Short-Close material line → treat as completed
        if (_isExcludedFromPending(item, prc)) return;

        result.push({
          ...item,
          tcdId: tcd.id,
          tcdNumber: tcd.tcdNumber,
          tcdDate: tcd.tcdDate,
          vendorName
        });
      });
    });
  });
  return result;
}

export function createPOD(data) {
  const normNum = String(data.poNumber || '').trim();
  const existingIdx = normNum ? state.pods.findIndex(
    p => String(p.poNumber || '').trim().toUpperCase() === normNum.toUpperCase()
  ) : -1;

  let pod;
  let pods;

  if (existingIdx !== -1) {
    const existing = state.pods[existingIdx];
    let existingItems = [...(existing.items || [])];
    if (existingItems.length === 0) {
      existingItems = getPODItems(existing, state.prcs, state.tcds);
    }
    const itemKeySet = new Set(existingItems.map(i => `${i.prcId}::${i.materialId}`));

    (data.items || []).forEach(newItem => {
      const key = `${newItem.prcId}::${newItem.materialId}`;
      if (!itemKeySet.has(key)) {
        existingItems.push(newItem);
        itemKeySet.add(key);
      } else {
        const ex = existingItems.find(i => `${i.prcId}::${i.materialId}` === key);
        if (ex) ex.quantity = parseFloat(newItem.quantity) || ex.quantity;
      }
    });

    pod = {
      ...existing,
      poNumber: normNum || existing.poNumber,
      poDate: data.poDate || existing.poDate,
      vendorName: data.vendorName || existing.vendorName,
      tcdId: data.tcdId || existing.tcdId,
      tcdNumber: data.tcdNumber || existing.tcdNumber,
      items: existingItems,
      updatedAt: new Date().toISOString(),
      updatedBy: state.currentUser?.name || 'Admin',
      status: normNum ? 'Issued' : existing.status
    };
    pods = [...state.pods];
    pods[existingIdx] = pod;
  } else {
    let items = (data.items || []).map(i => ({ ...i }));
    if (items.length === 0) {
      items = getPODItems(data, state.prcs, state.tcds);
    }

    pod = {
      id: `pod-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      poNumber: normNum,
      poDate: data.poDate || '',
      vendorName: data.vendorName || '',
      tcdId: data.tcdId || '',
      tcdNumber: data.tcdNumber || '',
      items: items,
      createdAt: new Date().toISOString(),
      createdBy: state.currentUser?.name || 'Admin',
      status: normNum ? 'Issued' : 'Pending PO Number'
    };
    pods = [pod, ...state.pods];
  }

  const prcs = [...state.prcs];

  if (pod.poNumber || pod.poDate) {
    (pod.items || []).forEach(item => {
      const prcIdx = prcs.findIndex(p => p.id === item.prcId || p.prNumber === item.prcId || p.prNumber === item.prNumber || p.id === item.prNumber);
      if (prcIdx === -1) return;
      const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };
      const matIdx = prc.materials.findIndex(m => m.id === item.materialId || (item.matCode && m.matCode === item.matCode));
      if (matIdx === -1) return;
      const mat = { ...prc.materials[matIdx] };
      if (pod.poNumber) mat.poNumber = pod.poNumber;
      if (pod.poDate) mat.poDate = pod.poDate;
      mat.vendorName = item.vendorName || pod.vendorName;
      mat.vendor = item.vendorName || pod.vendorName;
      if (item.tcdNumber || pod.tcdNumber) mat.tcdNumber = item.tcdNumber || pod.tcdNumber;
      mat.processedQty = (parseFloat(mat.processedQty) || 0) + (parseFloat(item.quantity) || 0);
      const totalQty = parseFloat(mat.quantity) || 0;
      const clsQty = parseFloat(mat.closedQty) || 0;
      mat.pendingQty = Math.max(0, totalQty - mat.processedQty - clsQty);
      mat.status = calculateMaterialStatus(mat);
      prc.materials[matIdx] = mat;
      if (pod.poNumber) prc.poNumber = pod.poNumber;
      if (pod.poDate) prc.poDate = pod.poDate;
      prc.poBy = state.currentUser?.name || 'Admin';
      if (pod.vendorName) prc.vendorName = pod.vendorName;
      if (item.tcdNumber || pod.tcdNumber) prc.tcdNumber = item.tcdNumber || pod.tcdNumber;
      prc.prStatus = 'Process Completed';
      prc.status = calculateStatus(prc, prc.materials);
      prc.updatedAt = new Date().toISOString();
      prcs[prcIdx] = prc;

      directSavePRC(_getEffectiveUid(), prc);
    });
  }

  setState({ pods, prcs, statusSummary: buildStatusSummary(prcs) });
  directSavePOD(_getEffectiveUid(), pod);

  addAuditLog({
    action: existingIdx !== -1 ? 'update_pod' : 'create_pod',
    collection: 'PODs',
    docId: pod.id,
    changes: { poNumber: pod.poNumber, vendorName: pod.vendorName, itemCount: (pod.items || []).length }
  });

  return pod;
}

export function deletePOD(id) {
  const pod = state.pods.find(p => p.id === id || p.poNumber === id);
  if (!pod) return { success: false, reason: 'POD document not found.' };

  const podId = pod.id;
  const poNum = pod.poNumber;
  const effectiveUid = _getEffectiveUid();

  // Snapshot before deletion
  const affectedPrcsBeforeDelete = state.prcs.filter(p =>
    (pod.items || []).some(i => i.prcId === p.id) ||
    (poNum && p.poNumber === poNum) ||
    (p.materials || []).some(m => poNum && m.poNumber === poNum)
  );
  recordUpdateSnapshot({
    type: 'DELETE_POD',
    targetType: 'Purchase Order',
    targetId: podId,
    targetName: poNum || podId,
    description: `Deleted PO "${poNum || podId}"`,
    patch: {},
    previousState: {
      pod: clone(pod),
      prcs: clone(affectedPrcsBeforeDelete)
    }
  });

  const pods = state.pods.filter(p => p.id !== podId && p.poNumber !== podId);

  // If PO had been issued and stamped on materials, revert them
  const affectedPrcIds = new Set((pod.items || []).map(i => i.prcId).filter(Boolean));
  const affectedMatKeys = new Set((pod.items || []).map(i => `${i.prcId}::${i.materialId}`));

  state.prcs.forEach(p => {
    if ((poNum && p.poNumber === poNum) || (p.materials || []).some(m => poNum && m.poNumber === poNum)) {
      affectedPrcIds.add(p.id);
    }
  });

  const updatedPrcs = state.prcs.map(prc => {
    if (!affectedPrcIds.has(prc.id)) return prc;
    let prcCopy = { ...prc, materials: [...(prc.materials || [])] };
    let prcModified = false;

    prcCopy.materials = prcCopy.materials.map(m => {
      const matKey = `${prc.id}::${m.id}`;
      const itemMatch = (pod.items || []).find(i => i.prcId === prc.id && i.materialId === m.id);
      if (affectedMatKeys.has(matKey) || (poNum && m.poNumber === poNum)) {
        prcModified = true;
        const subQty = parseFloat(itemMatch?.quantity) || 0;
        const currentProc = parseFloat(m.processedQty) || 0;
        const newProc = Math.max(0, currentProc - subQty);
        const totalQty = parseFloat(m.quantity) || 0;
        const clsQty = parseFloat(m.closedQty) || 0;
        const updatedM = {
          ...m,
          poNumber: '',
          poDate: '',
          processedQty: newProc,
          pendingQty: Math.max(0, totalQty - newProc - clsQty)
        };
        updatedM.status = calculateMaterialStatus(updatedM);
        return updatedM;
      }
      return m;
    });

    const remainingPoMat = prcCopy.materials.find(m => m.poNumber && m.poNumber !== poNum);
    if (remainingPoMat) {
      prcCopy.poNumber = remainingPoMat.poNumber;
      prcCopy.poDate = remainingPoMat.poDate || '';
    } else if ((poNum && prcCopy.poNumber === poNum) || !prcCopy.materials.some(m => m.poNumber)) {
      prcCopy.poNumber = '';
      prcCopy.poDate = '';
      prcModified = true;
    }

    if (prcModified) {
      prcCopy.status = calculateStatus(prcCopy, prcCopy.materials);
      prcCopy.updatedAt = new Date().toISOString();
      directSavePRC(effectiveUid, prcCopy);
    }
    return prcCopy;
  });

  state.pods = pods;
  state.prcs = updatedPrcs;
  state.statusSummary = buildStatusSummary(updatedPrcs);
  saveToLocalCache();

  directDeletePOD(effectiveUid, podId);
  if (poNum && poNum !== podId) directDeletePOD(effectiveUid, poNum);

  addAuditLog({ action: 'delete_pod', collection: 'PODs', docId: podId, changes: { poNumber: poNum } });
  return { success: true };
}

export function updatePOD(podId, patch) {
  const podIdx = state.pods.findIndex(p => p.id === podId);
  if (podIdx === -1) return;

  const existingPod = state.pods[podIdx];
  const items = (existingPod.items && existingPod.items.length) ? existingPod.items : getPODItems(existingPod, state.prcs, state.tcds);

  // Capture snapshot for undo stack
  const affectedPrcIdsBefore = new Set((items || []).map(i => i.prcId));
  const affectedPRCsBefore = state.prcs.filter(p => affectedPrcIdsBefore.has(p.id));
  recordUpdateSnapshot({
    type: 'UPDATE_POD',
    targetType: 'Purchase Order',
    targetId: podId,
    targetName: existingPod.poNumber || podId,
    description: `Updated PO "${existingPod.poNumber || podId}"`,
    patch,
    previousState: {
      pod: clone(existingPod),
      prcs: clone(affectedPRCsBefore)
    }
  });

  const pod = { ...existingPod, items, ...patch };
  if (patch.poNumber) pod.status = 'Issued';
  pod.updatedAt = new Date().toISOString();
  pod.updatedBy = state.currentUser?.name || 'Admin';

  const pods = [...state.pods];
  pods[podIdx] = pod;

  const prcs = [...state.prcs];
  if (patch.poNumber || patch.poDate) {
    (pod.items || []).forEach(item => {
      const prcIdx = prcs.findIndex(p => p.id === item.prcId || p.prNumber === item.prcId || p.prNumber === item.prNumber);
      if (prcIdx === -1) return;
      const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };
      const matIdx = prc.materials.findIndex(m => m.id === item.materialId || (item.matCode && m.matCode === item.matCode));
      if (matIdx === -1) return;
      const mat = { ...prc.materials[matIdx] };
      if (patch.poNumber) mat.poNumber = patch.poNumber;
      if (patch.poDate) mat.poDate = patch.poDate;
      mat.processedQty = (parseFloat(mat.processedQty) || 0) + (parseFloat(item.quantity) || 0);
      const totalQty = parseFloat(mat.quantity) || 0;
      const clsQty = parseFloat(mat.closedQty) || 0;
      mat.pendingQty = Math.max(0, totalQty - mat.processedQty - clsQty);
      mat.status = calculateMaterialStatus(mat);
      prc.materials[matIdx] = mat;
      if (patch.poNumber) prc.poNumber = patch.poNumber;
      if (patch.poDate) prc.poDate = patch.poDate;
      prc.poBy = state.currentUser?.name || 'Admin';
      if (pod.vendorName) prc.vendorName = pod.vendorName;
      prc.prStatus = 'Process Completed';
      prc.status = calculateStatus(prc, prc.materials);
      prc.updatedAt = new Date().toISOString();
      prcs[prcIdx] = prc;

      directSavePRC(_getEffectiveUid(), prc);
    });
  }

  setState({ pods, prcs, statusSummary: buildStatusSummary(prcs) });

  directSavePOD(_getEffectiveUid(), pod);

  addAuditLog({
    action: 'update_pod', collection: 'PODs', docId: podId,
    changes: patch
  });
}

// ── AUDIT LOG ─────────────────────────────────────────────

export function addAuditLog(entry) {
  const log = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    ...entry,
    timestamp: new Date().toISOString(),
    user: state.currentUser.name
  };
  setState({ activityLogs: [log, ...state.activityLogs] });

  directSaveActivityLog(_getEffectiveUid(), log);
}

// ── PRC TREEVIEW EXPAND / COLLAPSE ───────────────────────

export function isPRCExpanded(prcId) {
  return (state.expandedPRCIds || []).includes(prcId);
}

export function togglePRCExpanded(prcId) {
  const list = state.expandedPRCIds || [];
  let updated;
  let isExpandedNow;
  if (list.includes(prcId)) {
    updated = list.filter(id => id !== prcId);
    isExpandedNow = false;
  } else {
    updated = [...list, prcId];
    isExpandedNow = true;
  }
  setState({ expandedPRCIds: updated });
  return isExpandedNow;
}

export function expandAllPRCs(prcIds) {
  if (!prcIds) {
    prcIds = (state.prcs || []).map(p => p.id);
  }
  setState({ expandedPRCIds: [...new Set(prcIds)] });
}

export function collapseAllPRCs() {
  setState({ expandedPRCIds: [] });
}

// ═══════════════════════════════════════════════════════════
// RECORD UPDATE UNDO ENGINE (LAST 10+ UPDATES)
// ═══════════════════════════════════════════════════════════
export const MAX_UNDO_RECORDS = 20;

function _getUndoStorageKey() {
  const uid = state.firebaseUser?.uid || state.currentUser?.uid || state.currentUser?.id || 'guest';
  return `PRC_RECORD_UNDO_STACK_${uid}`;
}

/** Retrieve current undo stack for active user */
export function getUndoHistory() {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(_getUndoStorageKey());
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) return list;
      }
    }
  } catch (e) {
    console.warn('Failed to load undo history from storage:', e);
  }
  return state.recordUndoHistory || [];
}

/** Save snapshot of pre-update state before any record mutation */
export function recordUpdateSnapshot({
  type = 'UPDATE_RECORD',
  targetType = 'PRC',
  targetId = '',
  targetName = '',
  description = '',
  patch = {},
  previousState = {},
  user = null
}) {
  const snapshotId = `undo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const entry = {
    id: snapshotId,
    timestamp: new Date().toISOString(),
    type,
    targetType,
    targetId,
    targetName: targetName || targetId,
    description: description || `Updated ${targetType} ${targetName || targetId}`,
    patch: clone(patch || {}),
    previousState: clone(previousState || {}),
    user: user || state.currentUser?.name || 'User'
  };

  try {
    const history = getUndoHistory();
    const updatedHistory = [entry, ...history].slice(0, MAX_UNDO_RECORDS);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(_getUndoStorageKey(), JSON.stringify(updatedHistory));
    }
    state.recordUndoHistory = updatedHistory;
    emit('undo_stack_changed', updatedHistory);
  } catch (e) {
    console.warn('Failed to record update snapshot:', e);
  }

  return snapshotId;
}

/** Undo a specific record update or the most recent one */
export function undoRecordUpdate(updateId = null) {
  const history = getUndoHistory();
  if (!history || !history.length) {
    return { success: false, reason: 'No recent record updates to undo.' };
  }

  const entry = updateId ? history.find(e => e.id === updateId) : history[0];
  if (!entry) {
    return { success: false, reason: 'Update record not found in undo history.' };
  }

  const effectiveUid = _getEffectiveUid();
  const { previousState, targetType, targetId, description } = entry;
  const restoredItems = [];

  // 1. Restore PRC(s)
  if (previousState.prc) {
    const prcToRestore = clone(previousState.prc);
    const prcIdx = state.prcs.findIndex(p => p.id === prcToRestore.id || p.prNumber === prcToRestore.prNumber);
    if (prcIdx !== -1) {
      state.prcs[prcIdx] = prcToRestore;
    } else {
      state.prcs = [prcToRestore, ...state.prcs];
    }
    directSavePRC(effectiveUid, prcToRestore);
    restoredItems.push(`PRC ${prcToRestore.prNumber || prcToRestore.id}`);
  }

  if (Array.isArray(previousState.prcs)) {
    previousState.prcs.forEach(prcToRestore => {
      const cloned = clone(prcToRestore);
      const prcIdx = state.prcs.findIndex(p => p.id === cloned.id || p.prNumber === cloned.prNumber);
      if (prcIdx !== -1) {
        state.prcs[prcIdx] = cloned;
      } else {
        state.prcs = [cloned, ...state.prcs];
      }
      directSavePRC(effectiveUid, cloned);
      restoredItems.push(`PRC ${cloned.prNumber || cloned.id}`);
    });
  }

  // 2. Restore Allocation(s)
  if (previousState.allocation) {
    const allocToRestore = clone(previousState.allocation);
    const allocIdx = state.allocations.findIndex(a => a.id === allocToRestore.id || a.allocationNumber === allocToRestore.allocationNumber);
    if (allocIdx !== -1) {
      state.allocations[allocIdx] = allocToRestore;
    } else {
      state.allocations = [allocToRestore, ...state.allocations];
    }
    directSaveAllocation(effectiveUid, allocToRestore);
    restoredItems.push(`Allocation ${allocToRestore.allocationNumber || allocToRestore.id}`);
  }

  if (Array.isArray(previousState.allocations)) {
    previousState.allocations.forEach(a => {
      const cloned = clone(a);
      const idx = state.allocations.findIndex(al => al.id === cloned.id || al.allocationNumber === cloned.allocationNumber);
      if (idx !== -1) state.allocations[idx] = cloned;
      else state.allocations = [cloned, ...state.allocations];
      directSaveAllocation(effectiveUid, cloned);
      restoredItems.push(`Allocation ${cloned.allocationNumber || cloned.id}`);
    });
  }

  // 3. Restore RFQ(s)
  if (previousState.rfq) {
    const rfqToRestore = clone(previousState.rfq);
    const rfqIdx = state.rfqs.findIndex(r => r.id === rfqToRestore.id || r.rfqNumber === rfqToRestore.rfqNumber);
    if (rfqIdx !== -1) {
      state.rfqs[rfqIdx] = rfqToRestore;
    } else {
      state.rfqs = [rfqToRestore, ...state.rfqs];
    }
    directSaveRFQ(effectiveUid, rfqToRestore);
    restoredItems.push(`RFQ ${rfqToRestore.rfqNumber || rfqToRestore.id}`);
  }

  if (Array.isArray(previousState.rfqs)) {
    previousState.rfqs.forEach(r => {
      const cloned = clone(r);
      const idx = state.rfqs.findIndex(rf => rf.id === cloned.id || rf.rfqNumber === cloned.rfqNumber);
      if (idx !== -1) state.rfqs[idx] = cloned;
      else state.rfqs = [cloned, ...state.rfqs];
      directSaveRFQ(effectiveUid, cloned);
      restoredItems.push(`RFQ ${cloned.rfqNumber || cloned.id}`);
    });
  }

  // 4. Restore TCD(s)
  if (previousState.tcd) {
    const tcdToRestore = clone(previousState.tcd);
    const tcdIdx = state.tcds.findIndex(t => t.id === tcdToRestore.id || t.tcdNumber === tcdToRestore.tcdNumber);
    if (tcdIdx !== -1) {
      state.tcds[tcdIdx] = tcdToRestore;
    } else {
      state.tcds = [tcdToRestore, ...state.tcds];
    }
    directSaveTCD(effectiveUid, tcdToRestore);
    restoredItems.push(`TCD ${tcdToRestore.tcdNumber || tcdToRestore.id}`);
  }

  if (Array.isArray(previousState.tcds)) {
    previousState.tcds.forEach(t => {
      const cloned = clone(t);
      const idx = state.tcds.findIndex(tc => tc.id === cloned.id || tc.tcdNumber === cloned.tcdNumber);
      if (idx !== -1) state.tcds[idx] = cloned;
      else state.tcds = [cloned, ...state.tcds];
      directSaveTCD(effectiveUid, cloned);
      restoredItems.push(`TCD ${cloned.tcdNumber || cloned.id}`);
    });
  }

  // 5. Restore POD(s)
  if (previousState.pod) {
    const podToRestore = clone(previousState.pod);
    const podIdx = state.pods.findIndex(p => p.id === podToRestore.id || p.poNumber === podToRestore.poNumber);
    if (podIdx !== -1) {
      state.pods[podIdx] = podToRestore;
    } else {
      state.pods = [podToRestore, ...state.pods];
    }
    directSavePOD(effectiveUid, podToRestore);
    restoredItems.push(`PO ${podToRestore.poNumber || podToRestore.id}`);
  }

  if (Array.isArray(previousState.pods)) {
    previousState.pods.forEach(p => {
      const cloned = clone(p);
      const idx = state.pods.findIndex(po => po.id === cloned.id || po.poNumber === cloned.poNumber);
      if (idx !== -1) state.pods[idx] = cloned;
      else state.pods = [cloned, ...state.pods];
      directSavePOD(effectiveUid, cloned);
      restoredItems.push(`PO ${cloned.poNumber || cloned.id}`);
    });
  }

  // Re-calculate state summaries
  state.statusSummary = buildStatusSummary(state.prcs);
  state.totalMaterials = state.prcs.reduce((sum, p) => sum + (p.materials || []).length, 0);

  // Update undo history by removing this entry
  const updatedHistory = history.filter(e => e.id !== entry.id);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(_getUndoStorageKey(), JSON.stringify(updatedHistory));
    }
    state.recordUndoHistory = updatedHistory;
  } catch (e) {}

  saveToLocalCache();

  addAuditLog({
    action: 'undo_record_update',
    collection: targetType || 'PRCs',
    docId: targetId || entry.id,
    changes: {
      revertedAction: entry.type,
      description: `Undid update: ${description}`,
      restored: restoredItems
    }
  });

  emit('*');
  emit('undo_stack_changed', updatedHistory);

  return {
    success: true,
    entry,
    restoredItems,
    remainingCount: updatedHistory.length
  };
}

/** Helper to undo the latest record update */
export function undoLastRecordUpdate() {
  return undoRecordUpdate(null);
}

/** Revert up to N recent updates in reverse chronological order */
export function undoMultipleRecordUpdates(count = 10) {
  const history = getUndoHistory();
  const limit = Math.min(count, history.length);
  const results = [];
  for (let i = 0; i < limit; i++) {
    const res = undoLastRecordUpdate();
    if (res.success) results.push(res);
    else break;
  }
  return {
    success: results.length > 0,
    undoneCount: results.length,
    results
  };
}

/** Clear all stored record undo history */
export function clearUndoHistory() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(_getUndoStorageKey());
    }
    state.recordUndoHistory = [];
    emit('undo_stack_changed', []);
    return { success: true };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}


