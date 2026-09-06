// ==========================================================================
// EXECUTIVE 3D DASHBOARD MODULE
// PRC Procurement System — Live 3D Funnel, 3D Status Doughnut & Live Matrix Table
// ==========================================================================

import { getProcurementFunnelBreakdown } from './status-engine.js';

// Chart instances registry for Executive 3D theme
export const exec3dCharts = {};

export function cleanupExecutive3DCharts() {
  Object.values(exec3dCharts).forEach(c => {
    try { c?.destroy?.(); } catch (e) { /* ignore */ }
  });
  Object.keys(exec3dCharts).forEach(k => delete exec3dCharts[k]);
}

// Current matrix grouping mode ('buyer' | 'department')
let currentMatrixGrouping = 'buyer';

if (typeof window !== 'undefined') {
  window.switchMatrixGrouping = function(mode) {
    currentMatrixGrouping = mode;
    const btnBuyer = document.getElementById('exec3d-btn-by-buyer');
    const btnDept = document.getElementById('exec3d-btn-by-dept');
    if (btnBuyer && btnDept) {
      if (mode === 'buyer') {
        btnBuyer.className = 'btn btn-primary btn-xs';
        btnDept.className = 'btn btn-secondary btn-xs';
      } else {
        btnBuyer.className = 'btn btn-secondary btn-xs';
        btnDept.className = 'btn btn-primary btn-xs';
      }
    }
    const tbody = document.getElementById('exec3d-matrix-tbody');
    if (tbody && window.latestPRCsFor3D) {
      const rows = getLiveProcurementMatrix(window.latestPRCsFor3D, mode);
      tbody.innerHTML = renderMatrixRowsHTML(rows, window.latestPRCsFor3D);
    }
  };
}

/**
 * Generate 3D Stepped Ribbon Funnel SVG
 * Uses real live stages from getProcurementFunnelBreakdown(prcs)
 * Renders high-visibility isometric facets, depth lighting, connector pins,
 * and exact live conversion and drop-off metrics.
 */
