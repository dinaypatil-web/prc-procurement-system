import { parseDateObj } from './utils.js';

// =========================================================
// STATUS CALCULATION ENGINE
// Priority order — evaluates in strict sequence
// =========================================================

/**
 * STATUS PRIORITY (highest wins):
 * 1. Wrong PRC
 * 2. PR Not Approved
 * 3. Future PRC
 * 4. System Issue
 * 5. Inputs Required
 * 6. Awaiting Offer
 * 7. Partly Completed
 * 8. Process Completed
 * 9. Pending (default)
 */

export const STATUS = {
  AUTHORISED:      'Authorised',
  SHORT_CLOSED:    'Short-Close',
  NOT_ACTIVE:      'Not Active',
  WRONG_PRC:       'Wrong PRC',
  PR_NOT_APPROVED: 'PR Not Approved',
  FUTURE_PRC:      'Future PRC',
  SYSTEM_ISSUE:    'System Issue',
  INPUTS_REQUIRED: 'Inputs Required',
  AWAITING_OFFER:  'Awaiting Offer',
  PARTLY_COMPLETED:'Partly Completed',
  COMPLETED:       'Process Completed',
  PENDING:         'Pending',
  DRAFT:           'Draft',
  REJECTED:        'Rejected'
};

export const STATUS_CHIP = {
  [STATUS.AUTHORISED]:      'chip-authorised',
  [STATUS.SHORT_CLOSED]:    'chip-shortclosed',
  [STATUS.NOT_ACTIVE]:      'chip-not-active',
  [STATUS.WRONG_PRC]:       'chip-wrong',
  [STATUS.PR_NOT_APPROVED]: 'chip-pr-not',
  [STATUS.FUTURE_PRC]:      'chip-future',
  [STATUS.SYSTEM_ISSUE]:    'chip-system',
  [STATUS.INPUTS_REQUIRED]: 'chip-inputs',
  [STATUS.AWAITING_OFFER]:  'chip-awaiting',
  [STATUS.PARTLY_COMPLETED]:'chip-partly',
  [STATUS.COMPLETED]:       'chip-completed',
  [STATUS.PENDING]:         'chip-pending',
  [STATUS.DRAFT]:           'chip-draft',
  [STATUS.REJECTED]:        'chip-rejected'
};

export const STATUS_ICON = {
  [STATUS.AUTHORISED]:      '✅',
  [STATUS.SHORT_CLOSED]:    '🔒',
  [STATUS.NOT_ACTIVE]:      '🔒',
  [STATUS.WRONG_PRC]:       '❌',
  [STATUS.PR_NOT_APPROVED]: '🚫',
  [STATUS.FUTURE_PRC]:      '🔮',
  [STATUS.SYSTEM_ISSUE]:    '⚙️',
  [STATUS.INPUTS_REQUIRED]: '📋',
  [STATUS.AWAITING_OFFER]:  '⏳',
  [STATUS.PARTLY_COMPLETED]:'🔶',
  [STATUS.COMPLETED]:       '✅',
  [STATUS.PENDING]:         '🕐',
  [STATUS.DRAFT]:           '📝',
  [STATUS.REJECTED]:        '❌'
};

/**
 * Calculates the overall status for a PRC record.
 * @param {Object} prc - The PRC document from Firestore / state.
 * @param {Array}  materials - Array of material sub-documents.
 * @returns {string} Status string from STATUS enum.
 */
