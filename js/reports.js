// =========================================================
// REPORTS MODULE — Excel, PDF, CSV export
// =========================================================
import { getState, getFilteredPRCs, getFilteredMaterials } from './state.js';
import { fmtDate, toCSV, downloadText, toast } from './utils.js';
import { calculateStatus, calculateMaterialStatus, getPRCAge } from './status-engine.js';

/**
 * Resolve comprehensive procurement document summary for a PRC
 */
export function getPRCDocuments(prc) {
  if (!prc) return { allocNo: '—', allocDate: '—', buyer: '—', rfqNo: '—', rfqDate: '—', tcdNo: '—', tcdDate: '—', poNo: '—', poDate: '—', vendor: '—' };
  const mats = prc.materials || [];

  // 1. Allocation
  const allocNums = new Set();
  const allocDates = new Set();
  const buyers = new Set();
  if (prc.allocationNumber) allocNums.add(String(prc.allocationNumber).trim());
  if (prc.allocationDate) allocDates.add(String(prc.allocationDate).trim());
  if (prc.buyerName) buyers.add(String(prc.buyerName).trim());
  if (prc.allocatedBy) buyers.add(String(prc.allocatedBy).trim());

  mats.forEach(m => {
    if (m.allocationNumber) allocNums.add(String(m.allocationNumber).trim());
    if (m.allocationDate) allocDates.add(String(m.allocationDate).trim());
    if (m.buyerName) buyers.add(String(m.buyerName).trim());
    if (m.allocatedBy) buyers.add(String(m.allocatedBy).trim());
  });

  // 2. RFQ
  const rfqNums = new Set();
  const rfqDates = new Set();
  if (prc.rfqNumber) rfqNums.add(String(prc.rfqNumber).trim());
  if (prc.rfqDate) rfqDates.add(String(prc.rfqDate).trim());

  mats.forEach(m => {
    if (m.rfqNumber) rfqNums.add(String(m.rfqNumber).trim());
    if (m.rfqDate) rfqDates.add(String(m.rfqDate).trim());
  });

  // 3. TCD
  const tcdNums = new Set();
  const tcdDates = new Set();
  if (prc.tcdNumber) tcdNums.add(String(prc.tcdNumber).trim());
  if (prc.tcdDate) tcdDates.add(String(prc.tcdDate).trim());

  mats.forEach(m => {
    if (m.tcdNumber) tcdNums.add(String(m.tcdNumber).trim());
    if (m.tcdDate) tcdDates.add(String(m.tcdDate).trim());
  });

  // 4. PO
  const poNums = new Set();
  const poDates = new Set();
  if (prc.poNumber) poNums.add(String(prc.poNumber).trim());
  if (prc.poDate) poDates.add(String(prc.poDate).trim());

  mats.forEach(m => {
    if (m.poNumber) poNums.add(String(m.poNumber).trim());
    if (m.poDate) poDates.add(String(m.poDate).trim());
  });

  // 5. Vendor
  const vendors = new Set();
  if (prc.vendorName) vendors.add(String(prc.vendorName).trim());
  if (prc.vendor) vendors.add(String(prc.vendor).trim());
  mats.forEach(m => {
    if (m.vendorName) vendors.add(String(m.vendorName).trim());
    if (m.vendor) vendors.add(String(m.vendor).trim());
  });

  return {
    allocNo: Array.from(allocNums).filter(Boolean).join(', ') || '—',
    allocDate: Array.from(allocDates).filter(Boolean).map(d => fmtDate(d)).join(', ') || '—',
    buyer: Array.from(buyers).filter(Boolean).join(', ') || '—',
    rfqNo: Array.from(rfqNums).filter(Boolean).join(', ') || '—',
    rfqDate: Array.from(rfqDates).filter(Boolean).map(d => fmtDate(d)).join(', ') || '—',
    tcdNo: Array.from(tcdNums).filter(Boolean).join(', ') || '—',
    tcdDate: Array.from(tcdDates).filter(Boolean).map(d => fmtDate(d)).join(', ') || '—',
    poNo: Array.from(poNums).filter(Boolean).join(', ') || '—',
    poDate: Array.from(poDates).filter(Boolean).map(d => fmtDate(d)).join(', ') || '—',
    vendor: Array.from(vendors).filter(Boolean).join(', ') || '—'
  };
}