export function generate3DFunnelSVG(stages, totalPRCs) {
  const width = 640;
  const height = 370;
  
  if (!stages || !stages.length) {
    return `<div style="text-align:center;padding:40px;color:var(--color-text-secondary)">No funnel stages available</div>`;
  }

  // Curated high-contrast gradients for the 6 stages
  const tierPalettes = [
    { start: '#6366f1', end: '#4f46e5', bevel: '#818cf8', text: '#ffffff' }, // Purple (Imported)
    { start: '#0284c7', end: '#0369a1', bevel: '#38bdf8', text: '#ffffff' }, // Deep Blue (Allocated)
    { start: '#0ea5e9', end: '#0284c7', bevel: '#7dd3fc', text: '#ffffff' }, // Sky/Blue (RFQ Issued)
    { start: '#0d9488', end: '#0f766e', bevel: '#2dd4bf', text: '#ffffff' }, // Teal (Offers In)
    { start: '#10b981', end: '#059669', bevel: '#34d399', text: '#ffffff' }, // Emerald (TCD Done)
    { start: '#059669', end: '#047857', bevel: '#10b981', text: '#ffffff' }  // Dark Emerald (PO Issued)
  ];

  let defs = '';
  let elements = '';
  const numTiers = stages.length;
  const startY = 14;
  const tierHeight = 44;
  const tierGap = 10;
  const centerX = 140;
  const maxTopWidth = 240;
  const minTopWidth = 90;

  for (let i = 0; i < numTiers; i++) {
    const s = stages[i];
    const palette = tierPalettes[i % tierPalettes.length];
    const y = startY + i * (tierHeight + tierGap);
    
    // Smooth tapering widths
    const progressTop = i / numTiers;
    const progressBottom = (i + 1) / numTiers;
    const topW = maxTopWidth - (maxTopWidth - minTopWidth) * progressTop;
    const botW = maxTopWidth - (maxTopWidth - minTopWidth) * progressBottom;
    
    const topLeftX = centerX - topW / 2;
    const topRightX = centerX + topW / 2;
    const botLeftX = centerX - botW / 2;
    const botRightX = centerX + botW / 2;

    const isLast = (i === numTiers - 1);
    const gradId = `funnel-grad-${i}`;
    const shadowId = `funnel-shadow-${i}`;

    defs += `
      <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${palette.start}"/>
        <stop offset="100%" stop-color="${palette.end}"/>
      </linearGradient>
      <filter id="${shadowId}" x="-10%" y="-10%" width="130%" height="140%">
        <feDropShadow dx="0" dy="3" stdDeviation="3" flood-opacity="0.22"/>
      </filter>
    `;

    // Ribbon path (or downward arrow for the bottom stage)
    let ribbonPath = '';
    if (isLast) {
      const arrowPointY = y + tierHeight + 12;
      ribbonPath = `
        M ${topLeftX},${y}
        L ${topRightX},${y}
        L ${centerX},${arrowPointY}
        Z
      `;
    } else {
      ribbonPath = `
        M ${topLeftX},${y}
        L ${topRightX},${y}
        L ${botRightX},${y + tierHeight}
        L ${botLeftX},${y + tierHeight}
        Z
      `;
    }

    // Top 3D Bevel Highlight
    const bevelPath = `
      M ${topLeftX},${y}
      Q ${centerX},${y + 3} ${topRightX},${y}
      L ${topRightX - 2},${y + 3}
      Q ${centerX},${y + 6} ${topLeftX + 2},${y + 3}
      Z
    `;

    // Leader pin line to text on the right
    const pinY = y + tierHeight / 2;
    const pinStartX = isLast ? centerX + 25 : (topRightX + botRightX) / 2 + 6;
    const pinMidX = 275;
    const textStartX = 285;

    const convPct = totalPRCs > 0 ? Math.round((s.count / totalPRCs) * 100) : 0;
    const dropInfo = s.dropCount && s.dropCount > 0 ? `🔻 -${s.dropCount} drop` : '';

    elements += `
      <g class="exec3d-funnel-ribbon" onclick="if(typeof openFunnelReasonsModal==='function'){openFunnelReasonsModal(${i})}else if(typeof filterByDashboardTile==='function'){filterByDashboardTile('status','${s.stage||''}')}" style="cursor:pointer" title="Click to view reasons and PRCs for ${s.label}">
        <!-- 3D Ribbon Face -->
        <path d="${ribbonPath}" fill="url(#${gradId})" filter="url(#${shadowId})" stroke="rgba(255,255,255,0.3)" stroke-width="1.2"/>
        
        <!-- Top Bevel Lighting Curve -->
        <path d="${bevelPath}" fill="${palette.bevel}" opacity="0.65"/>
        
        <!-- Center Count Metric Inside Funnel -->
        <text x="${centerX}" y="${isLast ? y + tierHeight * 0.55 : y + tierHeight * 0.62}" 
              text-anchor="middle" fill="#ffffff" font-size="14.5" font-weight="800" letter-spacing="-0.2" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,0.5))">
          ${s.count.toLocaleString()} PRCs
        </text>

        <!-- Connecting Horizontal Leader Pin -->
        <line x1="${pinStartX}" y1="${pinY}" x2="${pinMidX}" y2="${pinY}" 
              stroke="var(--color-border)" stroke-width="1.5" stroke-dasharray="3,3" opacity="0.85"/>
        <circle cx="${pinStartX}" cy="${pinY}" r="3" fill="${palette.end}"/>
        <circle cx="${pinMidX}" cy="${pinY}" r="3.5" fill="#ffffff" stroke="${palette.end}" stroke-width="2"/>

        <!-- Stage Title & Label on Right -->
        <text x="${textStartX}" y="${pinY - 2}" fill="var(--color-text-primary)" font-size="13" font-weight="700">
          ${s.label}
        </text>
        
        <!-- Conversion % & Drop Delta Tag -->
        <text x="${textStartX}" y="${pinY + 13}" fill="var(--color-text-secondary)" font-size="11" font-weight="600">
          ${convPct}% retained · ${s.count} items ${dropInfo ? `  ${dropInfo}` : ''}
        </text>
      </g>
    `;
  }

  return `
    <svg class="exec3d-funnel-svg" viewBox="0 0 ${width} ${height}">
      <defs>${defs}</defs>
      ${elements}
    </svg>
  `;
}

/**
 * Compute real live Buyer or Department workload matrix from actual PRCs in memory
 */
