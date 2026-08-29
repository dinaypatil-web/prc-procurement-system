// =========================================================
// EXCEL IMPORT ENGINE (SheetJS-based)
// =========================================================
import { toast } from './utils.js';
import { updatePRC, getState, setState, addAuditLog, createAllocation, pushLocalDataToFirestore } from './state.js';
import { calculateStatus, calculateMaterialStatus, buildStatusSummary } from './status-engine.js';

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
export function mergeImport(rows) {
  const state     = getState();
  const existing  = state.prcs || [];
  const results   = { new: 0, skipped: 0, skippedPRCs: [], duplicateRows: 0 };

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
export function applyBulkAllocationImport(processedRows) {
  const validRows = processedRows.filter(r => r.isValid);
  if (!validRows.length) {
    toast('No valid rows to allocate', 'warning');
    return { success: false, count: 0 };
  }

  const state = getState();
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
    materialsAllocated: totalMaterialsAllocated
  };
}

