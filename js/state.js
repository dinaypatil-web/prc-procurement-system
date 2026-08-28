// =========================================================
// GLOBAL STATE MANAGER (DIRECT FIRESTORE PERSISTENCE)
// Data is saved directly to Firebase Cloud Firestore per-user
// Supports Real-Time Multi-Device Synchronization & Safe ID Escaping
// =========================================================
import { calculateStatus, calculateMaterialStatus, buildStatusSummary } from './status-engine.js';
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
  theme: localStorage.getItem('theme') || 'light',

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

  // UI
  sidebarCollapsed: false,
  currentPage: 'dashboard',
  viewLevel: 'prc',
  expandedPRCIds: [],
  searchQuery: '',
  filters: {},
  columnFilters: {},
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
      activityLogs: state.activityLogs
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
  if (rfqs.length) state.rfqs = consolidateRFQs(rfqs);
  if (tcds.length) state.tcds = consolidateTCDs(tcds);
  if (pods.length) state.pods = pods;
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

  // Sync restored data to Cloud Firestore
  const uid = _getEffectiveUid();
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

  emit('*');
  return {
    prcCount: state.prcs.length,
    allocationsCount: state.allocations.length,
    rfqCount: state.rfqs.length
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

  Object.assign(state, patch);

  if (patch.prcs || patch.allocations) {
    const reconciled = reconcileAllocationRouting(state.prcs, state.allocations);
    if (reconciled.allocChanged || reconciled.prcChanged) {
      state.prcs = reconciled.prcs;
      state.allocations = consolidateAllocations(reconciled.allocations);
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

  // Reconcile allocation document routing for all available data
  const reconciled = reconcileAllocationRouting(prcs, allocations);
  prcs = reconciled.prcs;
  allocations = consolidateAllocations(reconciled.allocations);
  rfqs = consolidateRFQs(rfqs);
  tcds = consolidateTCDs(tcds);

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
    state.pods = cached.pods || [];
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
      state.pods = firestoreData.pods || [];
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

export function getFilteredAllocations(user = state.currentUser) {
  if (isSuperAdmin(user)) return state.allocations || [];
  return (state.allocations || []).filter(a => doesRecordPertainToCurrentUser(a, user));
}

export function getFilteredRFQs(user = state.currentUser) {
  if (isSuperAdmin(user)) return state.rfqs || [];
  return (state.rfqs || []).filter(r => doesRecordPertainToCurrentUser(r, user));
}

export function getFilteredTCDs(user = state.currentUser) {
  if (isSuperAdmin(user)) return state.tcds || [];
  return (state.tcds || []).filter(t => doesRecordPertainToCurrentUser(t, user));
}

export function getFilteredPODs(user = state.currentUser) {
  if (isSuperAdmin(user)) return state.pods || [];
  return (state.pods || []).filter(p => doesRecordPertainToCurrentUser(p, user));
}

export function getFilteredActivityLogs(user = state.currentUser) {
  if (isSuperAdmin(user)) return state.activityLogs || [];
  return (state.activityLogs || []).filter(l => doesRecordPertainToCurrentUser(l, user));
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

  // Apply Excel-style Column Filters
  if (state.columnFilters && Object.keys(state.columnFilters).length > 0) {
    Object.entries(state.columnFilters).forEach(([colField, selectedVals]) => {
      if (bypassColumnField === colField || bypassColumnField === true) return;
      if (!selectedVals || !Array.isArray(selectedVals) || !selectedVals.length) return;
      const valSet = new Set(selectedVals.map(v => String(v).trim().toLowerCase()));
      const allowsBlank = valSet.has('(blanks)');

      list = list.filter(p => {
        if (colField === 'status') {
          const st = calculateStatus(p).toLowerCase();
          return valSet.has(st);
        }
        if (colField === 'allocationNumber' || colField === 'allocationDate' || colField === 'allocation') {
          const pAlloc = (p.allocationNumber || '').trim().toLowerCase();
          const matAllocs = (p.materials || []).map(m => (m.allocationNumber || '').trim().toLowerCase()).filter(Boolean);
          if (allowsBlank && !pAlloc && !matAllocs.length) return true;
          return valSet.has(pAlloc) || matAllocs.some(a => valSet.has(a));
        }
        if (colField === 'rfqNumber' || colField === 'rfq') {
          const pRfq = (p.rfqNumber || '').trim().toLowerCase();
          const matRfqs = (p.materials || []).map(m => (m.rfqNumber || '').trim().toLowerCase()).filter(Boolean);
          if (allowsBlank && !pRfq && !matRfqs.length) return true;
          return valSet.has(pRfq) || matRfqs.some(r => valSet.has(r));
        }
        if (colField === 'tcdNumber' || colField === 'tcd') {
          const pTcd = (p.tcdNumber || '').trim().toLowerCase();
          const matTcds = (p.materials || []).map(m => (m.tcdNumber || '').trim().toLowerCase()).filter(Boolean);
          if (allowsBlank && !pTcd && !matTcds.length) return true;
          return valSet.has(pTcd) || matTcds.some(t => valSet.has(t));
        }
        if (colField === 'poNumber' || colField === 'po') {
          const pPo = (p.poNumber || '').trim().toLowerCase();
          const matPos = (p.materials || []).map(m => (m.poNumber || '').trim().toLowerCase()).filter(Boolean);
          if (allowsBlank && !pPo && !matPos.length) return true;
          return valSet.has(pPo) || matPos.some(po => valSet.has(po));
        }
        if (colField === 'vendorName' || colField === 'vendor') {
          const pV = (p.vendorName || p.vendor || '').trim().toLowerCase();
          const matVs = (p.materials || []).map(m => (m.vendorName || m.vendor || '').trim().toLowerCase()).filter(Boolean);
          if (allowsBlank && !pV && !matVs.length) return true;
          return valSet.has(pV) || matVs.some(v => valSet.has(v));
        }
        if (colField === 'buyerName') {
          const b = (p.buyerName || p.allocatedBy || '').trim().toLowerCase();
          if (allowsBlank && !b) return true;
          return valSet.has(b);
        }
        if (colField === 'age' || colField === 'createdAt') {
          const a = `${getPRCAge(p)}d`.toLowerCase();
          return valSet.has(a);
        }

        const raw = (p[colField] !== undefined && p[colField] !== null) ? String(p[colField]).trim().toLowerCase() : '';
        if (allowsBlank && !raw) return true;
        return valSet.has(raw);
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
  const prcs = getFilteredPRCs(bypassColumnField);
  const allMats = [];

  prcs.forEach(p => {
    (p.materials || []).forEach(m => {
      allMats.push({
        allocationNumber: p.allocationNumber || '',
        allocationDate: p.allocationDate || '',
        buyerName: p.buyerName || p.allocatedBy || '',
        rfqNumber: p.rfqNumber || '',
        rfqDate: p.rfqDate || '',
        tcdNumber: p.tcdNumber || '',
        tcdDate: p.tcdDate || '',
        poNumber: p.poNumber || '',
        poDate: p.poDate || '',
        vendorName: p.vendorName || p.vendor || '',
        vendor: p.vendorName || p.vendor || '',
        deliveryDate: p.deliveryDate || p.deliveryEndDate || '',
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

  const q = state.searchQuery.toLowerCase();
  let list = allMats;
  if (q) {
    list = list.filter(m =>
      m.prNumber?.toLowerCase().includes(q) ||
      m.matCode?.toLowerCase().includes(q) ||
      m.description?.toLowerCase().includes(q) ||
      m.allocationNumber?.toLowerCase().includes(q) ||
      m.rfqNumber?.toLowerCase().includes(q) ||
      m.tcdNumber?.toLowerCase().includes(q) ||
      m.poNumber?.toLowerCase().includes(q) ||
      m.vendorName?.toLowerCase().includes(q) ||
      m.vendor?.toLowerCase().includes(q)
    );
  }

  const f = state.filters;
  if (f.status) {
    list = list.filter(m =>
      m.status === f.status ||
      m.prcStatus === f.status ||
      calculateMaterialStatus(m) === f.status
    );
  }

  // Apply Excel-style Column Filters on materials
  if (state.columnFilters && Object.keys(state.columnFilters).length > 0) {
    Object.entries(state.columnFilters).forEach(([colField, selectedVals]) => {
      if (bypassColumnField === colField || bypassColumnField === true) return;
      if (!selectedVals || !Array.isArray(selectedVals) || !selectedVals.length) return;
      const valSet = new Set(selectedVals.map(v => String(v).trim().toLowerCase()));
      const allowsBlank = valSet.has('(blanks)');

      list = list.filter(m => {
        if (colField === 'status') {
          const st = (m.status || calculateMaterialStatus(m) || '').trim().toLowerCase();
          return valSet.has(st);
        }
        if (colField === 'vendorName' || colField === 'vendor') {
          const v = (m.vendorName || m.vendor || '').trim().toLowerCase();
          if (allowsBlank && !v) return true;
          return valSet.has(v);
        }
        if (colField === 'buyerName') {
          const b = (m.buyerName || m.allocatedBy || '').trim().toLowerCase();
          if (allowsBlank && !b) return true;
          return valSet.has(b);
        }

        const raw = (m[colField] !== undefined && m[colField] !== null) ? String(m[colField]).trim().toLowerCase() : '';
        if (allowsBlank && !raw) return true;
        return valSet.has(raw);
      });
    });
  }

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

// ── EXCEL COLUMN FILTER HELPERS ───────────────────────────

export function setColumnFilter(field, values) {
  const arr = Array.isArray(values) ? values : [values];
  state.columnFilters = {
    ...state.columnFilters,
    [field]: arr
  };
  state.currentPage_num = 1;
  saveToLocalCache();
  emit('columnFilters');
  emit('*');
}

export function clearColumnFilter(field) {
  const next = { ...state.columnFilters };
  delete next[field];
  state.columnFilters = next;
  state.currentPage_num = 1;
  saveToLocalCache();
  emit('columnFilters');
  emit('*');
}

export function clearAllColumnFilters() {
  state.columnFilters = {};
  state.currentPage_num = 1;
  saveToLocalCache();
  emit('columnFilters');
  emit('*');
}

export function getActiveColumnFilterCount() {
  return Object.keys(state.columnFilters || {}).filter(k => (state.columnFilters[k] || []).length > 0).length;
}

export function getDistinctColumnValues(field, isMaterialView = false) {
  const list = isMaterialView ? getFilteredMaterials(field) : getFilteredPRCs(field);
  const valCountMap = new Map();

  list.forEach(item => {
    let vals = [];
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
    } else if (field === 'rfqNumber' || field === 'rfq') {
      if (item.materials && !isMaterialView) {
        const set = new Set();
        if (item.rfqNumber) set.add(item.rfqNumber);
        (item.materials || []).forEach(m => { if (m.rfqNumber) set.add(m.rfqNumber); });
        vals = set.size ? Array.from(set) : ['(Blanks)'];
      } else {
        vals = [item.rfqNumber || '(Blanks)'];
      }
    } else if (field === 'tcdNumber' || field === 'tcd') {
      if (item.materials && !isMaterialView) {
        const set = new Set();
        if (item.tcdNumber) set.add(item.tcdNumber);
        (item.materials || []).forEach(m => { if (m.tcdNumber) set.add(m.tcdNumber); });
        vals = set.size ? Array.from(set) : ['(Blanks)'];
      } else {
        vals = [item.tcdNumber || '(Blanks)'];
      }
    } else if (field === 'poNumber' || field === 'po') {
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
    } else if (field === 'buyerName') {
      vals = [item.buyerName || item.allocatedBy || '(Blanks)'];
    } else if (field === 'age' || field === 'createdAt') {
      const ageDays = isMaterialView ? 0 : getPRCAge(item);
      vals = [`${ageDays}d`];
    } else {
      const raw = item[field];
      vals = [raw !== undefined && raw !== null && String(raw).trim() !== '' ? String(raw).trim() : '(Blanks)'];
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

export function updatePRC(id, patch, cascadeToMaterials = false) {
  const idx = state.prcs.findIndex(p => p.id === id);
  if (idx === -1) return;

  const current = state.prcs[idx];
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

export function updateMaterial(prcId, materialId, patch) {
  const prcIdx = state.prcs.findIndex(p => p.id === prcId);
  if (prcIdx === -1) return;
  const prc = state.prcs[prcIdx];

  const materials = (prc.materials || []).map(m => {
    if (m.id === materialId) {
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

  const updatedPRC = {
    ...prc,
    materials,
    updatedAt: new Date().toISOString(),
    updatedBy: state.currentUser.name
  };
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
  const prcIdx = state.prcs.findIndex(p => p.id === prcId);
  if (prcIdx === -1) return;
  const prc = state.prcs[prcIdx];

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

  const updatedPRC = {
    ...prc,
    materials,
    updatedAt: new Date().toISOString(),
    updatedBy: state.currentUser.name
  };
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
 * documents that contain an item for (prcId, materialId).
 * Only the relevant field subsets are applied to each document type.
 * directSave* is called only for documents that actually changed.
 *
 * @param {string} prcId
 * @param {string} materialId
 * @param {Object} patch  - same patch object passed to updateMaterial / bulkUpdateMaterials
 */
function _syncMaterialPatchToDownstream(prcId, materialId, patch) {
  const uid = _getEffectiveUid();

  // Build per-stage sub-patches (identity fields always included)
  const identityPatch = {};
  _ITEM_IDENTITY_FIELDS.forEach(f => { if (patch[f] !== undefined) identityPatch[f] = patch[f]; });

  const stagePatch = { alloc: { ...identityPatch }, rfq: { ...identityPatch }, tcd: { ...identityPatch }, pod: { ...identityPatch } };
  Object.entries(_STAGE_FIELDS).forEach(([field, stages]) => {
    if (patch[field] !== undefined) {
      stages.forEach(s => { stagePatch[s][field] = patch[field]; });
    }
  });

  const hasAllocPatch = Object.keys(stagePatch.alloc).length > 0;
  const hasRFQPatch   = Object.keys(stagePatch.rfq).length > 0;
  const hasTCDPatch   = Object.keys(stagePatch.tcd).length > 0;
  const hasPODPatch   = Object.keys(stagePatch.pod).length > 0;

  // ── Allocation documents ──────────────────────────────────
  if (hasAllocPatch) {
    let allocations = [...state.allocations];
    let allocChanged = false;
    allocations = allocations.map(alloc => {
      const hasMatch = (alloc.items || []).some(i => i.prcId === prcId && i.materialId === materialId);
      if (!hasMatch) return alloc;
      const updatedItems = alloc.items.map(i =>
        (i.prcId === prcId && i.materialId === materialId) ? { ...i, ...stagePatch.alloc } : i
      );
      allocChanged = true;
      const updated = { ...alloc, items: updatedItems, updatedAt: new Date().toISOString() };
      directSaveAllocation(uid, updated);
      return updated;
    });
    if (allocChanged) setState({ allocations });
  }

  // ── RFQ documents ─────────────────────────────────────────
  if (hasRFQPatch) {
    let rfqs = [...state.rfqs];
    let rfqChanged = false;
    rfqs = rfqs.map(rfq => {
      const hasMatch = (rfq.items || []).some(i => i.prcId === prcId && i.materialId === materialId);
      if (!hasMatch) return rfq;
      const updatedItems = rfq.items.map(i =>
        (i.prcId === prcId && i.materialId === materialId) ? { ...i, ...stagePatch.rfq } : i
      );
      rfqChanged = true;
      const updated = { ...rfq, items: updatedItems, updatedAt: new Date().toISOString() };
      directSaveRFQ(uid, updated);
      return updated;
    });
    if (rfqChanged) setState({ rfqs });
  }

  // ── TCD documents (vendorAllocations[].items[]) ───────────
  if (hasTCDPatch) {
    let tcds = [...state.tcds];
    let tcdChanged = false;
    tcds = tcds.map(tcd => {
      const vas = tcd.vendorAllocations || tcd.vendors || [];
      let tcdModified = false;
      const updatedVAs = vas.map(va => {
        const hasMatch = (va.items || []).some(i => i.prcId === prcId && i.materialId === materialId);
        if (!hasMatch) return va;
        const updatedItems = va.items.map(i =>
          (i.prcId === prcId && i.materialId === materialId) ? { ...i, ...stagePatch.tcd } : i
        );
        tcdModified = true;
        return { ...va, items: updatedItems };
      });
      if (!tcdModified) return tcd;
      tcdChanged = true;
      const vaKey = tcd.vendorAllocations ? 'vendorAllocations' : 'vendors';
      const updated = { ...tcd, [vaKey]: updatedVAs, updatedAt: new Date().toISOString() };
      directSaveTCD(uid, updated);
      return updated;
    });
    if (tcdChanged) setState({ tcds });
  }

  // ── POD documents ─────────────────────────────────────────
  if (hasPODPatch) {
    let pods = [...state.pods];
    let podChanged = false;
    pods = pods.map(pod => {
      const hasMatch = (pod.items || []).some(i => i.prcId === prcId && i.materialId === materialId);
      if (!hasMatch) return pod;
      const updatedItems = pod.items.map(i =>
        (i.prcId === prcId && i.materialId === materialId) ? { ...i, ...stagePatch.pod } : i
      );
      podChanged = true;
      const updated = { ...pod, items: updatedItems, updatedAt: new Date().toISOString() };
      directSavePOD(uid, updated);
      return updated;
    });
    if (podChanged) setState({ pods });
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
      (item.materialCode && m.materialCode === item.materialCode) ||
      (item.materialCode && m.itemCode === item.materialCode) ||
      (item.itemCode && m.materialCode === item.itemCode)
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

export function deleteAllocation(id) {
  const hasRFQs = state.rfqs.some(r => r.items.some(i => i.allocationId === id));
  if (hasRFQs) {
    return { success: false, reason: 'Cannot delete Allocation — it has downstream RFQ documents.' };
  }
  const allocations = state.allocations.filter(a => a.id !== id);
  setState({ allocations });

  directDeleteAllocation(_getEffectiveUid(), id);

  addAuditLog({ action: 'delete_allocation', collection: 'Allocations', docId: id, changes: {} });
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
    rfq = {
      id: `rfq-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      rfqNumber: normNum,
      rfqDate: data.rfqDate,
      items: data.items || [],
      createdAt: new Date().toISOString(),
      createdBy: state.currentUser?.name || 'User',
      status: 'Active',
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

export function deleteRFQ(id) {
  const hasTCDs = state.tcds.some(t => (t.vendorAllocations || []).some(va => va.items.some(i => i.rfqId === id)));
  if (hasTCDs) {
    return { success: false, reason: 'Cannot delete RFQ — it has downstream TCD documents.' };
  }
  const rfqs = state.rfqs.filter(r => r.id !== id);
  setState({ rfqs });

  directDeleteRFQ(_getEffectiveUid(), id);

  addAuditLog({ action: 'delete_rfq', collection: 'RFQs', docId: id, changes: {} });
  return { success: true };
}

export function toggleRFQClose(id, isClosed) {
  const rfqIdx = state.rfqs.findIndex(r => r.id === id);
  if (rfqIdx === -1) return { success: false, reason: 'RFQ not found' };

  const rfq = { ...state.rfqs[rfqIdx] };
  rfq.isClosed = !!isClosed;
  rfq.status = isClosed ? 'Closed' : 'Active';
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

export function deleteTCD(id) {
  const hasPODs = state.pods.some(p => p.tcdId === id && p.poNumber);
  if (hasPODs) {
    return { success: false, reason: 'Cannot delete TCD — it has downstream issued Purchase Orders.' };
  }
  const tcds = state.tcds.filter(t => t.id !== id);
  // Also remove un-issued generated pods for this TCD
  const pods = state.pods.filter(p => p.tcdId !== id);
  setState({ tcds, pods });

  directDeleteTCD(_getEffectiveUid(), id);

  addAuditLog({ action: 'delete_tcd', collection: 'TCDs', docId: id, changes: {} });
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
  const pod = {
    id: `pod-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    poNumber: data.poNumber || '',
    poDate: data.poDate || '',
    vendorName: data.vendorName || '',
    tcdId: data.tcdId || '',
    tcdNumber: data.tcdNumber || '',
    items: (data.items || []).map(i => ({ ...i })),
    createdAt: new Date().toISOString(),
    createdBy: state.currentUser?.name || 'Admin',
    status: data.poNumber ? 'Issued' : 'Pending PO Number'
  };

  const pods = [pod, ...state.pods];
  const prcs = [...state.prcs];

  if (pod.poNumber || pod.poDate) {
    pod.items.forEach(item => {
      const prcIdx = prcs.findIndex(p => p.id === item.prcId);
      if (prcIdx === -1) return;
      const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };
      const matIdx = prc.materials.findIndex(m => m.id === item.materialId);
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
    action: 'create_pod', collection: 'PODs', docId: pod.id,
    changes: { poNumber: pod.poNumber, vendorName: pod.vendorName, itemCount: pod.items.length }
  });

  return pod;
}

export function deletePOD(id) {
  const pods = state.pods.filter(p => p.id !== id);
  setState({ pods });

  directDeletePOD(_getEffectiveUid(), id);

  addAuditLog({ action: 'delete_pod', collection: 'PODs', docId: id, changes: {} });
  return { success: true };
}

export function updatePOD(podId, patch) {
  const podIdx = state.pods.findIndex(p => p.id === podId);
  if (podIdx === -1) return;

  const pod = { ...state.pods[podIdx], ...patch };
  if (patch.poNumber) pod.status = 'Issued';
  pod.updatedAt = new Date().toISOString();
  pod.updatedBy = state.currentUser?.name || 'Admin';

  const pods = [...state.pods];
  pods[podIdx] = pod;

  const prcs = [...state.prcs];
  if (patch.poNumber || patch.poDate) {
    pod.items.forEach(item => {
      const prcIdx = prcs.findIndex(p => p.id === item.prcId);
      if (prcIdx === -1) return;
      const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };
      const matIdx = prc.materials.findIndex(m => m.id === item.materialId);
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