export function getLiveProcurementMatrix(prcs = [], groupByField = 'buyer') {
  const map = {};
  prcs.forEach(p => {
    let key = 'Unassigned';
    if (groupByField === 'buyer') {
      key = p.buyer || p.allocatedBuyer || p.buyerName || 'Unassigned';
    } else {
      key = p.department || 'General Procurement';
    }
    key = String(key).trim() || 'Unassigned';

    if (!map[key]) {
      map[key] = {
        name: key,
        total: 0,
        completed: 0,
        pending: 0,
        awaiting: 0,
        inputs: 0,
        materials: 0
      };
    }
    const g = map[key];
    g.total++;
    if (p.status === 'Process Completed') g.completed++;
    else if (p.status === 'Awaiting Offer') g.awaiting++;
    else if (p.status === 'Inputs Required') g.inputs++;
    else g.pending++;

    g.materials += (p.materials || []).length;
  });

  return Object.values(map)
    .sort((a, b) => b.total - a.total)
    .map(g => ({
      ...g,
      rate: g.total ? Math.round((g.completed / g.total) * 100) : 0
    }));
}

/**
 * Render matrix tbody rows HTML
 */
function renderMatrixRowsHTML(rows, prcs = []) {
  const totalPRCs = prcs.length;
  const completed = prcs.filter(p => p.status === 'Process Completed').length;
  const pending = prcs.filter(p => p.status !== 'Process Completed' && p.status !== 'Awaiting Offer').length;
  const awaiting = prcs.filter(p => p.status === 'Awaiting Offer').length;
  const totalMats = prcs.reduce((sum, p) => sum + (p.materials || []).length, 0);

  const rowsHtml = rows.map(r => `
    <tr>
      <td style="font-weight:700">
        ${r.name === 'Unassigned' ? '⏳ Unassigned Buyer' : `👤 ${r.name}`}
      </td>
      <td class="exec3d-heat-violet">${r.total.toLocaleString()}</td>
      <td class="exec3d-heat-teal">${r.completed.toLocaleString()}</td>
      <td class="exec3d-heat-coral">${r.pending.toLocaleString()}</td>
      <td>${r.awaiting.toLocaleString()}</td>
      <td>${r.materials.toLocaleString()}</td>
      <td class="exec3d-heat-blue">${r.rate}%</td>
      <td>
        <span class="badge ${r.rate >= 70 ? 'badge-success' : r.rate >= 40 ? 'badge-warning' : 'badge-danger'}">
          ${r.rate >= 70 ? 'Optimal' : r.rate >= 40 ? 'Active' : 'Attention'}
        </span>
      </td>
    </tr>
  `).join('');

  const footerHtml = `
    <tr class="exec3d-table-total-row">
      <td>Total Portfolio</td>
      <td class="exec3d-heat-violet">${totalPRCs.toLocaleString()}</td>
      <td class="exec3d-heat-teal">${completed.toLocaleString()}</td>
      <td class="exec3d-heat-coral">${pending.toLocaleString()}</td>
      <td>${awaiting.toLocaleString()}</td>
      <td>${totalMats.toLocaleString()}</td>
      <td class="exec3d-heat-blue">${totalPRCs ? Math.round((completed / totalPRCs) * 100) : 0}%</td>
      <td><span class="badge badge-primary">Active</span></td>
    </tr>
  `;

  return rowsHtml + footerHtml;
}

/**
 * Render the full Executive 3D Dashboard
 */
