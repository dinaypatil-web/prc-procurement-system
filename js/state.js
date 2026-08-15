// =========================================================
// GLOBAL STATE MANAGER (CREATOR-OWNED DATABASE PERSISTENCE)
// =========================================================
import { generateMockPRCs, MOCK_VENDORS, MOCK_USERS, MOCK_NOTIFICATIONS, MOCK_ACTIVITY_LOGS } from './mock-data.js';
import { calculateStatus, calculateMaterialStatus, buildStatusSummary } from './status-engine.js';

// App Owner Database Metadata & Identifier
export const CREATOR_DB_KEY = 'PRC_PROCUREMENT_APP_OWNER_DATABASE_V2';
export const CREATOR_INFO = {
  creatorId: 'u1',
  creatorName: 'App Owner (Super Admin)',
  creatorEmail: 'owner@company.com',
  databaseId: 'DB-PRC-APP-OWNER-MASTER-01',
  databaseName: 'App Owner Central Procurement Database',
  createdByName: 'App Owner',
  storageType: 'App Owner Master Database',
  createdAt: '2026-01-01T00:00:00.000Z'
};

export const APP_OWNER_USER = {
  id: 'u1',
  name: 'App Owner',
  email: 'owner@company.com',
  role: 'Super Admin',
  avatar: 'AO'
};

const _listeners = {};

