// =========================================================
// EXCEL IMPORT ENGINE (SheetJS-based)
// =========================================================
import { toast, clone, fmtDateTime } from './utils.js';
import { updatePRC, getState, setState, addAuditLog, createAllocation, pushLocalDataToFirestore } from './state.js';
import { calculateStatus, calculateMaterialStatus, buildStatusSummary } from './status-engine.js';

// ═══════════════════════════════════════════════════════════
// IMPORT SNAPSHOT & CALL BACK (ROLLBACK) ENGINE
// ═══════════════════════════════════════════════════════════
const IMPORT_HISTORY_STORAGE_KEY = 'PRC_EXCEL_IMPORT_HISTORY';
const MAX_SNAPSHOTS = 20;
let _lastImportSnapshotId = null;

/** Retrieve last created import snapshot ID */
export function getLastImportSnapshotId() {
  return _lastImportSnapshotId;
}

/** Retrieve import history list from localStorage and state */
export function getImportHistory() {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(IMPORT_HISTORY_STORAGE_KEY);
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) return list;
      }
    }
  } catch (e) {
    console.warn('Failed to load import history:', e);
  }
  return getState().importHistory || [];
}

/** Save pre-import snapshot before applying any Excel upload modifications */
export function createImportSnapshot(type, fileName, summary) {
  const state = getState();
  const snapshotId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const snapshot = {
    id: snapshotId,
    timestamp: new Date().toISOString(),
    type: type || 'Excel Import',
    fileName: fileName || 'Uploaded Spreadsheet',
    summary: summary || 'Import batch',
    user: state.currentUser?.name || 'User',
    stateSnapshot: {
      prcs: clone(state.prcs || []),
      allocations: clone(state.allocations || []),
      rfqs: clone(state.rfqs || []),
      tcds: clone(state.tcds || []),
      pods: clone(state.pods || []),
      statusSummary: clone(state.statusSummary || {})
    }
  };

  try {
    const history = getImportHistory();
    const updatedHistory = [snapshot, ...history].slice(0, MAX_SNAPSHOTS);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(IMPORT_HISTORY_STORAGE_KEY, JSON.stringify(updatedHistory));
    }
    setState({ importHistory: updatedHistory });
  } catch (e) {
    console.warn('Failed to save import snapshot:', e);
  }

  _lastImportSnapshotId = snapshotId;
  return snapshotId;
}

/** Rollback / Call Back a specific import snapshot */
export function rollbackImportSnapshot(snapshotId) {
  const history = getImportHistory();
  const snapshot = history.find(s => s.id === snapshotId);

  if (!snapshot || !snapshot.stateSnapshot) {
    return { success: false, reason: 'Import snapshot not found or corrupted.' };
  }

  const { prcs, allocations, rfqs, tcds, pods, statusSummary } = snapshot.stateSnapshot;

  // Commit restored state
  setState({
    prcs: clone(prcs || []),
    allocations: clone(allocations || []),
    rfqs: clone(rfqs || []),
    tcds: clone(tcds || []),
    pods: clone(pods || []),
    statusSummary: statusSummary || (buildStatusSummary ? buildStatusSummary(prcs || []) : {})
  });

  // Remove reverted snapshot from history
  const updatedHistory = history.filter(s => s.id !== snapshotId);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(IMPORT_HISTORY_STORAGE_KEY, JSON.stringify(updatedHistory));
    }
    setState({ importHistory: updatedHistory });
  } catch (e) {}

  if (_lastImportSnapshotId === snapshotId) {
    _lastImportSnapshotId = updatedHistory[0]?.id || null;
  }

  addAuditLog({
    action: 'rollback_excel_import',
    collection: 'PRCs',
    docId: snapshotId,
    changes: {
      summary: `Called back / Reverted Excel upload: ${snapshot.type} (${snapshot.fileName}) from ${snapshot.timestamp}. Database state restored.`
    }
  });

  // Direct sync to Cloud / Firestore
  try {
    pushLocalDataToFirestore();
  } catch (syncErr) {
    console.warn('Firestore push note after rollback:', syncErr);
  }

  return {
    success: true,
    snapshot,
    prcCount: (prcs || []).length
  };
}

/** Clear all import history */
export function clearImportHistory() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(IMPORT_HISTORY_STORAGE_KEY);
    }
    setState({ importHistory: [] });
    _lastImportSnapshotId = null;
  } catch (e) {}
}

