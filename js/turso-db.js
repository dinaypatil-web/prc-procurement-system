// =========================================================
// TURSO DATABASE CLIENT (libSQL on Edge)
// Relational Architecture: Hierarchical Header + Line Items
// =========================================================

import { getEnv, loadEnv } from './env.js';

const DEFAULT_TURSO_CONFIG = {
  url: "https://prc-procurement-db-dinay-patil.aws-ap-south-1.turso.io/v2/pipeline",
  token: "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODc4NDgwMzUsImlkIjoiMDFhMDQ0MGEtZTAwMS03Y2M3LTg1YTMtNmM1NjFhYjM0NzljIiwia2lkIjoibDdvQl9hXzkxQ3dlS3B2RS1BbkZWTU9mU1VjWDBGRmgyQmhtLVhLeTZhVSIsInJpZCI6IjkyODU0ZGNhLWRmYmItNDNmMy1hMWU3LTU3Zjg4MjFjOWU4MCJ9.pwXwdT-JWWrHoSTTB7Ml10vak3vgq78M_bXRWB8SyC3LRgmdQKmQ1K0eKHbgWjblRw2rEXBLv-20krGk9jUAAw"
};

function _normalizeTursoUrl(url) {
  if (!url) return '';
  let u = String(url).trim();
  if (u.startsWith('libsql://')) {
    u = u.replace('libsql://', 'https://');
  }
  if (!u.endsWith('/v2/pipeline')) {
    u = u.replace(/\/+$/, '') + '/v2/pipeline';
  }
  return u;
}

let _tursoUrl = _normalizeTursoUrl(DEFAULT_TURSO_CONFIG.url);
let _tursoToken = DEFAULT_TURSO_CONFIG.token;
let _isConfigured = true;
let _initPromise = null;

const COLLECTIONS = ['prcs', 'allocations', 'rfqs', 'tcds', 'pods', 'vendors', 'users', 'notifications', 'activityLogs'];

/**
 * Initialize Turso Configuration from custom override, env, or defaults
 */
export async function initTurso() {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      await loadEnv();
    } catch (e) {}

    // Check custom localStorage override
    let customCfg = null;
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem('PRC_CUSTOM_TURSO_CONFIG');
        if (raw) customCfg = JSON.parse(raw);
      }
    } catch (e) {}

    let url = _normalizeTursoUrl(customCfg?.url || getEnv('TURSO_DATABASE_URL', DEFAULT_TURSO_CONFIG.url));
    let token = customCfg?.token || getEnv('TURSO_AUTH_TOKEN', DEFAULT_TURSO_CONFIG.token);

    if (url && token) {
      _tursoUrl = url;
      _tursoToken = token;
      _isConfigured = true;
      console.info('⚡ Turso Database Client active (Relational libSQL Edge DB)');
    } else {
      _isConfigured = false;
    }
    return _isConfigured;
  })();

  return _initPromise;
}

export function isTursoConfigured() {
  return Boolean(_tursoUrl && _tursoToken);
}

export function getTursoConfig() {
  return {
    url: _tursoUrl || DEFAULT_TURSO_CONFIG.url,
    token: _tursoToken || DEFAULT_TURSO_CONFIG.token
  };
}

export async function testTursoConnection() {
  const start = performance.now();
  const res = await executeTursoPipeline(["SELECT 1 AS ping;"]);
  const latency = Math.round(performance.now() - start);
  if (res && res.results && res.results[0]?.type === 'ok') {
    return { success: true, latency };
  }
  return { success: false, error: 'Connection failed or bad credentials' };
}

/**
 * Execute an array of SQL statements in a single Turso HTTP pipeline request
 */