export function calculateStatus(prc, materials = prc?.materials || []) {
  // If authorization metadata exists, consider the PRC as Authorised even if prStatus is Pending
  let prStatus = String(prc.prStatus || '').trim();
  const hasAuthMeta = !!(
    (prc.authorizedBy && String(prc.authorizedBy).trim()) ||
    (prc.authorizedOn && String(prc.authorizedOn).trim()) ||
    (prc.authorisedBy && String(prc.authorisedBy).trim()) ||
    (prc.authorisedOn && String(prc.authorisedOn).trim()) ||
    (prc.authorizedDate && String(prc.authorizedDate).trim()) ||
    (prc.authorisedDate && String(prc.authorisedDate).trim())
  );
  if (hasAuthMeta && (!prStatus || prStatus.toLowerCase() === 'pending')) {
    prStatus = 'Authorised';
  }
  prStatus = String(prStatus).trim().toLowerCase();

  // 0. Short Closed (user override / PRC shortclosed)
  if (prc.isShortClosed || prStatus === 'short-close' || prStatus === 'short closed' || prStatus === 'shortclosed') return STATUS.SHORT_CLOSED;

  // 1. Wrong PRC (user override)
  if (prc.isWrongPRC || prStatus === 'wrong prc') return STATUS.WRONG_PRC;

  // 2. PR Not Approved (user override)
  if (prc.isPRNotApproved || prStatus === 'pr not approved') return STATUS.PR_NOT_APPROVED;

  // 3. Future PRC (user override)
  if (prc.isFuturePRC || prStatus === 'future prc') return STATUS.FUTURE_PRC;

  // 4. System Issue (user override)
  if (prc.isSystemIssue || prStatus === 'system issue') return STATUS.SYSTEM_ISSUE;

  // 5. Inputs Required — if any input source is flagged
  if (
    prc.inputFromStores    ||
    prc.inputFromEngineering ||
    prc.inputFromEndUser   ||
    prc.inputFromVendor
  ) return STATUS.INPUTS_REQUIRED;

  // Check RFQ & TCD status across materials and top-level fields
  const hasRFQ = !!(
    prc.rfqNumber ||
    (materials.length > 0 && materials.some(m => m.rfqNumber))
  );

  const hasTCDAny = !!(
    prc.tcdNumber ||
    prc.tcdApproved ||
    prc.poNumber ||
    prStatus === 'process completed' ||
    (materials.length > 0 && materials.some(m => m.tcdNumber || m.tcdApproved || m.poNumber || (parseFloat(m.processedQty) || 0) > 0))
  );

  // Material-level TCD analysis
  if (materials.length > 0) {
    const totalCount = materials.length;
    const completedCount = materials.filter(m => {
      const tot = parseFloat(m.quantity) || 0;
      const proc = parseFloat(m.processedQty) || 0;
      const cls = parseFloat(m.closedQty) || 0;
      return (
        m.tcdNumber ||
        m.tcdApproved ||
        m.poNumber ||
        (tot > 0 && (proc + cls) >= tot)
      );
    }).length;

    // Rule 1: TCD/TCDs Created for all items & Complete Required Quantity of PRC -> Process Completed
    if (completedCount === totalCount && totalCount > 0) {
      return STATUS.COMPLETED;
    }

    // Rule 2: TCD/TCDs created for Some Items/Item or some Quantity -> Partly Completed
    if (hasTCDAny || completedCount > 0) {
      return STATUS.PARTLY_COMPLETED;
    }

    // Rule 3: RFQ Generated but TCD not created -> Awaiting Offer
    if (hasRFQ && !hasTCDAny) {
      return STATUS.AWAITING_OFFER;
    }
  } else {
    // Top-level check
    if (prc.poNumber && prc.poDate && prc.vendorName) return STATUS.COMPLETED;
    if (hasTCDAny) return STATUS.COMPLETED;
    if (hasRFQ) return STATUS.AWAITING_OFFER;
  }

  if (prStatus === 'authorised' || prStatus === 'approved') return STATUS.AUTHORISED;

  // Default
  return STATUS.PENDING;
}

/**
 * Calculates material-level status.
 * @param {Object} material
 * @returns {string}
 */
export function calculateMaterialStatus(material) {
  if (!material) return STATUS.PENDING;

  const totalQty = parseFloat(material.quantity) || 0;
  const procQty  = parseFloat(material.processedQty) || 0;
  const clsQty   = parseFloat(material.closedQty) || 0;
  const pendQty  = Math.max(0, totalQty - procQty - clsQty);

  const matPrStatus = String(material.prStatus || '').trim().toLowerCase();
  if (material.isShortClosed || matPrStatus === 'short-close' || matPrStatus === 'short closed' || matPrStatus === 'shortclosed') return STATUS.SHORT_CLOSED;
  if (material.isWrongPRC || material.isCancelled || matPrStatus === 'wrong prc') return STATUS.WRONG_PRC;
  if (material.isFuturePRC || matPrStatus === 'future prc') return STATUS.FUTURE_PRC;

  // 1. Process Completed: TCD created/approved or PO fully issued for complete required quantity
  if (material.tcdApproved || (material.tcdNumber && pendQty === 0) || (totalQty > 0 && (procQty + clsQty) >= totalQty)) {
    return STATUS.COMPLETED;
  }

  // 2. Partly Completed: TCD created for partial quantity or some processed qty with pending balance
  if (material.tcdNumber || (procQty > 0 && pendQty > 0)) {
    return STATUS.PARTLY_COMPLETED;
  }

  // 3. Awaiting Offer: RFQ generated but TCD not created yet
  if (material.rfqNumber && !material.tcdNumber && !material.tcdApproved && !material.poNumber && procQty === 0) {
    return STATUS.AWAITING_OFFER;
  }

  if (matPrStatus === 'authorised' || matPrStatus === 'approved') return STATUS.AUTHORISED;

  return STATUS.PENDING;
}

