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
export function calculateStatus(prc, materials = []) {
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

  // 6. Awaiting Offer — RFQ floated but no quotations received
  if (prc.rfqNumber && !prc.offersReceived) return STATUS.AWAITING_OFFER;

  // 6.5. TCD Generated or Approved or PO issued -> Process Completed
  if (
    prc.tcdNumber ||
    prc.tcdApproved ||
    prc.poNumber ||
    prStatus === 'process completed' ||
    (materials.length > 0 && materials.some(m => m.tcdNumber || m.tcdApproved || m.poNumber))
  ) return STATUS.COMPLETED;

  // 7 & 8: Material-level PO analysis
  if (materials.length > 0) {
    const total    = materials.length;
    const completed = materials.filter(m =>
      m.poNumber && m.poDate && m.vendor
    ).length;

    if (completed > 0 && completed < total) return STATUS.PARTLY_COMPLETED;
    if (completed === total)               return STATUS.COMPLETED;
  } else {
    // No materials — check top-level PO fields
    if (prc.poNumber && prc.poDate && prc.vendorName) return STATUS.COMPLETED;
  }

  if (prStatus === 'authorised' || prStatus === 'approved') return STATUS.AUTHORISED;

  // 9. Default
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

  // TCD Created/Approved or PO issued -> Process Completed
  if (material.tcdNumber || material.tcdApproved || material.poNumber) return STATUS.COMPLETED;

  // Fully completed if processed + closed equals or exceeds requested quantity, or PO is fully issued
  if (totalQty > 0 && (procQty + clsQty) >= totalQty) return STATUS.COMPLETED;
  if (material.poNumber && material.poDate && (material.vendor || material.vendorName) && pendQty === 0) return STATUS.COMPLETED;

  // Partial completed if partial quantity has been processed with pending balance, or TCD approved
  if (procQty > 0 && pendQty > 0) return STATUS.PARTLY_COMPLETED;
  if (material.poNumber && material.poDate && pendQty > 0) return STATUS.PARTLY_COMPLETED;
  if (material.tcdApproved || (material.tcdNumber && material.tcdDate)) return STATUS.PARTLY_COMPLETED;

  if (material.offersReceived || (material.rfqNumber && material.rfqDate)) return STATUS.AWAITING_OFFER;
  if (material.allocationNumber && material.allocationDate) return STATUS.PENDING;
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
  const start = new Date(startDate);
  const end   = endDate ? new Date(endDate) : new Date();
  if (isNaN(start.getTime())) return 0;
  if (isNaN(end.getTime())) return 0;
  const diffDays = Math.floor((end - start) / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
}

/**
 * Calculates the exact PRC age in days up to completion / partial completion date.
 * @param {Object} prc
 * @returns {number}
 */
export function getPRCAge(prc) {
  if (!prc) return 0;
  const start = prc.allocationDate || prc.prDate || prc.createdAt;
  let end = null;

  if (prc.status === STATUS.COMPLETED) {
    end = prc.poDate || prc.completedDate || prc.updatedAt;
  } else if (prc.status === STATUS.PARTLY_COMPLETED) {
    end = prc.poDate || prc.tcdDate || prc.updatedAt;
  }

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

  if ([STATUS.SHORT_CLOSED, STATUS.WRONG_PRC, STATUS.PR_NOT_APPROVED, STATUS.SYSTEM_ISSUE].includes(status)) return null;
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
 * Returns timeline steps with completion state for a PRC.
 */
export function buildTimeline(prc) {
  if (!prc) return [];
  const mats = prc.materials || [];

  const allocNo   = prc.allocationNumber || mats.find(m => m.allocationNumber)?.allocationNumber;
  const allocDt   = prc.allocationDate   || mats.find(m => m.allocationDate)?.allocationDate;

  const rfqNo     = prc.rfqNumber || mats.find(m => m.rfqNumber)?.rfqNumber;
  const rfqDt     = prc.rfqDate   || mats.find(m => m.rfqDate)?.rfqDate;

  const tcdNo     = prc.tcdNumber || mats.find(m => m.tcdNumber)?.tcdNumber;
  const tcdDt     = prc.tcdDate   || mats.find(m => m.tcdDate)?.tcdDate || prc.updatedAt;

  const tcdAppr   = !!(prc.tcdApproved || mats.some(m => m.tcdApproved));
  const tcdApprDt = prc.tcdApprovedDate || mats.find(m => m.tcdApprovedDate)?.tcdApprovedDate || tcdDt;

  const poNo      = prc.poNumber || mats.find(m => m.poNumber)?.poNumber;
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
      label: 'Allocated',
      done:  !!allocNo,
      date:  allocDt,
      user:  prc.allocatedBy || prc.buyerName,
      icon:  '📌'
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