export function renderExecutive3D(container, prcs, s, helpers = {}) {
  // Store PRCs globally for matrix tab switcher
  if (typeof window !== 'undefined') {
    window.latestPRCsFor3D = prcs;
  }

  const totalPRCs = prcs.length;
  const completed = s['Process Completed'] || 0;
  const pending = (s['Pending'] || 0) + (s['Authorised'] || 0);
  const awaiting = s['Awaiting Offer'] || 0;
  const inputsReq = s['Inputs Required'] || 0;
  const totalMats = prcs.reduce((sum, p) => sum + (p.materials || []).length, 0);

  // Live Funnel Breakdown using the official status engine
  const funnelStages = getProcurementFunnelBreakdown(prcs);

  // Live Matrix Table
  const matrixRows = getLiveProcurementMatrix(prcs, currentMatrixGrouping);

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  container.innerHTML = `
<div class="exec3d-dashboard stagger-children">

  <!-- ── 1. TOP HEADER & WORKSPACE BANNER ──────────────────── -->
  <div class="exec3d-header-wrap">
    <div class="exec3d-brand">
      <div class="exec3d-logo-badge">3D</div>
      <div class="exec3d-title-group">
        <h1>
          <span>Procurement Operations & Workflow Analytics</span>
          <span style="font-size:11px;font-weight:700;background:rgba(99,102,241,0.15);color:#6366f1;padding:2px 8px;border-radius:12px">Executive 3D</span>
        </h1>
        <div class="exec3d-subtitle">Live Sourcing Pipeline, 3D Funnel & Buyer Performance Matrix · ${dateStr}</div>
      </div>
    </div>

    <!-- Quick Action Filter Pills -->
    <div class="exec3d-nav-pills">
      <button class="exec3d-nav-pill active" onclick="filterByDashboardTile('all')" title="View all records">All PRCs (${totalPRCs.toLocaleString()})</button>
      <button class="exec3d-nav-pill" onclick="filterByDashboardTile('status','Process Completed')" title="View completed PRCs">Completed (${completed.toLocaleString()})</button>
      <button class="exec3d-nav-pill" onclick="filterByDashboardTile('status','Pending')" title="View pending PRCs">Pending (${pending.toLocaleString()})</button>
      <button class="exec3d-nav-pill" onclick="filterByDashboardTile('viewLevel','material')" title="View all materials">Materials (${totalMats.toLocaleString()})</button>
    </div>

    <!-- Right Controls -->
    <div class="exec3d-actions">
      <span style="font-size:11.5px;font-weight:700;color:var(--color-success);background:rgba(16,185,129,0.1);padding:5px 10px;border-radius:8px;display:inline-flex;align-items:center;gap:5px" title="Live database connection active">
        <span>●</span> Live Database (${totalPRCs.toLocaleString()} Records)
      </span>
      <button class="exec3d-theme-toggle" onclick="setDashboardTheme('standard')" title="Switch back to Standard Classic Dashboard Theme">
        <span>📊 Standard Theme</span>
      </button>
    </div>
  </div>

  <!-- ── 2. VIBRANT GRADIENT KPI TILES (100% LIVE METRICS) ───── -->
  <div class="exec3d-kpi-grid">
    <!-- Card 1: Total PRCs -->
    <div class="exec3d-kpi-card kpi-purple" onclick="filterByDashboardTile('all')" title="Click to view all PRCs">
      <div class="exec3d-kpi-top">
        <span class="exec3d-kpi-label">Total PRCs Intake</span>
        <span class="exec3d-kpi-icon">📦</span>
      </div>
      <div class="exec3d-kpi-value">${totalPRCs.toLocaleString()}</div>
      <div class="exec3d-kpi-delta">
        <span>●</span> <span>100% Enterprise Total</span>
      </div>
    </div>

    <!-- Card 2: Process Completed -->
    <div class="exec3d-kpi-card kpi-blue" onclick="filterByDashboardTile('status','Process Completed')" title="Click to view completed PRCs">
      <div class="exec3d-kpi-top">
        <span class="exec3d-kpi-label">Process Completed</span>
        <span class="exec3d-kpi-icon">✅</span>
      </div>
      <div class="exec3d-kpi-value">${completed.toLocaleString()}</div>
      <div class="exec3d-kpi-delta">
        <span>▲</span> <span>${totalPRCs ? Math.round((completed / totalPRCs) * 100) : 0}% Completion Ratio</span>
      </div>
    </div>

    <!-- Card 3: Pending Sourcing -->
    <div class="exec3d-kpi-card kpi-cyan" onclick="filterByDashboardTile('status','Pending')" title="Click to view pending sourcing PRCs">
      <div class="exec3d-kpi-top">
        <span class="exec3d-kpi-label">Pending Sourcing</span>
        <span class="exec3d-kpi-icon">⏳</span>
      </div>
      <div class="exec3d-kpi-value">${pending.toLocaleString()}</div>
      <div class="exec3d-kpi-delta">
        <span>●</span> <span>${totalPRCs ? Math.round((pending / totalPRCs) * 100) : 0}% In Sourcing Pipeline</span>
      </div>
    </div>

    <!-- Card 4: Awaiting Offer -->
    <div class="exec3d-kpi-card kpi-teal" onclick="filterByDashboardTile('status','Awaiting Offer')" title="Click to view PRCs awaiting quotes">
      <div class="exec3d-kpi-top">
        <span class="exec3d-kpi-label">Awaiting Offer</span>
        <span class="exec3d-kpi-icon">📑</span>
      </div>
      <div class="exec3d-kpi-value">${awaiting.toLocaleString()}</div>
      <div class="exec3d-kpi-delta">
        <span>●</span> <span>${awaiting} RFQs Floating</span>
      </div>
    </div>

    <!-- Card 5: Inputs Required / Delays -->
    <div class="exec3d-kpi-card kpi-coral" onclick="filterByDashboardTile('status','Inputs Required')" title="Click to view PRCs requiring inputs">
      <div class="exec3d-kpi-top">
        <span class="exec3d-kpi-label">Inputs Required</span>
        <span class="exec3d-kpi-icon">⚠️</span>
      </div>
      <div class="exec3d-kpi-value">${inputsReq.toLocaleString()}</div>
      <div class="exec3d-kpi-delta">
        <span>●</span> <span>${inputsReq} Clarifications Pending</span>
      </div>
    </div>

    <!-- Card 6: Total Materials -->
    <div class="exec3d-kpi-card kpi-magenta" onclick="filterByDashboardTile('viewLevel','material')" title="Click to view material line items">
      <div class="exec3d-kpi-top">
        <span class="exec3d-kpi-label">Total Material Items</span>
        <span class="exec3d-kpi-icon">🔩</span>
      </div>
      <div class="exec3d-kpi-value">${totalMats.toLocaleString()}</div>
      <div class="exec3d-kpi-delta">
        <span>●</span> <span>Across ${totalPRCs} PRCs</span>
      </div>
    </div>
  </div>

  <!-- ── 3. CHARTS ROW 1: REAL MONTHLY PRC VS TCD (WITH DAY-LEVEL DRILLDOWN) + 3D FUNNEL ── -->
  <div class="exec3d-charts-row-1">
    
    <!-- Chart 1: Real Interactive Monthly PRC Vs Monthly TCD with Day-Level Detailing & Scroller -->
    <div class="exec3d-card chart-card">
      <div class="exec3d-card-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div>
          <div class="exec3d-card-title" id="prc-po-trend-title">Monthly PRC Vs Monthly TCD</div>
          <div class="exec3d-card-subtitle" id="prc-po-trend-subtitle">PRCs created vs TCDs finalized per month · 💡 Click any month for weekly breakdown (±2 Wks)</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <button type="button" id="btn-trend-back-weekly" class="btn btn-secondary btn-xs" style="display:none;padding:3px 9px;font-size:11px;font-weight:600;align-items:center;gap:4px" onclick="returnToWeeklyDrilldown()">
            <span>←</span> <span>Back to Weekly</span>
          </button>
          <button type="button" id="btn-trend-back-monthly" class="btn btn-secondary btn-xs" style="display:none;padding:3px 9px;font-size:11px;font-weight:600;align-items:center;gap:4px" onclick="setDashboardTrendView('monthly')">
            <span>←</span> <span>Back to Monthly Overview</span>
          </button>
          <div class="btn-group" style="display:inline-flex;border:1px solid var(--color-border);border-radius:6px;overflow:hidden;background:var(--color-surface)">
            <button type="button" id="btn-trend-monthly" class="btn btn-primary btn-xs" style="padding:3px 8px;font-size:11px;font-weight:600" onclick="setDashboardTrendView('monthly')">Monthly</button>
            <button type="button" id="btn-trend-weekly" class="btn btn-ghost btn-xs" style="padding:3px 8px;font-size:11px;font-weight:600" onclick="setDashboardTrendView('weekly')">Weekly (10 Wks)</button>
          </div>
        </div>
      </div>
      <div class="chart-canvas-wrap" style="height:280px">
        <canvas id="chart-monthly-trend"></canvas>
      </div>
      <div id="trend-chart-date-scroller" class="trend-date-scroller-wrap"></div>
    </div>

    <!-- Chart 2: 3D STEPPED RIBBON FUNNEL (LIVE ENTERPRISE STAGES) -->
    <div class="exec3d-card exec3d-funnel-card">
      <div class="exec3d-card-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div>
          <div class="exec3d-card-title">3D Procurement Sourcing Funnel</div>
          <div class="exec3d-card-subtitle">Live conversion & bottleneck drop-offs between stages</div>
        </div>
        <button class="btn btn-ghost btn-xs" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 8px;border:1px solid var(--color-border);border-radius:6px;background:var(--color-surface);font-weight:600" onclick="if(typeof openFunnelReasonsModal==='function')openFunnelReasonsModal()" title="View detailed drop-off reasons">
          <span>🔍</span> <span>Drop-off Reasons</span>
        </button>
      </div>
      <div class="exec3d-funnel-container">
        ${generate3DFunnelSVG(funnelStages, totalPRCs)}
      </div>
    </div>
  </div>

  <!-- ── 4. CHARTS ROW 2: 3D STATUS DOUGHNUT + LIVE BUYER/DEPARTMENT MATRIX TABLE ── -->
  <div class="exec3d-charts-row-2">
    <!-- Chart 3: 3D Status Doughnut with Perspective Angle -->
    <div class="exec3d-card">
      <div class="exec3d-card-header">
        <div>
          <div class="exec3d-card-title">Status Distribution (3D)</div>
          <div class="exec3d-card-subtitle">Live breakdown across all active PRC states</div>
        </div>
      </div>
      <div class="exec3d-chart-canvas-wrap">
        <canvas id="exec3d-chart-status"></canvas>
      </div>
    </div>

    <!-- Live Matrix Table -->
    <div class="exec3d-matrix-card" style="margin-top:0">
      <div class="exec3d-card-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div>
          <div class="exec3d-card-title">Buyer & Department Workload Matrix</div>
          <div class="exec3d-card-subtitle">Live procurement distribution, completion rates & pending items</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="btn-group" style="display:inline-flex;border:1px solid var(--color-border);border-radius:6px;overflow:hidden">
            <button id="exec3d-btn-by-buyer" class="btn ${currentMatrixGrouping==='buyer'?'btn-primary':'btn-secondary'} btn-xs" style="padding:4px 10px;font-size:11px;font-weight:600" onclick="switchMatrixGrouping('buyer')">👥 By Buyer</button>
            <button id="exec3d-btn-by-dept" class="btn ${currentMatrixGrouping==='department'?'btn-primary':'btn-secondary'} btn-xs" style="padding:4px 10px;font-size:11px;font-weight:600" onclick="switchMatrixGrouping('department')">🏢 By Department</button>
          </div>
          <button class="btn btn-secondary btn-xs" onclick="navigate('reports')">Export Excel 📊</button>
        </div>
      </div>

      <div class="exec3d-matrix-table-wrap">
        <table class="exec3d-table">
          <thead>
            <tr>
              <th>Assignee / Name</th>
              <th>Total PRCs</th>
              <th>Completed</th>
              <th>Pending</th>
              <th>Awaiting Offer</th>
              <th>Materials</th>
              <th>Completion Rate</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="exec3d-matrix-tbody">
            ${renderMatrixRowsHTML(matrixRows, prcs)}
          </tbody>
        </table>
      </div>
    </div>
  </div>

</div>
  `;

  // Initialize the Chart.js charts for Executive 3D
  setTimeout(() => initExecutive3DCharts(prcs, s), 80);
}