/**
 * Resolve comprehensive procurement document summary for a single Material
 */
export function getMaterialDocuments(mat, prc = null) {
  if (!mat) return { allocNo: '—', allocDate: '—', buyer: '—', rfqNo: '—', rfqDate: '—', tcdNo: '—', tcdDate: '—', poNo: '—', poDate: '—', vendor: '—' };

  const allocNo = mat.allocationNumber || (prc?.allocationNumber) || '—';
  const allocDate = (mat.allocationDate || prc?.allocationDate) ? fmtDate(mat.allocationDate || prc?.allocationDate) : '—';
  const buyer = mat.buyerName || mat.allocatedBy || (prc?.buyerName) || (prc?.allocatedBy) || '—';

  const rfqNo = mat.rfqNumber || (prc?.rfqNumber) || '—';
  const rfqDate = (mat.rfqDate || prc?.rfqDate) ? fmtDate(mat.rfqDate || prc?.rfqDate) : '—';

  const tcdNo = mat.tcdNumber || (prc?.tcdNumber) || '—';
  const tcdDate = (mat.tcdDate || prc?.tcdDate) ? fmtDate(mat.tcdDate || prc?.tcdDate) : '—';

  const rawPo = mat.poNumber || (prc?.poNumber) || '';
  const poNo = (rawPo && !rawPo.startsWith('pod-')) ? rawPo : '—';
  const poDate = (mat.poDate || prc?.poDate) ? fmtDate(mat.poDate || prc?.poDate) : '—';

  const vendor = mat.vendorName || mat.vendor || (prc?.vendorName) || (prc?.vendor) || '—';

  return {
    allocNo,
    allocDate,
    buyer,
    rfqNo,
    rfqDate,
    tcdNo,
    tcdDate,
    poNo,
    poDate,
    vendor
  };
}

export const REPORT_COLUMNS = {
  prc: [
    { key: 'prNumber',         label: 'PR Number' },
    { key: 'status',           label: 'Status', accessor: p => calculateStatus(p) },
    { key: 'department',       label: 'Department' },
    { key: 'job',              label: 'Job', accessor: p => p.job || p.jobNumber || '—' },
    { key: 'priority',         label: 'Priority' },
    { key: 'engineer',         label: 'Engineer', accessor: p => p.engineer || p.prCreatedBy || '—' },
    { key: 'allocationNumber', label: 'Allocation No.', accessor: p => getPRCDocuments(p).allocNo },
    { key: 'allocationDate',   label: 'Allocation Date', accessor: p => getPRCDocuments(p).allocDate },
    { key: 'buyerName',        label: 'Buyer Name', accessor: p => getPRCDocuments(p).buyer },
    { key: 'rfqNumber',        label: 'RFQ No.', accessor: p => getPRCDocuments(p).rfqNo },
    { key: 'rfqDate',          label: 'RFQ Date', accessor: p => getPRCDocuments(p).rfqDate },
    { key: 'tcdNumber',        label: 'TCD No.', accessor: p => getPRCDocuments(p).tcdNo },
    { key: 'tcdDate',          label: 'TCD Date', accessor: p => getPRCDocuments(p).tcdDate },
    { key: 'poNumber',         label: 'PO No.', accessor: p => getPRCDocuments(p).poNo },
    { key: 'poDate',           label: 'PO Date', accessor: p => getPRCDocuments(p).poDate },
    { key: 'vendorName',       label: 'Vendor', accessor: p => getPRCDocuments(p).vendor },
    { key: 'createdAt',        label: 'Created', accessor: p => fmtDate(p.createdAt || p.prDate) },
    { key: 'age',              label: 'Age (Days)', accessor: p => `${getPRCAge(p)}d` },
    { key: 'remarks',          label: 'Remarks', accessor: p => p.remarks || '' }
  ],
  material: [
    { key: 'prNumber',         label: 'PR Number' },
    { key: 'serialNumber',     label: 'Sl No.', accessor: m => m.serialNumber || '—' },
    { key: 'matCode',          label: 'Material Code' },
    { key: 'description',      label: 'Description' },
    { key: 'unit',             label: 'Unit', accessor: m => m.unit || '' },
    { key: 'quantity',         label: 'Req Qty', accessor: m => parseFloat(m.quantity) || 0 },
    { key: 'processedQty',     label: 'Processed Qty', accessor: m => parseFloat(m.processedQty) || 0 },
    { key: 'pendingQty',       label: 'Pending Qty', accessor: m => Math.max(0, (parseFloat(m.quantity)||0) - (parseFloat(m.processedQty)||0) - (parseFloat(m.closedQty)||0)) },
    { key: 'closedQty',        label: 'Closed Qty', accessor: m => parseFloat(m.closedQty) || 0 },
    { key: 'status',           label: 'Status', accessor: m => calculateMaterialStatus(m) },
    { key: 'allocationNumber', label: 'Allocation No.', accessor: m => getMaterialDocuments(m).allocNo },
    { key: 'allocationDate',   label: 'Allocation Date', accessor: m => getMaterialDocuments(m).allocDate },
    { key: 'buyerName',        label: 'Buyer Name', accessor: m => getMaterialDocuments(m).buyer },
    { key: 'rfqNumber',        label: 'RFQ No.', accessor: m => getMaterialDocuments(m).rfqNo },
    { key: 'rfqDate',          label: 'RFQ Date', accessor: m => getMaterialDocuments(m).rfqDate },
    { key: 'tcdNumber',        label: 'TCD No.', accessor: m => getMaterialDocuments(m).tcdNo },
    { key: 'tcdDate',          label: 'TCD Date', accessor: m => getMaterialDocuments(m).tcdDate },
    { key: 'poNumber',         label: 'PO No.', accessor: m => getMaterialDocuments(m).poNo },
    { key: 'poDate',           label: 'PO Date', accessor: m => getMaterialDocuments(m).poDate },
    { key: 'vendorName',       label: 'Vendor', accessor: m => getMaterialDocuments(m).vendor },
    { key: 'deliveryDate',     label: 'Delivery Date', accessor: m => fmtDate(m.deliveryDate || m.deliveryEndDate) },
    { key: 'warehouse',        label: 'Warehouse', accessor: m => m.warehouse || '' }
  ]
};

