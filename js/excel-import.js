// =========================================================
// EXCEL IMPORT ENGINE (SheetJS-based)
// =========================================================
import { toast } from './utils.js';
import { updatePRC, getState, setState, addAuditLog } from './state.js';
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

    // Check if PRC already exists in the system — NEVER overwrite or duplicate!
    if (existingPRCSet.has(prUpper)) {
      results.skipped++;
      results.skippedPRCs.push(prNumber);
      return; // Skip completely!
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
      prStatus: String(firstRow['PR STATUS'] || '').trim(),
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

  addAuditLog({
    action: 'import', collection: 'PRCs', docId: 'batch',
    changes: { summary: `New: ${results.new} PRCs imported, Skipped: ${results.skipped} existing PRCs (prevented duplicates/overwriting)` }
  });

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
    'PR STATUS': 'Approved',
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
    'PR STATUS': 'Approved',
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
    'PR STATUS': 'Approved',
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