/**
 * Initialize Chart.js graphs for the Executive 3D theme
 */
function initExecutive3DCharts(prcs, s) {
  cleanupExecutive3DCharts();
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  // 1. Render real Monthly PRC Vs Monthly TCD with Day-Level Detailing & Scroller
  if (typeof window.renderTrendChart === 'function') {
    window.renderTrendChart(prcs);
  }

  // 2. 3D Status Extruded Doughnut
  const statusEl = document.getElementById('exec3d-chart-status');
  if (statusEl && window.Chart) {
    const statusLabels = [
      'Process Completed',
      'Pending',
      'Awaiting Offer',
      'Inputs Required',
      'Partly Completed',
      'Wrong PRC',
      'PR Not Approved'
    ];
    const statusData = statusLabels.map(st => s[st] || 0);

    exec3dCharts['status'] = new Chart(statusEl, {
      type: 'doughnut',
      data: {
        labels: statusLabels,
        datasets: [{
          data: statusData,
          backgroundColor: [
            '#10b981', // Completed
            '#0284c7', // Pending
            '#06b6d4', // Awaiting Offer
            '#f43f5e', // Inputs Required
            '#8b5cf6', // Partly Completed
            '#ef4444', // Wrong PRC
            '#a855f7'  // PR Not Approved
          ],
          borderWidth: 3,
          borderColor: isDark ? '#111827' : '#ffffff',
          hoverOffset: 12
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: {
            position: 'right',
            labels: { boxWidth: 11, font: { size: 11, weight: '600' }, padding: 12 }
          },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.label}: ${ctx.raw} PRCs (${prcs.length ? Math.round((ctx.raw / prcs.length) * 100) : 0}%)`
            }
          }
        }
      }
    });
  }
}
