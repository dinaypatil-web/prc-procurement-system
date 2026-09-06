// ==========================================================================
// EXECUTIVE 3D DASHBOARD MODULE
// PRC Procurement System — Live 3D Funnel, 3D Status Doughnut & Live Matrix Table
// ==========================================================================

import { getProcurementFunnelBreakdown } from './status-engine.js';
import { getState, isSuperAdmin, doesRecordPertainToCurrentUser, setTableColumnFilter, clearAllTableColumnFilters } from './state.js';
import { toast } from './utils.js';

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
// Current matrix scope ('all' | 'currentUser')
let currentMatrixScope = 'all';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsString(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/\n/g, ' ');
}

function isCurrentUserMatch(name, user) {
  if (!name || !user) return false;
  const n = String(name).trim().toLowerCase();
  const uName = (user.name || '').trim().toLowerCase();
  const uEmail = (user.email || '').trim().toLowerCase();
  const uId = String(user.id || user.uid || '').trim().toLowerCase();

  if (n === uName || n === uEmail || n === uId) return true;
  if (uName && (n.includes(uName) || uName.includes(n))) return true;
  if (uEmail && n.includes(uEmail)) return true;
  return false;
}

if (typeof window !== 'undefined') {
  window.switchMatrixScope = function(scope) {
    currentMatrixScope = scope;
    const btnAll = document.getElementById('exec3d-scope-all');
    const btnUser = document.getElementById('exec3d-scope-user');
    if (btnAll && btnUser) {
      if (scope === 'all') {
        btnAll.className = 'btn btn-primary btn-xs';
        btnUser.className = 'btn btn-secondary btn-xs';
      } else {
        btnAll.className = 'btn btn-secondary btn-xs';
        btnUser.className = 'btn btn-primary btn-xs';
      }
    }
    const tbody = document.getElementById('exec3d-matrix-tbody');
    if (tbody && window.latestPRCsFor3D) {
      const rows = getLiveProcurementMatrix(window.latestPRCsFor3D, currentMatrixGrouping, currentMatrixScope);
      tbody.innerHTML = renderMatrixRowsHTML(rows, window.latestPRCsFor3D, currentMatrixGrouping, currentMatrixScope);
    }
  };

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
      const rows = getLiveProcurementMatrix(window.latestPRCsFor3D, mode, currentMatrixScope);
      tbody.innerHTML = renderMatrixRowsHTML(rows, window.latestPRCsFor3D, mode, currentMatrixScope);
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
export function getLiveProcurementMatrix(prcs = [], groupByField = 'buyer', scope = 'all') {
  const currentUser = getState()?.currentUser;
  let dataset = prcs;

  if (scope === 'currentUser' && currentUser) {
    dataset = prcs.filter(p => doesRecordPertainToCurrentUser(p, currentUser));
  }

  const map = {};
  dataset.forEach(p => {
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
export function renderMatrixRowsHTML(rows, prcs = [], groupByField = 'buyer', scope = 'all') {
  const currentUser = getState()?.currentUser;
  let relevantPRCs = prcs;
  if (scope === 'currentUser' && currentUser) {
    relevantPRCs = prcs.filter(p => doesRecordPertainToCurrentUser(p, currentUser));
  }

  const totalPRCs = relevantPRCs.length;
  const completed = relevantPRCs.filter(p => p.status === 'Process Completed').length;
  const pending = relevantPRCs.filter(p => p.status !== 'Process Completed' && p.status !== 'Awaiting Offer').length;
  const awaiting = relevantPRCs.filter(p => p.status === 'Awaiting Offer').length;
  const totalMats = relevantPRCs.reduce((sum, p) => sum + (p.materials || []).length, 0);

  if (!rows || rows.length === 0) {
    return `
      <tr>
        <td colspan="9" style="text-align:center;padding:36px 16px;color:var(--color-text-secondary)">
          <div style="font-size:26px;margin-bottom:8px">👤</div>
          <div style="font-weight:700;font-size:13px;color:var(--color-text-primary)">
            No records found for ${escapeHtml(currentUser?.name || 'Current User')}
          </div>
          <div style="font-size:12px;margin-top:4px">
            Switch to "👥 All Buyers" or allocate incoming PRCs to populate this view.
          </div>
        </td>
      </tr>
    `;
  }

  const rowsHtml = rows.map(r => {
    const isUser = isCurrentUserMatch(r.name, currentUser);
    const safeName = escapeHtml(r.name);
    const escapedArg = escapeJsString(r.name);
    const isUnassigned = r.name === 'Unassigned';

    let displayLabel = safeName;
    if (groupByField === 'buyer') {
      displayLabel = isUnassigned ? '⏳ Unassigned Buyer' : `👤 ${safeName}`;
    } else {
      displayLabel = `🏢 ${safeName}`;
    }

    return `
    <tr class="exec3d-row-clickable ${isUser ? 'exec3d-row-current-user' : ''}" 
        onclick="window.openMatrixEntityModal('${escapedArg}', '${groupByField}')"
        title="Click to pop up complete workload data & PRCs for ${safeName}">
      <td style="font-weight:700">
        <div style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span>${displayLabel}</span>
          ${isUser ? '<span class="badge badge-primary" style="font-size:9.5px;padding:2px 7px;font-weight:700;border-radius:10px" title="Active App User">⭐ You</span>' : ''}
        </div>
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
      <td style="text-align:right" onclick="event.stopPropagation()">
        <button class="btn btn-secondary btn-xs exec3d-view-data-btn" 
                onclick="window.openMatrixEntityModal('${escapedArg}', '${groupByField}')"
                title="Pop up complete data for ${safeName}"
                style="padding:3px 9px;font-size:11px;font-weight:700;display:inline-flex;align-items:center;gap:4px">
          <span>👁️ Pop-up Data</span>
        </button>
      </td>
    </tr>
  `;
  }).join('');

  const footerLabel = scope === 'currentUser' ? 'App User Portfolio' : 'Total Portfolio';
  const footerHtml = `
    <tr class="exec3d-table-total-row">
      <td>${footerLabel}</td>
      <td class="exec3d-heat-violet">${totalPRCs.toLocaleString()}</td>
      <td class="exec3d-heat-teal">${completed.toLocaleString()}</td>
      <td class="exec3d-heat-coral">${pending.toLocaleString()}</td>
      <td>${awaiting.toLocaleString()}</td>
      <td>${totalMats.toLocaleString()}</td>
      <td class="exec3d-heat-blue">${totalPRCs ? Math.round((completed / totalPRCs) * 100) : 0}%</td>
      <td><span class="badge badge-primary">Active</span></td>
      <td></td>
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
  const matrixRows = getLiveProcurementMatrix(prcs, currentMatrixGrouping, currentMatrixScope);

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
          <div class="exec3d-card-subtitle">Live procurement distribution, completion rates & pending items · Click any buyer to pop up details</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <!-- Scope Toggle: All vs App User Only -->
          <div class="btn-group" style="display:inline-flex;border:1px solid var(--color-border);border-radius:6px;overflow:hidden">
            <button id="exec3d-scope-all" class="btn ${currentMatrixScope==='all'?'btn-primary':'btn-secondary'} btn-xs" style="padding:4px 10px;font-size:11px;font-weight:600" onclick="switchMatrixScope('all')">👥 All Buyers</button>
            <button id="exec3d-scope-user" class="btn ${currentMatrixScope==='currentUser'?'btn-primary':'btn-secondary'} btn-xs" style="padding:4px 10px;font-size:11px;font-weight:600" onclick="switchMatrixScope('currentUser')">👤 App User Only</button>
          </div>
          <!-- Grouping Toggle: By Buyer vs By Department -->
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
              <th style="text-align:right">Action</th>
            </tr>
          </thead>
          <tbody id="exec3d-matrix-tbody">
            ${renderMatrixRowsHTML(matrixRows, prcs, currentMatrixGrouping, currentMatrixScope)}
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

/**
 * ==========================================================================
 * BUYER & DEPARTMENT WORKLOAD DOSSIER POP-UP MODAL
 * ==========================================================================
 * Pops up full detailed data for any clicked Buyer (or Department)
 */
export function openMatrixEntityModal(entityName, type = 'buyer') {
  const modalId = 'exec3d-entity-modal';
  const existing = document.getElementById(modalId);
  if (existing) existing.remove();

  const state = getState();
  const allPRCs = window.latestPRCsFor3D || state.prcs || [];
  const currentUser = state.currentUser;
  const isAppUser = isCurrentUserMatch(entityName, currentUser);

  // Filter PRCs belonging to this entity
  let entityPRCs = [];
  if (type === 'buyer') {
    if (entityName === 'Unassigned') {
      entityPRCs = allPRCs.filter(p => !p.buyer && !p.allocatedBuyer && !p.buyerName);
    } else {
      entityPRCs = allPRCs.filter(p => {
        const b = String(p.buyer || p.allocatedBuyer || p.buyerName || '').trim().toLowerCase();
        if (b === entityName.trim().toLowerCase()) return true;
        if (isAppUser && doesRecordPertainToCurrentUser(p, currentUser)) return true;
        return false;
      });
    }
  } else {
    entityPRCs = allPRCs.filter(p => {
      const d = String(p.department || 'General Procurement').trim().toLowerCase();
      return d === entityName.trim().toLowerCase();
    });
  }

  // Profile metadata
  const matchingUser = (state.users || []).find(u => isCurrentUserMatch(entityName, u)) || (isAppUser ? currentUser : null);
  const userRole = matchingUser?.role || (type === 'buyer' ? 'Procurement Buyer' : 'Department Portfolio');
  const userEmail = matchingUser?.email || '';
  const userDept = matchingUser?.department || (type === 'department' ? entityName : 'Procurement');
  const avatarLetter = (matchingUser?.name || entityName || 'U').charAt(0).toUpperCase();

  // Metrics
  const total = entityPRCs.length;
  const completed = entityPRCs.filter(p => p.status === 'Process Completed').length;
  const pending = entityPRCs.filter(p => p.status === 'Pending' || p.status === 'Authorised').length;
  const awaiting = entityPRCs.filter(p => p.status === 'Awaiting Offer').length;
  const inputsReq = entityPRCs.filter(p => p.status === 'Inputs Required').length;
  const materialsCount = entityPRCs.reduce((sum, p) => sum + (p.materials || []).length, 0);
  const rate = total ? Math.round((completed / total) * 100) : 0;

  const modalEl = document.createElement('div');
  modalEl.id = modalId;
  modalEl.className = 'modal-overlay open';
  modalEl.style.zIndex = '99999';

  let activeStatusFilter = 'all';
  let activeSearchTerm = '';

  function getFilteredList() {
    let list = entityPRCs;
    if (activeStatusFilter !== 'all') {
      if (activeStatusFilter === 'Completed') list = list.filter(p => p.status === 'Process Completed');
      else if (activeStatusFilter === 'Pending') list = list.filter(p => p.status === 'Pending' || p.status === 'Authorised');
      else if (activeStatusFilter === 'Awaiting') list = list.filter(p => p.status === 'Awaiting Offer');
      else if (activeStatusFilter === 'Inputs') list = list.filter(p => p.status === 'Inputs Required');
    }
    if (activeSearchTerm) {
      const q = activeSearchTerm.toLowerCase();
      list = list.filter(p => 
        (p.prNumber && p.prNumber.toLowerCase().includes(q)) ||
        (p.description && p.description.toLowerCase().includes(q)) ||
        (p.department && p.department.toLowerCase().includes(q)) ||
        (p.materials && p.materials.some(m => (m.matCode && m.matCode.toLowerCase().includes(q)) || (m.description && m.description.toLowerCase().includes(q))))
      );
    }
    return list;
  }

  function renderTableRowsHTML(list) {
    if (!list.length) {
      return `
        <tr>
          <td colspan="7" style="text-align:center;padding:32px;color:var(--color-text-secondary)">
            <div style="font-size:24px;margin-bottom:6px">🔍</div>
            <div style="font-weight:700">No PRCs match the search or status filter</div>
          </td>
        </tr>
      `;
    }

    return list.map(p => {
      const mats = p.materials || [];
      const isDone = p.status === 'Process Completed';
      const isAwaiting = p.status === 'Awaiting Offer';
      const isInputs = p.status === 'Inputs Required';

      const badgeClass = isDone ? 'badge-success' : isInputs ? 'badge-danger' : isAwaiting ? 'badge-info' : 'badge-warning';
      const dateDisplay = p.prDate || p.createdAt || '—';
      const safeDesc = escapeHtml(p.description || p.itemDescription || (mats[0]?.description) || 'General Material Procurement');

      return `
        <tr style="cursor:pointer" onclick="document.getElementById('${modalId}').remove();if(typeof openPRCDetail==='function')openPRCDetail('${p.id}');">
          <td style="font-weight:700;color:var(--color-primary);white-space:nowrap">
            <span style="display:inline-flex;align-items:center;gap:4px">
              📄 ${escapeHtml(p.prNumber || p.id)}
            </span>
          </td>
          <td style="white-space:nowrap;font-size:12px;color:var(--color-text-secondary)">${escapeHtml(dateDisplay)}</td>
          <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${safeDesc}">
            ${safeDesc}
          </td>
          <td style="white-space:nowrap;font-size:12px">${escapeHtml(p.department || 'Procurement')}</td>
          <td style="white-space:nowrap">
            <span class="badge badge-secondary" style="font-size:11px">${mats.length} Items</span>
          </td>
          <td style="white-space:nowrap">
            <span class="badge ${badgeClass}" style="font-size:11px">${escapeHtml(p.status || 'Draft')}</span>
          </td>
          <td style="text-align:right;white-space:nowrap" onclick="event.stopPropagation()">
            <button class="btn btn-ghost btn-xs" onclick="document.getElementById('${modalId}').remove();if(typeof openPRCDetail==='function')openPRCDetail('${p.id}');" title="Open complete PRC details" style="padding:2px 8px;font-size:11px;font-weight:600">
              👁️ View PRC
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  function updateModalBody() {
    const list = getFilteredList();
    const countEl = document.getElementById('exec3d-modal-filtered-count');
    if (countEl) countEl.textContent = `${list.length} of ${total} PRCs`;
    const tbody = document.getElementById('exec3d-modal-tbody');
    if (tbody) tbody.innerHTML = renderTableRowsHTML(list);
  }

  window._exec3dModalSetFilter = function(filter) {
    activeStatusFilter = filter;
    document.querySelectorAll('.exec3d-modal-filter-btn').forEach(b => {
      if (b.getAttribute('data-filter') === filter) {
        b.className = 'btn btn-primary btn-xs exec3d-modal-filter-btn';
      } else {
        b.className = 'btn btn-secondary btn-xs exec3d-modal-filter-btn';
      }
    });
    updateModalBody();
  };

  window._exec3dModalSearch = function(val) {
    activeSearchTerm = val.trim();
    updateModalBody();
  };

  window._exec3dOpenInPRCList = function() {
    document.getElementById(modalId).remove();
    clearAllTableColumnFilters('prc');
    if (type === 'buyer') {
      setTableColumnFilter('prc', 'buyerName', [entityName]);
    } else {
      setTableColumnFilter('prc', 'department', [entityName]);
    }
    if (typeof window.navigate === 'function') {
      window.navigate('prc-list');
    }
    if (typeof toast === 'function') {
      toast(`Filtered PRC Records by ${type === 'buyer' ? 'Buyer' : 'Department'}: ${entityName}`, 'info');
    }
  };

  window._exec3dExportEntityCSV = function() {
    if (!entityPRCs.length) {
      if (typeof toast === 'function') toast('No PRCs to export', 'warning');
      return;
    }
    const headers = ['PR Number', 'Date', 'Description', 'Department', 'Buyer', 'Status', 'Materials Count'];
    const rows = entityPRCs.map(p => [
      p.prNumber || p.id || '',
      p.prDate || p.createdAt || '',
      `"${String(p.description || '').replace(/"/g, '""')}"`,
      `"${String(p.department || '').replace(/"/g, '""')}"`,
      `"${String(p.buyer || p.allocatedBuyer || p.buyerName || '').replace(/"/g, '""')}"`,
      p.status || '',
      (p.materials || []).length
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `${type}_${entityName.replace(/\s+/g, '_')}_PRCs.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (typeof toast === 'function') toast(`Exported ${entityPRCs.length} PRCs to CSV`, 'success');
  };

  modalEl.innerHTML = `
    <div class="modal modal-lg fade-in-up" style="max-width:960px;max-height:92vh;display:flex;flex-direction:column;border-radius:14px;box-shadow:0 25px 60px -12px rgba(0,0,0,0.5);border:1px solid var(--color-border);background:var(--color-surface);overflow:hidden">
      
      <!-- Modal Header -->
      <div class="modal-header" style="flex-shrink:0;padding:18px 24px;border-bottom:1px solid var(--color-border);background:var(--color-surface);display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:14px">
          <div style="width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:18px;box-shadow:0 4px 12px rgba(99,102,241,0.3)">
            ${avatarLetter}
          </div>
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <h3 class="modal-title" style="margin:0;font-size:17px;font-weight:800">
                ${type === 'buyer' ? 'Buyer Workload Dossier' : 'Department Workload Dossier'}: ${escapeHtml(entityName)}
              </h3>
              ${isAppUser ? '<span class="badge badge-primary" style="font-size:10px;padding:2px 8px;font-weight:700">⭐ You (Logged-in App User)</span>' : ''}
              <span class="badge badge-secondary" style="font-size:11px">${escapeHtml(userRole)}</span>
            </div>
            <p style="font-size:12px;color:var(--color-text-secondary);margin:3px 0 0 0">
              ${userEmail ? `${escapeHtml(userEmail)} · ` : ''}${escapeHtml(userDept)} · ${total} Total PRCs Assigned · ${materialsCount} Materials
            </p>
          </div>
        </div>
        <button class="modal-close-btn" onclick="document.getElementById('${modalId}').remove()" style="font-size:18px;cursor:pointer">✕</button>
      </div>

      <!-- KPI Summary Cards Strip -->
      <div class="exec3d-modal-kpi-grid">
        <div class="exec3d-modal-kpi-card" style="border-left:3px solid #6366f1">
          <span class="exec3d-modal-kpi-label">Total PRCs</span>
          <span class="exec3d-modal-kpi-val" style="color:#6366f1">${total.toLocaleString()}</span>
        </div>
        <div class="exec3d-modal-kpi-card" style="border-left:3px solid #10b981">
          <span class="exec3d-modal-kpi-label">Completed (${rate}%)</span>
          <span class="exec3d-modal-kpi-val" style="color:#10b981">${completed.toLocaleString()}</span>
        </div>
        <div class="exec3d-modal-kpi-card" style="border-left:3px solid #0284c7">
          <span class="exec3d-modal-kpi-label">Pending</span>
          <span class="exec3d-modal-kpi-val" style="color:#0284c7">${pending.toLocaleString()}</span>
        </div>
        <div class="exec3d-modal-kpi-card" style="border-left:3px solid #06b6d4">
          <span class="exec3d-modal-kpi-label">Awaiting Offer</span>
          <span class="exec3d-modal-kpi-val" style="color:#06b6d4">${awaiting.toLocaleString()}</span>
        </div>
        <div class="exec3d-modal-kpi-card" style="border-left:3px solid #f43f5e">
          <span class="exec3d-modal-kpi-label">Inputs Required</span>
          <span class="exec3d-modal-kpi-val" style="color:#f43f5e">${inputsReq.toLocaleString()}</span>
        </div>
        <div class="exec3d-modal-kpi-card" style="border-left:3px solid #8b5cf6">
          <span class="exec3d-modal-kpi-label">Materials</span>
          <span class="exec3d-modal-kpi-val" style="color:#8b5cf6">${materialsCount.toLocaleString()}</span>
        </div>
      </div>

      <!-- Filter and Search Bar -->
      <div style="padding:12px 20px;background:var(--color-surface);border-bottom:1px solid var(--color-border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <button class="btn btn-primary btn-xs exec3d-modal-filter-btn" data-filter="all" onclick="window._exec3dModalSetFilter('all')">All (${total})</button>
          <button class="btn btn-secondary btn-xs exec3d-modal-filter-btn" data-filter="Completed" onclick="window._exec3dModalSetFilter('Completed')">Completed (${completed})</button>
          <button class="btn btn-secondary btn-xs exec3d-modal-filter-btn" data-filter="Pending" onclick="window._exec3dModalSetFilter('Pending')">Pending (${pending})</button>
          <button class="btn btn-secondary btn-xs exec3d-modal-filter-btn" data-filter="Awaiting" onclick="window._exec3dModalSetFilter('Awaiting')">Awaiting (${awaiting})</button>
          <button class="btn btn-secondary btn-xs exec3d-modal-filter-btn" data-filter="Inputs" onclick="window._exec3dModalSetFilter('Inputs')">Inputs Req (${inputsReq})</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="text" placeholder="Search PR #, desc, mat..." oninput="window._exec3dModalSearch(this.value)" 
                 style="font-size:12px;padding:5px 10px;border-radius:6px;border:1px solid var(--color-border);background:var(--color-bg);width:190px" />
          <span id="exec3d-modal-filtered-count" style="font-size:11.5px;color:var(--color-text-secondary);white-space:nowrap">${total} PRCs</span>
        </div>
      </div>

      <!-- PRC List Table -->
      <div style="flex:1;overflow-y:auto;padding:0;max-height:480px">
        <table class="exec3d-table" style="margin:0;width:100%">
          <thead style="position:sticky;top:0;background:var(--color-surface);z-index:2;box-shadow:0 1px 0 var(--color-border)">
            <tr>
              <th>PR Number</th>
              <th>Date</th>
              <th>Description / Scope</th>
              <th>Department</th>
              <th>Materials</th>
              <th>Status</th>
              <th style="text-align:right">Action</th>
            </tr>
          </thead>
          <tbody id="exec3d-modal-tbody">
            ${renderTableRowsHTML(entityPRCs)}
          </tbody>
        </table>
      </div>

      <!-- Modal Footer -->
      <div class="modal-footer" style="padding:14px 20px;border-top:1px solid var(--color-border);background:var(--color-bg-secondary);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div style="display:flex;align-items:center;gap:8px">
          <button class="btn btn-secondary btn-sm" onclick="window._exec3dExportEntityCSV()" style="font-size:12px;display:inline-flex;align-items:center;gap:5px">
            <span>📥 Export CSV</span>
          </button>
          <button class="btn btn-primary btn-sm" onclick="window._exec3dOpenInPRCList()" style="font-size:12px;display:inline-flex;align-items:center;gap:5px;background:linear-gradient(135deg,#6366f1,#4f46e5);border:none">
            <span>📋 Open in PRC Records Table →</span>
          </button>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('${modalId}').remove()" style="font-size:12px">
          ✕ Close
        </button>
      </div>

    </div>
  `;

  document.body.appendChild(modalEl);
}

if (typeof window !== 'undefined') {
  window.openMatrixEntityModal = openMatrixEntityModal;
  window.openBuyerDetailsModal = function(buyerName) {
    openMatrixEntityModal(buyerName, 'buyer');
  };
}
