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
  directSaveActivityLog
} from './firestore-db.js';
import { isFirebaseConfigured } from './firebase-config.js';

export const LOCAL_CACHE_KEY = 'PRC_PROCUREMENT_USER_CACHE';

export const DEFAULT_USER = {
  id: 'guest',
  uid: null,
  name: 'Guest',
  email: '',
  role: 'User',
  avatar: 'GU'
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
  const { ensureFirebaseAuth, isFirebaseConfigured } = await import('./firebase-config.js');
  const authUser = await ensureFirebaseAuth();

  if (authUser && (!state.firebaseUser || !state.firebaseUser.uid)) {
    await setAuthenticatedUser(authUser);
  }

  const uid = state.firebaseUser?.uid || authUser?.uid || 'default';

  try {
    console.info(`☁️ Pushing ${state.prcs.length} local records to Cloud Firestore (uid: ${uid})...`);
    const { saveAllUserData } = await import('./firestore-db.js');
    const success = await saveAllUserData(uid, state);
    if (success) {
      saveToLocalCache();
      emit('*');
    }
    return { success, count: state.prcs.length };
  } catch (err) {
    console.error('Failed to push local data to Firestore:', err);
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

  saveToLocalCache();
  emit('*');

  // Start Real-Time continuous live subscription across all PCs
  subscribeToRealtimeUserData(uid, (colName, items) => {
    handleRealtimeUpdate(colName, items);
  });
}

export const initDemoData = initAppData;

// ── AUTH STATE SETTERS ────────────────────────────────────

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

export function updateUserProfile(patch) {
  if (!patch) return false;

  state.currentUser = {
    ...state.currentUser,
    ...patch
  };

  // If avatar is blank or default fallback, compute from name
  if (!state.currentUser.avatar || state.currentUser.avatar === 'GU' || state.currentUser.avatar === 'U') {
    const fn = (state.currentUser.name || state.currentUser.email || 'U').trim();
    const parts = fn.split(' ');
    state.currentUser.avatar = parts.length > 1
      ? (parts[0][0] + parts[1][0]).toUpperCase()
      : fn.slice(0, 2).toUpperCase();
  }

  // Update in state.users list
  const userIdx = state.users.findIndex(u =>
    (u.id && u.id === state.currentUser.id) ||
    (u.uid && u.uid === state.currentUser.uid) ||
    (u.email && u.email.toLowerCase() === (state.currentUser.email || '').toLowerCase())
  );
  if (userIdx >= 0) {
    state.users[userIdx] = { ...state.users[userIdx], ...state.currentUser };
  } else {
    state.users.push({ ...state.currentUser });
  }

  // Save to local cache
  saveToLocalCache();

  // Save to Firestore if connected
  if (isFirebaseConfigured()) {
    const uid = _getEffectiveUid();
    saveAllUserData(uid, state).catch(err => console.warn('Firestore profile sync error:', err));
  }

  emit('currentUser');
  emit('users');
  emit('*');
  return true;
}

// ── PRC OPERATIONS ────────────────────────────────────────

export function getFilteredPRCs() {
  let list = [...state.prcs];
  const q = state.searchQuery.toLowerCase();

  if (q) {
    list = list.filter(p =>
      p.prNumber?.toLowerCase().includes(q)       ||
      p.allocationNumber?.toLowerCase().includes(q)||
      p.buyerName?.toLowerCase().includes(q)       ||
      p.allocatedBy?.toLowerCase().includes(q)       ||
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
    pages:    Math.ceil(filtered.length / state.pageSize),
    page:     state.currentPage_num
  };
}

export function getFilteredMaterials() {
  const prcs = getFilteredPRCs();
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

  addAuditLog({
    action: 'update_prc', collection: 'PRCs', docId: id,
    changes: { ...patch, cascaded: cascadeToMaterials }
  });
}

export function getPRCById(id) {
  return state.prcs.find(p => p.id === id) || null;
}

export function deletePRC(id) {
  const hasAllocations = state.allocations.some(a => a.items.some(i => i.prcId === id));
  const hasRFQs = state.rfqs.some(r => r.items.some(i => i.prcId === id));
  const hasTCDs = state.tcds.some(t => (t.vendorAllocations || []).some(va => va.items.some(i => i.prcId === id)));
  const hasPODs = state.pods.some(p => p.items.some(i => i.prcId === id));

  if (hasAllocations || hasRFQs || hasTCDs || hasPODs) {
    return { success: false, reason: 'Cannot delete PRC — it has downstream Allocation, RFQ, TCD, or PO documents. Delete those first.' };
  }

  const prc = state.prcs.find(p => p.id === id);
  if (!prc) return { success: false, reason: 'PRC not found.' };

  const prcs = state.prcs.filter(p => p.id !== id);
  setState({ prcs, statusSummary: buildStatusSummary(prcs), totalMaterials: prcs.reduce((a, p) => a + (p.materials || []).length, 0) });

  // Direct Firestore delete
  directDeletePRC(_getEffectiveUid(), id);

  addAuditLog({
    action: 'delete_prc', collection: 'PRCs', docId: id,
    changes: { prNumber: prc.prNumber, materialsCount: (prc.materials || []).length }
  });
  return { success: true };
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

  addAuditLog({
    action: 'bulk_update_materials', collection: 'PRC Materials', docId: prcId,
    changes: { materialCount: materialIds.length, patch }
  });
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

export function getAvailablePRCsForAllocation() {
  return (state.prcs || []).filter(p => {
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
    alloc.items.forEach(item => {
      // Exclude PRCs tagged as Future PRC, Wrong PRC, or Short Closed
      const prc = state.prcs.find(p => p.id === item.prcId || p.prNumber === item.prNumber);
      if (prc) {
        if (isPRCShortClosed(prc) || prc.isFuturePRC || prc.isWrongPRC) return;
        const prcStatus = String(prc.status || '').trim().toLowerCase();
        const prStatus = String(prc.prStatus || '').trim().toLowerCase();
        if (prcStatus === 'future prc' || prcStatus === 'wrong prc' ||
            prStatus === 'future prc' || prStatus === 'wrong prc') {
          return;
        }

        // Also check material-level flags
        const mat = (prc.materials || []).find(m => m.id === item.materialId || m.matCode === item.matCode);
        if (mat) {
          if (isMaterialShortClosed(mat, prc) || mat.isFuturePRC || mat.isWrongPRC) return;
          const matStatus = String(mat.status || '').trim().toLowerCase();
          if (matStatus === 'future prc' || matStatus === 'wrong prc') return;
        }
      }

      // Check item itself if flags exist directly on allocation item
      if (isMaterialShortClosed(item, prc) || item.isFuturePRC || item.isWrongPRC) return;
      const itemStatus = String(item.status || '').trim().toLowerCase();
      if (itemStatus === 'future prc' || itemStatus === 'wrong prc') return;

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
    if (isPRCShortClosed(rfq) || rfq.isShortClosed || String(rfq.status || '').toLowerCase() === 'short closed' || String(rfq.status || '').toLowerCase() === 'short-close') return;

    // Closed RFQs ONLY will be eligible for TCD creation
    const isClosed = !!(rfq.isClosed || String(rfq.status || '').trim().toLowerCase() === 'closed');
    if (!isClosed) return;
    rfq.items.forEach(item => {
      // Exclude PRCs tagged as Future PRC, Wrong PRC, or Short Closed
      const prc = state.prcs.find(p => p.id === item.prcId || p.prNumber === item.prNumber);
      if (prc) {
        if (isPRCShortClosed(prc) || prc.isFuturePRC || prc.isWrongPRC) return;
        const prcStatus = String(prc.status || '').trim().toLowerCase();
        const prStatus = String(prc.prStatus || '').trim().toLowerCase();
        if (prcStatus === 'future prc' || prcStatus === 'wrong prc' ||
            prStatus === 'future prc' || prStatus === 'wrong prc') {
          return;
        }

        // Also check material-level flags
        const mat = (prc.materials || []).find(m => m.id === item.materialId || m.matCode === item.matCode);
        if (mat) {
          if (isMaterialShortClosed(mat, prc) || mat.isFuturePRC || mat.isWrongPRC) return;
          const matStatus = String(mat.status || '').trim().toLowerCase();
          if (matStatus === 'future prc' || matStatus === 'wrong prc') return;
        }
      }

      // Check item itself if flags exist directly on rfq item
      if (isMaterialShortClosed(item, prc) || item.isFuturePRC || item.isWrongPRC) return;
      const itemStatus = String(item.status || '').trim().toLowerCase();
      if (itemStatus === 'future prc' || itemStatus === 'wrong prc') return;

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
    if (!tcd.approved && String(tcd.status || '').trim().toLowerCase() !== 'approved') return;
    const allocations = tcd.vendorAllocations || tcd.vendors || [];
    allocations.forEach(va => {
      const vendorName = va.vendorName || va.name || '';
      (va.items || []).forEach(item => {
        const prc = state.prcs.find(p => p.id === item.prcId || p.prNumber === item.prNumber);
        if (prc && (isPRCShortClosed(prc) || prc.isFuturePRC || prc.isWrongPRC)) return;
        if (isMaterialShortClosed(item, prc)) return;

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