/** Export to CSV */
export function exportCSV(reportType = null) {
  const state = getState();
  const effectiveType = reportType || (state.viewLevel === 'material' ? 'material' : 'prc');
  const cols = REPORT_COLUMNS[effectiveType] || REPORT_COLUMNS.prc;
  const data = effectiveType === 'material' ? getFilteredMaterials() : getFilteredPRCs();
  const csv  = toCSV(data, cols);
  const filename = `${effectiveType === 'material' ? 'Material_Items_Report' : 'PRC_Records_Report'}_${new Date().toISOString().split('T')[0]}.csv`;
  downloadText(csv, filename, 'text/csv');
  toast(`CSV exported — ${data.length} records`, 'success');
}

/** Export to Excel via SheetJS */
export function exportExcel(reportType = null, title = null) {
  if (!window.XLSX) { toast('SheetJS not loaded', 'error'); return; }

  const state = getState();
  const prcs  = getFilteredPRCs();
  const mats  = getFilteredMaterials();
  const effectiveTitle = title || (state.viewLevel === 'material' ? 'Material Items Procurement Report' : 'PRC Procurement Report');

  // Cover sheet data
  const coverData = [
    ['L&T EIP 4.0 — Procurement Report'],
    ['Generated:', new Date().toLocaleString()],
    ['Generated By:', state.currentUser?.name || 'System'],
    ['Total PRCs:', prcs.length],
    ['Total Material Items:', mats.length],
    ['Report Title:', effectiveTitle],
    []
  ];

  const wb = XLSX.utils.book_new();

  // 1. Cover sheet
  const coverWS = XLSX.utils.aoa_to_sheet(coverData);
  XLSX.utils.book_append_sheet(wb, coverWS, 'Summary');

  // 2. PRC Data Sheet (Complete with RFQ No, RFQ Date, Allocation, TCD, PO, Vendor)
  const prcCols = REPORT_COLUMNS.prc;
  const prcHeaders = prcCols.map(c => c.label);
  const prcRows = prcs.map(p =>
    prcCols.map(c => c.accessor ? c.accessor(p) : (p[c.key] ?? ''))
  );
  const prcWS = XLSX.utils.aoa_to_sheet([prcHeaders, ...prcRows]);
  prcWS['!cols'] = prcCols.map(c => ({ wch: Math.max(c.label.length, 15) }));
  XLSX.utils.book_append_sheet(wb, prcWS, 'PRC Records');

  // 3. Material Items Sheet (Complete with RFQ No, RFQ Date, Allocation, TCD, PO, Vendor)
  const matCols = REPORT_COLUMNS.material;
  const matHeaders = matCols.map(c => c.label);
  const matRows = mats.map(m =>
    matCols.map(c => c.accessor ? c.accessor(m) : (m[c.key] ?? ''))
  );
  const matWS = XLSX.utils.aoa_to_sheet([matHeaders, ...matRows]);
  matWS['!cols'] = matCols.map(c => ({ wch: Math.max(c.label.length, 14) }));
  XLSX.utils.book_append_sheet(wb, matWS, 'Material Items');

  const filename = `LNT_EIP4_PRC_Report_${new Date().toISOString().split('T')[0]}.xlsx`;
  XLSX.writeFile(wb, filename);
  toast(`Excel exported — ${prcs.length} PRCs, ${mats.length} materials`, 'success');
}