export async function executeTursoPipeline(statements) {
  if (!_isConfigured) {
    await initTurso();
  }
  if (!_tursoUrl || !_tursoToken) {
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

function _toBool(val) {
  if (val === true || val === 1 || val === '1' || val === 'true') return true;
  return false;
}

// ═══════════════════════════════════════════════════════════
// ROW CONVERTERS (DB Snake_Case Columns -> JS CamelCase Models)
// ═══════════════════════════════════════════════════════════

function _rowToMap(cols, row) {
  const obj = {};
  cols.forEach((col, idx) => {
    obj[col] = row[idx]?.value;
  });
  return obj;
}

function _mapPRCHeader(m) {
  return {
    id: m.id,
    userId: m.user_id,
    prNumber: m.pr_number || m.id,
    prDate: m.pr_date || '',
    status: m.status || 'Pending',
    prStatus: m.pr_status || '',
    department: m.department || '',
    job: m.job || '',
    jobCode: m.job_code || '',
    jobDesc: m.job_desc || '',
    wbsCode: m.wbs_code || '',
    wbsDesc: m.wbs_desc || '',
    cpCode: m.cp_code || '',
    cpDesc: m.cp_desc || '',
    category: m.category || '',
    categoryDesc: m.category_desc || '',
    priority: m.priority || 'Medium',
    budgetReference: m.budget_reference || '',
    warehouseCode: m.warehouse_code || '',
    warehouseDesc: m.warehouse_desc || '',
    buyerName: m.buyer_name || '',
    allocatedBy: m.allocated_by || '',
    allocationNumber: m.allocation_number || '',
    allocationDate: m.allocation_date || '',
    rfqNumber: m.rfq_number || '',
    rfqDate: m.rfq_date || '',
    tcdNumber: m.tcd_number || '',
    tcdDate: m.tcd_date || '',
    tcdApproved: _toBool(m.tcd_approved),
    tcdApprovedBy: m.tcd_approved_by || '',
    tcdApprovedDate: m.tcd_approved_date || '',
    poNumber: m.po_number || '',
    poDate: m.po_date || '',
    vendorName: m.vendor_name || '',
    isShortClosed: _toBool(m.is_short_closed),
    isWrongPRC: _toBool(m.is_wrong_prc),
    isPRNotApproved: _toBool(m.is_pr_not_approved),
    isFuturePRC: _toBool(m.is_future_prc),
    isSystemIssue: _toBool(m.is_system_issue),
    offersReceived: _toBool(m.offers_received),
    remarks: m.remarks || '',
    createdBy: m.created_by || '',
    requestedBy: m.requested_by || '',
    authorizedBy: m.authorized_by || '',
    authorizedOn: m.authorized_on || '',
    createdAt: m.created_at || '',
    updatedAt: m.updated_at || '',
    materials: []
  };
}

function _mapPRCMaterial(m) {
  return {
    id: m.id,
    prcId: m.prc_id,
    userId: m.user_id,
    serialNumber: m.serial_number || '',
    matCode: m.mat_code || '',
    description: m.description || '',
    quantity: parseFloat(m.quantity) || 0,
    unit: m.unit || '',
    suggestedRate: parseFloat(m.suggested_rate) || 0,
    value: parseFloat(m.value) || 0,
    processedQty: parseFloat(m.processed_qty) || 0,
    closedQty: parseFloat(m.closed_qty) || 0,
    pendingQty: parseFloat(m.pending_qty) || 0,
    status: m.status || 'Pending',
    allocationNumber: m.allocation_number || '',
    allocationDate: m.allocation_date || '',
    buyerName: m.buyer_name || '',
    allocatedBy: m.allocated_by || '',
    rfqNumber: m.rfq_number || '',
    rfqDate: m.rfq_date || '',
    offersReceived: _toBool(m.offers_received),
    tcdNumber: m.tcd_number || '',
    tcdDate: m.tcd_date || '',
    tcdApproved: _toBool(m.tcd_approved),
    poNumber: m.po_number || '',
    poDate: m.po_date || '',
    vendorName: m.vendor_name || '',
    vendor: m.vendor_name || '',
    deliveryDate: m.delivery_date || '',
    deliveryStartDate: m.delivery_start_date || '',
    deliveryEndDate: m.delivery_end_date || '',
    materialGroupCode: m.material_group_code || '',
    materialGroupDesc: m.material_group_desc || '',
    materialClass: m.material_class || '',
    warehouseCode: m.warehouse_code || '',
    warehouseDesc: m.warehouse_desc || '',
    warehouse: m.warehouse_desc || '',
    wbsCode: m.wbs_code || '',
    wbsDesc: m.wbs_desc || '',
    cpCode: m.cp_code || '',
    cpDesc: m.cp_desc || '',
    drawingNumber: m.drawing_number || '',
    remarks: m.remarks || '',
    updatedAt: m.updated_at || ''
  };
}

function _mapAllocationHeader(m) {
  return {
    id: m.id,
    userId: m.user_id,
    allocationNumber: m.allocation_number || m.id,
    allocationDate: m.allocation_date || '',
    buyerName: m.buyer_name || '',
    allocatedBy: m.allocated_by || m.buyer_name || '',
    status: m.status || 'Active',
    createdBy: m.created_by || '',
    createdAt: m.created_at || '',
    updatedAt: m.updated_at || '',
    items: []
  };
}

function _mapAllocationItem(m) {
  return {
    id: m.id,
    allocationId: m.allocation_id,
    prcId: m.prc_id || '',
    materialId: m.material_id || '',
    prNumber: m.pr_number || '',
    matCode: m.mat_code || '',
    description: m.description || '',
    quantity: parseFloat(m.quantity) || 0,
    unit: m.unit || ''
  };
}

function _mapRFQHeader(m) {
  return {
    id: m.id,
    userId: m.user_id,
    rfqNumber: m.rfq_number || m.id,
    rfqDate: m.rfq_date || '',
    status: m.status || 'Active',
    offersReceived: _toBool(m.offers_received),
    isClosed: _toBool(m.is_closed),
    createdBy: m.created_by || '',
    createdAt: m.created_at || '',
    updatedAt: m.updated_at || '',
    items: []
  };
}

function _mapRFQItem(m) {
  return {
    id: m.id,
    rfqId: m.rfq_id,
    prcId: m.prc_id || '',
    materialId: m.material_id || '',
    allocationId: m.allocation_id || '',
    prNumber: m.pr_number || '',
    matCode: m.mat_code || '',
    description: m.description || '',
    quantity: parseFloat(m.quantity) || 0,
    unit: m.unit || ''
  };
}

function _mapTCDHeader(m) {
  return {
    id: m.id,
    userId: m.user_id,
    tcdNumber: m.tcd_number || m.id,
    tcdDate: m.tcd_date || '',
    status: m.status || 'Active',
    approved: _toBool(m.approved),
    approvedBy: m.approved_by || '',
    approvedDate: m.approved_date || '',
    createdBy: m.created_by || '',
    createdAt: m.created_at || '',
    updatedAt: m.updated_at || '',
    vendorAllocations: []
  };
}

function _mapTCDItem(m) {
  return {
    id: m.id,
    tcdId: m.tcd_id,
    vendorName: m.vendor_name || '',
    prcId: m.prc_id || '',
    materialId: m.material_id || '',
    rfqId: m.rfq_id || '',
    prNumber: m.pr_number || '',
    matCode: m.mat_code || '',
    description: m.description || '',
    quantity: parseFloat(m.quantity) || 0,
    unit: m.unit || ''
  };
}

function _mapPODHeader(m) {
  const rawPo = (m.po_number || '').trim();
  const isPodId = !rawPo || rawPo === m.id || rawPo.startsWith('pod-');
  return {
    id: m.id,
    userId: m.user_id,
    poNumber: isPodId ? '' : rawPo,
    poDate: m.po_date || '',
    tcdId: m.tcd_id || '',
    tcdNumber: m.tcd_number || '',
    vendorName: m.vendor_name || '',
    status: m.status || (isPodId ? 'Pending PO Number' : 'Issued'),
    createdBy: m.created_by || '',
    createdAt: m.created_at || '',
    updatedAt: m.updated_at || '',
    items: []
  };
}

function _mapPODItem(m) {
  return {
    id: m.id,
    podId: m.pod_id,
    prcId: m.prc_id || '',
    materialId: m.material_id || '',
    rfqId: m.rfq_id || '',
    prNumber: m.pr_number || '',
    matCode: m.mat_code || '',
    description: m.description || '',
    quantity: parseFloat(m.quantity) || 0,
    unit: m.unit || ''
  };
}

function _mapUser(m) {
  return {
    id: m.id,
    userId: m.user_id,
    uid: m.id,
    name: m.name || '',
    email: m.email || '',
    password: m.password || '',
    role: m.role || 'User',
    department: m.department || '',
    title: m.title || '',
    phone: m.phone || '',
    avatar: m.avatar || '',
    passwordUpdated: m.password_updated || null,
    createdAt: m.created_at || '',
    updatedAt: m.updated_at || ''
  };
}

function _mapVendor(m) {
  return {
    id: m.id,
    userId: m.user_id,
    name: m.name || '',
    code: m.code || '',
    contactPerson: m.contact_person || '',
    email: m.email || '',
    phone: m.phone || '',
    category: m.category || '',
    rating: parseFloat(m.rating) || 5.0,
    status: m.status || 'Active',
    createdAt: m.created_at || '',
    updatedAt: m.updated_at || ''
  };
}

function _mapActivityLog(m) {
  let changes = {};
  try {
    changes = JSON.parse(m.changes || '{}');
  } catch (e) {
    changes = m.changes;
  }
  return {
    id: m.id,
    userId: m.user_id,
    docId: m.doc_id || '',
    collection: m.collection_name || '',
    collectionName: m.collection_name || '',
    action: m.action || '',
    user: m.user_name || '',
    userName: m.user_name || '',
    changes,
    timestamp: m.timestamp || m.updated_at || '',
    updatedAt: m.updated_at || ''
  };
}

function _mapNotification(m) {
  return {
    id: m.id,
    userId: m.user_id,
    title: m.title || '',
    message: m.message || '',
    type: m.type || 'info',
    isRead: _toBool(m.is_read),
    link: m.link || '',
    createdAt: m.created_at || '',
    updatedAt: m.updated_at || ''
  };
}

// ═══════════════════════════════════════════════════════════
// DATA LOADING (Header + Line Items Assembly)
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

  const queries = [
    { sql: `SELECT * FROM prcs ORDER BY rowid ASC;`, args: [] },
    { sql: `SELECT * FROM prc_materials ORDER BY rowid ASC;`, args: [] },
    { sql: `SELECT * FROM allocations ORDER BY rowid ASC;`, args: [] },
    { sql: `SELECT * FROM allocation_items ORDER BY rowid ASC;`, args: [] },
    { sql: `SELECT * FROM rfqs ORDER BY rowid ASC;`, args: [] },
    { sql: `SELECT * FROM rfq_items ORDER BY rowid ASC;`, args: [] },
    { sql: `SELECT * FROM tcds ORDER BY rowid ASC;`, args: [] },
    { sql: `SELECT * FROM tcd_items ORDER BY rowid ASC;`, args: [] },
    { sql: `SELECT * FROM pods ORDER BY rowid ASC;`, args: [] },
    { sql: `SELECT * FROM pod_items ORDER BY rowid ASC;`, args: [] },
    { sql: `SELECT * FROM vendors ORDER BY rowid ASC;`, args: [] },
    { sql: `SELECT * FROM users ORDER BY rowid ASC;`, args: [] },
    { sql: `SELECT * FROM notifications ORDER BY rowid ASC;`, args: [] },
    { sql: `SELECT * FROM activity_logs ORDER BY rowid ASC;`, args: [] },
    { sql: `SELECT * FROM user_profiles WHERE user_id = ?;`, args: [effectiveUid] }
  ];

  const response = await executeTursoPipeline(queries);
  if (!response || !response.results) {
    console.warn('Could not load user data from Turso');
    return null;
  }

  function getRows(idx) {
    const resObj = response.results[idx];
    if (resObj && resObj.type === 'ok' && resObj.response && resObj.response.result) {
      const cols = resObj.response.result.cols.map(c => c.name);
      return (resObj.response.result.rows || []).map(r => _rowToMap(cols, r));
    }
    return [];
  }

  // 1. PRCs & Materials
  const prcHeaders = getRows(0).map(_mapPRCHeader);
  const prcMaterials = getRows(1).map(_mapPRCMaterial);
  const prcMap = new Map();
  prcHeaders.forEach(p => { prcMap.set(p.id, p); });
  prcMaterials.forEach(m => {
    const prc = prcMap.get(m.prcId);
    if (prc) {
      prc.materials.push(m);
    }
  });

  // 2. Allocations & Items
  const allocHeaders = getRows(2).map(_mapAllocationHeader);
  const allocItems = getRows(3).map(_mapAllocationItem);
  const allocMap = new Map();
  allocHeaders.forEach(a => { allocMap.set(a.id, a); });
  allocItems.forEach(i => {
    const alloc = allocMap.get(i.allocationId);
    if (alloc) {
      alloc.items.push(i);
    }
  });

  // 3. RFQs & Items
  const rfqHeaders = getRows(4).map(_mapRFQHeader);
  const rfqItems = getRows(5).map(_mapRFQItem);
  const rfqMap = new Map();
  rfqHeaders.forEach(r => { rfqMap.set(r.id, r); });
  rfqItems.forEach(i => {
    const rfq = rfqMap.get(i.rfqId);
    if (rfq) {
      rfq.items.push(i);
    }
  });

  // 4. TCDs & Items (reconstruct vendorAllocations)
  const tcdHeaders = getRows(6).map(_mapTCDHeader);
  const tcdItems = getRows(7).map(_mapTCDItem);
  const tcdMap = new Map();
  tcdHeaders.forEach(t => { tcdMap.set(t.id, t); });
  tcdItems.forEach(i => {
    const tcd = tcdMap.get(i.tcdId);
    if (tcd) {
      let va = tcd.vendorAllocations.find(v => v.vendorName === i.vendorName);
      if (!va) {
        va = { vendorName: i.vendorName, items: [] };
        tcd.vendorAllocations.push(va);
      }
      va.items.push(i);
    }
  });

  // 5. PODs & Items
  const podHeaders = getRows(8).map(_mapPODHeader);
  const podItems = getRows(9).map(_mapPODItem);
  const podMap = new Map();
  podHeaders.forEach(p => { podMap.set(p.id, p); });
  podItems.forEach(i => {
    const pod = podMap.get(i.podId);
    if (pod) {
      pod.items.push(i);
    }
  });

  // Flat Collections
  const vendors = getRows(10).map(_mapVendor);
  const users = getRows(11).map(_mapUser);
  const notifications = getRows(12).map(_mapNotification);
  const activityLogs = getRows(13).map(_mapActivityLog);

  // Profile
  const profileRows = getRows(14);
  let profile = null;
  if (profileRows.length > 0) {
    const p = profileRows[0];
    profile = {
      name: p.name || '',
      email: p.email || '',
      role: p.role || 'User',
      avatar: p.avatar || 'U',
      lastSyncedAt: p.last_synced_at || ''
    };
  }

  const result = {
    prcs: prcHeaders,
    allocations: allocHeaders,
    rfqs: rfqHeaders,
    tcds: tcdHeaders,
    pods: podHeaders,
    vendors,
    users,
    notifications,
    activityLogs,
    profile
  };

  console.info(`⚡ Loaded relational data for '${effectiveUid}' from Turso (PRCs: ${result.prcs.length}, Materials: ${prcMaterials.length}, Allocs: ${result.allocations.length}, RFQs: ${result.rfqs.length}, TCDs: ${result.tcds.length}, PODs: ${result.pods.length})`);
  return result;
}

// ═══════════════════════════════════════════════════════════
// DIRECT DOCUMENT LEVEL WRITES (Header + Line Items)
// ═══════════════════════════════════════════════════════════

export async function directSavePRC(uid, prc) {
  if (!prc || !prc.id && !prc.prNumber) return false;
  const effectiveUid = (uid && uid !== 'default') ? uid : (prc.userId || 'guest');
  const prcId = prc.id || prc.prNumber;
  const now = new Date().toISOString();

  const statements = [
    {
      sql: `INSERT INTO prcs (
        id, user_id, pr_number, pr_date, status, pr_status, department, job, job_code, job_desc,
        wbs_code, wbs_desc, cp_code, cp_desc, category, category_desc, priority, budget_reference,
        warehouse_code, warehouse_desc, buyer_name, allocated_by, allocation_number, allocation_date,
        rfq_number, rfq_date, tcd_number, tcd_date, tcd_approved, tcd_approved_by, tcd_approved_date,
        po_number, po_date, vendor_name, is_short_closed, is_wrong_prc, is_pr_not_approved,
        is_future_prc, is_system_issue, offers_received, remarks, created_by, requested_by,
        authorized_by, authorized_on, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        pr_number = excluded.pr_number,
        pr_date = excluded.pr_date,
        status = excluded.status,
        pr_status = excluded.pr_status,
        department = excluded.department,
        job = excluded.job,
        job_code = excluded.job_code,
        job_desc = excluded.job_desc,
        wbs_code = excluded.wbs_code,
        wbs_desc = excluded.wbs_desc,
        cp_code = excluded.cp_code,
        cp_desc = excluded.cp_desc,
        category = excluded.category,
        category_desc = excluded.category_desc,
        priority = excluded.priority,
        budget_reference = excluded.budget_reference,
        warehouse_code = excluded.warehouse_code,
        warehouse_desc = excluded.warehouse_desc,
        buyer_name = excluded.buyer_name,
        allocated_by = excluded.allocated_by,
        allocation_number = excluded.allocation_number,
        allocation_date = excluded.allocation_date,
        rfq_number = excluded.rfq_number,
        rfq_date = excluded.rfq_date,
        tcd_number = excluded.tcd_number,
        tcd_date = excluded.tcd_date,
        tcd_approved = excluded.tcd_approved,
        tcd_approved_by = excluded.tcd_approved_by,
        tcd_approved_date = excluded.tcd_approved_date,
        po_number = excluded.po_number,
        po_date = excluded.po_date,
        vendor_name = excluded.vendor_name,
        is_short_closed = excluded.is_short_closed,
        is_wrong_prc = excluded.is_wrong_prc,
        is_pr_not_approved = excluded.is_pr_not_approved,
        is_future_prc = excluded.is_future_prc,
        is_system_issue = excluded.is_system_issue,
        offers_received = excluded.offers_received,
        remarks = excluded.remarks,
        created_by = excluded.created_by,
        requested_by = excluded.requested_by,
        authorized_by = excluded.authorized_by,
        authorized_on = excluded.authorized_on,
        updated_at = excluded.updated_at;`,
      args: [
        prcId,
        effectiveUid,
        prc.prNumber || prcId,
        prc.prDate || prc.createdOn || '',
        prc.status || 'Pending',
        prc.prStatus || '',
        prc.department || '',
        prc.job || '',
        prc.jobCode || '',
        prc.jobDesc || '',
        prc.wbsCode || '',
        prc.wbsDesc || '',
        prc.cpCode || '',
        prc.cpDesc || '',
        prc.category || '',
        prc.categoryDesc || '',
        prc.priority || 'Medium',
        prc.budgetReference || '',
        prc.warehouseCode || '',
        prc.warehouseDesc || '',
        prc.buyerName || '',
        prc.allocatedBy || '',
        prc.allocationNumber || '',
        prc.allocationDate || '',
        prc.rfqNumber || '',
        prc.rfqDate || '',
        prc.tcdNumber || '',
        prc.tcdDate || '',
        prc.tcdApproved ? 1 : 0,
        prc.tcdApprovedBy || '',
        prc.tcdApprovedDate || '',
        prc.poNumber || '',
        prc.poDate || '',
        prc.vendorName || '',
        prc.isShortClosed ? 1 : 0,
        prc.isWrongPRC ? 1 : 0,
        prc.isPRNotApproved ? 1 : 0,
        prc.isFuturePRC ? 1 : 0,
        prc.isSystemIssue ? 1 : 0,
        prc.offersReceived ? 1 : 0,
        prc.remarks || '',
        prc.createdBy || '',
        prc.requestedBy || '',
        prc.authorizedBy || '',
        prc.authorizedOn || '',
        prc.createdAt || prc.createdOn || now,
        now
      ]
    },
    {
      sql: `DELETE FROM prc_materials WHERE prc_id = ?;`,
      args: [prcId]
    }
  ];

  (prc.materials || []).forEach((m, idx) => {
    const matId = m.id || `${prcId}-mat-${idx + 1}`;
    statements.push({
      sql: `INSERT INTO prc_materials (
        id, prc_id, user_id, serial_number, mat_code, description, quantity, unit,
        suggested_rate, value, processed_qty, closed_qty, pending_qty, status,
        allocation_number, allocation_date, buyer_name, allocated_by, rfq_number,
        rfq_date, offers_received, tcd_number, tcd_date, tcd_approved, po_number,
        po_date, vendor_name, delivery_date, delivery_start_date, delivery_end_date,
        material_group_code, material_group_desc, material_class, warehouse_code,
        warehouse_desc, wbs_code, wbs_desc, cp_code, cp_desc, drawing_number, remarks, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      args: [
        matId,
        prcId,
        effectiveUid,
        String(m.serialNumber || idx + 1),
        m.matCode || '',
        m.description || '',
        parseFloat(m.quantity) || 0,
        m.unit || '',
        parseFloat(m.suggestedRate) || 0,
        parseFloat(m.value) || 0,
        parseFloat(m.processedQty) || 0,
        parseFloat(m.closedQty) || 0,
        parseFloat(m.pendingQty) || 0,
        m.status || 'Pending',
        m.allocationNumber || '',
        m.allocationDate || '',
        m.buyerName || '',
        m.allocatedBy || '',
        m.rfqNumber || '',
        m.rfqDate || '',
        m.offersReceived ? 1 : 0,
        m.tcdNumber || '',
        m.tcdDate || '',
        m.tcdApproved ? 1 : 0,
        m.poNumber || '',
        m.poDate || '',
        m.vendorName || m.vendor || '',
        m.deliveryDate || '',
        m.deliveryStartDate || '',
        m.deliveryEndDate || '',
        m.materialGroupCode || '',
        m.materialGroupDesc || '',
        m.materialClass || '',
        m.warehouseCode || '',
        m.warehouseDesc || m.warehouse || '',
        m.wbsCode || '',
        m.wbsDesc || '',
        m.cpCode || '',
        m.cpDesc || '',
        m.drawingNumber || '',
        m.remarks || '',
        now
      ]
    });
  });

  const result = await executeTursoPipeline(statements);
  return result && result.results && result.results[0] && result.results[0].type === 'ok';
}

export async function directDeletePRC(uid, prcId) {
  if (!prcId) return false;
  const statements = [
    { sql: `DELETE FROM prc_materials WHERE prc_id = ?;`, args: [String(prcId)] },
    { sql: `DELETE FROM prcs WHERE id = ?;`, args: [String(prcId)] }
  ];
  const result = await executeTursoPipeline(statements);
  return result && result.results && result.results[1]?.type === 'ok';
}

export async function directSaveAllocation(uid, alloc) {
  if (!alloc || !alloc.id && !alloc.allocationNumber) return false;
  const effectiveUid = (uid && uid !== 'default') ? uid : (alloc.userId || 'guest');
  const allocId = alloc.id || alloc.allocationNumber;
  const now = new Date().toISOString();

  const statements = [
    {
      sql: `INSERT INTO allocations (id, user_id, allocation_number, allocation_date, buyer_name, allocated_by, status, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              user_id = excluded.user_id,
              allocation_number = excluded.allocation_number,
              allocation_date = excluded.allocation_date,
              buyer_name = excluded.buyer_name,
              allocated_by = excluded.allocated_by,
              status = excluded.status,
              created_by = excluded.created_by,
              updated_at = excluded.updated_at;`,
      args: [
        allocId,
        effectiveUid,
        alloc.allocationNumber || allocId,
        alloc.allocationDate || '',
        alloc.buyerName || '',
        alloc.allocatedBy || alloc.buyerName || '',
        alloc.status || 'Active',
        alloc.createdBy || '',
        alloc.createdAt || now,
        now
      ]
    },
    {
      sql: `DELETE FROM allocation_items WHERE allocation_id = ?;`,
      args: [allocId]
    }
  ];

  (alloc.items || []).forEach((item, idx) => {
    statements.push({
      sql: `INSERT INTO allocation_items (id, allocation_id, prc_id, material_id, pr_number, mat_code, description, quantity, unit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      args: [
        item.id || `${allocId}-item-${idx + 1}`,
        allocId,
        item.prcId || '',
        item.materialId || '',
        item.prNumber || '',
        item.matCode || '',
        item.description || '',
        parseFloat(item.quantity) || 0,
        item.unit || ''
      ]
    });
  });

  const result = await executeTursoPipeline(statements);
  return result && result.results && result.results[0]?.type === 'ok';
}

export async function directDeleteAllocation(uid, allocId) {
  if (!allocId) return false;
  const statements = [
    { sql: `DELETE FROM allocation_items WHERE allocation_id = ?;`, args: [String(allocId)] },
    { sql: `DELETE FROM allocations WHERE id = ?;`, args: [String(allocId)] }
  ];
  const result = await executeTursoPipeline(statements);
  return result && result.results && result.results[1]?.type === 'ok';
}

export async function directSaveRFQ(uid, rfq) {
  if (!rfq || !rfq.id && !rfq.rfqNumber) return false;
  const effectiveUid = (uid && uid !== 'default') ? uid : (rfq.userId || 'guest');
  const rfqId = rfq.id || rfq.rfqNumber;
  const now = new Date().toISOString();

  const statements = [
    {
      sql: `INSERT INTO rfqs (id, user_id, rfq_number, rfq_date, status, offers_received, is_closed, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              user_id = excluded.user_id,
              rfq_number = excluded.rfq_number,
              rfq_date = excluded.rfq_date,
              status = excluded.status,
              offers_received = excluded.offers_received,
              is_closed = excluded.is_closed,
              created_by = excluded.created_by,
              updated_at = excluded.updated_at;`,
      args: [
        rfqId,
        effectiveUid,
        rfq.rfqNumber || rfqId,
        rfq.rfqDate || '',
        rfq.status || 'Active',
        rfq.offersReceived ? 1 : 0,
        rfq.isClosed ? 1 : 0,
        rfq.createdBy || '',
        rfq.createdAt || now,
        now
      ]
    },
    {
      sql: `DELETE FROM rfq_items WHERE rfq_id = ?;`,
      args: [rfqId]
    }
  ];

  (rfq.items || []).forEach((item, idx) => {
    statements.push({
      sql: `INSERT INTO rfq_items (id, rfq_id, prc_id, material_id, allocation_id, pr_number, mat_code, description, quantity, unit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      args: [
        item.id || `${rfqId}-item-${idx + 1}`,
        rfqId,
        item.prcId || '',
        item.materialId || '',
        item.allocationId || '',
        item.prNumber || '',
        item.matCode || '',
        item.description || '',
        parseFloat(item.quantity) || 0,
        item.unit || ''
      ]
    });
  });

  const result = await executeTursoPipeline(statements);
  return result && result.results && result.results[0]?.type === 'ok';
}

export async function directDeleteRFQ(uid, rfqId) {
  if (!rfqId) return false;
  const statements = [
    { sql: `DELETE FROM rfq_items WHERE rfq_id = ?;`, args: [String(rfqId)] },
    { sql: `DELETE FROM rfqs WHERE id = ?;`, args: [String(rfqId)] }
  ];
  const result = await executeTursoPipeline(statements);
  return result && result.results && result.results[1]?.type === 'ok';
}

export async function directSaveTCD(uid, tcd) {
  if (!tcd || !tcd.id && !tcd.tcdNumber) return false;
  const effectiveUid = (uid && uid !== 'default') ? uid : (tcd.userId || 'guest');
  const tcdId = tcd.id || tcd.tcdNumber;
  const now = new Date().toISOString();

  const statements = [
    {
      sql: `INSERT INTO tcds (id, user_id, tcd_number, tcd_date, status, approved, approved_by, approved_date, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              user_id = excluded.user_id,
              tcd_number = excluded.tcd_number,
              tcd_date = excluded.tcd_date,
              status = excluded.status,
              approved = excluded.approved,
              approved_by = excluded.approved_by,
              approved_date = excluded.approved_date,
              created_by = excluded.created_by,
              updated_at = excluded.updated_at;`,
      args: [
        tcdId,
        effectiveUid,
        tcd.tcdNumber || tcdId,
        tcd.tcdDate || '',
        tcd.status || 'Active',
        tcd.approved ? 1 : 0,
        tcd.approvedBy || '',
        tcd.approvedDate || '',
        tcd.createdBy || '',
        tcd.createdAt || now,
        now
      ]
    },
    {
      sql: `DELETE FROM tcd_items WHERE tcd_id = ?;`,
      args: [tcdId]
    }
  ];

  (tcd.vendorAllocations || []).forEach((va, vIdx) => {
    const vendorName = va.vendorName || '';
    (va.items || []).forEach((item, iIdx) => {
      statements.push({
        sql: `INSERT INTO tcd_items (id, tcd_id, vendor_name, prc_id, material_id, rfq_id, pr_number, mat_code, description, quantity, unit)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        args: [
          item.id || `${tcdId}-item-${vIdx + 1}-${iIdx + 1}`,
          tcdId,
          vendorName,
          item.prcId || '',
          item.materialId || '',
          item.rfqId || '',
          item.prNumber || '',
          item.matCode || '',
          item.description || '',
          parseFloat(item.quantity) || 0,
          item.unit || ''
        ]
      });
    });
  });

  const result = await executeTursoPipeline(statements);
  return result && result.results && result.results[0]?.type === 'ok';
}

export async function directDeleteTCD(uid, tcdId) {
  if (!tcdId) return false;
  const statements = [
    { sql: `DELETE FROM tcd_items WHERE tcd_id = ?;`, args: [String(tcdId)] },
    { sql: `DELETE FROM tcds WHERE id = ?;`, args: [String(tcdId)] }
  ];
  const result = await executeTursoPipeline(statements);
  return result && result.results && result.results[1]?.type === 'ok';
}

export async function directSavePOD(uid, pod) {
  if (!pod || (!pod.id && !pod.poNumber)) return false;
  const effectiveUid = (uid && uid !== 'default') ? uid : (pod.userId || 'guest');
  const podId = pod.id || pod.poNumber;
  const now = new Date().toISOString();
  const rawPo = (pod.poNumber || '').trim();
  const poNum = (rawPo && rawPo !== podId && !rawPo.startsWith('pod-')) ? rawPo : '';

  const statements = [
    {
      sql: `INSERT INTO pods (id, user_id, po_number, po_date, tcd_id, tcd_number, vendor_name, status, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              user_id = excluded.user_id,
              po_number = excluded.po_number,
              po_date = excluded.po_date,
              tcd_id = excluded.tcd_id,
              tcd_number = excluded.tcd_number,
              vendor_name = excluded.vendor_name,
              status = excluded.status,
              created_by = excluded.created_by,
              updated_at = excluded.updated_at;`,
      args: [
        podId,
        effectiveUid,
        poNum,
        pod.poDate || '',
        pod.tcdId || '',
        pod.tcdNumber || '',
        pod.vendorName || '',
        pod.status || (poNum ? 'Issued' : 'Pending PO Number'),
        pod.createdBy || '',
        pod.createdAt || now,
        now
      ]
    },
    {
      sql: `DELETE FROM pod_items WHERE pod_id = ?;`,
      args: [podId]
    }
  ];

  (pod.items || []).forEach((item, idx) => {
    statements.push({
      sql: `INSERT INTO pod_items (id, pod_id, prc_id, material_id, rfq_id, pr_number, mat_code, description, quantity, unit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      args: [
        item.id || `${podId}-item-${idx + 1}`,
        podId,
        item.prcId || '',
        item.materialId || '',
        item.rfqId || '',
        item.prNumber || '',
        item.matCode || '',
        item.description || '',
        parseFloat(item.quantity) || 0,
        item.unit || ''
      ]
    });
  });

  const result = await executeTursoPipeline(statements);
  return result && result.results && result.results[0]?.type === 'ok';
}

export async function directDeletePOD(uid, podId) {
  if (!podId) return false;
  const statements = [
    { sql: `DELETE FROM pod_items WHERE pod_id = ?;`, args: [String(podId)] },
    { sql: `DELETE FROM pods WHERE id = ?;`, args: [String(podId)] }
  ];
  const result = await executeTursoPipeline(statements);
  return result && result.results && result.results[1]?.type === 'ok';
}

export async function directSaveActivityLog(uid, log) {
  if (!log || !log.id) return false;
  const effectiveUid = (uid && uid !== 'default') ? uid : (log.userId || 'guest');
  const now = new Date().toISOString();

  const stmt = {
    sql: `INSERT INTO activity_logs (id, user_id, doc_id, collection_name, action, user_name, changes, timestamp, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            user_id = excluded.user_id,
            doc_id = excluded.doc_id,
            collection_name = excluded.collection_name,
            action = excluded.action,
            user_name = excluded.user_name,
            changes = excluded.changes,
            timestamp = excluded.timestamp,
            updated_at = excluded.updated_at;`,
    args: [
      log.id,
      effectiveUid,
      log.docId || '',
      log.collection || log.collectionName || '',
      log.action || '',
      log.user || log.userName || '',
      typeof log.changes === 'object' ? JSON.stringify(log.changes) : String(log.changes || ''),
      log.timestamp || now,
      now
    ]
  };

  const result = await executeTursoPipeline([stmt]);
  return result && result.results && result.results[0]?.type === 'ok';
}

export async function directSaveDoc(uid, collectionName, docId, docData) {
  if (!docId || !docData) return false;
  const effectiveUid = (uid && uid !== 'default') ? uid : (docData.userId || 'guest');
  const now = new Date().toISOString();

  if (collectionName === 'prcs') return directSavePRC(effectiveUid, docData);
  if (collectionName === 'allocations') return directSaveAllocation(effectiveUid, docData);
  if (collectionName === 'rfqs') return directSaveRFQ(effectiveUid, docData);
  if (collectionName === 'tcds') return directSaveTCD(effectiveUid, docData);
  if (collectionName === 'pods') return directSavePOD(effectiveUid, docData);
  if (collectionName === 'activityLogs' || collectionName === 'activity_logs') return directSaveActivityLog(effectiveUid, { ...docData, id: docId });

  if (collectionName === 'users') {
    const stmt = {
      sql: `INSERT INTO users (id, user_id, name, email, password, role, department, title, phone, avatar, password_updated, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              user_id = excluded.user_id,
              name = excluded.name,
              email = excluded.email,
              password = CASE WHEN excluded.password != '' THEN excluded.password ELSE users.password END,
              role = excluded.role,
              department = excluded.department,
              title = excluded.title,
              phone = excluded.phone,
              avatar = excluded.avatar,
              password_updated = excluded.password_updated,
              updated_at = excluded.updated_at;`,
      args: [
        String(docId),
        effectiveUid,
        docData.name || '',
        docData.email || '',
        docData.password || '',
        docData.role || 'User',
        docData.department || '',
        docData.title || '',
        docData.phone || '',
        docData.avatar || '',
        docData.passwordUpdated || null,
        docData.createdAt || now,
        now
      ]
    };
    const result = await executeTursoPipeline([stmt]);
    return result && result.results && result.results[0]?.type === 'ok';
  }

  if (collectionName === 'vendors') {
    const stmt = {
      sql: `INSERT INTO vendors (id, user_id, name, code, contact_person, email, phone, category, rating, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              user_id = excluded.user_id,
              name = excluded.name,
              code = excluded.code,
              contact_person = excluded.contact_person,
              email = excluded.email,
              phone = excluded.phone,
              category = excluded.category,
              rating = excluded.rating,
              status = excluded.status,
              updated_at = excluded.updated_at;`,
      args: [
        String(docId),
        effectiveUid,
        docData.name || '',
        docData.code || '',
        docData.contactPerson || '',
        docData.email || '',
        docData.phone || '',
        docData.category || '',
        parseFloat(docData.rating) || 5.0,
        docData.status || 'Active',
        docData.createdAt || now,
        now
      ]
    };
    const result = await executeTursoPipeline([stmt]);
    return result && result.results && result.results[0]?.type === 'ok';
  }

  if (collectionName === 'notifications') {
    const stmt = {
      sql: `INSERT INTO notifications (id, user_id, title, message, type, is_read, link, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              user_id = excluded.user_id,
              title = excluded.title,
              message = excluded.message,
              type = excluded.type,
              is_read = excluded.is_read,
              link = excluded.link,
              updated_at = excluded.updated_at;`,
      args: [
        String(docId),
        effectiveUid,
        docData.title || '',
        docData.message || '',
        docData.type || 'info',
        docData.isRead ? 1 : 0,
        docData.link || '',
        docData.createdAt || now,
        now
      ]
    };
    const result = await executeTursoPipeline([stmt]);
    return result && result.results && result.results[0]?.type === 'ok';
  }

  return false;
}

export async function directDeleteDoc(uid, collectionName, docId) {
  if (!docId) return false;
  if (collectionName === 'prcs') return directDeletePRC(uid, docId);
  if (collectionName === 'allocations') return directDeleteAllocation(uid, docId);
  if (collectionName === 'rfqs') return directDeleteRFQ(uid, docId);
  if (collectionName === 'tcds') return directDeleteTCD(uid, docId);
  if (collectionName === 'pods') return directDeletePOD(uid, docId);

  const table = collectionName === 'activityLogs' ? 'activity_logs' : collectionName;
  const stmt = {
    sql: `DELETE FROM ${table} WHERE id = ?;`,
    args: [String(docId)]
  };
  const result = await executeTursoPipeline([stmt]);
  return result && result.results && result.results[0]?.type === 'ok';
}

// ═══════════════════════════════════════════════════════════
// COLLECTION AND BULK SAVE
// ═══════════════════════════════════════════════════════════

export async function saveCollection(uid, collectionName, items) {
  if (!items || items.length === 0) return true;
  const effectiveUid = (uid && uid !== 'default') ? uid : 'guest';

  for (const item of items) {
    const rawId = item.id || item.prNumber || item.allocationNumber || item.rfqNumber || item.tcdNumber || item.poNumber;
    if (rawId) {
      await directSaveDoc(effectiveUid, collectionName, rawId, item);
    }
  }
  return true;
}

export async function saveAllUserData(uid, stateData) {
  if (!_isConfigured) {
    await initTurso();
  }
  if (!_isConfigured) return false;

  const effectiveUid = (uid && uid !== 'default') ? uid : 'guest';
  const now = new Date().toISOString();

  // Save profile
  if (effectiveUid !== 'guest' && stateData.currentUser) {
    await executeTursoPipeline([{
      sql: `INSERT INTO user_profiles (user_id, name, email, role, avatar, last_synced_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              name = excluded.name,
              email = excluded.email,
              role = excluded.role,
              avatar = excluded.avatar,
              last_synced_at = excluded.last_synced_at,
              updated_at = excluded.updated_at;`,
      args: [
        effectiveUid,
        stateData.currentUser.name || '',
        stateData.currentUser.email || '',
        stateData.currentUser.role || 'User',
        stateData.currentUser.avatar || 'U',
        now,
        now
      ]
    }]);
  }

  // Save all entities
  for (const colName of COLLECTIONS) {
    const items = stateData[colName] || [];
    await saveCollection(effectiveUid, colName, items);
  }

  console.info(`⚡ Synced all collections to relational Turso tables for '${effectiveUid}'`);
  return true;
}

// ═══════════════════════════════════════════════════════════
// REAL-TIME / POLLING SYNCHRONIZATION
// ═══════════════════════════════════════════════════════════

let _pollTimer = null;

export async function subscribeToRealtimeUserData(uid, onUpdate) {
  unsubscribeRealtimeUserData();
  const effectiveUid = (uid && uid !== 'default') ? uid : 'guest';
  let lastChecked = new Date().toISOString();

  _pollTimer = setInterval(async () => {
    try {
      const queries = [
        { sql: `SELECT COUNT(*) FROM prcs WHERE updated_at > ?;`, args: [lastChecked] },
        { sql: `SELECT COUNT(*) FROM allocations WHERE updated_at > ?;`, args: [lastChecked] },
        { sql: `SELECT COUNT(*) FROM rfqs WHERE updated_at > ?;`, args: [lastChecked] },
        { sql: `SELECT COUNT(*) FROM tcds WHERE updated_at > ?;`, args: [lastChecked] },
        { sql: `SELECT COUNT(*) FROM pods WHERE updated_at > ?;`, args: [lastChecked] }
      ];
      const res = await executeTursoPipeline(queries);
      if (res && res.results) {
        const hasUpdates = res.results.some(r => (parseInt(r.response?.result?.rows[0]?.[0]?.value) || 0) > 0);
        if (hasUpdates) {
          lastChecked = new Date().toISOString();
          const freshData = await loadAllUserData(effectiveUid);
          if (freshData && typeof onUpdate === 'function') {
            onUpdate('*', freshData);
          }
        }
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