/**
 * Returns the CSS chip class for a given status string.
 * @param {string} status
 * @returns {string}
 */
export function getStatusChipClass(status) {
  return STATUS_CHIP[status] || 'chip-pending';
}

/**
 * Returns the emoji icon for a status.
 * @param {string} status
 * @returns {string}
 */
export function getStatusIcon(status) {
  return STATUS_ICON[status] || '🕐';
}

/**
 * Calculates the procurement ageing in days.
 * @param {string|Date} startDate
 * @param {string|Date} [endDate] - Capped completion or milestone date
 * @returns {number}
 */
export function calcAgeDays(startDate, endDate = null) {
  if (!startDate) return 0;
  const start = parseDateObj(startDate);
  const end   = endDate ? parseDateObj(endDate) : new Date();
  if (!start || !end) return 0;
  const diffDays = Math.floor((end - start) / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
}

/**
 * Calculates the exact PRC age in days.
 * Rule: Calculated from Allocation date to TCD Creation date or 0 if it is marked
 * Wrong PRC, PR Not approved, Future PRC or System Issue. If TCD not created, then from allocation date to current date.
 * @param {Object} prc
 * @returns {number}
 */
export function getPRCAge(prc) {
  if (!prc) return 0;

  // Return 0 if marked Wrong PRC, PR Not approved, Future PRC or System Issue
  const currentStatus = prc.status || calculateStatus(prc, prc.materials || []);
  const prStatus = String(prc.prStatus || '').trim().toLowerCase();

  const zeroAgeStatuses = [
    STATUS.WRONG_PRC,
    STATUS.PR_NOT_APPROVED,
    STATUS.FUTURE_PRC,
    STATUS.SYSTEM_ISSUE
  ];

  const zeroAgePRStatus = [
    'wrong prc',
    'pr not approved',
    'future prc',
    'system issue'
  ];

  if (
    prc.isWrongPRC ||
    prc.isPRNotApproved ||
    prc.isFuturePRC ||
    prc.isSystemIssue ||
    zeroAgeStatuses.includes(currentStatus) ||
    zeroAgePRStatus.includes(prStatus)
  ) {
    return 0;
  }

  // Start date: Allocation date
  const mats = prc.materials || [];
  const start = prc.allocationDate || prc.allocatedDate || mats.find(m => m.allocationDate)?.allocationDate;
  if (!start) return 0;

  // End date: TCD Creation date if TCD created, otherwise current date (null -> new Date())
  const tcdDt = prc.tcdDate || prc.tcdCreationDate || prc.tcdCreatedDate || mats.find(m => m.tcdDate)?.tcdDate;
  const hasTCD = !!(prc.tcdNumber || tcdDt || mats.some(m => m.tcdNumber || m.tcdDate));

  const end = (hasTCD && tcdDt) ? tcdDt : null;

  return calcAgeDays(start, end);
}

/**
 * Returns CSS class for age badge based on days and threshold.
 * @param {number} days
 * @param {number} threshold - days before turning yellow
 * @returns {string}
 */
export function getAgeBadgeClass(days, threshold = 3) {
  if (days <= threshold)        return 'age-green';
  if (days <= threshold * 2)    return 'age-yellow';
  if (days <= threshold * 4)    return 'age-orange';
  return 'age-red';
}

/**
 * Determines notification priority for a PRC.
 * Returns: 'red' | 'orange' | 'yellow' | 'green' | null
 */
export function getAlertLevel(prc, materials) {
  const status = calculateStatus(prc, materials);
  const age = getPRCAge(prc);

  if ([STATUS.SHORT_CLOSED, STATUS.WRONG_PRC, STATUS.PR_NOT_APPROVED, STATUS.FUTURE_PRC, STATUS.SYSTEM_ISSUE].includes(status)) return null;
  if (status === STATUS.COMPLETED) return null;

  if (age > 14) return 'red';
  if (age > 7)  return 'orange';
  if (age > 3)  return 'yellow';
  return 'green';
}

/**
 * Builds a summary status breakdown from an array of PRC records.
 * @param {Array} prcs
 * @param {Object} materialsMap - { prcId: [materials] }
 * @returns {Object} counts per status
 */
export function buildStatusSummary(prcs, materialsMap = {}) {
  const summary = {};
  Object.values(STATUS).forEach(s => summary[s] = 0);
  summary.total = prcs.length;

  prcs.forEach(prc => {
    const mats = materialsMap[prc.id] || prc.materials || [];
    const status = calculateStatus(prc, mats);
    summary[status] = (summary[status] || 0) + 1;
  });

  return summary;
}

/**
 * Checks whether an item or PRC has a complete Allocation process.
 * Rule: Complete allocation MUST have allocationNumber, allocationDate, AND buyerName.
 * If any of these 3 fields is missing/empty, the allocation process is INCOMPLETE.
 */
export function isAllocationComplete(item) {
  if (!item) return false;
  const allocNo = String(item.allocationNumber || '').trim();
  const allocDt = String(item.allocationDate || '').trim();
  const buyer   = String(item.buyerName || item.allocatedBy || '').trim();
  return !!(allocNo && allocDt && buyer);
}

export function isPRCAllocationComplete(prc) {
  if (!prc) return false;
  if (isAllocationComplete(prc)) return true;
  const mats = prc.materials || [];
  if (!mats.length) return false;
  return mats.every(m => isMaterialAllocationComplete(m, prc));
}

export function isMaterialAllocationComplete(mat, prc = null) {
  if (!mat) return false;
  const allocNo = String(mat.allocationNumber || prc?.allocationNumber || '').trim();
  const allocDt = String(mat.allocationDate || prc?.allocationDate || '').trim();
  const buyer   = String(mat.buyerName || mat.allocatedBy || prc?.buyerName || prc?.allocatedBy || '').trim();
  return !!(allocNo && allocDt && buyer);
}

/**
 * Returns timeline steps with completion state for a PRC.
 */
export function buildTimeline(prc) {
  if (!prc) return [];
  const mats = prc.materials || [];

  const allocNo   = prc.allocationNumber || mats.find(m => m.allocationNumber)?.allocationNumber;
  const allocDt   = prc.allocationDate   || mats.find(m => m.allocationDate)?.allocationDate;
  const buyerName = prc.buyerName || prc.allocatedBy || mats.find(m => m.buyerName || m.allocatedBy)?.buyerName || mats.find(m => m.buyerName || m.allocatedBy)?.allocatedBy;

  const hasAllocNo   = !!(allocNo && String(allocNo).trim());
  const hasAllocDt   = !!(allocDt && String(allocDt).trim());
  const hasBuyerName = !!(buyerName && String(buyerName).trim());
  const allocDone    = hasAllocNo && hasAllocDt && hasBuyerName;

  const allocMissing = [];
  if (!hasAllocNo)   allocMissing.push('Allocation Number');
  if (!hasAllocDt)   allocMissing.push('Allocation Date');
  if (!hasBuyerName) allocMissing.push('Buyer Name');

  const rfqNo     = prc.rfqNumber || mats.find(m => m.rfqNumber)?.rfqNumber;
  const rfqDt     = prc.rfqDate   || mats.find(m => m.rfqDate)?.rfqDate;

  const tcdNo     = prc.tcdNumber || mats.find(m => m.tcdNumber)?.tcdNumber;
  const tcdDt     = prc.tcdDate   || mats.find(m => m.tcdDate)?.tcdDate || prc.updatedAt;

  const tcdAppr   = !!(prc.tcdApproved || mats.some(m => m.tcdApproved));
  const tcdApprDt = prc.tcdApprovedDate || mats.find(m => m.tcdApprovedDate)?.tcdApprovedDate || tcdDt;

  const rawPo     = prc.poNumber || mats.find(m => m.poNumber)?.poNumber;
  const poNo      = (rawPo && !String(rawPo).startsWith('pod-')) ? rawPo : '';
  const poDt      = prc.poDate   || mats.find(m => m.poDate)?.poDate || prc.updatedAt;

  const offersDone = !!(prc.offersReceived || mats.some(m => m.offersReceived) || tcdNo || tcdAppr || poNo);
  const offersDt   = prc.offersReceivedDate || mats.find(m => m.offersReceivedDate)?.offersReceivedDate || tcdDt || rfqDt;

  return [
    {
      key:   'imported',
      label: 'PRC Imported',
      done:  !!prc.createdAt,
      date:  prc.createdAt,
      user:  prc.importedBy || 'System',
      icon:  '📥'
    },
    {
      key:   'allocated',
      label: allocDone ? 'Allocated' : (allocMissing.length < 3 ? 'Allocation Incomplete' : 'Allocated'),
      done:  allocDone,
      date:  allocDt,
      user:  allocDone ? (buyerName || 'Allocated') : (allocMissing.length < 3 ? `Missing: ${allocMissing.join(', ')}` : 'Unassigned'),
      icon:  allocDone ? '📌' : (allocMissing.length < 3 ? '⚠️' : '📌')
    },
    {
      key:   'rfq',
      label: 'RFQ Generated',
      done:  !!rfqNo,
      date:  rfqDt,
      user:  prc.rfqBy || prc.updatedBy,
      icon:  '📨'
    },
    {
      key:   'offers',
      label: 'Offers Received',
      done:  offersDone,
      date:  offersDt,
      user:  prc.rfqBy,
      icon:  '📩'
    },
    {
      key:   'tcd',
      label: 'TCD Generated',
      done:  !!tcdNo,
      date:  tcdDt,
      user:  prc.tcdBy || prc.updatedBy || 'System',
      icon:  '📊'
    },
    {
      key:   'tcdApproved',
      label: 'TCD Approved',
      done:  tcdAppr,
      date:  tcdApprDt,
      user:  prc.tcdApprovedBy || prc.tcdBy,
      icon:  '✔️'
    },
    {
      key:   'po',
      label: 'PO Issued',
      done:  !!poNo,
      date:  poDt,
      user:  prc.poBy || prc.vendorName,
      icon:  '🛒'
    }
  ];
}

/**
 * Checks if a PRC or Material line item is inactive (Shortclosed or Closed with 0 pending quantity).
 * Rule: If PRC is shortclosed OR Material Line Item is closed & pending quantity is 0, returns true.
 * @param {Object} prc
 * @param {Object} material
 * @returns {boolean}
 */
export function isPRCOrMaterialInactive(prc, material) {
  const shortKeywords = ['short-close', 'short-closed', 'short close', 'short closed', 'shortclose', 'shortclosed'];
  
  // 1. Check parent PRC shortclose
  if (prc) {
    if (prc.isShortClosed === true || prc.shortClosed === true) return true;
    const prcS = String(prc.status || prc.prStatus || '').trim().toLowerCase();
    if (shortKeywords.includes(prcS)) return true;
  }

  // 2. Check Material Line Item closed & pending quantity is 0
  if (material) {
    if (material.isShortClosed === true || material.shortClosed === true) return true;
    const matSt = String(material.status || '').trim().toLowerCase();
    const matPr = String(material.prStatus || '').trim().toLowerCase();
    if (shortKeywords.includes(matSt) || shortKeywords.includes(matPr)) return true;

    const isClosed = material.isClosed === true || material.closed === true ||
                     matSt === 'closed' || matPr === 'closed' ||
                     (parseFloat(material.closedQty) || 0) > 0;

    const totalQty = parseFloat(material.quantity) || 0;
    const procQty  = parseFloat(material.processedQty) || 0;
    const clsQty   = parseFloat(material.closedQty) || 0;
    const pendQty  = (material.pendingQty !== undefined && material.pendingQty !== null && String(material.pendingQty).trim() !== '')
      ? parseFloat(material.pendingQty)
      : Math.max(0, totalQty - procQty - clsQty);

    if (isClosed && pendQty === 0) {
      return true;
    }
  }

  return false;
}

/**
 * Evaluates the effective status of an RFQ document.
 * Rule: If PRC is shortclosed OR Material Line Item is closed & pending quantity is 0 & RFQ for the same is created,
 * it shall be tagged as "Not Active" instead of "Active".
 * @param {Object} rfq
 * @param {Array}  prcs - Array of PRC records to resolve items
 * @returns {string} 'Closed' | 'Not Active' | 'Active' | ...
 */
export function getRFQStatus(rfq, prcs = []) {
  if (!rfq) return STATUS.PENDING;

  // Explicitly Closed RFQ or RFQ with TCD Number assigned
  const isClosed = !!(
    rfq.isClosed ||
    String(rfq.status || '').trim().toLowerCase() === 'closed' ||
    (rfq.tcdNumber && String(rfq.tcdNumber).trim() !== '') ||
    (Array.isArray(rfq.items) && rfq.items.length > 0 && rfq.items.some(i => i.tcdNumber && String(i.tcdNumber).trim() !== ''))
  );
  if (isClosed) return 'Closed';

  const rfqStatusRaw = String(rfq.status || '').trim().toLowerCase();
  const shortKeywords = ['short-close', 'short-closed', 'short close', 'short closed', 'shortclose', 'shortclosed', 'not active'];
  if (rfq.isShortClosed || shortKeywords.includes(rfqStatusRaw)) {
    return STATUS.NOT_ACTIVE;
  }

  const items = rfq.items || [];
  if (items.length > 0 && Array.isArray(prcs) && prcs.length > 0) {
    const allInactive = items.every(item => {
      const prc = prcs.find(p => p.id === item.prcId || p.prNumber === item.prNumber);
      const mat = prc?.materials?.find(m =>
        (item.materialId && m.id === item.materialId) ||
        (item.matCode && (m.matCode === item.matCode || m.materialCode === item.matCode)) ||
        (item.materialCode && (m.matCode === item.materialCode || m.materialCode === item.materialCode))
      );
      return isPRCOrMaterialInactive(prc, mat || item);
    });

    if (allInactive) {
      return STATUS.NOT_ACTIVE;
    }
  }

  return rfq.status || 'Active';
}

/**
 * Evaluates the effective status of an Allocation document.
 * Rule: If all items' parent PRCs are shortclosed OR material line items closed & pending quantity is 0,
 * tagged as "Not Active" instead of "Active".
 * @param {Object} alloc
 * @param {Array}  prcs
 * @returns {string}
 */
export function getAllocationStatus(alloc, prcs = []) {
  if (!alloc) return 'Active';

  const allocStatusRaw = String(alloc.status || '').trim().toLowerCase();
  const shortKeywords = ['short-close', 'short-closed', 'short close', 'short closed', 'shortclose', 'shortclosed', 'not active'];
  if (alloc.isShortClosed || shortKeywords.includes(allocStatusRaw)) {
    return STATUS.NOT_ACTIVE;
  }

  const items = alloc.items || [];
  if (items.length > 0 && Array.isArray(prcs) && prcs.length > 0) {
    const allInactive = items.every(item => {
      const prc = prcs.find(p => p.id === item.prcId || p.prNumber === item.prNumber);
      const mat = prc?.materials?.find(m =>
        (item.materialId && m.id === item.materialId) ||
        (item.matCode && (m.matCode === item.matCode || m.materialCode === item.matCode)) ||
        (item.materialCode && (m.matCode === item.materialCode || m.materialCode === item.materialCode))
      );
      return isPRCOrMaterialInactive(prc, mat || item);
    });

    if (allInactive) {
      return STATUS.NOT_ACTIVE;
    }
  }

  return alloc.status || 'Active';
}

/**
 * Computes stage-by-stage funnel progression and analyzes exact bottleneck/drop-off reasons between steps.
 * Transitions:
 * 1. Imported -> Allocated
 * 2. Allocated -> RFQ Issued
 * 3. RFQ Issued -> Offers In
 * 4. Offers In -> TCD Done
 * 5. TCD Done -> PO Issued
 *
 * @param {Array} prcs
 * @returns {Array} List of stage objects with counts, drop deltas, and categorized reasons
 */
function isPRCShortClosedCheck(p) {
  if (!p) return false;
  if (p.isShortClosed || p.shortClosed) return true;
  const s = String(p.status || '').trim().toLowerCase();
  return s.includes('short close') || s.includes('short-close') || s.includes('shortclosed') || s.includes('shortclose') || s.includes('not active');
}

export function getProcurementFunnelBreakdown(prcs = []) {
  const totalImported = prcs.length;

  // Stage 1 -> 2: Imported to Allocated
  const allocatedPRCs = prcs.filter(p => isPRCAllocationComplete(p) || p.allocationNumber || (p.materials || []).some(m => m.allocationNumber || (m.allocatedQty || 0) > 0));
  const notAllocatedPRCs = prcs.filter(p => !allocatedPRCs.includes(p));

  const s1ShortClosedPRCs = notAllocatedPRCs.filter(p => isPRCShortClosedCheck(p));
  const s1PendingPRCs = notAllocatedPRCs.filter(p => !s1ShortClosedPRCs.includes(p));

  const stage1Reasons = [];
  if (s1PendingPRCs.length > 0) {
    stage1Reasons.push({
      reasonKey: 'pending_allocation',
      label: 'Pending Buyer Allocation (Unassigned)',
      count: s1PendingPRCs.length,
      icon: '⏳',
      prcIds: s1PendingPRCs.map(p => p.id || p.prNumber),
      prcs: s1PendingPRCs
    });
  }
  if (s1ShortClosedPRCs.length > 0) {
    stage1Reasons.push({
      reasonKey: 'short_closed_pr',
      label: 'Short Closed / Dropped at PR Stage',
      count: s1ShortClosedPRCs.length,
      icon: '🚫',
      prcIds: s1ShortClosedPRCs.map(p => p.id || p.prNumber),
      prcs: s1ShortClosedPRCs
    });
  }

  // Stage 2 -> 3: Allocated to RFQ Issued
  const rfqPRCs = allocatedPRCs.filter(p => p.rfqNumber || (p.materials || []).some(m => m.rfqNumber));
  const notRfqPRCs = allocatedPRCs.filter(p => !rfqPRCs.includes(p));

  const s2ShortClosedPRCs = notRfqPRCs.filter(p => isPRCShortClosedCheck(p));
  const s2DirectPoPRCs = notRfqPRCs.filter(p => !s2ShortClosedPRCs.includes(p) && (p.poNumber || (p.materials || []).some(m => m.poNumber)));
  const s2PendingSourcingPRCs = notRfqPRCs.filter(p => !s2ShortClosedPRCs.includes(p) && !s2DirectPoPRCs.includes(p));

  const stage2Reasons = [];
  if (s2PendingSourcingPRCs.length > 0) {
    stage2Reasons.push({
      reasonKey: 'pending_rfq',
      label: 'Sourcing & RFQ Drafting in Progress',
      count: s2PendingSourcingPRCs.length,
      icon: '📝',
      prcIds: s2PendingSourcingPRCs.map(p => p.id || p.prNumber),
      prcs: s2PendingSourcingPRCs
    });
  }
  if (s2DirectPoPRCs.length > 0) {
    stage2Reasons.push({
      reasonKey: 'direct_po',
      label: 'Direct / Repeat Order (Bypassed RFQ)',
      count: s2DirectPoPRCs.length,
      icon: '⚡',
      prcIds: s2DirectPoPRCs.map(p => p.id || p.prNumber),
      prcs: s2DirectPoPRCs
    });
  }
  if (s2ShortClosedPRCs.length > 0) {
    stage2Reasons.push({
      reasonKey: 'short_closed_post_alloc',
      label: 'Short Closed Post-Allocation',
      count: s2ShortClosedPRCs.length,
      icon: '🚫',
      prcIds: s2ShortClosedPRCs.map(p => p.id || p.prNumber),
      prcs: s2ShortClosedPRCs
    });
  }

  // Stage 3 -> 4: RFQ Issued to Offers In
  const offersPRCs = rfqPRCs.filter(p => p.offersReceived || p.tcdNumber || p.tcdApproved || p.poNumber || (p.materials || []).some(m => m.offersReceived || m.tcdNumber || m.tcdApproved || m.poNumber));
  const notOffersPRCs = rfqPRCs.filter(p => !offersPRCs.includes(p));

  const s3AwaitingPRCs = notOffersPRCs.filter(p => {
    const age = calcAgeDays(p.rfqDate || p.updatedAt);
    return age <= 14;
  });
  const s3OverduePRCs = notOffersPRCs.filter(p => !s3AwaitingPRCs.includes(p));

  const stage3Reasons = [];
  if (s3AwaitingPRCs.length > 0) {
    stage3Reasons.push({
      reasonKey: 'awaiting_quotes',
      label: 'Awaiting Vendor Quotations (Active)',
      count: s3AwaitingPRCs.length,
      icon: '📬',
      prcIds: s3AwaitingPRCs.map(p => p.id || p.prNumber),
      prcs: s3AwaitingPRCs
    });
  }
  if (s3OverduePRCs.length > 0) {
    stage3Reasons.push({
      reasonKey: 'quotes_followup',
      label: 'Quotation Follow-up / Overdue / Clarification',
      count: s3OverduePRCs.length,
      icon: '⚠️',
      prcIds: s3OverduePRCs.map(p => p.id || p.prNumber),
      prcs: s3OverduePRCs
    });
  }

  // Stage 4 -> 5: Offers In to TCD Done
  const tcdPRCs = offersPRCs.filter(p => p.tcdNumber || p.tcdApproved || p.poNumber || (p.materials || []).some(m => m.tcdNumber || m.tcdApproved || m.poNumber));
  const notTcdPRCs = offersPRCs.filter(p => !tcdPRCs.includes(p));

  const s4CommercialEvalPRCs = notTcdPRCs.filter(p => (p.offersReceived || (p.materials || []).some(m => m.offersReceived)) && !p.tcdNumber && !(p.materials || []).some(m => m.tcdNumber));
  const s4ApprovalPendingPRCs = notTcdPRCs.filter(p => !s4CommercialEvalPRCs.includes(p));

  const stage4Reasons = [];
  if (s4CommercialEvalPRCs.length > 0) {
    stage4Reasons.push({
      reasonKey: 'commercial_eval',
      label: 'Techno-Commercial Evaluation & Negotiation',
      count: s4CommercialEvalPRCs.length,
      icon: '⚖️',
      prcIds: s4CommercialEvalPRCs.map(p => p.id || p.prNumber),
      prcs: s4CommercialEvalPRCs
    });
  }
  if (s4ApprovalPendingPRCs.length > 0) {
    stage4Reasons.push({
      reasonKey: 'tcd_approval_pending',
      label: 'TCD Approval Pending from Authority',
      count: s4ApprovalPendingPRCs.length,
      icon: '✍️',
      prcIds: s4ApprovalPendingPRCs.map(p => p.id || p.prNumber),
      prcs: s4ApprovalPendingPRCs
    });
  }
  if (!stage4Reasons.length && notTcdPRCs.length > 0) {
    stage4Reasons.push({
      reasonKey: 'tcd_in_progress',
      label: 'Commercial Discussion in Progress',
      count: notTcdPRCs.length,
      icon: '💬',
      prcIds: notTcdPRCs.map(p => p.id || p.prNumber),
      prcs: notTcdPRCs
    });
  }

  // Stage 5 -> 6: TCD Done to PO Issued
  const poPRCs = tcdPRCs.filter(p => p.poNumber || (p.materials || []).some(m => m.poNumber));
  const notPoPRCs = tcdPRCs.filter(p => !poPRCs.includes(p));

  const s5PoDraftingPRCs = notPoPRCs.filter(p => p.tcdApproved || (p.materials || []).some(m => m.tcdApproved) || p.tcdNumber || (p.materials || []).some(m => m.tcdNumber));
  const s5BudgetPendingPRCs = notPoPRCs.filter(p => !s5PoDraftingPRCs.includes(p));

  const stage5Reasons = [];
  if (s5PoDraftingPRCs.length > 0) {
    stage5Reasons.push({
      reasonKey: 'po_creation_pending',
      label: 'PO Creation & SAP Approval Pending',
      count: s5PoDraftingPRCs.length,
      icon: '🛒',
      prcIds: s5PoDraftingPRCs.map(p => p.id || p.prNumber),
      prcs: s5PoDraftingPRCs
    });
  }
  if (s5BudgetPendingPRCs.length > 0) {
    stage5Reasons.push({
      reasonKey: 'budget_release_pending',
      label: 'Vendor Acceptance / Budget Release Pending',
      count: s5BudgetPendingPRCs.length,
      icon: '🏦',
      prcIds: s5BudgetPendingPRCs.map(p => p.id || p.prNumber),
      prcs: s5BudgetPendingPRCs
    });
  }
  if (!stage5Reasons.length && notPoPRCs.length > 0) {
    stage5Reasons.push({
      reasonKey: 'po_in_process',
      label: 'PO Processing & Issuance in Progress',
      count: notPoPRCs.length,
      icon: '⏳',
      prcIds: notPoPRCs.map(p => p.id || p.prNumber),
      prcs: notPoPRCs
    });
  }

  return [
    {
      stage: 'Imported',
      label: '1. Imported',
      count: totalImported,
      color: '#3b82f6',
      dropCount: 0,
      dropReasons: []
    },
    {
      stage: 'Allocated',
      label: '2. Allocated',
      count: allocatedPRCs.length,
      color: '#06b6d4',
      dropCount: totalImported - allocatedPRCs.length,
      dropFrom: 'Imported',
      dropReasons: stage1Reasons
    },
    {
      stage: 'RFQ Issued',
      label: '3. RFQ Issued',
      count: rfqPRCs.length,
      color: '#8b5cf6',
      dropCount: allocatedPRCs.length - rfqPRCs.length,
      dropFrom: 'Allocated',
      dropReasons: stage2Reasons
    },
    {
      stage: 'Offers In',
      label: '4. Offers In',
      count: offersPRCs.length,
      color: '#f59e0b',
      dropCount: rfqPRCs.length - offersPRCs.length,
      dropFrom: 'RFQ Issued',
      dropReasons: stage3Reasons
    },
    {
      stage: 'TCD Done',
      label: '5. TCD Done',
      count: tcdPRCs.length,
      color: '#10b981',
      dropCount: offersPRCs.length - tcdPRCs.length,
      dropFrom: 'Offers In',
      dropReasons: stage4Reasons
    },
    {
      stage: 'PO Issued',
      label: '6. PO Issued',
      count: poPRCs.length,
      color: '#059669',
      dropCount: tcdPRCs.length - poPRCs.length,
      dropFrom: 'TCD Done',
      dropReasons: stage5Reasons
    }
  ];
}