/** Export to PDF via jsPDF */
export async function exportPDF(title = null) {
  if (!window.jspdf) { toast('jsPDF not loaded', 'error'); return; }

  const { jsPDF } = window.jspdf;
  const state = getState();
  const isMaterialView = state.viewLevel === 'material';
  const prcs = getFilteredPRCs();
  const mats = getFilteredMaterials();
  const reportTitle = title || (isMaterialView ? 'Material Items Report' : 'PRC Procurement Report');

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const primary = [0, 51, 102]; // L&T Corporate Navy
  const pageW   = doc.internal.pageSize.getWidth();
  const pageH   = doc.internal.pageSize.getHeight();

  // Header banner
  doc.setFillColor(...primary);
  doc.rect(0, 0, pageW, 22, 'F');
  // L&T Gold accent line
  doc.setFillColor(255, 184, 0);
  doc.rect(0, 21.5, pageW, 0.8, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('L&T EIP 4.0 — ' + reportTitle, 10, 14);
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.text(`Generated: ${new Date().toLocaleString()} | By: ${state.currentUser?.name || 'User'}`, pageW - 10, 14, { align: 'right' });

  // Summary row
  const sum = state.statusSummary || {};
  doc.setTextColor(40, 40, 40);
  doc.setFontSize(8.5);
  doc.setFillColor(240, 244, 248);
  doc.rect(0, 22, pageW, 11, 'F');
  const sumItems = [
    `Total PRCs: ${prcs.length}`,
    `Total Materials: ${mats.length}`,
    `Completed: ${sum['Process Completed'] || 0}`,
    `Pending: ${sum['Pending'] || 0}`,
    `Partly: ${sum['Partly Completed'] || 0}`,
    `Awaiting: ${sum['Awaiting Offer'] || 0}`
  ];
  sumItems.forEach((s, i) => {
    doc.text(s, 10 + i * 46, 29);
  });

  if (isMaterialView) {
    // Material view PDF
    const cols = [
      'PR Number', 'Mat Code', 'Description', 'Req Qty', 'Proc Qty', 'Status',
      'Allocation No. / Date', 'RFQ No. / Date', 'TCD No. / Date', 'PO No. / Date', 'Vendor'
    ];

    const rows = mats.slice(0, 500).map(m => {
      const docs = getMaterialDocuments(m);
      const allocStr = docs.allocNo !== '—' ? `${docs.allocNo}${docs.allocDate !== '—' ? '\n' + docs.allocDate : ''}` : '—';
      const rfqStr   = docs.rfqNo !== '—' ? `${docs.rfqNo}${docs.rfqDate !== '—' ? '\n' + docs.rfqDate : ''}` : '—';
      const tcdStr   = docs.tcdNo !== '—' ? `${docs.tcdNo}${docs.tcdDate !== '—' ? '\n' + docs.tcdDate : ''}` : '—';
      const poStr    = docs.poNo !== '—' ? `${docs.poNo}${docs.poDate !== '—' ? '\n' + docs.poDate : ''}` : '—';

      return [
        m.prNumber || '—',
        m.matCode || '—',
        (m.description || '—').length > 35 ? (m.description || '').substring(0, 35) + '…' : (m.description || '—'),
        `${m.quantity || 0} ${m.unit || ''}`,
        `${m.processedQty || 0}`,
        calculateMaterialStatus(m),
        allocStr,
        rfqStr,
        tcdStr,
        poStr,
        docs.vendor
      ];
    });

    if (doc.autoTable) {
      doc.autoTable({
        head: [cols],
        body: rows,
        startY: 35,
        theme: 'striped',
        headStyles: { fillColor: primary, textColor: 255, fontSize: 7.5, fontStyle: 'bold' },
        bodyStyles: { fontSize: 6.8, cellPadding: 1.2 },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        margin: { left: 5, right: 5 }
      });
    } else {
      let y = 38;
      doc.setFontSize(7);
      rows.forEach(r => {
        if (y > pageH - 15) { doc.addPage(); y = 20; }
        doc.text(r.join(' | '), 5, y);
        y += 5;
      });
    }
  } else {
    // PRC view PDF
    const cols = [
      'PR Number', 'Status', 'Department', 'Allocation No. & Date', 'RFQ No. & Date', 'TCD No. & Date', 'PO No. & Date', 'Vendor', 'Age'
    ];

    const rows = prcs.slice(0, 500).map(p => {
      const docs = getPRCDocuments(p);
      const allocStr = docs.allocNo !== '—' ? `${docs.allocNo}${docs.allocDate !== '—' ? '\n' + docs.allocDate : ''}` : '—';
      const rfqStr   = docs.rfqNo !== '—' ? `${docs.rfqNo}${docs.rfqDate !== '—' ? '\n' + docs.rfqDate : ''}` : '—';
      const tcdStr   = docs.tcdNo !== '—' ? `${docs.tcdNo}${docs.tcdDate !== '—' ? '\n' + docs.tcdDate : ''}` : '—';
      const poStr    = docs.poNo !== '—' ? `${docs.poNo}${docs.poDate !== '—' ? '\n' + docs.poDate : ''}` : '—';

      return [
        p.prNumber || '—',
        calculateStatus(p),
        p.department || '—',
        allocStr,
        rfqStr,
        tcdStr,
        poStr,
        docs.vendor,
        `${getPRCAge(p)}d`
      ];
    });

    if (doc.autoTable) {
      doc.autoTable({
        head: [cols],
        body: rows,
        startY: 35,
        theme: 'striped',
        headStyles: { fillColor: primary, textColor: 255, fontSize: 8, fontStyle: 'bold' },
        bodyStyles: { fontSize: 7.2, cellPadding: 1.4 },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        margin: { left: 5, right: 5 }
      });
    } else {
      let y = 38;
      doc.setFontSize(7.5);
      rows.forEach(r => {
        if (y > pageH - 15) { doc.addPage(); y = 20; }
        doc.text(r.join(' | '), 5, y);
        y += 5.5;
      });
    }
  }

  // Footer
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7.5);
    doc.setTextColor(150);
    doc.text(`Page ${i} of ${pageCount}`, pageW - 10, pageH - 5, { align: 'right' });
    doc.text('L&T Construction EIP 4.0 — Confidential', 10, pageH - 5);
  }

  const pdfFileName = `${isMaterialView ? 'Material_Items_Report' : 'PRC_Report'}_${new Date().toISOString().split('T')[0]}.pdf`;
  doc.save(pdfFileName);
  toast('PDF exported successfully!', 'success');
}

/** Generate ageing report data calculated from Allocation date to TCD Creation date or current date */
export function getAgeingReport() {
  const prcs = getFilteredPRCs().filter(p => !['Short-Close', 'Short Closed', 'Wrong PRC', 'PR Not Approved', 'Future PRC', 'System Issue'].includes(p.status));
  return prcs.map(p => {
    const ageDays = getPRCAge(p);
    return { ...p, ageDays };
  }).sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0));
}