/** Render HTML table of recent Excel import batches with Call Back (Revert) actions */
export function renderImportHistoryTable() {
  const history = getImportHistory();

  if (!history || !history.length) {
    return `
      <div style="padding:24px;text-align:center;color:var(--color-text-secondary);font-size:13px">
        <span>ℹ️ No Excel upload restore points found. Restore points are automatically created whenever an Excel file is imported.</span>
      </div>
    `;
  }

  const rows = history.map((item, idx) => {
    let typeBadgeClass = 'badge-secondary';
    if (item.type.includes('Requisition')) typeBadgeClass = 'badge-primary';
    else if (item.type.includes('Allocation')) typeBadgeClass = 'badge-warning';
    else if (item.type.includes('PO Report')) typeBadgeClass = 'badge-success';

    return `
      <tr>
        <td><strong>${idx + 1}</strong></td>
        <td><span class="font-mono" style="font-size:11px">${fmtDateTime(item.timestamp)}</span></td>
        <td><span class="badge ${typeBadgeClass}">${item.type}</span></td>
        <td><span class="font-bold font-mono" style="color:var(--color-primary)">${item.fileName || 'Spreadsheet.xlsx'}</span></td>
        <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis" title="${item.summary}">${item.summary}</td>
        <td>${item.user || 'User'}</td>
        <td style="text-align:right">
          <button class="btn btn-secondary btn-xs" onclick="handleRollbackImport('${item.id}')" style="color:var(--color-danger);border-color:rgba(239,68,68,0.3);font-weight:600" title="Call back / Revert this Excel upload">
            <span>⏪</span> Call Back (Revert)
          </button>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div class="table-wrapper" style="max-height:300px;overflow:auto;border:1px solid var(--color-border);border-radius:8px">
      <table class="data-table" style="font-size:12px;white-space:nowrap">
        <thead>
          <tr>
            <th>#</th>
            <th>Uploaded At</th>
            <th>Import Type</th>
            <th>File Name</th>
            <th>Summary / Records</th>
            <th>User</th>
            <th style="text-align:right">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}


// Expected columns in the import Excel file (45 Enterprise Columns)
export const ALL_IMPORT_COLUMNS = [
  'JOB CODE',
  'JOB DESC',
  'FROM JOB CODE',
  'WAREHOUSE CODE',
  'WAREHOUSE DESC',
  'PR NUMBER',
  'PR DATE',
  'PR TYPE',
  'SERIAL NUMBER',
  'MATERIAL CODE',
  'MATERIAL DESC',
  'UOM',
  'CP CODE',
  'CP DESC',
  'WBS CODE',
  'WBS DESC',
  'QUANTITY',
  'SUGGESTED RATE',
  'VALUE',
  'PENDING QTY',
  'CURRENCY DESC',
  'BUDGET REFERENCE',
  'DELIVERY START DATE',
  'DELIVERY END DATE',
  'DRAWING NUMBER',
  'REMARKS',
  'PR STATUS',
  'CLOSED QTY',
  'CLOSED BY',
  'CLOSED ON',
  'CREATED BY',
  'CREATED ON',
  'AUTHORIZED BY',
  'AUTHORIZED ON',
  'ALLOCATION NUMBER',
  'ALLOCATION DATE',
  'BUYER NAME',
  'CATEGORY DESC',
  'MATERIAL GROUP CODE',
  'MATERIAL GROUP DESCRIPTION',
  'MATERIAL CLASS',
  'IC DESC',
  'BU',
  'SBU',
  'PR GR NUMBER'
];

export const IMPORT_COLUMNS = {
  required: ['PR NUMBER', 'MATERIAL CODE', 'MATERIAL DESC', 'UOM', 'QUANTITY'],
  optional: ALL_IMPORT_COLUMNS.filter(c => !['PR NUMBER', 'MATERIAL CODE', 'MATERIAL DESC', 'UOM', 'QUANTITY'].includes(c))
};

// Aliases mapping for flexible header matching (case-insensitive & trimmed)
const ALIAS_MAP = {
  'PR NUMBER': ['PR NUMBER', 'PR NUMBER', 'PR NO', 'PR_NUMBER', 'PRNUMBER'],
  'MATERIAL CODE': ['MATERIAL CODE', 'MATERIAL CODE', 'MAT CODE', 'MATERIAL_CODE', 'MAT_CODE', 'ITEM CODE'],
  'MATERIAL DESC': ['MATERIAL DESC', 'MATERIAL DESCRIPTION', 'DESCRIPTION', 'MAT DESC', 'MATERIAL_DESC', 'ITEM DESC'],
  'UOM': ['UOM', 'UNIT', 'UNIT OF MEASURE'],
  'QUANTITY': ['QUANTITY', 'QTY', 'REQ QTY', 'REQUESTED QTY'],
  'JOB CODE': ['JOB CODE', 'JOB', 'JOB_CODE', 'PROJECT CODE'],
  'JOB DESC': ['JOB DESC', 'JOB DESCRIPTION', 'JOB_DESC', 'PROJECT DESC'],
  'FROM JOB CODE': ['FROM JOB CODE', 'FROM JOB', 'FROM_JOB_CODE', 'SOURCE JOB'],
  'WAREHOUSE CODE': ['WAREHOUSE CODE', 'WAREHOUSE', 'WH CODE', 'PLANT CODE'],
  'WAREHOUSE DESC': ['WAREHOUSE DESC', 'WAREHOUSE NAME', 'WH DESC', 'PLANT DESC'],
  'PR DATE': ['PR DATE', 'REQUISITION DATE', 'PR_DATE'],
  'PR TYPE': ['PR TYPE', 'REQUISITION TYPE', 'PR_TYPE'],
  'SERIAL NUMBER': ['SERIAL NUMBER', 'SERIAL NO', 'SL NO', 'LINE NO', 'ITEM NO'],
  'CP CODE': ['CP CODE', 'COST PACKAGE CODE', 'PACKAGE CODE'],
  'CP DESC': ['CP DESC', 'COST PACKAGE DESC', 'PACKAGE DESC'],
  'WBS CODE': ['WBS CODE', 'WBS ELEMENT', 'WBS_CODE'],
  'WBS DESC': ['WBS DESC', 'WBS DESCRIPTION', 'WBS_DESC'],
  'SUGGESTED RATE': ['SUGGESTED RATE', 'SUGGESTED PRICE', 'UNIT RATE', 'ESTIMATED RATE', 'RATE'],
  'VALUE': ['VALUE', 'TOTAL VALUE', 'AMOUNT', 'ESTIMATED VALUE'],
  'PENDING QTY': ['PENDING QTY', 'PENDING QUANTITY', 'BALANCE QTY'],
  'CURRENCY DESC': ['CURRENCY DESC', 'CURRENCY', 'CURRENCY CODE'],
  'BUDGET REFERENCE': ['BUDGET REFERENCE', 'BUDGET REF', 'BUDGET CODE'],
  'DELIVERY START DATE': ['DELIVERY START DATE', 'DELIVERY START', 'START DATE'],
  'DELIVERY END DATE': ['DELIVERY END DATE', 'DELIVERY DATE', 'REQUIRED DATE', 'END DATE'],
  'DRAWING NUMBER': ['DRAWING NUMBER', 'DRAWING NO', 'DRAWING REF', 'DRG NO'],
  'REMARKS': ['REMARKS', 'NOTE', 'NOTES', 'COMMENTS'],
  'PR STATUS': ['PR STATUS', 'STATUS', 'REQUISITION STATUS'],
  'CLOSED QTY': ['CLOSED QTY', 'CLOSED QUANTITY'],
  'CLOSED BY': ['CLOSED BY'],
  'CLOSED ON': ['CLOSED ON', 'CLOSED DATE'],
  'CREATED BY': ['CREATED BY', 'REQUESTED BY', 'REQUISITIONER', 'PREPARED BY'],
  'CREATED ON': ['CREATED ON', 'REQUEST DATE', 'CREATION DATE'],
  'AUTHORIZED BY': ['AUTHORIZED BY', 'APPROVED BY', 'APPROVER'],
  'AUTHORIZED ON': ['AUTHORIZED ON', 'APPROVED ON', 'APPROVAL DATE'],
  'ALLOCATION NUMBER': ['ALLOCATION NUMBER', 'ALLOCATION NO', 'ALLOCATION CODE'],
  'ALLOCATION DATE': ['ALLOCATION DATE', 'ALLOCATED ON'],
  'BUYER NAME': ['BUYER NAME', 'BUYER', 'PURCHASER', 'ALLOCATED TO'],
  'CATEGORY DESC': ['CATEGORY DESC', 'CATEGORY', 'CATEGORY DESCRIPTION'],
  'MATERIAL GROUP CODE': ['MATERIAL GROUP CODE', 'MAT GROUP CODE', 'MATERIAL GROUP'],
  'MATERIAL GROUP DESCRIPTION': ['MATERIAL GROUP DESCRIPTION', 'MATERIAL GROUP DESC', 'MAT GROUP DESC'],
  'MATERIAL CLASS': ['MATERIAL CLASS', 'MAT CLASS', 'CLASS'],
  'IC DESC': ['IC DESC', 'IC', 'INDEPENDENT COMPANY'],
  'BU': ['BU', 'BUSINESS UNIT'],
  'SBU': ['SBU', 'STRATEGIC BUSINESS UNIT'],
  'PR GR NUMBER': ['PR GR NUMBER', 'PR GR NO', 'GR NUMBER']
};

function stripKey(k) {
  return String(k || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/** Normalize row keys to canonical column names */
export function normalizeRow(rawRow) {
  const norm = {};
  const rawKeys = Object.keys(rawRow);

  // Preserve original properties
  rawKeys.forEach(k => {
    norm[k] = rawRow[k];
  });

  ALL_IMPORT_COLUMNS.forEach(col => {
    if (norm[col] === undefined) norm[col] = '';
    const aliases = ALIAS_MAP[col] || [col];
    const strippedCol = stripKey(col);
    const strippedAliases = aliases.map(stripKey);

    for (const key of rawKeys) {
      const strippedKey = stripKey(key);
      if (strippedKey === strippedCol || strippedAliases.includes(strippedKey)) {
        norm[col] = rawRow[key];
        break;
      }
    }
  });

  // Smart fallbacks to ensure smooth import execution
  if (!norm['UOM'] || String(norm['UOM']).trim() === '') norm['UOM'] = 'EA';
  if (!norm['MATERIAL CODE'] || String(norm['MATERIAL CODE']).trim() === '') {
    norm['MATERIAL CODE'] = norm['SERIAL NUMBER'] ? `MAT-${norm['SERIAL NUMBER']}` : 'MAT-ITEM';
  }
  if (!norm['QUANTITY'] || isNaN(parseFloat(norm['QUANTITY'])) || parseFloat(norm['QUANTITY']) <= 0) {
    norm['QUANTITY'] = 1;
  }
  if (!norm['MATERIAL DESC'] && norm['MATERIAL CODE']) {
    norm['MATERIAL DESC'] = `Material ${norm['MATERIAL CODE']}`;
  }

  return norm;
}

/** Parse an uploaded Excel file → array of raw rows */
export async function parseExcelFile(file) {
  return new Promise((resolve, reject) => {
    if (!window.XLSX) {
      reject(new Error('SheetJS library not loaded. Please refresh the page.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array', cellDates: true });
        if (!wb.SheetNames || !wb.SheetNames.length) {
          reject(new Error('Excel file contains no worksheets.'));
          return;
        }
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { raw: false, defval: '' });
        resolve(rows);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsArrayBuffer(file);
  });
}

/** Validate rows, returning { valid, errors, cleanRows } */
export function validateRows(rows) {
  const errors = [];
  const seen   = new Set();
  const normalizedRows = rows.map(r => normalizeRow(r));

  normalizedRows.forEach((row, idx) => {
    const rowNum = idx + 2; // 1-indexed + header
    const rowErrors = [];

    const prNumber = String(row['PR NUMBER'] || '').trim();
    if (!prNumber) {
      rowErrors.push('"PR NUMBER" is required');
    }

    const matCode = String(row['MATERIAL CODE'] || `MAT-${idx+1}`).trim();
    const serial  = String(row['SERIAL NUMBER'] || idx+1).trim();

    if (prNumber && matCode) {
      const key = `${prNumber}::${matCode}::${serial}`;
      if (seen.has(key)) {
        rowErrors.push(`Duplicate entry in file: PR ${prNumber} + Material ${matCode}`);
      } else {
        seen.add(key);
      }
    }

    if (rowErrors.length) {
      errors.push({ row: rowNum, data: row, errors: rowErrors });
    }
  });

  const validRows = normalizedRows.filter((_, idx) => !errors.find(e => e.row === idx + 2));

  return {
    valid: errors.length === 0,
    errors,
    cleanRows: validRows.length > 0 ? validRows : normalizedRows
  };
}

/** Merge import rows into state — skips existing PRCs to prevent duplicates and overwrites */
export function mergeImport(rows, fileName = 'Requisitions_Import.xlsx') {
  const state     = getState();
  const existing  = state.prcs || [];
  const results   = { new: 0, skipped: 0, skippedPRCs: [], duplicateRows: 0, snapshotId: null };

  // Create pre-import snapshot for Call Back / Rollback
  const snapshotId = createImportSnapshot(
    'Enterprise Requisitions (45 Columns)',
    fileName,
    `Import batch with ${rows.length} rows processed.`
  );
  results.snapshotId = snapshotId;

  const existingPRCSet = new Set(existing.map(p => String(p.prNumber || '').trim().toUpperCase()));

  const grouped = {};
  rows.forEach(row => {
    const pr = String(row['PR NUMBER'] || '').trim();
    if (!pr) return;
    if (!grouped[pr]) grouped[pr] = [];
    grouped[pr].push(row);
  });

  const newPRCsToAdd = [];

  Object.entries(grouped).forEach(([prNumber, matRows]) => {
    const prUpper = prNumber.toUpperCase();

    // If PRC already exists in the system, do NOT overwrite the PRC header or duplicate materials.
    // Instead: if imported rows for this PRC contain allocation details, create/merge Allocation documents
    // Otherwise mark the existing PRC as Authorised so it appears under 'Authorised Pending PRCs'.
    if (existingPRCSet.has(prUpper)) {
      const existingPrc = existing.find(p => String(p.prNumber || '').trim().toUpperCase() === prUpper);
      if (!existingPrc) {
        results.skipped++;
        results.skippedPRCs.push(prNumber);
        return;
      }

      // Collect allocation groups from the imported rows for this PRC
      const allocGroups = {};
      let anyAllocFound = false;

      matRows.forEach((row, idx) => {
        const matCode = String(row['MATERIAL CODE'] || '').trim() || `MAT-${idx + 1}`;
        const serialNo = String(row['SERIAL NUMBER'] || idx + 1).trim();
        const matId = `${prNumber}-${matCode}-${serialNo}`;
        const allocNum = String(row['ALLOCATION NUMBER'] || '').trim();
        const allocDate = String(row['ALLOCATION DATE'] || '').trim();
        const buyerName = String(row['BUYER NAME'] || '').trim();

        if (allocNum && allocDate && buyerName) {
          anyAllocFound = true;
          if (!allocGroups[allocNum]) allocGroups[allocNum] = { allocationNumber: allocNum, allocationDate: allocDate, buyerName, items: [] };

          // Only add allocation item if material exists in the existing PRC
          const matExists = (existingPrc.materials || []).some(m => m.id === matId || (m.matCode === matCode && String(m.serialNumber || '') === String(serialNo)));
          if (matExists) {
            allocGroups[allocNum].items.push({
              prcId: existingPrc.id,
              materialId: matId,
              quantity: parseFloat(row['QUANTITY']) || 0,
              matCode,
              description: String(row['MATERIAL DESC'] || '').trim(),
              unit: String(row['UOM'] || '').trim(),
              prNumber: prNumber
            });
          }
        }
      });

      try {
        const stateNow = getState();
        const existingAllocNumbers = new Set((stateNow.allocations || []).map(a => a.allocationNumber));

        Object.values(allocGroups).forEach(alloc => {
          if (!alloc.items.length) return;
          if (existingAllocNumbers.has(alloc.allocationNumber)) {
            // merge into existing allocation
            const allocations = [...(stateNow.allocations || [])];
            const idx = allocations.findIndex(a => a.allocationNumber === alloc.allocationNumber);
            if (idx === -1) return;
            const existing = { ...allocations[idx], items: [...(allocations[idx].items || [])] };
            const keySet = new Set(existing.items.map(i => `${i.prcId}::${i.materialId}`));
            alloc.items.forEach(it => {
              const key = `${it.prcId}::${it.materialId}`;
              if (!keySet.has(key)) {
                existing.items.push(it);
                keySet.add(key);
              }
            });
            allocations[idx] = existing;

            // Cascade allocation fields to PRC materials
            const prcs = [...(stateNow.prcs || [])];
            const affectedPrcIds = new Set(existing.items.map(i => i.prcId));
            affectedPrcIds.forEach(prcId => {
              const prcIdx = prcs.findIndex(p => p.id === prcId);
              if (prcIdx === -1) return;
              const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };
              existing.items.filter(i => i.prcId === prcId).forEach(item => {
                const matIdx = prc.materials.findIndex(m => m.id === item.materialId);
                if (matIdx === -1) return;
                prc.materials[matIdx] = {
                  ...prc.materials[matIdx],
                  allocationNumber: existing.allocationNumber,
                  allocationDate: existing.allocationDate,
                  buyerName: existing.buyerName,
                  allocatedBy: existing.buyerName
                };
                prc.materials[matIdx].status = calculateMaterialStatus(prc.materials[matIdx]);
              });
              if (!prc.allocationNumber || prc.allocationNumber === existing.allocationNumber) {
                prc.allocationNumber = existing.allocationNumber;
                prc.allocationDate = existing.allocationDate;
                prc.buyerName = existing.buyerName;
                prc.allocatedBy = existing.buyerName;
              }
              prc.status = calculateStatus(prc, prc.materials);
              prc.updatedAt = new Date().toISOString();
              prcs[prcIdx] = prc;
            });

            setState({ allocations, prcs, statusSummary: buildStatusSummary(prcs) });
          } else {
            // create new allocation
            createAllocation({ allocationNumber: alloc.allocationNumber, allocationDate: alloc.allocationDate, buyerName: alloc.buyerName, items: alloc.items });
          }
        });

        // If no allocations were found in the imported rows, mark PRC as Authorised so it appears under pending allocations
        if (!Object.keys(allocGroups).length) {
          const prcs = [...(stateNow.prcs || [])];
          const prcIdx = prcs.findIndex(p => p.id === existingPrc.id);
          if (prcIdx !== -1) {
            const prc = { ...prcs[prcIdx] };
            prc.prStatus = prc.prStatus || 'Authorised';
            prc.updatedAt = new Date().toISOString();
            prc.status = calculateStatus(prc, prc.materials || []);
            prcs[prcIdx] = prc;
            setState({ prcs, statusSummary: buildStatusSummary(prcs) });
          }
        }
      } catch (err) {
        console.error('Failed to process imported rows for existing PRC:', err);
      }

      results.skipped++;
      results.skippedPRCs.push(prNumber);
      return;
    }

    const firstRow = matRows[0];
    const seenMatKeys = new Set();
    const materials = [];

    matRows.forEach((row, idx) => {
      const matCode = String(row['MATERIAL CODE'] || '').trim() || `MAT-${idx + 1}`;
      const serialNo = String(row['SERIAL NUMBER'] || idx + 1).trim();
      const matKey = `${matCode}::${serialNo}`;

      if (seenMatKeys.has(matKey)) {
        results.duplicateRows++;
        return; // Avoid duplicate line items within the same PRC in the file
      }
      seenMatKeys.add(matKey);

      const matId = `${prNumber}-${matCode}-${serialNo}`;
      const qty = parseFloat(row['QUANTITY']) || 1;
      const rate = parseFloat(row['SUGGESTED RATE']) || 0;
      const val = parseFloat(row['VALUE']) || (qty * rate);
      const procQty = parseFloat(row['PROCESSED QTY']) || 0;
      const clsQty  = parseFloat(row['CLOSED QTY']) || 0;
      const pendQty = Math.max(0, qty - procQty - clsQty);

      const matObj = {
        id:                     matId,
        serialNumber:           serialNo,
        matCode:                matCode,
        description:            String(row['MATERIAL DESC'] || 'Material ' + matCode).trim(),
        unit:                   String(row['UOM'] || 'EA').trim(),
        quantity:               qty,
        processedQty:           procQty,
        suggestedRate:          rate,
        value:                  val,
        pendingQty:             pendQty,
        closedQty:              clsQty,
        currencyDesc:           String(row['CURRENCY DESC'] || 'KWD').trim(),
        warehouseCode:          String(row['WAREHOUSE CODE'] || '').trim(),
        warehouseDesc:          String(row['WAREHOUSE DESC'] || '').trim(),
        warehouse:              String(row['WAREHOUSE DESC'] || row['WAREHOUSE CODE'] || '').trim(),
        deliveryStartDate:      String(row['DELIVERY START DATE'] || '').trim(),
        deliveryEndDate:        String(row['DELIVERY END DATE'] || '').trim(),
        drawingNumber:          String(row['DRAWING NUMBER'] || '').trim(),
        materialGroupCode:      String(row['MATERIAL GROUP CODE'] || '').trim(),
        materialGroupDesc:      String(row['MATERIAL GROUP DESCRIPTION'] || '').trim(),
        materialClass:          String(row['MATERIAL CLASS'] || '').trim(),
        cpCode:                 String(row['CP CODE'] || '').trim(),
        cpDesc:                 String(row['CP DESC'] || '').trim(),
        wbsCode:                String(row['WBS CODE'] || '').trim(),
        wbsDesc:                String(row['WBS DESC'] || '').trim(),
        remarks:                String(row['REMARKS'] || '').trim(),

        // Material-level workflow fields
        allocationNumber:       String(row['ALLOCATION NUMBER'] || '').trim(),
        allocationDate:         String(row['ALLOCATION DATE'] || '').trim(),
        buyerName:              String(row['BUYER NAME'] || '').trim(),
        allocatedBy:            String(row['BUYER NAME'] || '').trim(),
        rfqNumber:              '',
        rfqDate:                '',
        offersReceived:         false,
        tcdNumber:              '',
        tcdDate:                '',
        tcdApproved:            false,
        poNumber:               '',
        poDate:                 '',
        vendor:                 '',
        vendorName:             '',
        deliveryDate:           String(row['DELIVERY END DATE'] || '').trim()
      };
      matObj.status = calculateMaterialStatus ? calculateMaterialStatus(matObj) : String(row['PR STATUS'] || 'Pending').trim();
      materials.push(matObj);
    });

    const jobCode = String(firstRow['JOB CODE'] || '').trim();
    const jobDesc = String(firstRow['JOB DESC'] || '').trim();
    const jobStr = jobCode ? `${jobCode}${jobDesc ? ' - ' + jobDesc : ''}` : jobDesc;

    let rawPrStatus = String(firstRow['PR STATUS'] || '').trim();
    const hasAuthMeta = !!(
      String(firstRow['AUTHORIZED BY'] || firstRow['AUTHORISED BY'] || '').trim() ||
      String(firstRow['AUTHORIZED ON'] || firstRow['AUTHORISED ON'] || '').trim()
    );
    if (hasAuthMeta || !rawPrStatus || rawPrStatus.toLowerCase() === 'pending') {
      rawPrStatus = 'Authorised';
    }

    const prHeaderFields = {
      jobCode,
      jobDesc,
      job: jobStr,
      fromJobCode: String(firstRow['FROM JOB CODE'] || '').trim(),
      warehouseCode: String(firstRow['WAREHOUSE CODE'] || '').trim(),
      warehouseDesc: String(firstRow['WAREHOUSE DESC'] || '').trim(),
      prDate: String(firstRow['PR DATE'] || '').trim(),
      prType: String(firstRow['PR TYPE'] || '').trim(),
      cpCode: String(firstRow['CP CODE'] || '').trim(),
      cpDesc: String(firstRow['CP DESC'] || '').trim(),
      wbsCode: String(firstRow['WBS CODE'] || '').trim(),
      wbsDesc: String(firstRow['WBS DESC'] || '').trim(),
      currencyDesc: String(firstRow['CURRENCY DESC'] || '').trim(),
      budgetReference: String(firstRow['BUDGET REFERENCE'] || '').trim(),
      prStatus: rawPrStatus,
      closedBy: String(firstRow['CLOSED BY'] || '').trim(),
      closedOn: String(firstRow['CLOSED ON'] || '').trim(),
      createdBy: String(firstRow['CREATED BY'] || '').trim(),
      requestedBy: String(firstRow['CREATED BY'] || '').trim(),
      createdOn: String(firstRow['CREATED ON'] || '').trim(),
      authorizedBy: String(firstRow['AUTHORIZED BY'] || '').trim(),
      authorizedOn: String(firstRow['AUTHORIZED ON'] || '').trim(),
      allocationNumber: String(firstRow['ALLOCATION NUMBER'] || '').trim(),
      allocationDate: String(firstRow['ALLOCATION DATE'] || '').trim(),
      buyerName: String(firstRow['BUYER NAME'] || '').trim(),
      allocatedBy: String(firstRow['BUYER NAME'] || '').trim(),
      categoryDesc: String(firstRow['CATEGORY DESC'] || '').trim(),
      category: String(firstRow['CATEGORY DESC'] || '').trim(),
      icDesc: String(firstRow['IC DESC'] || '').trim(),
      bu: String(firstRow['BU'] || '').trim(),
      sbu: String(firstRow['SBU'] || '').trim(),
      department: String(firstRow['BU'] || firstRow['SBU'] || firstRow['IC DESC'] || 'Procurement').trim(),
      prGrNumber: String(firstRow['PR GR NUMBER'] || '').trim(),
      remarks: String(firstRow['REMARKS'] || '').trim()
    };

    const newPRC = {
      id: prNumber,
      prNumber,
      createdAt: String(firstRow['CREATED ON'] || firstRow['PR DATE'] || new Date().toISOString().split('T')[0]).trim(),
      importedBy: state.currentUser?.name || 'App Owner',
      priority: 'Medium',
      materials,
      ...prHeaderFields,

      // Manual workflow defaults
      rfqNumber:'', rfqDate:'', offersReceived: false, tcdNumber:'', tcdDate:'', tcdApproved: false,
      poNumber:'', poDate:'', vendorName:''
    };
    newPRC.status = calculateStatus(newPRC, materials);
    newPRCsToAdd.push(newPRC);
    results.new++;
  });

  const updatedPRCs = [...existing, ...newPRCsToAdd];
  const summary = buildStatusSummary(updatedPRCs);
  const totalMats = updatedPRCs.reduce((acc, p) => acc + (p.materials || []).length, 0);

  setState({
    prcs: updatedPRCs,
    statusSummary: summary,
    totalMaterials: totalMats
  });

  // If imported rows contained allocation data, create or merge Allocation documents
  try {
    const currentState = getState();
    const existingAllocNumbers = new Set((currentState.allocations || []).map(a => a.allocationNumber));

    // Group imported materials by allocation number
    const allocGroups = {};
    newPRCsToAdd.forEach(prc => {
      (prc.materials || []).forEach(m => {
        const allocNum = String(m.allocationNumber || prc.allocationNumber || '').trim();
        const allocDate = String(m.allocationDate || prc.allocationDate || '').trim();
        const buyerName = String(m.buyerName || prc.buyerName || '').trim();

        if (allocNum && allocDate && buyerName) {
          if (!allocGroups[allocNum]) allocGroups[allocNum] = { allocationNumber: allocNum, allocationDate: allocDate, buyerName, items: [] };
          allocGroups[allocNum].items.push({
            prcId: prc.id,
            materialId: m.id,
            quantity: parseFloat(m.quantity) || 0,
            matCode: m.matCode,
            description: m.description,
            unit: m.unit || '',
            prNumber: prc.prNumber
          });
        }
      });
    });

    Object.values(allocGroups).forEach(alloc => {
      if (!alloc.items.length) return;
      // If allocation number already exists, merge items into existing allocation
      if (existingAllocNumbers.has(alloc.allocationNumber)) {
        const stateNow = getState();
        const allocations = [...(stateNow.allocations || [])];
        const idx = allocations.findIndex(a => a.allocationNumber === alloc.allocationNumber);
        if (idx === -1) return; // safety
        const existing = { ...allocations[idx], items: [...(allocations[idx].items || [])] };
        const keySet = new Set(existing.items.map(i => `${i.prcId}::${i.materialId}`));
        alloc.items.forEach(it => {
          const key = `${it.prcId}::${it.materialId}`;
          if (!keySet.has(key)) {
            existing.items.push(it);
            keySet.add(key);
          }
        });
        allocations[idx] = existing;

        // Cascade changes to PRCs/materials similar to createAllocation
        const prcs = [...(stateNow.prcs || [])];
        const affectedPrcIds = new Set(existing.items.map(i => i.prcId));
        affectedPrcIds.forEach(prcId => {
          const prcIdx = prcs.findIndex(p => p.id === prcId);
          if (prcIdx === -1) return;
          const prc = { ...prcs[prcIdx], materials: [...(prcs[prcIdx].materials || [])] };
          existing.items.filter(i => i.prcId === prcId).forEach(item => {
            const matIdx = prc.materials.findIndex(m => m.id === item.materialId);
            if (matIdx === -1) return;
            prc.materials[matIdx] = {
              ...prc.materials[matIdx],
              allocationNumber: existing.allocationNumber,
              allocationDate: existing.allocationDate,
              buyerName: existing.buyerName,
              allocatedBy: existing.buyerName
            };
            prc.materials[matIdx].status = calculateMaterialStatus(prc.materials[matIdx]);
          });
          if (!prc.allocationNumber || prc.allocationNumber === existing.allocationNumber) {
            prc.allocationNumber = existing.allocationNumber;
            prc.allocationDate = existing.allocationDate;
            prc.buyerName = existing.buyerName;
            prc.allocatedBy = existing.buyerName;
          }
          prc.status = calculateStatus(prc, prc.materials);
          prc.updatedAt = new Date().toISOString();
          prcs[prcIdx] = prc;
        });

        setState({ allocations, prcs, statusSummary: buildStatusSummary(prcs) });
      } else {
        // Create a new Allocation document for this allocation number
        createAllocation({ allocationNumber: alloc.allocationNumber, allocationDate: alloc.allocationDate, buyerName: alloc.buyerName, items: alloc.items });
      }
    });
  } catch (err) {
    console.error('Failed to create/merge imported allocation documents:', err);
  }

  addAuditLog({
    action: 'import', collection: 'PRCs', docId: 'batch',
    changes: { summary: `New: ${results.new} PRCs imported, Skipped: ${results.skipped} existing PRCs (prevented duplicates/overwriting)` }
  });

  // Direct Cloud Firestore synchronization
  try {
    pushLocalDataToFirestore();
  } catch (syncErr) {
    console.warn('Direct Firestore push notice for imported data:', syncErr);
  }

  return results;
}

export const SAMPLE_IMPORT_DATA = [
  {
    'JOB CODE': 'JOB-2026-01',
    'JOB DESC': 'Substation Construction Phase 2',
    'FROM JOB CODE': 'JOB-2025-88',
    'WAREHOUSE CODE': 'WH-01',
    'WAREHOUSE DESC': 'Main Central Warehouse',
    'PR NUMBER': 'PR-2026-1001',
    'PR DATE': '2026-01-15',
    'PR TYPE': 'Standard Requisition',
    'SERIAL NUMBER': '1',
    'MATERIAL CODE': 'MAT-50281',
    'MATERIAL DESC': 'SKF Deep Groove Ball Bearing 6205-2RS',
    'UOM': 'EA',
    'CP CODE': 'CP-401',
    'CP DESC': 'Mechanical Spares Package',
    'WBS CODE': 'WBS-01.04.02',
    'WBS DESC': 'Pumps & Compressors Maintenance',
    'QUANTITY': 25,
    'SUGGESTED RATE': 45.50,
    'VALUE': 1137.50,
    'PENDING QTY': 25,
    'CURRENCY DESC': 'KWD',
    'BUDGET REFERENCE': 'BGT-2026-MECH-04',
    'DELIVERY START DATE': '2026-02-01',
    'DELIVERY END DATE': '2026-02-15',
    'DRAWING NUMBER': 'DRW-ME-6205-A',
    'REMARKS': 'Critical spare for high-pressure cooling pump',
    'PR STATUS': 'Authorised',
    'CLOSED QTY': 0,
    'CLOSED BY': '',
    'CLOSED ON': '',
    'CREATED BY': 'App Owner',
    'CREATED ON': '2026-01-15',
    'AUTHORIZED BY': 'App Owner',
    'AUTHORIZED ON': '2026-01-16',
    'ALLOCATION NUMBER': 'ALLOC-2026-012',
    'ALLOCATION DATE': '2026-01-17',
    'BUYER NAME': 'App Owner',
    'CATEGORY DESC': 'Mechanical Spares',
    'MATERIAL GROUP CODE': 'MG-102',
    'MATERIAL GROUP DESCRIPTION': 'Bearings & Power Transmission',
    'MATERIAL CLASS': 'Class A - Critical',
    'IC DESC': 'Industrial Construction',
    'BU': 'Heavy Civil & Infrastructure',
    'SBU': 'Power & Water Solutions',
    'PR GR NUMBER': 'GR-90214'
  },
  {
    'JOB CODE': 'JOB-2026-01',
    'JOB DESC': 'Substation Construction Phase 2',
    'FROM JOB CODE': 'JOB-2025-88',
    'WAREHOUSE CODE': 'WH-01',
    'WAREHOUSE DESC': 'Main Central Warehouse',
    'PR NUMBER': 'PR-2026-1001',
    'PR DATE': '2026-01-15',
    'PR TYPE': 'Standard Requisition',
    'SERIAL NUMBER': '2',
    'MATERIAL CODE': 'MAT-70342',
    'MATERIAL DESC': '2-inch Stainless Steel 316 Gate Valve',
    'UOM': 'PCS',
    'CP CODE': 'CP-401',
    'CP DESC': 'Mechanical Spares Package',
    'WBS CODE': 'WBS-01.04.05',
    'WBS DESC': 'Piping & Valves',
    'QUANTITY': 10,
    'SUGGESTED RATE': 320.00,
    'VALUE': 3200.00,
    'PENDING QTY': 10,
    'CURRENCY DESC': 'KWD',
    'BUDGET REFERENCE': 'BGT-2026-MECH-04',
    'DELIVERY START DATE': '2026-02-05',
    'DELIVERY END DATE': '2026-02-20',
    'DRAWING NUMBER': 'DRW-VAL-SS-02',
    'REMARKS': 'Must comply with API 600 standards',
    'PR STATUS': 'Authorised',
    'CLOSED QTY': 0,
    'CLOSED BY': '',
    'CLOSED ON': '',
    'CREATED BY': 'App Owner',
    'CREATED ON': '2026-01-15',
    'AUTHORIZED BY': 'App Owner',
    'AUTHORIZED ON': '2026-01-16',
    'ALLOCATION NUMBER': 'ALLOC-2026-012',
    'ALLOCATION DATE': '2026-01-17',
    'BUYER NAME': 'App Owner',
    'CATEGORY DESC': 'Valves & Fittings',
    'MATERIAL GROUP CODE': 'MG-205',
    'MATERIAL GROUP DESCRIPTION': 'Industrial Valves',
    'MATERIAL CLASS': 'Class A - Critical',
    'IC DESC': 'Industrial Construction',
    'BU': 'Heavy Civil & Infrastructure',
    'SBU': 'Power & Water Solutions',
    'PR GR NUMBER': 'GR-90214'
  },
  {
    'JOB CODE': 'JOB-2026-04',
    'JOB DESC': 'Solar Power Substation Expansion',
    'FROM JOB CODE': 'JOB-2025-90',
    'WAREHOUSE CODE': 'WH-02',
    'WAREHOUSE DESC': 'North Yard Warehouse',
    'PR NUMBER': 'PR-2026-1002',
    'PR DATE': '2026-01-18',
    'PR TYPE': 'Urgent Requisition',
    'SERIAL NUMBER': '1',
    'MATERIAL CODE': 'MAT-88190',
    'MATERIAL DESC': 'High Bay Industrial LED Floodlight 400W 5000K',
    'UOM': 'SET',
    'CP CODE': 'CP-602',
    'CP DESC': 'Electrical & Lighting',
    'WBS CODE': 'WBS-02.01.09',
    'WBS DESC': 'Yard Lighting & Electrical Installations',
    'QUANTITY': 15,
    'SUGGESTED RATE': 185.00,
    'VALUE': 2775.00,
    'PENDING QTY': 15,
    'CURRENCY DESC': 'KWD',
    'BUDGET REFERENCE': 'BGT-2026-ELEC-12',
    'DELIVERY START DATE': '2026-02-10',
    'DELIVERY END DATE': '2026-02-25',
    'DRAWING NUMBER': 'DRW-EL-400W-FL',
    'REMARKS': 'IP66 waterproof rating required',
    'PR STATUS': 'Authorised',
    'CLOSED QTY': 0,
    'CLOSED BY': '',
    'CLOSED ON': '',
    'CREATED BY': 'App Owner',
    'CREATED ON': '2026-01-18',
    'AUTHORIZED BY': 'App Owner',
    'AUTHORIZED ON': '2026-01-19',
    'ALLOCATION NUMBER': 'ALLOC-2026-019',
    'ALLOCATION DATE': '2026-01-20',
    'BUYER NAME': 'App Owner',
    'CATEGORY DESC': 'Electrical Equipment',
    'MATERIAL GROUP CODE': 'MG-301',
    'MATERIAL GROUP DESCRIPTION': 'Lighting Fixtures & Luminaires',
    'MATERIAL CLASS': 'Class B - Standard',
    'IC DESC': 'Renewable Energy Projects',
    'BU': 'Power & Utility',
    'SBU': 'Solar & Wind Energy',
    'PR GR NUMBER': 'GR-90330'
  }
];

/** Generate sample Excel template containing all 45 columns */
export function downloadSampleTemplate() {
  if (!window.XLSX) { toast('SheetJS not available', 'error'); return; }

  const sampleData = SAMPLE_IMPORT_DATA;

  const ws = XLSX.utils.json_to_sheet(sampleData, { header: ALL_IMPORT_COLUMNS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'PR Import Template');

  // Auto column width calculation
  const colWidths = ALL_IMPORT_COLUMNS.map(col => ({
    wch: Math.max(col.length + 3, 12)
  }));
  ws['!cols'] = colWidths;

  XLSX.writeFile(wb, 'PRC_Enterprise_Import_Template.xlsx');
  toast('Enterprise 45-Column sample template downloaded!', 'success');
}

/** Render import preview table HTML */
export function renderPreviewTable(rows, errors) {
  const state = getState();
  const existingPRCSet = new Set((state.prcs || []).map(p => String(p.prNumber || '').trim().toUpperCase()));
  const errorRows = new Set(errors.map(e => e.row - 2));
  const cols = rows.length ? Object.keys(rows[0]) : ALL_IMPORT_COLUMNS;

  const head = cols.map(c => `<th>${c}</th>`).join('');
  const body = rows.slice(0, 100).map((row, idx) => {
    const hasError = errorRows.has(idx);
    const rowErrors = errors.filter(e => e.row === idx + 2);
    const errTip = rowErrors.map(e => e.errors.join(', ')).join('; ');
    const prNumber = String(row['PR NUMBER'] || '').trim().toUpperCase();
    const alreadyExists = existingPRCSet.has(prNumber);

    let statusChip = '<span class="chip chip-completed">✓ Ready to Import</span>';
    if (hasError) {
      statusChip = `<span class="chip chip-wrong" title="${errTip}">⚠ Error</span>`;
    } else if (alreadyExists) {
      statusChip = '<span class="chip chip-awaiting" style="font-size:11px" title="This PRC already exists in the system and will be skipped to protect existing records">⏭ Already Exists (Will Skip)</span>';
    }

    return `
      <tr class="${hasError ? 'table-row-error' : (alreadyExists ? 'opacity-70' : '')}" title="${errTip || (alreadyExists ? 'Already in database — will be skipped to prevent overwrite' : '')}">
        ${cols.map(c => `<td>${row[c] ?? ''}</td>`).join('')}
        <td>${statusChip}</td>
      </tr>`;
  }).join('');

  return `
    <div class="table-wrapper" style="flex:1;min-height:0;overflow:auto">
      <table class="data-table" style="font-size:12px;white-space:nowrap">
        <thead><tr>${head}<th>Import Action</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    ${rows.length > 100 ? `<p class="text-sm text-secondary mt-2" style="flex-shrink:0">Showing first 100 of ${rows.length} rows.</p>` : ''}
  `;
}

// ═══════════════════════════════════════════════════════════
// DEDICATED BULK ALLOCATION EXCEL ENGINE (7 Columns)
// PR Number, Status, Department, Job, Allocation No., Allocation date, Buyer Name
// ═══════════════════════════════════════════════════════════

export const BULK_ALLOCATION_COLUMNS = [
  'PR NUMBER',
  'STATUS',
  'DEPARTMENT',
  'JOB',
  'ALLOCATION NO',
  'ALLOCATION DATE',
  'BUYER NAME'
];

const BULK_ALLOCATION_ALIAS_MAP = {
  'PR NUMBER': ['PR NUMBER', 'PR NO', 'PR_NUMBER', 'PRNUMBER', 'REQUISITION NUMBER', 'PR', 'PRC NUMBER', 'PRC NO'],
  'STATUS': ['STATUS', 'PR STATUS', 'PR_STATUS', 'REQUISITION STATUS', 'STATE'],
  'DEPARTMENT': ['DEPARTMENT', 'DEPT', 'BU', 'SBU', 'IC DESC', 'UNIT', 'SECTION'],
  'JOB': ['JOB', 'JOB CODE', 'PROJECT', 'PROJECT CODE', 'JOB DESC', 'JOB_CODE'],
  'ALLOCATION NO': ['ALLOCATION NO', 'ALLOCATION NUMBER', 'ALLOCATION NO.', 'ALLOCATION CODE', 'ALLOC NO', 'ALLOCATION_NO', 'ALLOCATION_NUMBER', 'ALLOCATION', 'ALLOC #'],
  'ALLOCATION DATE': ['ALLOCATION DATE', 'ALLOCATED ON', 'ALLOCATED DATE', 'ALLOC_DATE', 'DATE', 'ALLOC DATE'],
  'BUYER NAME': ['BUYER NAME', 'BUYER', 'PURCHASER', 'ALLOCATED TO', 'BUYER_NAME', 'ASSIGNED BUYER', 'ALLOCATED BY']
};

/** Normalize bulk allocation row keys */
export function normalizeBulkAllocationRow(rawRow) {
  const norm = {};
  const rawKeys = Object.keys(rawRow || {});

  rawKeys.forEach(k => {
    norm[k] = rawRow[k];
  });

  BULK_ALLOCATION_COLUMNS.forEach(col => {
    if (norm[col] === undefined) norm[col] = '';
    const aliases = BULK_ALLOCATION_ALIAS_MAP[col] || [col];
    const strippedCol = stripKey(col);
    const strippedAliases = aliases.map(stripKey);

    for (const key of rawKeys) {
      const strippedKey = stripKey(key);
      if (strippedKey === strippedCol || strippedAliases.includes(strippedKey)) {
        norm[col] = rawRow[key];
        break;
      }
    }
  });

  // Clean date strings if needed
  if (norm['ALLOCATION DATE']) {
    let dateStr = String(norm['ALLOCATION DATE']).trim();
    if (dateStr.includes('T')) dateStr = dateStr.split('T')[0];
    // Check if Excel parsed as serial number
    if (/^\d{5}$/.test(dateStr)) {
      const excelDate = new Date((parseInt(dateStr, 10) - (25567 + 2)) * 86400 * 1000);
      if (!isNaN(excelDate.getTime())) {
        dateStr = excelDate.toISOString().split('T')[0];
      }
    }
    norm['ALLOCATION DATE'] = dateStr;
  }

  return norm;
}

/** Generate sample Excel template specifically for Bulk Allocation */
export function downloadBulkAllocationTemplate() {
  if (!window.XLSX) {
    toast('SheetJS library is not available. Please refresh.', 'error');
    return;
  }

  const state = getState();
  const existingPRCs = state.prcs || [];
  const pendingPRCs = existingPRCs.filter(p => !p.allocationNumber || p.prStatus === 'Authorised' || p.status === 'Authorised' || p.status === 'Pending Allocation');

  let sampleData = [];
  const todayStr = new Date().toISOString().split('T')[0];

  if (pendingPRCs.length > 0) {
    // Populate with real pending PRs from the system for convenience
    sampleData = pendingPRCs.slice(0, 5).map((p, idx) => ({
      'PR NUMBER': p.prNumber,
      'STATUS': 'Allocated',
      'DEPARTMENT': p.department || p.bu || p.sbu || 'Procurement',
      'JOB': p.job || p.jobCode || 'Main Project',
      'ALLOCATION NO': `ALLOC-${new Date().getFullYear()}-${String(idx + 1).padStart(3, '0')}`,
      'ALLOCATION DATE': todayStr,
      'BUYER NAME': state.currentUser?.name || 'Assigned Buyer'
    }));
  } else {
    // Fallback demo rows
    sampleData = [
      {
        'PR NUMBER': 'PR-2026-1001',
        'STATUS': 'Allocated',
        'DEPARTMENT': 'Mechanical Dept',
        'JOB': 'JOB-2026-01 - Substation Construction',
        'ALLOCATION NO': 'ALLOC-2026-001',
        'ALLOCATION DATE': todayStr,
        'BUYER NAME': 'John Doe'
      },
      {
        'PR NUMBER': 'PR-2026-1002',
        'STATUS': 'Allocated',
        'DEPARTMENT': 'Electrical Dept',
        'JOB': 'JOB-2026-04 - Solar Substation',
        'ALLOCATION NO': 'ALLOC-2026-002',
        'ALLOCATION DATE': todayStr,
        'BUYER NAME': 'Sarah Smith'
      },
      {
        'PR NUMBER': 'PR-2026-1003',
        'STATUS': 'Allocated',
        'DEPARTMENT': 'Civil Infrastructure',
        'JOB': 'JOB-2026-08 - Water Treatment',
        'ALLOCATION NO': 'ALLOC-2026-003',
        'ALLOCATION DATE': todayStr,
        'BUYER NAME': 'Alex Johnson'
      }
    ];
  }

  const ws = XLSX.utils.json_to_sheet(sampleData, { header: BULK_ALLOCATION_COLUMNS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Bulk Allocation');

  // Set column widths
  ws['!cols'] = [
    { wch: 18 }, // PR NUMBER
    { wch: 15 }, // STATUS
    { wch: 22 }, // DEPARTMENT
    { wch: 32 }, // JOB
    { wch: 20 }, // ALLOCATION NO
    { wch: 18 }, // ALLOCATION DATE
    { wch: 22 }  // BUYER NAME
  ];

  XLSX.writeFile(wb, 'Bulk_Allocation_Template.xlsx');
  toast('Bulk Allocation Excel Template downloaded!', 'success');
}

/** Validate Bulk Allocation rows against database */
export function validateBulkAllocationRows(rawRows) {
  const state = getState();
  const existingPRCs = state.prcs || [];
  const prcMap = new Map();
  existingPRCs.forEach(p => {
    const key = String(p.prNumber || '').trim().toUpperCase();
    if (key) prcMap.set(key, p);
  });

  const errors = [];
  const processedRows = [];
  const seenPRCsInFile = new Set();

  rawRows.forEach((raw, idx) => {
    const rowNum = idx + 2; // Header is row 1
    const norm = normalizeBulkAllocationRow(raw);
    const rowErrors = [];

    const prNumber = String(norm['PR NUMBER'] || '').trim();
    const allocNo = String(norm['ALLOCATION NO'] || '').trim();
    const allocDate = String(norm['ALLOCATION DATE'] || '').trim();
    const buyerName = String(norm['BUYER NAME'] || '').trim();
    const status = String(norm['STATUS'] || 'Allocated').trim();
    const dept = String(norm['DEPARTMENT'] || '').trim();
    const job = String(norm['JOB'] || '').trim();

    if (!prNumber) {
      rowErrors.push('PR NUMBER is required');
    }
    if (!allocNo) {
      rowErrors.push('ALLOCATION NO is required');
    }
    if (!allocDate) {
      rowErrors.push('ALLOCATION DATE is required');
    }
    if (!buyerName) {
      rowErrors.push('BUYER NAME is required');
    }

    const prUpper = prNumber.toUpperCase();
    const matchedPrc = prcMap.get(prUpper);
    const isDuplicateInFile = seenPRCsInFile.has(prUpper);
    if (prNumber) seenPRCsInFile.add(prUpper);

    if (isDuplicateInFile) {
      rowErrors.push(`Duplicate PR ${prNumber} in uploaded file`);
    }

    const matCount = matchedPrc ? (matchedPrc.materials || []).length : 0;

    const rowObj = {
      rowNum,
      prNumber,
      allocNo,
      allocDate,
      buyerName,
      status: status || 'Allocated',
      department: dept,
      job,
      exists: !!matchedPrc,
      prc: matchedPrc,
      materialCount: matCount,
      errors: rowErrors,
      isValid: rowErrors.length === 0
    };

    if (rowErrors.length > 0) {
      errors.push({ row: rowNum, errors: rowErrors, data: norm });
    }

    processedRows.push(rowObj);
  });

  const validCount = processedRows.filter(r => r.isValid).length;
  const errorCount = processedRows.filter(r => !r.isValid).length;
  const newPRCount = processedRows.filter(r => r.isValid && !r.exists).length;
  const matchedPRCount = processedRows.filter(r => r.isValid && r.exists).length;

  return {
    valid: errorCount === 0,
    errors,
    rows: processedRows,
    summary: {
      total: processedRows.length,
      valid: validCount,
      errors: errorCount,
      matchedPRs: matchedPRCount,
      newPRs: newPRCount
    }
  };
}

/** Render preview table for Bulk Allocation Modal */
export function renderBulkAllocationPreviewTable(processedRows) {
  if (!processedRows || !processedRows.length) {
    return `<div class="empty-state" style="padding:24px"><div class="empty-state-title">No rows to display</div></div>`;
  }

  const rowsHtml = processedRows.map(r => {
    let statusBadge = '';
    let rowClass = '';

    if (!r.isValid) {
      rowClass = 'table-row-error';
      statusBadge = `<span class="chip chip-wrong" title="${r.errors.join(', ')}">❌ ${r.errors[0]}</span>`;
    } else if (r.exists) {
      statusBadge = `<span class="chip chip-completed" title="PR found. ${r.materialCount} material(s) will be allocated.">✓ Ready (${r.materialCount} items)</span>`;
    } else {
      statusBadge = `<span class="chip chip-awaiting" title="PR not found in database. Will create PR and allocate.">➕ New PR (Will Create)</span>`;
    }

    return `
      <tr class="${rowClass}">
        <td><strong>${r.rowNum}</strong></td>
        <td><span class="font-mono font-semibold" style="color:var(--color-primary)">${r.prNumber}</span></td>
        <td><span class="font-mono font-bold">${r.allocNo}</span></td>
        <td>${r.allocDate || '—'}</td>
        <td><strong>${r.buyerName || '—'}</strong></td>
        <td>${r.department || (r.prc ? (r.prc.department || r.prc.bu || '—') : '—')}</td>
        <td>${r.job || (r.prc ? (r.prc.job || r.prc.jobCode || '—') : '—')}</td>
        <td><span class="chip chip-pending">${r.status || 'Allocated'}</span></td>
        <td>${statusBadge}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="table-wrapper" style="max-height:340px;overflow:auto;border:1px solid var(--color-border);border-radius:8px">
      <table class="data-table" style="font-size:12px;white-space:nowrap">
        <thead>
          <tr>
            <th>#</th>
            <th>PR Number</th>
            <th>Allocation No</th>
            <th>Allocation Date</th>
            <th>Buyer Name</th>
            <th>Department</th>
            <th>Job</th>
            <th>Target Status</th>
            <th>Validation Status</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

/** Apply Bulk Allocation updates to state, PRCs, allocations, and database */
export function applyBulkAllocationImport(processedRows, fileName = 'Bulk_Allocation.xlsx') {
  const validRows = processedRows.filter(r => r.isValid);
  if (!validRows.length) {
    toast('No valid rows to allocate', 'warning');
    return { success: false, count: 0 };
  }

  const state = getState();

  // Create pre-import snapshot for Call Back / Rollback
  const snapshotId = createImportSnapshot(
    'Bulk Allocation Excel',
    fileName,
    `Bulk allocation for ${validRows.length} PR(s).`
  );

  const existingPRCs = [...(state.prcs || [])];
  const existingAllocs = [...(state.allocations || [])];

  let updatedPRCount = 0;
  let createdPRCount = 0;
  let totalMaterialsAllocated = 0;

  // Group valid rows by Allocation Number
  const allocGroups = {};

  validRows.forEach(r => {
    const prUpper = r.prNumber.toUpperCase();
    let prcIdx = existingPRCs.findIndex(p => String(p.prNumber || '').trim().toUpperCase() === prUpper);

    let prc;
    if (prcIdx !== -1) {
      // Existing PRC
      prc = { ...existingPRCs[prcIdx], materials: [...(existingPRCs[prcIdx].materials || [])] };
      updatedPRCount++;
    } else {
      // Create new PRC
      createdPRCount++;
      const newPrcId = r.prNumber;
      prc = {
        id: newPrcId,
        prNumber: r.prNumber,
        createdAt: r.allocDate || new Date().toISOString().split('T')[0],
        importedBy: state.currentUser?.name || 'Bulk Allocation',
        priority: 'Medium',
        department: r.department || 'Procurement',
        job: r.job || 'General Project',
        jobCode: r.job || '',
        materials: [
          {
            id: `${r.prNumber}-MAT-01-1`,
            serialNumber: '1',
            matCode: `MAT-${r.prNumber}-01`,
            description: `Items for Requisition ${r.prNumber}`,
            unit: 'EA',
            quantity: 1,
            processedQty: 0,
            pendingQty: 1,
            closedQty: 0,
            currencyDesc: 'KWD',
            allocationNumber: r.allocNo,
            allocationDate: r.allocDate,
            buyerName: r.buyerName,
            allocatedBy: r.buyerName,
            status: 'Allocated'
          }
        ]
      };
      existingPRCs.push(prc);
      prcIdx = existingPRCs.length - 1;
    }

    // Update PR Header fields
    prc.allocationNumber = r.allocNo;
    prc.allocationDate   = r.allocDate;
    prc.buyerName        = r.buyerName;
    prc.allocatedBy      = r.buyerName;
    if (r.department) {
      prc.department = r.department;
      prc.bu = r.department;
    }
    if (r.job) {
      prc.job = r.job;
      prc.jobCode = r.job;
    }
    if (r.status) {
      prc.prStatus = r.status;
    }

    // If PRC had no materials, add a placeholder material
    if (!prc.materials || prc.materials.length === 0) {
      prc.materials = [
        {
          id: `${r.prNumber}-MAT-01-1`,
          serialNumber: '1',
          matCode: `MAT-${r.prNumber}-01`,
          description: `Items for Requisition ${r.prNumber}`,
          unit: 'EA',
          quantity: 1,
          processedQty: 0,
          pendingQty: 1,
          closedQty: 0,
          currencyDesc: 'KWD',
          allocationNumber: r.allocNo,
          allocationDate: r.allocDate,
          buyerName: r.buyerName,
          allocatedBy: r.buyerName,
          status: 'Allocated'
        }
      ];
    }

    // Update all materials in this PR with allocation info
    prc.materials = prc.materials.map(m => {
      totalMaterialsAllocated++;
      const updatedMat = {
        ...m,
        allocationNumber: r.allocNo,
        allocationDate: r.allocDate,
        buyerName: r.buyerName,
        allocatedBy: r.buyerName
      };
      updatedMat.status = calculateMaterialStatus ? calculateMaterialStatus(updatedMat) : 'Allocated';
      return updatedMat;
    });

    prc.status = calculateStatus ? calculateStatus(prc, prc.materials) : 'Allocated';
    prc.updatedAt = new Date().toISOString();
    existingPRCs[prcIdx] = prc;

    // Collect for Allocation documents
    if (!allocGroups[r.allocNo]) {
      allocGroups[r.allocNo] = {
        allocationNumber: r.allocNo,
        allocationDate: r.allocDate,
        buyerName: r.buyerName,
        items: []
      };
    }

    prc.materials.forEach(m => {
      allocGroups[r.allocNo].items.push({
        prcId: prc.id,
        materialId: m.id,
        quantity: parseFloat(m.quantity) || 1,
        matCode: m.matCode || 'MAT',
        description: m.description || '',
        unit: m.unit || 'EA',
        prNumber: prc.prNumber
      });
    });
  });

  // Save/merge Allocation documents into state
  const updatedAllocs = [...existingAllocs];

  Object.values(allocGroups).forEach(group => {
    const existingIdx = updatedAllocs.findIndex(
      a => String(a.allocationNumber || '').trim().toUpperCase() === group.allocationNumber.toUpperCase()
    );

    if (existingIdx !== -1) {
      // Merge items
      const existing = updatedAllocs[existingIdx];
      const existingItems = [...(existing.items || [])];
      const itemKeySet = new Set(existingItems.map(i => `${i.prcId}::${i.materialId}`));

      group.items.forEach(newItem => {
        const key = `${newItem.prcId}::${newItem.materialId}`;
        if (!itemKeySet.has(key)) {
          existingItems.push(newItem);
          itemKeySet.add(key);
        }
      });

      updatedAllocs[existingIdx] = {
        ...existing,
        allocationDate: group.allocationDate || existing.allocationDate,
        buyerName: group.buyerName || existing.buyerName,
        allocatedBy: group.buyerName || existing.allocatedBy,
        items: existingItems,
        updatedAt: new Date().toISOString(),
        updatedBy: state.currentUser?.name || 'Bulk Allocation'
      };
    } else {
      // New allocation document
      updatedAllocs.unshift({
        id: `alloc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        allocationNumber: group.allocationNumber,
        allocationDate: group.allocationDate,
        buyerName: group.buyerName,
        allocatedBy: group.buyerName,
        items: group.items,
        createdAt: new Date().toISOString(),
        createdBy: state.currentUser?.name || 'Bulk Allocation',
        status: 'Active'
      });
    }
  });

  const summary = buildStatusSummary ? buildStatusSummary(existingPRCs) : state.statusSummary;

  // Commit updated state
  setState({
    prcs: existingPRCs,
    allocations: updatedAllocs,
    statusSummary: summary
  });

  // Audit log
  addAuditLog({
    action: 'bulk_allocation_excel',
    collection: 'Allocations',
    docId: 'bulk_import',
    changes: {
      summary: `Bulk Allocation via Excel: ${validRows.length} PRs processed (${updatedPRCount} existing updated, ${createdPRCount} new created), ${Object.keys(allocGroups).length} Allocation Document(s) created/merged.`
    }
  });

  // Push to Cloud / Firestore
  try {
    pushLocalDataToFirestore();
  } catch (syncErr) {
    console.warn('Firestore sync note for bulk allocation:', syncErr);
  }

  return {
    success: true,
    prsAllocated: validRows.length,
    updatedPRCount,
    createdPRCount,
    allocationsCreated: Object.keys(allocGroups).length,
    materialsAllocated: totalMaterialsAllocated,
    snapshotId
  };
}

// ═══════════════════════════════════════════════════════════
// DEDICATED PO REPORT LINE-ITEM EXCEL ENGINE (14 Columns)
// PRC Number, PRC Date, Material Code, Allocation Number,
// Allocation Date, Buyer Name, RFQ Number, TCD Number, TCD Date,
// PO Number, PO Amendment Number, PO Quantity, PO Date, Vendor Name
// ═══════════════════════════════════════════════════════════

export const PO_REPORT_COLUMNS = [
  'PRC NUMBER',
  'PRC DATE',
  'MATERIAL CODE',
  'ALLOCATION NUMBER',
  'ALLOCATION DATE',
  'BUYER NAME',
  'RFQ NUMBER',
  'TCD NUMBER',
  'TCD DATE',
  'PO NUMBER',
  'PO AMENDMENT NUMBER',
  'PO QUANTITY',
  'PO DATE',
  'VENDOR NAME'
];

const PO_REPORT_ALIAS_MAP = {
  'PRC NUMBER': ['PRC NUMBER', 'PRC NO', 'PR NUMBER', 'PR NO', 'PR_NUMBER', 'PRNUMBER', 'REQUISITION NUMBER', 'PR', 'PRC', 'PRC_NUMBER'],
  'PRC DATE': ['PRC DATE', 'PR DATE', 'PR_DATE', 'PRC_DATE', 'REQUISITION DATE', 'PR DATE.', 'CREATED ON', 'PRC CREATED ON'],
  'MATERIAL CODE': ['MATERIAL CODE', 'MAT CODE', 'ITEM CODE', 'MATERIAL_CODE', 'MAT_CODE', 'ITEM NO', 'MATERIAL'],
  'ALLOCATION NUMBER': ['ALLOCATION NUMBER', 'ALLOCATION NO', 'ALLOCATION NO.', 'ALLOC NO', 'ALLOC NO.', 'ALLOCATION', 'ALLOCATION_NUMBER', 'ALLOC_NUMBER', 'ALLOCATION NUM'],
  'ALLOCATION DATE': ['ALLOCATION DATE', 'ALLOC DATE', 'ALLOCATION_DATE', 'ALLOC_DATE', 'ALLOCATION ON', 'ALLOC DATE.'],
  'BUYER NAME': ['BUYER NAME', 'BUYER', 'BUYER_NAME', 'PURCHASER', 'BUYER PERSON', 'ALLOCATED TO', 'BUYER_PERSON'],
  'RFQ NUMBER': ['RFQ NUMBER', 'RFQ NO', 'RFQ_NUMBER', 'RFQ NO.', 'RFQ', 'RFQ CODE', 'RFQ_NO', 'RFQ NUM', 'RFQ #', 'RFQ#', 'ENQUIRY NUMBER', 'ENQUIRY NO', 'ENQUIRY NO.', 'ENQ NO', 'ENQ NO.', 'ENQUIRY_NO', 'ENQUIRY', 'TENDER NUMBER', 'TENDER NO', 'TENDER NO.', 'TENDER', 'BID NUMBER', 'BID NO', 'BID NO.', 'REQUEST FOR QUOTATION', 'QUOTATION REQUEST NUMBER', 'QUOTATION REQUEST NO', 'RFQ_ID', 'RFQID'],
  'TCD NUMBER': ['TCD NUMBER', 'TCD NO', 'TCD_NUMBER', 'TCD NO.', 'TCD', 'TCD CODE', 'TCD_NO'],
  'TCD DATE': ['TCD DATE', 'TCD_DATE', 'TCD DATE.', 'TCD ON', 'TCD CREATION DATE'],
  'PO NUMBER': ['PO NUMBER', 'PO NO', 'PO_NUMBER', 'PO NO.', 'PO', 'PURCHASE ORDER NUMBER', 'PURCHASE ORDER', 'ORDER NO', 'PO_NO'],
  'PO AMENDMENT NUMBER': ['PO AMENDMENT NUMBER', 'PO AMENDMENT NO', 'PO AMD NO', 'AMENDMENT NUMBER', 'AMENDMENT NO', 'PO AMD', 'PO_AMENDMENT_NUMBER', 'AMD NO', 'AMD NUMBER', 'PO AMENDMENT', 'AMD'],
  'PO QUANTITY': ['PO QUANTITY', 'PO QTY', 'PO_QUANTITY', 'PO_QTY', 'ORDERED QTY', 'ORDER QUANTITY', 'PURCHASE ORDER QTY', 'QUANTITY', 'QTY'],
  'PO DATE': ['PO DATE', 'PO_DATE', 'PO DATE.', 'ORDER DATE', 'PURCHASE ORDER DATE', 'PO ISSUED DATE'],
  'VENDOR NAME': ['VENDOR NAME', 'VENDOR', 'SUPPLIER', 'SUPPLIER NAME', 'VENDOR_NAME', 'PARTY NAME', 'SUPPLIER_NAME', 'VENDOR DESC']
};

/** Format PO Number with Amendment Number if greater than 0 */
export function formatPONumberWithAmendment(rawPoNum, rawAmdNum) {
  const poNum = String(rawPoNum || '').trim();
  if (!poNum) return '';
  const amdStr = String(rawAmdNum || '').trim();
  const amdNum = parseFloat(amdStr);
  if (!isNaN(amdNum) && amdNum > 0) {
    return `${poNum}-${amdStr}`;
  }
  return poNum;
}

/** Normalize single raw row from PO Report */
export function normalizePOReportRow(rawRow) {
  const norm = {};
  const rawKeys = Object.keys(rawRow || {});

  rawKeys.forEach(k => {
    norm[k] = rawRow[k];
  });

  PO_REPORT_COLUMNS.forEach(col => {
    if (norm[col] === undefined) norm[col] = '';
    const aliases = PO_REPORT_ALIAS_MAP[col] || [col];
    const strippedCol = stripKey(col);
    const strippedAliases = aliases.map(stripKey);

    for (const key of rawKeys) {
      const strippedKey = stripKey(key);
      if (strippedKey === strippedCol || strippedAliases.includes(strippedKey)) {
        norm[col] = rawRow[key];
        break;
      }
    }
  });

  // Clean date strings
  ['PRC DATE', 'ALLOCATION DATE', 'TCD DATE', 'PO DATE'].forEach(dateField => {
    if (norm[dateField]) {
      let dateStr = String(norm[dateField]).trim();
      if (dateStr.includes('T')) dateStr = dateStr.split('T')[0];
      if (/^\d{5}$/.test(dateStr)) {
        const excelDate = new Date((parseInt(dateStr, 10) - (25567 + 2)) * 86400 * 1000);
        if (!isNaN(excelDate.getTime())) {
          dateStr = excelDate.toISOString().split('T')[0];
        }
      }
      norm[dateField] = dateStr;
    }
  });

  // Clean numeric PO quantity
  const rawQty = norm['PO QUANTITY'];
  norm['PO QUANTITY'] = (rawQty !== undefined && rawQty !== '' && !isNaN(parseFloat(rawQty))) ? parseFloat(rawQty) : 0;

  // Format effective PO Number
  norm['_EFFECTIVE_PO_NUMBER'] = formatPONumberWithAmendment(norm['PO NUMBER'], norm['PO AMENDMENT NUMBER']);

  return norm;
}

/** Generate sample Excel template for PO Report import */
export function downloadPOReportTemplate() {
  if (!window.XLSX) {
    toast('SheetJS library is not available. Please refresh.', 'error');
    return;
  }

  const state = getState();
  const existingPRCs = state.prcs || [];
  let sampleData = [];
  const todayStr = new Date().toISOString().split('T')[0];

  // Try using existing PRCs and line items if available
  let count = 0;
  for (const prc of existingPRCs) {
    for (const m of (prc.materials || [])) {
      if (count >= 5) break;
      sampleData.push({
        'PRC NUMBER': prc.prNumber,
        'PRC DATE': prc.prDate || prc.createdAt || todayStr,
        'MATERIAL CODE': m.matCode,
        'ALLOCATION NUMBER': m.allocationNumber || prc.allocationNumber || `AL-${prc.prNumber.replace(/\D/g, '') || '2026'}-01`,
        'ALLOCATION DATE': m.allocationDate || prc.allocationDate || todayStr,
        'BUYER NAME': m.buyerName || prc.buyerName || 'Patil Dinay Dilip',
        'RFQ NUMBER': m.rfqNumber || prc.rfqNumber || `RFQ-${prc.prNumber.replace(/\D/g, '') || '2026'}-01`,
        'TCD NUMBER': m.tcdNumber || prc.tcdNumber || `TCD-${prc.prNumber.replace(/\D/g, '') || '2026'}-01`,
        'TCD DATE': m.tcdDate || prc.tcdDate || todayStr,
        'PO NUMBER': `PO-2026-${String(count + 1).padStart(3, '0')}`,
        'PO AMENDMENT NUMBER': count % 2 === 1 ? '1' : '0',
        'PO QUANTITY': parseFloat(m.quantity) || 10,
        'PO DATE': todayStr,
        'VENDOR NAME': prc.vendorName || prc.vendor || 'Al-Bahar & Sons Trading Co.'
      });
      count++;
    }
    if (count >= 5) break;
  }

  // Fallback demo rows if no PRCs exist
  if (!sampleData.length) {
    sampleData = [
      {
        'PRC NUMBER': 'PR-2026-1001',
        'PRC DATE': todayStr,
        'MATERIAL CODE': 'MAT-50281',
        'ALLOCATION NUMBER': 'AL-2026-001',
        'ALLOCATION DATE': todayStr,
        'BUYER NAME': 'Patil Dinay Dilip',
        'RFQ NUMBER': 'RFQ-2026-001',
        'TCD NUMBER': 'TCD-2026-001',
        'TCD DATE': todayStr,
        'PO NUMBER': 'PO-2026-101',
        'PO AMENDMENT NUMBER': '0',
        'PO QUANTITY': 15,
        'PO DATE': todayStr,
        'VENDOR NAME': 'Al-Bahar & Sons Trading Co.'
      },
      {
        'PRC NUMBER': 'PR-2026-1001',
        'PRC DATE': todayStr,
        'MATERIAL CODE': 'MAT-50281',
        'ALLOCATION NUMBER': 'AL-2026-001',
        'ALLOCATION DATE': todayStr,
        'BUYER NAME': 'Patil Dinay Dilip',
        'RFQ NUMBER': 'RFQ-2026-001',
        'TCD NUMBER': 'TCD-2026-001',
        'TCD DATE': todayStr,
        'PO NUMBER': 'PO-2026-101',
        'PO AMENDMENT NUMBER': '1',
        'PO QUANTITY': 10,
        'PO DATE': todayStr,
        'VENDOR NAME': 'Al-Bahar & Sons Trading Co.'
      },
      {
        'PRC NUMBER': 'PR-2026-1001',
        'PRC DATE': todayStr,
        'MATERIAL CODE': 'MAT-70342',
        'ALLOCATION NUMBER': 'AL-2026-001',
        'ALLOCATION DATE': todayStr,
        'BUYER NAME': 'Patil Dinay Dilip',
        'RFQ NUMBER': 'RFQ-2026-001',
        'TCD NUMBER': 'TCD-2026-001',
        'TCD DATE': todayStr,
        'PO NUMBER': 'PO-2026-102',
        'PO AMENDMENT NUMBER': '0',
        'PO QUANTITY': 10,
        'PO DATE': todayStr,
        'VENDOR NAME': 'Kuwait National Materials Co.'
      },
      {
        'PRC NUMBER': 'PR-2026-1002',
        'PRC DATE': todayStr,
        'MATERIAL CODE': 'MAT-88190',
        'ALLOCATION NUMBER': 'AL-2026-002',
        'ALLOCATION DATE': todayStr,
        'BUYER NAME': 'Ahmed Al-Sabah',
        'RFQ NUMBER': 'RFQ-2026-002',
        'TCD NUMBER': 'TCD-2026-002',
        'TCD DATE': todayStr,
        'PO NUMBER': 'PO-2026-103',
        'PO AMENDMENT NUMBER': '2',
        'PO QUANTITY': 15,
        'PO DATE': todayStr,
        'VENDOR NAME': 'Gulf Engineering Solutions'
      }
    ];
  }

  const ws = XLSX.utils.json_to_sheet(sampleData, { header: PO_REPORT_COLUMNS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'PO Line Items Report');

  ws['!cols'] = [
    { wch: 18 }, // PRC NUMBER
    { wch: 16 }, // PRC DATE
    { wch: 18 }, // MATERIAL CODE
    { wch: 20 }, // ALLOCATION NUMBER
    { wch: 16 }, // ALLOCATION DATE
    { wch: 20 }, // BUYER NAME
    { wch: 18 }, // RFQ NUMBER
    { wch: 18 }, // TCD NUMBER
    { wch: 16 }, // TCD DATE
    { wch: 18 }, // PO NUMBER
    { wch: 22 }, // PO AMENDMENT NUMBER
    { wch: 16 }, // PO QUANTITY
    { wch: 16 }, // PO DATE
    { wch: 28 }  // VENDOR NAME
  ];

  XLSX.writeFile(wb, 'PO_Report_Import_Template.xlsx');
  toast('PO Report Excel Template downloaded!', 'success');
}

/** Validate and group PO Report rows by (PRC Number + Material Code) */
export function validatePOReportRows(rawRows) {
  const state = getState();
  const existingPRCs = state.prcs || [];
  const prcMap = new Map();

  existingPRCs.forEach(p => {
    const key = String(p.prNumber || p.id || '').trim().toUpperCase();
    if (key) prcMap.set(key, p);
  });

  const errors = [];
  const normalizedRows = [];
  const groups = {};

  rawRows.forEach((raw, idx) => {
    const rowNum = idx + 2;
    const norm = normalizePOReportRow(raw);
    const rowErrors = [];

    const prcNumber = String(norm['PRC NUMBER'] || '').trim();
    const matCode = String(norm['MATERIAL CODE'] || '').trim();
    const poNum = String(norm['PO NUMBER'] || '').trim();
    const poQty = parseFloat(norm['PO QUANTITY']) || 0;
    const poDate = String(norm['PO DATE'] || '').trim();

    if (!prcNumber) rowErrors.push('PRC NUMBER is required');
    if (!matCode) rowErrors.push('MATERIAL CODE is required');
    if (!poNum) rowErrors.push('PO NUMBER is required');
    if (poQty <= 0) rowErrors.push('PO QUANTITY must be greater than 0');
    if (!poDate) rowErrors.push('PO DATE is required');

    norm._rowNum = rowNum;
    norm._errors = rowErrors;
    norm._isValid = rowErrors.length === 0;

    if (rowErrors.length > 0) {
      errors.push({ row: rowNum, errors: rowErrors, data: norm });
    }

    normalizedRows.push(norm);

    if (prcNumber && matCode) {
      const groupKey = `${prcNumber.toUpperCase()}::${matCode.toUpperCase()}`;
      if (!groups[groupKey]) {
        groups[groupKey] = {
          groupKey,
          prcNumber,
          matCode,
          rows: [],
          cumulatedPOQty: 0,
          rawPoNumbers: new Set(),
          poAmendments: new Set(),
          effectivePoNumbers: new Set(),
          latestEffectivePoNumber: '',
          latestRawPoNumber: '',
          latestAmdNumber: '',
          latestPrcDate: '',
          latestAllocationNumber: '',
          latestAllocationDate: '',
          latestBuyerName: '',
          latestRfqNumber: '',
          latestTcdNumber: '',
          latestTcdDate: '',
          latestPoDate: '',
          latestVendorName: '',
          errors: []
        };
      }
      const g = groups[groupKey];
      g.rows.push(norm);
      if (norm._isValid) {
        g.cumulatedPOQty += poQty;
      } else {
        g.errors.push(...rowErrors);
      }

      if (poNum) g.rawPoNumbers.add(poNum);
      if (norm['PO AMENDMENT NUMBER']) g.poAmendments.add(String(norm['PO AMENDMENT NUMBER']).trim());
      if (norm['_EFFECTIVE_PO_NUMBER']) {
        g.effectivePoNumbers.add(norm['_EFFECTIVE_PO_NUMBER']);
        g.latestEffectivePoNumber = norm['_EFFECTIVE_PO_NUMBER'];
      }
      if (norm['PO NUMBER'] && String(norm['PO NUMBER']).trim()) g.latestRawPoNumber = String(norm['PO NUMBER']).trim();
      if (norm['PO AMENDMENT NUMBER'] && String(norm['PO AMENDMENT NUMBER']).trim()) g.latestAmdNumber = String(norm['PO AMENDMENT NUMBER']).trim();
      if (norm['PRC DATE'] && String(norm['PRC DATE']).trim()) g.latestPrcDate = String(norm['PRC DATE']).trim();
      if (norm['ALLOCATION NUMBER'] && String(norm['ALLOCATION NUMBER']).trim()) g.latestAllocationNumber = String(norm['ALLOCATION NUMBER']).trim();
      if (norm['ALLOCATION DATE'] && String(norm['ALLOCATION DATE']).trim()) g.latestAllocationDate = String(norm['ALLOCATION DATE']).trim();
      if (norm['BUYER NAME'] && String(norm['BUYER NAME']).trim()) g.latestBuyerName = String(norm['BUYER NAME']).trim();
      if (norm['RFQ NUMBER'] && String(norm['RFQ NUMBER']).trim()) g.latestRfqNumber = String(norm['RFQ NUMBER']).trim();
      if (norm['TCD NUMBER'] && String(norm['TCD NUMBER']).trim()) g.latestTcdNumber = String(norm['TCD NUMBER']).trim();
      if (norm['TCD DATE'] && String(norm['TCD DATE']).trim()) g.latestTcdDate = String(norm['TCD DATE']).trim();
      if (norm['PO DATE'] && String(norm['PO DATE']).trim()) g.latestPoDate = String(norm['PO DATE']).trim();
      if (norm['VENDOR NAME'] && String(norm['VENDOR NAME']).trim()) g.latestVendorName = String(norm['VENDOR NAME']).trim();
    }
  });

  // Evaluate each matched group against database
  const processedGroups = Object.values(groups).map(g => {
    const prcUpper = g.prcNumber.toUpperCase();
    const matchedPrc = prcMap.get(prcUpper);
    let matchedMat = null;

    if (matchedPrc) {
      const matUpper = g.matCode.toUpperCase();
      matchedMat = (matchedPrc.materials || []).find(m =>
        String(m.matCode || '').trim().toUpperCase() === matUpper ||
        String(m.id || '').toUpperCase().includes(matUpper)
      );
    }

    const existsPRC = Boolean(matchedPrc);
    const existsMaterial = Boolean(matchedMat);
    const isSkipped = !existsPRC || !existsMaterial;
    let skipReason = '';
    if (!existsPRC) {
      skipReason = `PRC ${g.prcNumber} not found in App PRC Records`;
    } else if (!existsMaterial) {
      skipReason = `Material Code ${g.matCode} not found in PRC ${g.prcNumber} in App`;
    }

    const isValid = g.errors.length === 0 && g.cumulatedPOQty > 0 && existsPRC && existsMaterial;

    return {
      ...g,
      existsPRC,
      existsMaterial,
      isSkipped,
      skipReason,
      prc: matchedPrc,
      material: matchedMat,
      matDescription: matchedMat ? matchedMat.description : `Material ${g.matCode}`,
      unit: matchedMat ? matchedMat.unit : 'EA',
      originalReqQty: matchedMat ? (parseFloat(matchedMat.quantity) || g.cumulatedPOQty) : g.cumulatedPOQty,
      isValid
    };
  });

  const totalRawRows = normalizedRows.length;
  const validGroupsCount = processedGroups.filter(g => g.isValid).length;
  const skippedNotInAppCount = processedGroups.filter(g => !g.existsPRC || !g.existsMaterial).length;
  const skippedPRCCount = processedGroups.filter(g => !g.existsPRC).length;
  const skippedMaterialCount = processedGroups.filter(g => g.existsPRC && !g.existsMaterial).length;
  const errorGroupsCount = processedGroups.filter(g => g.errors.length > 0 || g.cumulatedPOQty <= 0).length;
  const matchedPRCsCount = new Set(processedGroups.filter(g => g.existsPRC && g.existsMaterial).map(g => g.prcNumber.toUpperCase())).size;

  return {
    valid: errors.length === 0,
    errors,
    rawRows: normalizedRows,
    groups: processedGroups,
    summary: {
      totalRows: totalRawRows,
      uniqueLineItems: processedGroups.length,
      validItems: validGroupsCount,
      skippedNotInApp: skippedNotInAppCount,
      skippedPRCCount,
      skippedMaterialCount,
      errorItems: errorGroupsCount,
      matchedPRCs: matchedPRCsCount
    }
  };
}

/** Render preview table for PO Report Line Items */
export function renderPOReportPreviewTable(processedGroups) {
  if (!processedGroups || !processedGroups.length) {
    return `<div class="empty-state" style="padding:24px"><div class="empty-state-title">No line items to display</div></div>`;
  }

  const rowsHtml = processedGroups.map((g, idx) => {
    let statusBadge = '';
    let rowClass = '';

    if (!g.existsPRC) {
      rowClass = 'table-row-error';
      statusBadge = `<span class="chip chip-wrong" style="font-weight:600" title="PRC ${g.prcNumber} is not present in App PRC Records. This line item will be SKIPPED.">⚠️ PRC Not in App (Skipped)</span>`;
    } else if (!g.existsMaterial) {
      rowClass = 'table-row-error';
      statusBadge = `<span class="chip chip-wrong" style="font-weight:600" title="Material Code ${g.matCode} is not present under PRC ${g.prcNumber} in App. This line item will be SKIPPED.">⚠️ Mat Code Not in PRC (Skipped)</span>`;
    } else if (g.errors.length > 0 || g.cumulatedPOQty <= 0) {
      rowClass = 'table-row-error';
      statusBadge = `<span class="chip chip-wrong" title="${g.errors.join(', ')}">❌ ${g.errors[0] || 'Invalid'}</span>`;
    } else {
      statusBadge = `<span class="chip chip-completed" title="PRC and Material line item matched in database">✓ Matched Line Item</span>`;
    }

    const amdDisplay = g.latestAmdNumber && parseFloat(g.latestAmdNumber) > 0
      ? `<span class="badge badge-primary" style="font-size:10px">Amd: ${g.latestAmdNumber}</span>`
      : `<span style="color:var(--color-text-tertiary)">0</span>`;

    const multiRowNote = g.rows.length > 1
      ? `<span class="badge badge-secondary" title="Cumulated from ${g.rows.length} rows in Excel" style="font-size:10px;margin-left:4px">Σ ${g.rows.length} rows</span>`
      : '';

    return `
      <tr class="${rowClass}">
        <td><strong>${idx + 1}</strong></td>
        <td><span class="font-mono font-semibold" style="color:var(--color-primary)">${g.prcNumber}</span></td>
        <td>${g.latestPrcDate || '—'}</td>
        <td><span class="font-mono font-bold">${g.matCode}</span></td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis" title="${g.matDescription}"><strong>${g.matDescription}</strong></td>
        <td><span class="font-mono">${g.latestAllocationNumber || '—'}</span></td>
        <td>${g.latestAllocationDate || '—'}</td>
        <td><strong>${g.latestBuyerName || '—'}</strong></td>
        <td><span class="font-mono">${g.latestRfqNumber || '—'}</span></td>
        <td><span class="font-mono">${g.latestTcdNumber || '—'}</span></td>
        <td>${g.latestTcdDate || '—'}</td>
        <td><span class="font-mono">${g.latestRawPoNumber || '—'}</span></td>
        <td style="text-align:center">${amdDisplay}</td>
        <td><span class="font-mono font-bold" style="color:var(--color-success)">${g.latestEffectivePoNumber || '—'}</span></td>
        <td>
          <span class="chip ${g.isValid ? 'chip-completed' : 'chip-wrong'}" style="font-weight:700">
            ${g.cumulatedPOQty} ${g.unit || ''}
          </span>
          ${multiRowNote}
        </td>
        <td>${g.latestPoDate || '—'}</td>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis" title="${g.latestVendorName || '—'}">${g.latestVendorName || '—'}</td>
        <td>${statusBadge}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="table-wrapper" style="max-height:360px;overflow:auto;border:1px solid var(--color-border);border-radius:8px">
      <table class="data-table" style="font-size:12px;white-space:nowrap">
        <thead>
          <tr>
            <th>#</th>
            <th>PRC Number</th>
            <th>PRC Date</th>
            <th>Material Code</th>
            <th>Description</th>
            <th>Allocation No</th>
            <th>Allocation Date</th>
            <th>Buyer Name</th>
            <th>RFQ Number</th>
            <th>TCD Number</th>
            <th>TCD Date</th>
            <th>Base PO #</th>
            <th>AMD #</th>
            <th>Final PO Number</th>
            <th>Cumulated PO Qty</th>
            <th>PO Date</th>
            <th>Vendor Name</th>
            <th>Validation Status</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

/** Apply PO Report line-item updates strictly for PRCs and Material Codes that exist in App PRC Records */
export function applyPOReportImport(processedGroups, fileName = 'PO_Report.xlsx') {
  // STRICT RULE: Only import for PRCs AND Material Codes that exist in App PRC Records
  const validGroups = (processedGroups || []).filter(g => g.existsPRC && g.existsMaterial && g.isValid);
  const skippedCount = (processedGroups || []).filter(g => !g.existsPRC || !g.existsMaterial).length;

  if (!validGroups.length) {
    toast('No matching PRCs and Material Codes found in App records. All rows for non-existent PRCs or Material Codes were skipped.', 'warning');
    return { success: false, count: 0, skippedCount };
  }

  const state = getState();

  // Create pre-import snapshot for Call Back / Rollback
  const snapshotId = createImportSnapshot(
    'PO Report Line-Item Import',
    fileName,
    `PO Report update for ${validGroups.length} line item(s) across existing App PRCs & Material Codes (${skippedCount} non-existent PRCs/Material Codes skipped).`
  );

  const existingPRCs = [...(state.prcs || [])];
  const existingAllocs = [...(state.allocations || [])];
  const existingRFQs = [...(state.rfqs || [])];
  const existingTCDs = [...(state.tcds || [])];
  const existingPODs = [...(state.pods || [])];

  let updatedMaterialsCount = 0;
  const modifiedPRCIndices = new Set();

  // Track downstream collections to upsert
  const allocDocsMap = {};
  const rfqDocsMap = {};
  const tcdDocsMap = {};
  const podDocsMap = {};

  validGroups.forEach(g => {
    const prcUpper = g.prcNumber.toUpperCase();
    let prcIdx = existingPRCs.findIndex(p => String(p.prNumber || p.id || '').trim().toUpperCase() === prcUpper);

    // If PRC is not found in existing records, skip completely (do NOT create new PRC)
    if (prcIdx === -1) {
      return;
    }

    const prc = { ...existingPRCs[prcIdx], materials: [...(existingPRCs[prcIdx].materials || [])] };

    const matUpper = g.matCode.toUpperCase();
    let matIdx = prc.materials.findIndex(m =>
      String(m.matCode || '').trim().toUpperCase() === matUpper ||
      String(m.id || '').toUpperCase().includes(matUpper)
    );

    // If Material Code is not found under this existing PRC, skip completely (do NOT create new material)
    if (matIdx === -1) {
      return;
    }

    modifiedPRCIndices.add(prcIdx);
    const material = { ...prc.materials[matIdx] };

    // 1. Update Quantities: PO Quantity, RFQ Quantity & TCD Quantity = Cumulated PO Quantity
    const cumQty = g.cumulatedPOQty;
    material.poQuantity = cumQty;
    material.rfqQuantity = cumQty;
    material.tcdQuantity = cumQty;
    material.processedQty = cumQty;

    const baseReqQty = parseFloat(material.quantity) || 0;
    if (baseReqQty < cumQty) {
      material.quantity = cumQty; // Adjust requisition quantity if PO qty exceeds initial
    }
    const clsQty = parseFloat(material.closedQty) || 0;
    material.pendingQty = Math.max(0, (material.quantity || cumQty) - cumQty - clsQty);

    // 2. Update Allocation fields
    if (g.latestAllocationNumber) {
      material.allocationNumber = g.latestAllocationNumber;
      material.allocationDate = g.latestAllocationDate;
      material.buyerName = g.latestBuyerName;
      material.allocatedBy = g.latestBuyerName;
    }

    // 3. Update Workflow identifiers
    if (g.latestRfqNumber) {
      material.rfqNumber = g.latestRfqNumber;
      if (!material.rfqDate && (g.latestTcdDate || g.latestPoDate || g.latestAllocationDate)) {
        material.rfqDate = g.latestTcdDate || g.latestPoDate || g.latestAllocationDate;
      }
    }
    if (g.latestTcdNumber) material.tcdNumber = g.latestTcdNumber;
    if (g.latestTcdDate) material.tcdDate = g.latestTcdDate;
    material.tcdApproved = true;
    if (g.latestEffectivePoNumber) material.poNumber = g.latestEffectivePoNumber;
    if (g.latestAmdNumber) material.poAmendmentNumber = g.latestAmdNumber;
    if (g.latestPoDate) material.poDate = g.latestPoDate;
    if (g.latestVendorName) material.vendorName = g.latestVendorName;

    // Recalculate Material Status
    material.status = calculateMaterialStatus ? calculateMaterialStatus(material) : 'Process Completed';
    prc.materials[matIdx] = material;
    updatedMaterialsCount++;

    // 4. Update PRC Header
    if (g.latestPrcDate) {
      prc.prDate = g.latestPrcDate;
      prc.createdAt = g.latestPrcDate;
    }
    if (g.latestAllocationNumber) {
      prc.allocationNumber = g.latestAllocationNumber;
      prc.allocationDate = g.latestAllocationDate;
      prc.buyerName = g.latestBuyerName;
      prc.allocatedBy = g.latestBuyerName;
    }
    if (g.latestRfqNumber) {
      prc.rfqNumber = g.latestRfqNumber;
      if (!prc.rfqDate && (g.latestTcdDate || g.latestPoDate || g.latestAllocationDate)) {
        prc.rfqDate = g.latestTcdDate || g.latestPoDate || g.latestAllocationDate;
      }
    }
    if (g.latestTcdNumber) prc.tcdNumber = g.latestTcdNumber;
    if (g.latestTcdDate) prc.tcdDate = g.latestTcdDate;
    prc.tcdApproved = true;
    prc.offersReceived = true;
    if (g.latestEffectivePoNumber) prc.poNumber = g.latestEffectivePoNumber;
    if (g.latestPoDate) prc.poDate = g.latestPoDate;
    if (g.latestVendorName) {
      prc.vendorName = g.latestVendorName;
      prc.vendor = g.latestVendorName;
    }
    prc.updatedAt = new Date().toISOString();
    prc.status = calculateStatus ? calculateStatus(prc, prc.materials) : 'Process Completed';

    existingPRCs[prcIdx] = prc;

    // 5. Collect for downstream Allocations, RFQs, TCDs, and PODs
    const itemData = {
      prcId: prc.id,
      materialId: material.id,
      prNumber: prc.prNumber,
      matCode: material.matCode,
      description: material.description,
      quantity: cumQty,
      poQuantity: cumQty,
      rfqQuantity: cumQty,
      tcdQuantity: cumQty,
      unit: material.unit || 'EA',
      allocationNumber: g.latestAllocationNumber || '',
      allocationDate: g.latestAllocationDate || '',
      buyerName: g.latestBuyerName || prc.buyerName || '',
      rfqNumber: g.latestRfqNumber || '',
      tcdNumber: g.latestTcdNumber || '',
      tcdDate: g.latestTcdDate || '',
      poNumber: g.latestEffectivePoNumber || '',
      poDate: g.latestPoDate || '',
      vendorName: g.latestVendorName || prc.vendorName || ''
    };

    if (g.latestAllocationNumber) {
      const aKey = g.latestAllocationNumber.toUpperCase();
      if (!allocDocsMap[aKey]) {
        allocDocsMap[aKey] = {
          allocationNumber: g.latestAllocationNumber,
          allocationDate: g.latestAllocationDate || new Date().toISOString().split('T')[0],
          buyerName: g.latestBuyerName || 'Assigned Buyer',
          allocatedBy: g.latestBuyerName || 'Assigned Buyer',
          items: []
        };
      }
      allocDocsMap[aKey].items.push(itemData);
    }

    if (g.latestRfqNumber) {
      const rKey = g.latestRfqNumber.toUpperCase();
      if (!rfqDocsMap[rKey]) {
        rfqDocsMap[rKey] = {
          rfqNumber: g.latestRfqNumber,
          rfqDate: g.latestTcdDate || g.latestPoDate || new Date().toISOString().split('T')[0],
          tcdNumber: g.latestTcdNumber || '',
          tcdDate: g.latestTcdDate || '',
          items: []
        };
      }
      if (g.latestTcdNumber && !rfqDocsMap[rKey].tcdNumber) {
        rfqDocsMap[rKey].tcdNumber = g.latestTcdNumber;
        rfqDocsMap[rKey].tcdDate = g.latestTcdDate || '';
      }
      rfqDocsMap[rKey].items.push(itemData);
    }

    if (g.latestTcdNumber) {
      const tKey = g.latestTcdNumber.toUpperCase();
      if (!tcdDocsMap[tKey]) {
        tcdDocsMap[tKey] = {
          tcdNumber: g.latestTcdNumber,
          tcdDate: g.latestTcdDate || g.latestPoDate || new Date().toISOString().split('T')[0],
          rfqNumber: g.latestRfqNumber || '',
          poNumber: g.latestEffectivePoNumber || '',
          poDate: g.latestPoDate || '',
          vendorName: g.latestVendorName || prc.vendorName || 'Assigned Vendor',
          approved: true,
          items: []
        };
      }
      if (g.latestEffectivePoNumber && !tcdDocsMap[tKey].poNumber) {
        tcdDocsMap[tKey].poNumber = g.latestEffectivePoNumber;
        tcdDocsMap[tKey].poDate = g.latestPoDate || '';
      }
      tcdDocsMap[tKey].items.push(itemData);
    }

    if (g.latestEffectivePoNumber) {
      const pKey = g.latestEffectivePoNumber.toUpperCase();
      if (!podDocsMap[pKey]) {
        podDocsMap[pKey] = {
          poNumber: g.latestEffectivePoNumber,
          poDate: g.latestPoDate || new Date().toISOString().split('T')[0],
          tcdNumber: g.latestTcdNumber || '',
          vendorName: g.latestVendorName || prc.vendorName || 'Assigned Vendor',
          items: []
        };
      }
      podDocsMap[pKey].items.push(itemData);
    }
  });

  // 6. Upsert Allocations
  const updatedAllocs = [...existingAllocs];
  Object.values(allocDocsMap).forEach(alloc => {
    const exIdx = updatedAllocs.findIndex(a => String(a.allocationNumber || '').trim().toUpperCase() === alloc.allocationNumber.toUpperCase());
    if (exIdx !== -1) {
      const ex = updatedAllocs[exIdx];
      const mergedItems = [...(ex.items || [])];
      const keySet = new Set(mergedItems.map(i => `${i.prcId}::${i.materialId}`));
      alloc.items.forEach(it => {
        const k = `${it.prcId}::${it.materialId}`;
        if (!keySet.has(k)) { mergedItems.push(it); keySet.add(k); }
        else {
          const match = mergedItems.find(i => `${i.prcId}::${i.materialId}` === k);
          if (match) match.quantity = it.quantity;
        }
      });
      updatedAllocs[exIdx] = { ...ex, buyerName: alloc.buyerName, allocationDate: alloc.allocationDate, items: mergedItems, updatedAt: new Date().toISOString() };
    } else {
      updatedAllocs.unshift({
        id: `alloc-auto-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        allocationNumber: alloc.allocationNumber,
        allocationDate: alloc.allocationDate,
        buyerName: alloc.buyerName,
        allocatedBy: alloc.allocatedBy,
        items: alloc.items,
        status: 'Active',
        createdAt: new Date().toISOString(),
        createdBy: 'PO Report Import'
      });
    }
  });

  // 7. Upsert RFQs (Updating TCD Number & items with TCD Number)
  const updatedRFQs = [...existingRFQs];
  Object.values(rfqDocsMap).forEach(rfq => {
    const exIdx = updatedRFQs.findIndex(r => String(r.rfqNumber || '').trim().toUpperCase() === rfq.rfqNumber.toUpperCase());
    if (exIdx !== -1) {
      const ex = updatedRFQs[exIdx];
      const mergedItems = [...(ex.items || [])];
      const keySet = new Set(mergedItems.map(i => `${i.prcId}::${i.materialId}`));
      rfq.items.forEach(it => {
        const k = `${it.prcId}::${it.materialId}`;
        if (!keySet.has(k)) { mergedItems.push(it); keySet.add(k); }
        else {
          const match = mergedItems.find(i => `${i.prcId}::${i.materialId}` === k);
          if (match) {
            match.quantity = it.quantity;
            if (it.tcdNumber) match.tcdNumber = it.tcdNumber;
            if (it.tcdDate) match.tcdDate = it.tcdDate;
          }
        }
      });
      const hasTCD = Boolean(rfq.tcdNumber || ex.tcdNumber);
      updatedRFQs[exIdx] = {
        ...ex,
        tcdNumber: rfq.tcdNumber || ex.tcdNumber || '',
        tcdDate: rfq.tcdDate || ex.tcdDate || '',
        status: hasTCD ? 'Closed' : ex.status,
        isClosed: hasTCD ? true : ex.isClosed,
        closedAt: hasTCD ? (ex.closedAt || rfq.tcdDate || new Date().toISOString()) : ex.closedAt,
        closedBy: hasTCD ? (ex.closedBy || 'PO Report Import (TCD Created)') : ex.closedBy,
        items: mergedItems,
        updatedAt: new Date().toISOString()
      };
    } else {
      updatedRFQs.unshift({
        id: `rfq-auto-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        rfqNumber: rfq.rfqNumber,
        rfqDate: rfq.rfqDate,
        tcdNumber: rfq.tcdNumber || '',
        tcdDate: rfq.tcdDate || '',
        items: rfq.items,
        status: 'Closed',
        isClosed: true,
        closedAt: rfq.tcdDate || new Date().toISOString(),
        closedBy: 'PO Report Import (TCD Created)',
        createdAt: new Date().toISOString(),
        createdBy: 'PO Report Import'
      });
    }
  });

  // 8. Upsert TCDs (Updating PO Number specifically for this TCD)
  const updatedTCDs = [...existingTCDs];
  Object.values(tcdDocsMap).forEach(tcd => {
    const exIdx = updatedTCDs.findIndex(t => String(t.tcdNumber || '').trim().toUpperCase() === tcd.tcdNumber.toUpperCase());
    if (exIdx !== -1) {
      const ex = updatedTCDs[exIdx];
      const vendorAllocations = ex.vendorAllocations || ex.vendors || [{ vendorName: tcd.vendorName || 'Assigned Vendor', items: [] }];
      const primaryVA = vendorAllocations[0] || { vendorName: tcd.vendorName || 'Assigned Vendor', items: [] };
      const mergedItems = [...(primaryVA.items || [])];
      const keySet = new Set(mergedItems.map(i => `${i.prcId}::${i.materialId}`));
      tcd.items.forEach(it => {
        const k = `${it.prcId}::${it.materialId}`;
        if (!keySet.has(k)) { mergedItems.push(it); keySet.add(k); }
        else {
          const match = mergedItems.find(i => `${i.prcId}::${i.materialId}` === k);
          if (match) {
            match.quantity = it.quantity;
            if (it.poNumber) match.poNumber = it.poNumber;
            if (it.poDate) match.poDate = it.poDate;
          }
        }
      });
      primaryVA.items = mergedItems;
      primaryVA.vendorName = tcd.vendorName || primaryVA.vendorName;
      primaryVA.poNumber = tcd.poNumber || primaryVA.poNumber || '';
      primaryVA.poDate = tcd.poDate || primaryVA.poDate || '';
      vendorAllocations[0] = primaryVA;

      updatedTCDs[exIdx] = {
        ...ex,
        rfqNumber: tcd.rfqNumber || ex.rfqNumber || '',
        poNumber: tcd.poNumber || ex.poNumber || '',
        poDate: tcd.poDate || ex.poDate || '',
        approved: true,
        status: 'Approved',
        vendorAllocations,
        vendors: vendorAllocations,
        updatedAt: new Date().toISOString()
      };
    } else {
      updatedTCDs.unshift({
        id: `tcd-auto-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        tcdNumber: tcd.tcdNumber,
        tcdDate: tcd.tcdDate,
        rfqNumber: tcd.rfqNumber,
        poNumber: tcd.poNumber || '',
        poDate: tcd.poDate || '',
        approved: true,
        status: 'Approved',
        vendorAllocations: [{
          vendorName: tcd.vendorName || 'Assigned Vendor',
          poNumber: tcd.poNumber || '',
          poDate: tcd.poDate || '',
          items: tcd.items
        }],
        vendors: [{
          vendorName: tcd.vendorName || 'Assigned Vendor',
          poNumber: tcd.poNumber || '',
          poDate: tcd.poDate || '',
          items: tcd.items
        }],
        createdAt: new Date().toISOString(),
        createdBy: 'PO Report Import'
      });
    }
  });

  // 9. Upsert PODs
  const updatedPODs = [...existingPODs];
  Object.values(podDocsMap).forEach(pod => {
    const exIdx = updatedPODs.findIndex(p => String(p.poNumber || '').trim().toUpperCase() === pod.poNumber.toUpperCase());
    if (exIdx !== -1) {
      const ex = updatedPODs[exIdx];
      const mergedItems = [...(ex.items || [])];
      const keySet = new Set(mergedItems.map(i => `${i.prcId}::${i.materialId}`));
      pod.items.forEach(it => {
        const k = `${it.prcId}::${it.materialId}`;
        if (!keySet.has(k)) { mergedItems.push(it); keySet.add(k); }
        else {
          const match = mergedItems.find(i => `${i.prcId}::${i.materialId}` === k);
          if (match) match.quantity = it.quantity;
        }
      });
      updatedPODs[exIdx] = { ...ex, tcdNumber: pod.tcdNumber || ex.tcdNumber, poDate: pod.poDate, vendorName: pod.vendorName || ex.vendorName, status: 'Issued', items: mergedItems, updatedAt: new Date().toISOString() };
    } else {
      updatedPODs.unshift({
        id: `pod-auto-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        poNumber: pod.poNumber,
        poDate: pod.poDate,
        tcdNumber: pod.tcdNumber,
        vendorName: pod.vendorName,
        status: 'Issued',
        items: pod.items,
        createdAt: new Date().toISOString(),
        createdBy: 'PO Report Import'
      });
    }
  });

  const summary = buildStatusSummary ? buildStatusSummary(existingPRCs) : state.statusSummary;

  // Commit updated state
  setState({
    prcs: existingPRCs,
    allocations: updatedAllocs,
    rfqs: updatedRFQs,
    tcds: updatedTCDs,
    pods: updatedPODs,
    statusSummary: summary
  });

  const updatedPRCCount = modifiedPRCIndices.size;
  const createdPRCCount = 0;

  // Audit log
  addAuditLog({
    action: 'po_report_import_excel',
    collection: 'PODs',
    docId: 'bulk_import',
    changes: {
      summary: `PO Report Import via Excel: ${validGroups.length} line items updated across ${updatedPRCCount} existing App PRCs (${skippedCount} non-existent PRCs skipped), with cumulated PO/RFQ/TCD quantities, allocation, and vendor records.`
    }
  });

  // Push to Cloud / Firestore
  try {
    pushLocalDataToFirestore();
  } catch (syncErr) {
    console.warn('Firestore sync note for PO Report Import:', syncErr);
  }

  return {
    success: true,
    lineItemsUpdated: validGroups.length,
    updatedPRCCount,
    createdPRCCount: 0,
    skippedCount,
    materialsUpdated: updatedMaterialsCount,
    posCreatedOrUpdated: Object.keys(podDocsMap).length,
    allocationsCreatedOrUpdated: Object.keys(allocDocsMap).length,
    snapshotId
  };
}