const state = {
  // Auth
  currentUser: { ...APP_OWNER_USER },
  isAuthenticated: true,
  theme: localStorage.getItem('theme') || 'dark',

  // Database Ownership Metadata
  creatorDbMeta: { ...CREATOR_INFO },

  // Core Data Collections
  prcs: [],
  allocations: [],   // Allocation documents
  rfqs: [],          // RFQ documents
  tcds: [],          // TCD (Techno-Commercial Document)
  pods: [],          // Purchase Order Documents
  vendors: [],
  users: [{ ...APP_OWNER_USER }],
  notifications: [],
  activityLogs: [],

  // UI
  sidebarCollapsed: false,
  currentPage: 'dashboard',
  viewLevel: 'prc', // 'prc' or 'material'
  searchQuery: '',
  filters: {},
  sortField: 'createdAt',
  sortDir: 'desc',
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

// Save current data state directly to Creator Database
export function saveToCreatorDatabase() {
  try {
    const dataToSave = {
      meta: {
        ...CREATOR_INFO,
        lastSavedAt: new Date().toISOString(),
        lastSavedBy: state.currentUser?.name || CREATOR_INFO.creatorName
      },
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
    localStorage.setItem(CREATOR_DB_KEY, JSON.stringify(dataToSave));
  } catch (err) {
    console.error('Failed to save to Creator Database:', err);
  }
}

// Load data state from Creator Database
export function loadFromCreatorDatabase() {
  try {
    // Clear legacy keys with simulation data if present
    ['PRC_PROCUREMENT_CREATOR_DATABASE_V1', 'PRC_PROCUREMENT_APP_OWNER_DATABASE_V1'].forEach(k => localStorage.removeItem(k));

    const raw = localStorage.getItem(CREATOR_DB_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load Creator Database:', err);
    return null;
  }
}

// Reset Creator Database to fresh clean state (0 simulation PRCs/users)
export function resetCreatorDatabase() {
  localStorage.removeItem(CREATOR_DB_KEY);
  return initDemoData(true);
}

// Export Creator Database JSON
export function exportCreatorDatabase() {
  const data = loadFromCreatorDatabase() || {
    meta: CREATOR_INFO,
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
  a.download = `Creator_Database_Backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function setState(patch) {
  Object.assign(state, patch);
  Object.keys(patch).forEach(key => emit(key));
  emit('*');

  // Automatically sync changes to Central Creator Database whenever data arrays update
  const dataKeys = ['prcs', 'allocations', 'rfqs', 'tcds', 'pods', 'vendors', 'users', 'notifications', 'activityLogs'];
  if (Object.keys(patch).some(k => dataKeys.includes(k))) {
    saveToCreatorDatabase();
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

// ── INITIALISE APP OWNER DATABASE ──────────────────────────────
export async function initDemoData(forceClean = false) {
  const creatorDb = forceClean ? null : loadFromCreatorDatabase();
  let prcs, vendors, users, notifications, activityLogs, allocations, rfqs, tcds, pods;

  if (creatorDb && Array.isArray(creatorDb.prcs)) {
    console.info(`📦 Loaded data from App Owner Central Database (${CREATOR_INFO.databaseId}).`);
    prcs = creatorDb.prcs;
    allocations = creatorDb.allocations || [];
    rfqs = creatorDb.rfqs || [];
    tcds = creatorDb.tcds || [];
    pods = creatorDb.pods || [];
    vendors = creatorDb.vendors || [];
    users = creatorDb.users || [{ ...APP_OWNER_USER }];
    notifications = creatorDb.notifications || [];
    activityLogs = creatorDb.activityLogs || [];
  } else {
    console.info(`⚙️ Initializing Clean App Owner Database (${CREATOR_INFO.databaseId}) with 0 simulation PRCs/users...`);
    prcs = [];
    allocations = [];
    rfqs = [];
    tcds = [];
    pods = [];
    vendors = [];
    users = [{ ...APP_OWNER_USER }];
    notifications = [];
    activityLogs = [{
      id: `log-${Date.now()}`,
      action: 'init_database',
      collection: 'System',
      docId: CREATOR_INFO.databaseId,
      timestamp: new Date().toISOString(),
      user: APP_OWNER_USER.name,
      changes: { message: 'Clean App Owner database initialized.' }
    }];
  }

  const summary = buildStatusSummary(prcs);
  const totalMats = prcs.reduce((acc, p) => acc + (p.materials || []).length, 0);

  state.currentUser = { ...APP_OWNER_USER };
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
  state.creatorDbMeta = creatorDb?.meta || { ...CREATOR_INFO, lastSavedAt: new Date().toISOString() };

  // Save state back to Creator Database key
  saveToCreatorDatabase();
  emit('*');
}

// ── PRC HELPERS ───────────────────────────────────────────────
export function getFilteredPRCs() {
  let list = [...state.prcs];
  const q = state.searchQuery.toLowerCase();

  if (q) {
    list = list.filter(p =>
      p.prNumber?.toLowerCase().includes(q)       ||
      p.allocationNumber?.toLowerCase().includes(q)||
      p.rfqNumber?.toLowerCase().includes(q)      ||
      p.tcdNumber?.toLowerCase().includes(q)      ||
      p.poNumber?.toLowerCase().includes(q)       ||
      p.vendorName?.toLowerCase().includes(q)     ||
      p.department?.toLowerCase().includes(q)     ||
      p.job?.toLowerCase().includes(q)            ||
      p.remarks?.toLowerCase().includes(q)        ||
      (p.materials||[]).some(m =>
        m.matCode?.toLowerCase().includes(q) ||
        m.description?.toLowerCase().includes(q)
      )
    );
  }

  // Apply filters
  const f = state.filters;
  if (f.status)     list = list.filter(p => p.status === f.status);
  if (f.department) list = list.filter(p => p.department === f.department);
  if (f.priority)   list = list.filter(p => p.priority === f.priority);
  if (f.engineer)   list = list.filter(p => p.engineer === f.engineer);
  if (f.dateFrom)   list = list.filter(p => p.createdAt >= f.dateFrom);
  if (f.dateTo)     list = list.filter(p => p.createdAt <= f.dateTo);

  // Sort
  list.sort((a,b) => {
    const av = a[state.sortField] || '';
    const bv = b[state.sortField] || '';
    const cmp = String(av).localeCompare(String(bv));
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
        ...m,
        prcId: p.id,
        prNumber: p.prNumber,
        department: p.department,
        job: p.job,
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
  if (f.status) list = list.filter(m => m.status === f.status || m.prcStatus === f.status);

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
  addAuditLog({
    action: 'update_prc', collection: 'PRCs', docId: id,
    changes: { ...patch, cascaded: cascadeToMaterials }
  });
}

export function getPRCById(id) {
  return state.prcs.find(p => p.id === id) || null;
}

// ── DELETE PRC ────────────────────────────────────────────────
export function deletePRC(id) {
  // Check for downstream references
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
  addAuditLog({
    action: 'bulk_update_materials', collection: 'PRC Materials', docId: prcId,
    changes: { materialCount: materialIds.length, patch }
  });
}

// ═══════════════════════════════════════════════════════════
// ALLOCATION DOCUMENT OPERATIONS
// ═══════════════════════════════════════════════════════════

/**
 * Get the already-allocated quantity for a specific material across all allocations.
 */
export function getAllocatedQty(prcId, materialId) {
  return state.allocations.reduce((sum, alloc) => {
    return sum + (alloc.items || [])
      .filter(i => i.prcId === prcId && i.materialId === materialId)
      .reduce((s, i) => s + (parseFloat(i.quantity) || 0), 0);
  }, 0);
}

/**
 * Returns list of PRCs that are available for allocation.
 * No filters applied except excluding PRCs where all materials are already fully allocated.
 */
export function getAvailablePRCsForAllocation() {
  return (state.prcs || []).filter(p => {
    const mats = p.materials || [];
    if (!mats.length) return false;

    // Get unallocated materials (materials where allocated quantity < total quantity)
    const availableMats = mats.filter(m => {
      const allocd = getAllocatedQty(p.id, m.id);
      const totalQty = parseFloat(m.quantity) || 0;
      return allocd < totalQty || totalQty === 0;
    });

    return availableMats.length > 0;
  });
}

/**
 * Create a new Allocation document.
 * @param {Object} data - { allocationNumber, allocationDate, buyerName, items: [{prcId, materialId, quantity, matCode, description, unit, prNumber}] }
 */
export function createAllocation(data) {
  const allocation = {
    id: `alloc-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    allocationNumber: data.allocationNumber,
    allocationDate: data.allocationDate,
    buyerName: data.buyerName || '',
    items: data.items || [],
    createdAt: new Date().toISOString(),
    createdBy: state.currentUser.name,
    status: 'Active'
  };

  const allocations = [allocation, ...state.allocations];

  // Update material-level and PRC-level allocation info across all affected PRCs
  const prcs = [...state.prcs];
  const affectedPrcIds = new Set(allocation.items.map(i => i.prcId));

  affectedPrcIds.forEach(prcId => {
    const prcIdx = prcs.findIndex(p => p.id === prcId);
    if (prcIdx === -1) return;
    const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };

    allocation.items.filter(i => i.prcId === prcId).forEach(item => {
      const matIdx = prc.materials.findIndex(m => m.id === item.materialId);
      if (matIdx === -1) return;
      prc.materials[matIdx] = {
        ...prc.materials[matIdx],
        allocationNumber: data.allocationNumber,
        allocationDate: data.allocationDate,
        buyerName: data.buyerName,
        allocatedBy: data.buyerName
      };
      prc.materials[matIdx].status = calculateMaterialStatus(prc.materials[matIdx]);
    });

    if (!prc.allocationNumber || prc.allocationNumber === data.allocationNumber) {
      prc.allocationNumber = data.allocationNumber;
      prc.allocationDate = data.allocationDate;
      prc.buyerName = data.buyerName;
      prc.allocatedBy = data.buyerName;
    }

    prc.status = calculateStatus(prc, prc.materials);
    prc.updatedAt = new Date().toISOString();
    prcs[prcIdx] = prc;
  });

  setState({ allocations, prcs, statusSummary: buildStatusSummary(prcs) });
  addAuditLog({
    action: 'create_allocation', collection: 'Allocations', docId: allocation.id,
    changes: { allocationNumber: data.allocationNumber, itemCount: data.items.length, prcCount: affectedPrcIds.size }
  });

  return allocation;
}

export function getAllocationById(id) {
  return state.allocations.find(a => a.id === id) || null;
}

export function deleteAllocation(id) {
  // Check if any RFQs reference this allocation
  const hasRFQs = state.rfqs.some(r => r.items.some(i => i.allocationId === id));
  if (hasRFQs) {
    return { success: false, reason: 'Cannot delete Allocation — it has downstream RFQ documents.' };
  }
  const allocations = state.allocations.filter(a => a.id !== id);
  setState({ allocations });
  addAuditLog({ action: 'delete_allocation', collection: 'Allocations', docId: id, changes: {} });
  return { success: true };
}

// ═══════════════════════════════════════════════════════════
// RFQ DOCUMENT OPERATIONS
// ═══════════════════════════════════════════════════════════

/**
 * Get the already-RFQ'd quantity for a material from a specific allocation.
 */
export function getRFQdQty(allocationId, prcId, materialId) {
  return state.rfqs.reduce((sum, rfq) => {
    return sum + rfq.items
      .filter(i => i.allocationId === allocationId && i.prcId === prcId && i.materialId === materialId)
      .reduce((s, i) => s + (parseFloat(i.quantity) || 0), 0);
  }, 0);
}

/**
 * Get all allocated materials with available (un-RFQ'd) quantities.
 */
export function getAvailableForRFQ() {
  const result = [];
  state.allocations.forEach(alloc => {
    alloc.items.forEach(item => {
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

/**
 * Create a new RFQ document.
 * @param {Object} data - { rfqNumber, rfqDate, items: [{allocationId, prcId, materialId, quantity, matCode, description, unit, prNumber}] }
 */
export function createRFQ(data) {
  const rfq = {
    id: `rfq-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    rfqNumber: data.rfqNumber,
    rfqDate: data.rfqDate,
    items: data.items || [],
    createdAt: new Date().toISOString(),
    createdBy: state.currentUser.name,
    status: 'Active',
    offersReceived: false
  };

  const rfqs = [rfq, ...state.rfqs];

  // Update material-level RFQ info
  const prcs = [...state.prcs];
  rfq.items.forEach(item => {
    const prcIdx = prcs.findIndex(p => p.id === item.prcId);
    if (prcIdx === -1) return;
    const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };
    const matIdx = prc.materials.findIndex(m => m.id === item.materialId);
    if (matIdx === -1) return;
    prc.materials[matIdx] = {
      ...prc.materials[matIdx],
      rfqNumber: data.rfqNumber,
      rfqDate: data.rfqDate
    };
    prc.materials[matIdx].status = calculateMaterialStatus(prc.materials[matIdx]);
    prc.status = calculateStatus(prc, prc.materials);
    prc.updatedAt = new Date().toISOString();
    prcs[prcIdx] = prc;
  });

  setState({ rfqs, prcs, statusSummary: buildStatusSummary(prcs) });
  addAuditLog({
    action: 'create_rfq', collection: 'RFQs', docId: rfq.id,
    changes: { rfqNumber: data.rfqNumber, itemCount: data.items.length }
  });

  return rfq;
}

export function getRFQById(id) {
  return state.rfqs.find(r => r.id === id) || null;
}

export function deleteRFQ(id) {
  const hasTCDs = state.tcds.some(t => (t.vendorAllocations || []).some(va => va.items.some(i => i.rfqId === id)));
  if (hasTCDs) {
    return { success: false, reason: 'Cannot delete RFQ — it has downstream TCD documents.' };
  }
  const rfqs = state.rfqs.filter(r => r.id !== id);
  setState({ rfqs });
  addAuditLog({ action: 'delete_rfq', collection: 'RFQs', docId: id, changes: {} });
  return { success: true };
}

// ═══════════════════════════════════════════════════════════
// TCD (TECHNO-COMMERCIAL DOCUMENT) OPERATIONS
// ═══════════════════════════════════════════════════════════

/**
 * Get the already-TCD'd quantity for a material from a specific RFQ.
 */
export function getTCDdQty(rfqId, prcId, materialId) {
  return state.tcds.reduce((sum, tcd) => {
    return sum + (tcd.vendorAllocations || []).reduce((vaSum, va) => {
      return vaSum + va.items
        .filter(i => i.rfqId === rfqId && i.prcId === prcId && i.materialId === materialId)
        .reduce((s, i) => s + (parseFloat(i.quantity) || 0), 0);
    }, 0);
  }, 0);
}

/**
 * Get all RFQ'd materials with available (un-TCD'd) quantities.
 */
export function getAvailableForTCD() {
  const result = [];
  state.rfqs.forEach(rfq => {
    rfq.items.forEach(item => {
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

/**
 * Create a new TCD (Techno-Commercial Document).
 * @param {Object} data - { tcdNumber, tcdDate, vendorAllocations: [{ vendorName, items: [{rfqId, prcId, materialId, quantity, matCode, description, unit, prNumber}] }] }
 */
export function createTCD(data) {
  const tcd = {
    id: `tcd-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    tcdNumber: data.tcdNumber,
    tcdDate: data.tcdDate,
    vendorAllocations: data.vendorAllocations || [],
    createdAt: new Date().toISOString(),
    createdBy: state.currentUser.name,
    status: 'Pending Approval',
    approved: false,
    approvedDate: null,
    approvedBy: null
  };

  const tcds = [tcd, ...state.tcds];

  // Update material-level TCD info
  const prcs = [...state.prcs];
  (tcd.vendorAllocations || []).forEach(va => {
    va.items.forEach(item => {
      const prcIdx = prcs.findIndex(p => p.id === item.prcId);
      if (prcIdx === -1) return;
      const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };
      const matIdx = prc.materials.findIndex(m => m.id === item.materialId);
      if (matIdx === -1) return;
      prc.materials[matIdx] = {
        ...prc.materials[matIdx],
        tcdNumber: data.tcdNumber,
        tcdDate: data.tcdDate
      };
      prc.materials[matIdx].status = calculateMaterialStatus(prc.materials[matIdx]);
      prc.status = calculateStatus(prc, prc.materials);
      prc.updatedAt = new Date().toISOString();
      prcs[prcIdx] = prc;
    });
  });

  setState({ tcds, prcs, statusSummary: buildStatusSummary(prcs) });
  addAuditLog({
    action: 'create_tcd', collection: 'TCDs', docId: tcd.id,
    changes: { tcdNumber: data.tcdNumber, vendorCount: data.vendorAllocations.length }
  });

  return tcd;
}

export function getTCDById(id) {
  return state.tcds.find(t => t.id === id) || null;
}

/**
 * Approve a TCD and auto-generate POD(s) — one per vendor.
 * PODs are generated with EMPTY PO numbers — user fills them in manually.
 */
export function approveTCD(tcdId) {
  const tcdIdx = state.tcds.findIndex(t => t.id === tcdId);
  if (tcdIdx === -1) return { success: false, reason: 'TCD not found.' };

  const tcd = { ...state.tcds[tcdIdx] };
  if (tcd.approved) return { success: false, reason: 'TCD is already approved.' };

  tcd.approved = true;
  tcd.approvedDate = new Date().toISOString();
  tcd.approvedBy = state.currentUser.name;
  tcd.status = 'Approved';

  const tcds = [...state.tcds];
  tcds[tcdIdx] = tcd;

  // Generate PODs — one per vendor, with EMPTY PO number for user to fill
  const generatedPODs = [];
  const prcs = [...state.prcs];

  (tcd.vendorAllocations || []).forEach(va => {
    const pod = {
      id: `pod-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      poNumber: '',       // User will fill this in
      poDate: '',         // User will fill this in
      vendorName: va.vendorName,
      tcdId: tcd.id,
      tcdNumber: tcd.tcdNumber,
      items: va.items.map(i => ({ ...i })),
      createdAt: new Date().toISOString(),
      createdBy: state.currentUser.name,
      status: 'Pending PO Number'
    };
    generatedPODs.push(pod);

    // Update material-level TCD approval and vendor info (but NOT PO number yet)
    va.items.forEach(item => {
      const prcIdx = prcs.findIndex(p => p.id === item.prcId);
      if (prcIdx === -1) return;
      const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };
      const matIdx = prc.materials.findIndex(m => m.id === item.materialId);
      if (matIdx === -1) return;
      const mat = { ...prc.materials[matIdx] };
      mat.tcdApproved = true;
      mat.vendorName = va.vendorName;
      mat.vendor = va.vendorName;
      mat.status = calculateMaterialStatus(mat);
      prc.materials[matIdx] = mat;
      prc.status = calculateStatus(prc, prc.materials);
      prc.updatedAt = new Date().toISOString();
      prcs[prcIdx] = prc;
    });
  });

  const pods = [...generatedPODs, ...state.pods];
  setState({ tcds, pods, prcs, statusSummary: buildStatusSummary(prcs) });
  addAuditLog({
    action: 'approve_tcd', collection: 'TCDs', docId: tcdId,
    changes: { tcdNumber: tcd.tcdNumber, podsGenerated: generatedPODs.length }
  });

  return { success: true, pods: generatedPODs };
}

// ═══════════════════════════════════════════════════════════
// POD (PURCHASE ORDER DOCUMENT) OPERATIONS
// ═══════════════════════════════════════════════════════════

export function getPODById(id) {
  return state.pods.find(p => p.id === id) || null;
}

/**
 * Update a POD — primarily for setting PO Number and PO Date.
 * Cascades PO info to the underlying PRC materials.
 */
export function updatePOD(podId, patch) {
  const podIdx = state.pods.findIndex(p => p.id === podId);
  if (podIdx === -1) return;

  const pod = { ...state.pods[podIdx], ...patch };
  if (patch.poNumber) pod.status = 'Issued';
  pod.updatedAt = new Date().toISOString();
  pod.updatedBy = state.currentUser.name;

  const pods = [...state.pods];
  pods[podIdx] = pod;

  // Cascade PO number/date to materials
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
      prc.status = calculateStatus(prc, prc.materials);
      prc.updatedAt = new Date().toISOString();
      prcs[prcIdx] = prc;
    });
  }

  setState({ pods, prcs, statusSummary: buildStatusSummary(prcs) });
  addAuditLog({
    action: 'update_pod', collection: 'PODs', docId: podId,
    changes: patch
  });
}

// ═══════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════

export function addAuditLog(entry) {
  const log = {
    id: `log-${Date.now()}`,
    ...entry,
    timestamp: new Date().toISOString(),
    user: state.currentUser.name
  };
  setState({ activityLogs: [log, ...state.activityLogs] });
}

