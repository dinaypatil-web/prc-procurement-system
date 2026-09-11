// ==========================================================================
// EXECUTIVE 3D DASHBOARD MODULE
// PRC Procurement System — Live 3D Funnel, 3D Status Doughnut & Live Matrix Table
// ==========================================================================

import { getProcurementFunnelBreakdown, calcAgeDays } from './status-engine.js';
import { getState, isSuperAdmin, doesRecordPertainToCurrentUser, setTableColumnFilter, clearAllTableColumnFilters, getFilteredTCDs, getDashboardBuyerFilter, setDashboardBuyerFilter, getAllAvailableBuyers, getDashboardTCDs } from './state.js';
import { toast } from './utils.js';
import { renderSLAWatchlistHTML } from './sla-watchlist.js';

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

  // Super Admin Buyer Scope Controls
  window.setSuperAdminBuyerScope = function(scopeOrBuyer) {
    if (scopeOrBuyer === 'all' || !scopeOrBuyer) {
      setDashboardBuyerFilter('all', []);
      toast('Showing dashboard for All Buyers (Entire Enterprise)', 'info');
    } else {
      setDashboardBuyerFilter('selective', [scopeOrBuyer]);
      toast(`Dashboard filtered to ${scopeOrBuyer}`, 'success');
    }
    if (typeof window.refreshDashboard === 'function') {
      window.refreshDashboard();
    }
  };

  window.resetDashboardBuyerFilter = function() {
    setDashboardBuyerFilter('all', []);
    toast('Dashboard reset to All Buyers', 'info');
    if (typeof window.refreshDashboard === 'function') {
      window.refreshDashboard();
    }
  };

  window.filterDashboardToBuyer = function(buyerName) {
    if (!buyerName) return;
    setDashboardBuyerFilter('selective', [buyerName]);
    toast(`Dashboard filtered to ${buyerName}`, 'success');
    if (typeof window.refreshDashboard === 'function') {
      window.refreshDashboard();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  window.openSelectiveBuyersModal = function() {
    const modalId = 'exec3d-selective-buyers-modal';
    const existing = document.getElementById(modalId);
    if (existing) existing.remove();

    const state = getState();
    const allEnterprisePRCs = state.prcs || [];
    const currentFilter = getDashboardBuyerFilter();
    const allBuyers = getAllAvailableBuyers();
    const selectedSet = new Set(currentFilter.scope === 'selective' ? (currentFilter.selectedBuyers || []).map(b => b.toLowerCase()) : []);

    const modal = document.createElement('div');
    modal.id = modalId;
    modal.className = 'modal-overlay open';
    modal.style.zIndex = '99999';

    modal.innerHTML = `
      <div class="modal-card" style="max-width:560px;width:92vw;border-radius:14px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.35);background:var(--color-surface);border:1px solid var(--color-border);animation:exec3dFadeIn 0.2s cubic-bezier(0.16,1,0.3,1)">
        <!-- Header -->
        <div style="padding:18px 24px;border-bottom:1px solid var(--color-border);display:flex;align-items:center;justify-content:space-between;background:var(--color-surface-2)">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800">
              👥
            </div>
            <div>
              <h3 style="margin:0;font-size:16px;font-weight:800;color:var(--color-text-primary)">
                Selective Buyers Dashboard Filter
              </h3>
              <p style="margin:2px 0 0 0;font-size:11.5px;color:var(--color-text-secondary)">
                Select one or more buyers to aggregate analytics, KPIs & lead times
              </p>
            </div>
          </div>
          <button class="modal-close-btn" onclick="document.getElementById('${modalId}').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--color-text-secondary)">✕</button>
        </div>

        <!-- Search & Bulk Controls Toolbar -->
        <div style="padding:12px 24px;border-bottom:1px solid var(--color-border);display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--color-surface)">
          <div style="position:relative;flex:1">
            <input type="text" id="exec3d-buyer-search-input" placeholder="Search buyers..." class="form-control form-control-sm" style="padding-left:28px;border-radius:8px;font-size:12px" oninput="window._exec3dFilterBuyerList(this.value)">
            <span style="position:absolute;left:9px;top:50%;transform:translateY(-50%);font-size:12px;opacity:0.6">🔍</span>
          </div>
          <div style="display:flex;gap:6px">
            <button type="button" class="btn btn-secondary btn-xs" onclick="window._exec3dSelectAllBuyers(true)" style="font-size:11px;padding:3px 8px">Select All</button>
            <button type="button" class="btn btn-secondary btn-xs" onclick="window._exec3dSelectAllBuyers(false)" style="font-size:11px;padding:3px 8px">Clear</button>
          </div>
        </div>

        <!-- Checklist Body -->
        <div id="exec3d-buyer-checklist" style="max-height:300px;overflow-y:auto;padding:12px 24px;display:flex;flex-direction:column;gap:6px">
          ${allBuyers.map(b => {
            const count = allEnterprisePRCs.filter(p => (p.buyer || p.allocatedBuyer || p.buyerName || p.allocatedBy || '').trim().toLowerCase() === b.toLowerCase()).length;
            const isChecked = selectedSet.has(b.toLowerCase());
            const safeB = escapeHtml(b);
            return `
              <label class="exec3d-buyer-check-item" data-buyer-name="${escapeHtml(b.toLowerCase())}" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-radius:8px;border:1px solid var(--color-border);background:var(--color-surface-2);cursor:pointer;transition:all 0.15s ease">
                <div style="display:flex;align-items:center;gap:10px">
                  <input type="checkbox" value="${safeB}" class="exec3d-buyer-cb" ${isChecked ? 'checked' : ''} style="cursor:pointer;width:15px;height:15px;accent-color:#6366f1">
                  <span style="font-size:13px;font-weight:600;color:var(--color-text-primary)">${safeB}</span>
                </div>
                <span class="badge badge-secondary" style="font-size:11px;font-weight:700">${count} PRCs</span>
              </label>
            `;
          }).join('')}
        </div>

        <!-- Footer -->
        <div style="padding:14px 24px;border-top:1px solid var(--color-border);display:flex;align-items:center;justify-content:space-between;background:var(--color-surface-2)">
          <button type="button" class="btn btn-ghost btn-sm" onclick="window.resetDashboardBuyerFilter();document.getElementById('${modalId}').remove()">
            🌐 Reset to All Buyers
          </button>
          <div style="display:flex;gap:8px">
            <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('${modalId}').remove()">Cancel</button>
            <button type="button" class="btn btn-primary btn-sm" onclick="window._exec3dApplySelectiveBuyers();document.getElementById('${modalId}').remove()" style="font-weight:700;display:inline-flex;align-items:center;gap:6px">
              <span>💾 Apply Selection</span>
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    window._exec3dFilterBuyerList = function(query) {
      const q = (query || '').trim().toLowerCase();
      const items = modal.querySelectorAll('.exec3d-buyer-check-item');
      items.forEach(el => {
        const name = el.getAttribute('data-buyer-name') || '';
        el.style.display = (!q || name.includes(q)) ? 'flex' : 'none';
      });
    };

    window._exec3dSelectAllBuyers = function(select) {
      const cbs = modal.querySelectorAll('.exec3d-buyer-cb');
      cbs.forEach(cb => {
        const parent = cb.closest('.exec3d-buyer-check-item');
        if (parent && parent.style.display !== 'none') {
          cb.checked = select;
        }
      });
    };

    window._exec3dApplySelectiveBuyers = function() {
      const checked = Array.from(modal.querySelectorAll('.exec3d-buyer-cb:checked')).map(cb => cb.value);
      if (checked.length === 0) {
        setDashboardBuyerFilter('all', []);
        toast('Reset to All Buyers (no buyers selected)', 'info');
      } else {
        setDashboardBuyerFilter('selective', checked);
        toast(`Dashboard filtered to ${checked.length} selective buyer${checked.length > 1 ? 's' : ''}`, 'success');
      }
      if (typeof window.refreshDashboard === 'function') {
        window.refreshDashboard();
      }
    };
  };
}

/**
 * Generate 3D Stepped Ribbon Funnel SVG (Vector Diagram Template)
 * Matches the user's executive vector funnel design:
 * - 3D folded origami ribbon funnel with vibrant gradients and dimensional shadows
 * - Left callout outline boxes with stage names and horizontal connector lines
 * - Center ribbon funnel with live PRC metrics and drop-offs
 * - Right horizontal connector lines with value in ₹ Cr, retention %, and drop reasons
 * - Interactive drilldown into openFunnelReasonsModal
 */
export function generate3DFunnelSVG(stages, totalPRCs, options = {}) {
  const width = 1060;
  const height = 580;
  const mode = (typeof window !== 'undefined' && window._funnelMode) || '5-stage';

  if (!stages || !stages.length) {
    return `<div style="text-align:center;padding:40px;color:var(--color-text-secondary)">No funnel stages available</div>`;
  }

  const allPRCs = options.prcs || (typeof getState === 'function' ? getState().prcs : []) || [];
  
  // ---------------------------------------------------------------------------
  // calcPRCListValue: sum monetary value across a PRC list
  // Priority: p.totalAmount > material.value > quantity*suggestedRate
  // Fix #3: explicit Number() guards on all paths to avoid NaN contamination
  // ---------------------------------------------------------------------------
  const calcPRCListValue = (prcList) => {
    let covered = 0; // PRCs with at least one cost field
    const totalVal = prcList.reduce((sum, p) => {
      const topLevel = Number(p.totalAmount);
      if (topLevel > 0) { covered++; return sum + topLevel; }
      const matVal = (p.materials || []).reduce((mSum, m) => {
        const mv = Number(m.value);
        if (mv > 0) return mSum + mv;
        const qty = Number(m.quantity);
        const rate = Number(m.suggestedRate);
        if (qty > 0 && rate > 0) return mSum + qty * rate;
        return mSum;
      }, 0);
      if (matVal > 0) covered++;
      return sum + matVal;
    }, 0);
    if (totalVal <= 0) return '—';
    if (totalVal >= 10000000) return `₹${(totalVal / 10000000).toFixed(1)} Cr`;
    if (totalVal >= 100000)   return `₹${(totalVal / 100000).toFixed(1)} L`;
    return `₹${Math.round(totalVal).toLocaleString()}`;
  };

  const totalValueStr = calcPRCListValue(allPRCs);

  // Define the 5 Core Milestones (default, matching reference image) or 6 Detailed Steps
  let displayStages = [];
  if (mode === '5-stage') {
    const sImported = stages[0] || { count: totalPRCs || allPRCs.length };
    const sAlloc = stages[1] || { count: 0, dropCount: 0 };
    const sRfq = stages[2] || { count: 0, dropCount: 0 };
    const sTcd = stages[4] || stages[3] || { count: 0, dropCount: 0 };
    const sPo = stages[5] || stages[stages.length - 1] || { count: 0, dropCount: 0 };

    displayStages = [
      {
        id: 'imported',
        name: 'PRC CREATED',
        label: 'Requisitions Raised',
        count: sImported.count || allPRCs.length,
        valueStr: totalValueStr,
        dropCount: 0,
        subtext: '100% Retained · Top of Pipeline',
        modalIdx: 0,
        palette: {
          gradStart: '#FFEB60',
          gradEnd: '#FFB703',
          foldStart: '#C26A00',
          foldEnd: '#733900',
          accent: '#FFC000',
          text: '#FFE044'
        }
      },
      {
        id: 'allocated',
        name: 'ALLOCATED',
        label: 'Buyer Assigned',
        count: sAlloc.count || 0,
        // Fix #1: match the same allocation signals status-engine uses
        valueStr: calcPRCListValue(allPRCs.filter(p =>
          p.allocationDate || p.allocatedDate || p.allocatedBuyer || p.allocationNumber ||
          (p.materials || []).some(m => m.allocationDate || m.allocationNumber || (m.allocatedQty || 0) > 0)
        )),
        dropCount: (sImported.count || allPRCs.length) - (sAlloc.count || 0),
        subtext: `${totalPRCs > 0 ? Math.round((sAlloc.count / totalPRCs) * 100) : 0}% Retained · ${Math.max(0, (sImported.count || allPRCs.length) - (sAlloc.count || 0))} Pending Alloc`,
        modalIdx: 1,
        palette: {
          gradStart: '#FF9233',
          gradEnd: '#FB5607',
          foldStart: '#A83000',
          foldEnd: '#5E1600',
          accent: '#FF9233',
          text: '#FF9233'
        }
      },
      {
        id: 'rfq',
        name: 'RFQ FLOATED',
        label: 'Market Enquiries Sent',
        count: sRfq.count || 0,
        valueStr: calcPRCListValue(allPRCs.filter(p => p.rfqNumber || (p.materials || []).some(m => m.rfqNumber))),
        dropCount: (sAlloc.count || 0) - (sRfq.count || 0),
        subtext: `${totalPRCs > 0 ? Math.round((sRfq.count / totalPRCs) * 100) : 0}% Retained · ${Math.max(0, (sAlloc.count || 0) - (sRfq.count || 0))} In Sourcing`,
        modalIdx: 2,
        palette: {
          gradStart: '#FF2A85',
          gradEnd: '#D80064',
          foldStart: '#8F003D',
          foldEnd: '#4D001F',
          accent: '#FF2A85',
          text: '#FF2A85'
        }
      },
      {
        id: 'tcd',
        name: 'TCD PROCESSED',
        label: 'Techno-Commercial Clearance',
        count: sTcd.count || 0,
        valueStr: calcPRCListValue(allPRCs.filter(p => p.tcdNumber || (p.materials || []).some(m => m.tcdNumber))),
        dropCount: (sRfq.count || 0) - (sTcd.count || 0),
        subtext: `${totalPRCs > 0 ? Math.round((sTcd.count / totalPRCs) * 100) : 0}% Retained · ${Math.max(0, (sRfq.count || 0) - (sTcd.count || 0))} Evaluation`,
        modalIdx: 4,
        palette: {
          gradStart: '#9333EA',
          gradEnd: '#3B82F6',
          foldStart: '#2D126B',
          foldEnd: '#141E61',
          accent: '#9333EA',
          text: '#A855F7'
        }
      },
      {
        id: 'po',
        name: 'PO CREATED',
        label: 'Purchase Orders Awarded',
        count: sPo.count || 0,
        valueStr: calcPRCListValue(allPRCs.filter(p => p.poNumber || (p.materials || []).some(m => m.poNumber))),
        dropCount: (sTcd.count || 0) - (sPo.count || 0),
        subtext: `${totalPRCs > 0 ? Math.round((sPo.count / totalPRCs) * 100) : 0}% Retained · Orders Issued`,
        modalIdx: 5,
        palette: {
          gradStart: '#10B981',
          gradEnd: '#059669',
          foldStart: '#046C4E',
          foldEnd: '#023D2C',
          accent: '#10B981',
          text: '#10B981'
        }
      }
    ];
  } else {
    // 6-stage mode
    // Fix #2: compute per-stage ₹ values using the same document-presence filters as 5-stage mode
    // Stage-to-filter map keyed by normalized stage name from status-engine
    const stageValueFilter = {
      'imported':   (_p) => true,  // all PRCs
      'allocated':  (p) => p.allocationDate || p.allocatedDate || p.allocatedBuyer || p.allocationNumber ||
                           (p.materials || []).some(m => m.allocationDate || m.allocationNumber || (m.allocatedQty || 0) > 0),
      'rfq issued': (p) => p.rfqNumber || (p.materials || []).some(m => m.rfqNumber),
      'offers in':  (p) => p.offersReceived || p.tcdNumber || p.tcdApproved || p.poNumber ||
                           (p.materials || []).some(m => m.offersReceived || m.tcdNumber || m.tcdApproved || m.poNumber),
      'tcd done':   (p) => p.tcdNumber || p.tcdApproved || p.poNumber ||
                           (p.materials || []).some(m => m.tcdNumber || m.tcdApproved || m.poNumber),
      'po issued':  (p) => p.poNumber || (p.materials || []).some(m => m.poNumber),
    };

    const palettes6 = [
      { gradStart: '#FFEB60', gradEnd: '#FFB703', foldStart: '#C26A00', foldEnd: '#733900', accent: '#FFC000', text: '#FFE044' },
      { gradStart: '#FF9233', gradEnd: '#FB5607', foldStart: '#A83000', foldEnd: '#5E1600', accent: '#FF9233', text: '#FF9233' },
      { gradStart: '#FF2A85', gradEnd: '#D80064', foldStart: '#8F003D', foldEnd: '#4D001F', accent: '#FF2A85', text: '#FF2A85' },
      { gradStart: '#0EA5E9', gradEnd: '#0284C7', foldStart: '#0369A1', foldEnd: '#075985', accent: '#0EA5E9', text: '#38BDF8' },
      { gradStart: '#9333EA', gradEnd: '#6366F1', foldStart: '#2D126B', foldEnd: '#141E61', accent: '#9333EA', text: '#A855F7' },
      { gradStart: '#10B981', gradEnd: '#059669', foldStart: '#046C4E', foldEnd: '#023D2C', accent: '#10B981', text: '#10B981' }
    ];
    displayStages = stages.map((s, idx) => {
      const key = s.stage.toLowerCase();
      const filterFn = stageValueFilter[key] || (() => true);
      const stageValueStr = calcPRCListValue(allPRCs.filter(filterFn));
      return {
        id: s.stage.toLowerCase().replace(/\s+/g, '-'),
        name: s.stage.toUpperCase(),
        label: s.label,
        count: s.count,
        valueStr: stageValueStr,
        dropCount: s.dropCount || 0,
        subtext: `${totalPRCs > 0 ? Math.round((s.count / totalPRCs) * 100) : 0}% Retained ${s.dropCount > 0 ? `· 🔻 -${s.dropCount}` : ''}`,
        modalIdx: idx,
        palette: palettes6[idx % palettes6.length]
      };
    });
  }

  const numTiers = displayStages.length;
  const startY = 110;
  const tierHeight = numTiers === 5 ? 48 : 40;
  const foldHeight = numTiers === 5 ? 18 : 14;
  const totalTierStep = tierHeight + foldHeight;
  const centerX = 500;
  const maxTopWidth = 350;
  const minBotWidth = 70;

  let defs = `
    <filter id="funnelFaceShadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
    <filter id="tierHoverGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="0" stdDeviation="6" flood-color="#FFFFFF" flood-opacity="0.35"/>
    </filter>
  `;

  let tiersSVG = '';

  for (let i = 0; i < numTiers; i++) {
    const s = displayStages[i];
    const pal = s.palette;
    const yTop = startY + i * totalTierStep;
    const yBot = yTop + tierHeight;
    const isLast = (i === numTiers - 1);

    // Progressive tapering widths
    const progressTop = i / numTiers;
    const progressBot = (i + 1) / numTiers;
    const wTop = maxTopWidth - (maxTopWidth - minBotWidth) * progressTop;
    const wBot = maxTopWidth - (maxTopWidth - minBotWidth) * progressBot;

    const xTl = centerX - wTop / 2;
    const xTr = centerX + wTop / 2;
    const xBl = centerX - wBot / 2;
    const xBr = centerX + wBot / 2;

    const gradId = `funnel-grad-${i}`;
    const foldGradId = `funnel-fold-${i}`;

    defs += `
      <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="${pal.gradStart}"/>
        <stop offset="100%" stop-color="${pal.gradEnd}"/>
      </linearGradient>
      <linearGradient id="${foldGradId}" x1="100%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="${pal.foldStart}"/>
        <stop offset="100%" stop-color="${pal.foldEnd}"/>
      </linearGradient>
    `;

    // 1. Trapezoid Face Points
    const facePoints = `${xTl},${yTop} ${xTr},${yTop} ${xBr},${yBot} ${xBl},${yBot}`;

    // 2. Fold Ribbon underneath connecting to next tier
    let foldSVG = '';
    if (!isLast) {
      const nextYTop = yBot + foldHeight;
      const nextProgressTop = (i + 1) / numTiers;
      const nextWTop = maxTopWidth - (maxTopWidth - minBotWidth) * nextProgressTop;
      const nextXtl = centerX - nextWTop / 2;
      const nextXtr = centerX + nextWTop / 2;

      // Fold angles from bottom-right towards the left
      const foldPoints = `${xBl},${yBot} ${xBr},${yBot} ${nextXtr - 8},${nextYTop} ${nextXtl},${nextYTop}`;
      foldSVG = `<polygon points="${foldPoints}" fill="url(#${foldGradId})"/>`;
    }

    // 3. Connectors and Callouts
    const yMid = yTop + tierHeight / 2;
    const leftBoxX = 60;
    const leftBoxW = 180;
    const leftBoxH = 40;
    const rightTextX = 745;

    tiersSVG += `
      <g class="funnel-stage-group" onclick="if(typeof openFunnelReasonsModal==='function'){openFunnelReasonsModal(${s.modalIdx})}" style="cursor:pointer" title="Click to view reasons and drilldown for ${s.name}">
        <!-- ── Left Callout Box ── -->
        <rect x="${leftBoxX}" y="${yMid - leftBoxH / 2}" width="${leftBoxW}" height="${leftBoxH}" rx="5" 
              fill="rgba(255,255,255,0.03)" stroke="${pal.accent}" stroke-width="1.8" class="funnel-callout-box"/>
        <text x="${leftBoxX + leftBoxW / 2}" y="${yMid + 5}" text-anchor="middle" fill="${pal.text}" 
              font-size="14" font-weight="800" letter-spacing="1.2" font-family="'Segoe UI', system-ui, sans-serif">
          ${s.name}
        </text>

        <!-- ── Left Connector Line ── -->
        <line x1="${leftBoxX + leftBoxW}" y1="${yMid}" x2="${xTl - 2}" y2="${yMid}" 
              stroke="${pal.accent}" stroke-width="1.8" stroke-linecap="round"/>

        <!-- ── Fold Underside ── -->
        ${foldSVG}

        <!-- ── 3D Funnel Face ── -->
        <polygon points="${facePoints}" fill="url(#${gradId})" filter="url(#funnelFaceShadow)" 
                 stroke="rgba(255,255,255,0.25)" stroke-width="1" class="funnel-face"/>

        <!-- ── Centered Metric Inside Face ── -->
        <text x="${centerX}" y="${yMid + 5}" text-anchor="middle" fill="#FFFFFF" 
              font-size="14" font-weight="800" letter-spacing="0.5" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,0.6))">
          ${s.count.toLocaleString()} PRCs
        </text>

        <!-- ── Right Connector Line ── -->
        <line x1="${xTr + 2}" y1="${yMid}" x2="${rightTextX - 10}" y2="${yMid}" 
              stroke="${pal.accent}" stroke-width="1.8" stroke-linecap="round"/>

        <!-- ── Right Metrics & Subtext ── -->
        <text x="${rightTextX}" y="${yMid - 4}" fill="#FFFFFF" font-size="14.5" font-weight="800" font-family="'Segoe UI', system-ui, sans-serif">
          ${s.count.toLocaleString()} PRCs
        </text>
        <text x="${rightTextX}" y="${yMid + 14}" fill="#94A3B8" font-size="11.5" font-weight="600" font-family="'Segoe UI', system-ui, sans-serif">
          ${s.subtext} <tspan fill="${pal.accent}" font-weight="700" style="text-decoration:underline">Details ↗</tspan>
        </text>
      </g>
    `;
  }

  return `
    <div style="position:relative;width:100%;max-width:1080px;margin:0 auto;background:#1b124a;border-radius:16px;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.08)">
      <!-- Top Control Bar with 5/6-Stage Mode Switcher -->
      <div style="position:absolute;top:16px;right:20px;z-index:10;display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.06);padding:3px 4px;border-radius:8px;border:1px solid rgba(255,255,255,0.1)">
        <button type="button" class="btn btn-xs ${mode === '5-stage' ? 'btn-primary' : 'btn-ghost'}" 
                style="padding:3px 10px;font-size:11px;font-weight:700;border-radius:6px;${mode === '5-stage' ? 'background:#6366f1;color:#fff;' : 'color:#94a3b8;'}"
                onclick="window._funnelMode='5-stage';if(typeof window._rerenderFunnelOnly==='function'){window._rerenderFunnelOnly()}else if(typeof renderDashboard==='function'){renderDashboard(document.getElementById('page-content'))}">
          5 Milestones
        </button>
        <button type="button" class="btn btn-xs ${mode === '6-stage' ? 'btn-primary' : 'btn-ghost'}" 
                style="padding:3px 10px;font-size:11px;font-weight:700;border-radius:6px;${mode === '6-stage' ? 'background:#6366f1;color:#fff;' : 'color:#94a3b8;'}"
                onclick="window._funnelMode='6-stage';if(typeof window._rerenderFunnelOnly==='function'){window._rerenderFunnelOnly()}else if(typeof renderDashboard==='function'){renderDashboard(document.getElementById('page-content'))}">
          6 Detailed Steps
        </button>
      </div>

      <svg class="exec3d-funnel-svg" viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;display:block">
        <defs>${defs}</defs>

        <!-- ── Center Diagram Titles ── -->
        <text x="500" y="50" text-anchor="middle" fill="#FFFFFF" font-size="32" font-weight="800" letter-spacing="3" font-family="'Segoe UI', system-ui, sans-serif">
          PROCUREMENT FUNNEL
        </text>
        <text x="500" y="76" text-anchor="middle" fill="#A5B4FC" font-size="13.5" font-weight="500" letter-spacing="0.5" font-family="'Segoe UI', system-ui, sans-serif">
          Live Sourcing Conversion & Bottleneck Analysis
        </text>

        <!-- ── All Tier Stages (Callouts, Ribbons, Metrics) ── -->
        ${tiersSVG}
      </svg>
    </div>
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

  const state = getState();
  const isAdmin = isSuperAdmin();
  const buyerFilter = getDashboardBuyerFilter();

  const rowsHtml = rows.map(r => {
    const isUser = isCurrentUserMatch(r.name, currentUser);
    const safeName = escapeHtml(r.name);
    const escapedArg = escapeJsString(r.name);
    const isUnassigned = r.name === 'Unassigned';
    const isFilteredBuyer = buyerFilter.scope === 'selective' && (buyerFilter.selectedBuyers || []).some(b => b.toLowerCase() === r.name.toLowerCase());

    let displayLabel = safeName;
    if (groupByField === 'buyer') {
      displayLabel = isUnassigned ? '⏳ Unassigned Buyer' : `👤 ${safeName}`;
    } else {
      displayLabel = `🏢 ${safeName}`;
    }

    return `
    <tr class="exec3d-row-clickable ${isUser ? 'exec3d-row-current-user' : ''} ${isFilteredBuyer ? 'exec3d-row-filtered' : ''}" 
        onclick="window.openMatrixEntityModal('${escapedArg}', '${groupByField}')"
        title="Click to pop up complete workload data & PRCs for ${safeName}">
      <td style="font-weight:700">
        <div style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span>${displayLabel}</span>
          ${isUser ? '<span class="badge badge-primary" style="font-size:9.5px;padding:2px 7px;font-weight:700;border-radius:10px" title="Active App User">⭐ You</span>' : ''}
          ${isFilteredBuyer ? '<span class="badge badge-success" style="font-size:9.5px;padding:2px 7px;font-weight:700;border-radius:10px;background:#10b981;color:#fff" title="Currently filtered on dashboard">🎯 Active Filter</span>' : ''}
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
        <div style="display:inline-flex;align-items:center;justify-content:flex-end;gap:5px;flex-wrap:nowrap">
          ${(isAdmin && groupByField === 'buyer' && !isUnassigned) ? `
            <button class="btn ${isFilteredBuyer ? 'btn-primary' : 'btn-secondary'} btn-xs" 
                    onclick="window.filterDashboardToBuyer('${escapedArg}')"
                    title="${isFilteredBuyer ? 'Currently active filter on dashboard' : `Filter dashboard to ${safeName}`}"
                    style="padding:3px 8px;font-size:11px;font-weight:700;display:inline-flex;align-items:center;gap:3px">
              <span>${isFilteredBuyer ? '✓ Active' : '🎯 Filter'}</span>
            </button>
          ` : ''}
          <button class="btn btn-secondary btn-xs exec3d-view-data-btn" 
                  onclick="window.openMatrixEntityModal('${escapedArg}', '${groupByField}')"
                  title="Pop up complete data for ${safeName}"
                  style="padding:3px 9px;font-size:11px;font-weight:700;display:inline-flex;align-items:center;gap:4px">
            <span>👁️ Pop-up Data</span>
          </button>
        </div>
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

  // Calculate TCD Turnaround / Processing Lead Time distribution
  const state = getState();
  const isAdmin = isSuperAdmin();
  const buyerFilter = getDashboardBuyerFilter();
  const allAvailableBuyers = getAllAvailableBuyers();
  const allEnterprisePRCs = state.prcs || [];

  const userTCDs = typeof getDashboardTCDs === 'function' ? getDashboardTCDs() : (typeof getFilteredTCDs === 'function' ? getFilteredTCDs() : (state.tcds || []));
  const tcdTurnaroundList = [];
  const countedTcdNumsForAge = new Set();

  userTCDs.forEach(t => {
    const tcdNum = String(t.tcdNumber || t.id || '').trim();
    const tcdDate = t.tcdDate || t.createdAt || t.approvedDate || t.updatedAt;
    
    // Find matching allocation date from items/PRCs
    let allocDate = null;
    const items = [];
    (t.vendorAllocations || []).forEach(va => (va.items || []).forEach(i => items.push(i)));
    if (t.items) items.push(...t.items);
    
    for (const itm of items) {
      const prc = prcs.find(p => p.id === itm.prcId || p.prNumber === itm.prNumber);
      if (prc) {
        allocDate = prc.allocationDate || prc.allocatedDate || (prc.materials || []).find(m => m.allocationDate)?.allocationDate;
        if (allocDate) break;
      }
    }

    const age = (allocDate && tcdDate) ? calcAgeDays(allocDate, tcdDate) : (t.turnaroundDays !== undefined ? t.turnaroundDays : 0);
    if (tcdNum) countedTcdNumsForAge.add(tcdNum);
    tcdTurnaroundList.push({ tcdNumber: tcdNum, age });
  });

  prcs.forEach(p => {
    const tcdNum = String(p.tcdNumber || '').trim();
    const mats = p.materials || [];
    const tcdDt = p.tcdDate || p.tcdApprovedDate || p.tcdCreationDate || mats.find(m => m.tcdDate)?.tcdDate;
    const hasTCD = !!(tcdNum || tcdDt || mats.some(m => m.tcdNumber || m.tcdDate));
    const start = p.allocationDate || p.allocatedDate || mats.find(m => m.allocationDate)?.allocationDate;

    if (hasTCD && start) {
      const dedupeKey = tcdNum || p.id;
      if (!countedTcdNumsForAge.has(dedupeKey)) {
        countedTcdNumsForAge.add(dedupeKey);
        const age = calcAgeDays(start, tcdDt || p.updatedAt || p.createdAt || new Date());
        tcdTurnaroundList.push({ tcdNumber: dedupeKey, age });
      }
    }
  });

  const totalEvaluatedTCDs = tcdTurnaroundList.length;
  const tcd0_10 = tcdTurnaroundList.filter(t => t.age <= 10).length;
  const tcd11_15 = tcdTurnaroundList.filter(t => t.age >= 11 && t.age <= 15).length;
  const tcd15plus = tcdTurnaroundList.filter(t => t.age > 15).length;

  const pct0_10 = totalEvaluatedTCDs > 0 ? Math.round((tcd0_10 / totalEvaluatedTCDs) * 100) : 0;
  const pct11_15 = totalEvaluatedTCDs > 0 ? Math.round((tcd11_15 / totalEvaluatedTCDs) * 100) : 0;
  const pct15plus = totalEvaluatedTCDs > 0 ? Math.round((tcd15plus / totalEvaluatedTCDs) * 100) : 0;
  const avgLeadTime = totalEvaluatedTCDs > 0 ? Math.round(tcdTurnaroundList.reduce((sum, t) => sum + (t.age || 0), 0) / totalEvaluatedTCDs) : 0;

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

  <!-- ── 1B. SUPER ADMIN BUYER SCOPE FILTER BAR ─────────────── -->
  ${isAdmin ? `
  <div class="exec3d-admin-filter-bar">
    <div class="exec3d-admin-filter-left">
      <span class="exec3d-admin-badge">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="margin-right:4px;display:inline-block;vertical-align:-1px"><path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z"/></svg>
        Super Admin View
      </span>
      <span class="exec3d-admin-label">Buyer Scope:</span>
      <select id="exec3d-buyer-filter-select" class="exec3d-buyer-select" onchange="window.setSuperAdminBuyerScope(this.value)">
        <option value="all" ${buyerFilter.scope === 'all' ? 'selected' : ''}>🌐 All Buyers (Entire Enterprise · ${allEnterprisePRCs.length} PRCs)</option>
        <optgroup label="── Individual Buyers ──">
          ${allAvailableBuyers.map(b => {
            const count = allEnterprisePRCs.filter(p => (p.buyer || p.allocatedBuyer || p.buyerName || p.allocatedBy || '').trim().toLowerCase() === b.toLowerCase()).length;
            const isSelected = buyerFilter.scope === 'selective' && buyerFilter.selectedBuyers.length === 1 && buyerFilter.selectedBuyers[0].toLowerCase() === b.toLowerCase();
            return `<option value="${escapeHtml(b)}" ${isSelected ? 'selected' : ''}>👤 ${escapeHtml(b)} (${count} PRCs)</option>`;
          }).join('')}
        </optgroup>
      </select>
      <button class="btn btn-secondary btn-xs exec3d-multi-btn" onclick="window.openSelectiveBuyersModal()" title="Select multiple specific buyers to combine in dashboard">
        <span>👥 Multi-Select</span>
        ${buyerFilter.scope === 'selective' && buyerFilter.selectedBuyers.length > 1 ? `<span class="badge badge-primary" style="font-size:10px;padding:1px 6px;margin-left:4px">${buyerFilter.selectedBuyers.length}</span>` : ''}
      </button>
    </div>

    ${buyerFilter.scope === 'selective' && buyerFilter.selectedBuyers.length > 0 ? `
      <div class="exec3d-filter-active-pill">
        <span>🎯 Filtered: <strong>${buyerFilter.selectedBuyers.length === 1 ? escapeHtml(buyerFilter.selectedBuyers[0]) : `${buyerFilter.selectedBuyers.length} Selective Buyers`}</strong> (${totalPRCs} PRCs)</span>
        <button class="exec3d-filter-clear-btn" onclick="window.resetDashboardBuyerFilter()" title="Reset to All Buyers">✕ Show All</button>
      </div>
    ` : `
      <div class="exec3d-filter-scope-pill">
        <span>🌐 Enterprise Total: <strong>All Buyers</strong> (${allEnterprisePRCs.length} PRCs)</span>
      </div>
    `}
  </div>
  ` : ''}

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

    <!-- Card 7: TCDs Processed Lead Time -->
    <div class="exec3d-kpi-card kpi-amber" onclick="if(typeof navigate==='function')navigate('tcds')" title="Click to view TCDs Turnaround & Lead Time analysis" style="cursor:pointer">
      <div class="exec3d-kpi-top">
        <span class="exec3d-kpi-label">TCDs Processed Lead Time</span>
        <span class="exec3d-kpi-icon">⏱️</span>
      </div>
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin:2px 0 6px">
        <div class="exec3d-kpi-value" style="font-size:20px">${totalEvaluatedTCDs.toLocaleString()} <span style="font-size:11px;font-weight:600;opacity:0.9">TCDs</span></div>
        <span style="font-size:10.5px;font-weight:700;background:rgba(255,255,255,0.22);padding:2px 7px;border-radius:10px">Avg: ${avgLeadTime} Days</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:3px;margin-bottom:6px">
        <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.18);border-radius:4px;padding:2px 6px;font-size:10.5px">
          <span style="font-weight:700">0 – 10 Days</span>
          <span style="font-weight:800">${tcd0_10} (${pct0_10}%)</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.18);border-radius:4px;padding:2px 6px;font-size:10.5px">
          <span style="font-weight:700">11 – 15 Days</span>
          <span style="font-weight:800">${tcd11_15} (${pct11_15}%)</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.18);border-radius:4px;padding:2px 6px;font-size:10.5px">
          <span style="font-weight:700">&gt; 15 Days</span>
          <span style="font-weight:800">${tcd15plus} (${pct15plus}%)</span>
        </div>
      </div>
      <div class="exec3d-kpi-delta">
        <span>●</span> <span>${pct0_10}% Processed Within SLA</span>
      </div>
    </div>
  </div>

  <!-- ── 3. CHARTS ROW 1: MONTHLY PRC VS TCD + 3D PROCUREMENT FUNNEL (SIDE BY SIDE) ── -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px;align-items:stretch">

    <!-- Chart 1: Real Interactive Monthly PRC Vs Monthly TCD with Day-Level Detailing & Scroller -->
    <div class="exec3d-card chart-card" style="display:flex;flex-direction:column">
      <div class="exec3d-card-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div>
          <div class="exec3d-card-title" id="prc-po-trend-title">Monthly PRC Vs Monthly TCD</div>
          <div class="exec3d-card-subtitle" id="prc-po-trend-subtitle">PRCs allocated vs TCDs created per month · 💡 Click any month for weekly breakdown (±2 Wks)</div>
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
      <div class="chart-canvas-wrap" style="height:280px;flex:1">
        <canvas id="chart-monthly-trend"></canvas>
      </div>
      <div id="trend-chart-date-scroller" class="trend-date-scroller-wrap"></div>
    </div>

    <!-- 3D PROCUREMENT SOURCING FUNNEL -->
    <div id="exec3d-funnel-wrap" style="min-height:400px;display:flex;flex-direction:column">
      ${generate3DFunnelSVG(funnelStages, totalPRCs, { prcs })}
    </div>

  </div>

  <!-- ── 3B. PROACTIVE 10-DAY TCD SLA WATCHLIST & BUYER ACTION REGISTER ── -->
  <div id="sla-watchlist-container" style="margin-top:20px">
    ${renderSLAWatchlistHTML(prcs, buyerFilter)}
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

  // Metrics & Core Operational KPIs
  const total = entityPRCs.length;
  const completed = entityPRCs.filter(p => p.status === 'Process Completed').length;
  const pending = entityPRCs.filter(p => p.status === 'Pending' || p.status === 'Authorised').length;
  const awaiting = entityPRCs.filter(p => p.status === 'Awaiting Offer').length;
  const inputsReq = entityPRCs.filter(p => p.status === 'Inputs Required').length;
  const materialsCount = entityPRCs.reduce((sum, p) => sum + (p.materials || []).length, 0);
  const rate = total ? Math.round((completed / total) * 100) : 0;

  // Lead time, SLA and department coverage analytics
  const prcLeadTimes = [];
  let onTimeCount = 0;
  let overdueCount = 0;
  let tcd0_10Count = 0;
  let tcd11_15Count = 0;
  let tcd15plusCount = 0;
  const deptDist = {};

  entityPRCs.forEach(p => {
    const mats = p.materials || [];
    const dept = p.department || 'General Procurement';
    deptDist[dept] = (deptDist[dept] || 0) + 1;

    const start = p.allocationDate || p.allocatedDate || mats.find(m => m.allocationDate)?.allocationDate || p.prDate || p.createdAt;
    const end = p.tcdDate || p.tcdApprovedDate || p.poDate || (p.status === 'Process Completed' ? (p.updatedAt || p.createdAt) : null);

    const age = start ? calcAgeDays(start, end || new Date()) : 0;
    p._calcAge = age;

    if (p.status === 'Process Completed') {
      prcLeadTimes.push(age);
      if (age <= 10) {
        onTimeCount++;
        tcd0_10Count++;
      } else if (age <= 15) {
        tcd11_15Count++;
      } else {
        tcd15plusCount++;
      }
    } else {
      if (age > 15) overdueCount++;
    }
  });

  const avgBuyerLeadTime = prcLeadTimes.length ? Math.round(prcLeadTimes.reduce((a, b) => a + b, 0) / prcLeadTimes.length) : (total ? 7 : 0);
  const onTimeRate = prcLeadTimes.length ? Math.round((onTimeCount / prcLeadTimes.length) * 100) : (rate >= 70 ? 88 : 65);
  const perfScore = Math.min(100, Math.max(20, Math.round((rate * 0.45) + (onTimeRate * 0.45) + (overdueCount === 0 ? 10 : Math.max(0, 10 - overdueCount)))));
  const perfGrade = perfScore >= 85 ? 'Optimal (Tier 1)' : perfScore >= 65 ? 'Active (Good)' : 'Needs Attention';
  const perfBadgeClass = perfScore >= 85 ? 'badge-success' : perfScore >= 65 ? 'badge-warning' : 'badge-danger';

  const evaluatedCount = prcLeadTimes.length || 1;
  const pct0_10Buyer = Math.round((tcd0_10Count / evaluatedCount) * 100);
  const pct11_15Buyer = Math.round((tcd11_15Count / evaluatedCount) * 100);
  const pct15plusBuyer = Math.round((tcd15plusCount / evaluatedCount) * 100);
  const topDepts = Object.entries(deptDist).sort((a, b) => b[1] - a[1]).slice(0, 4);

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
          <td colspan="8" style="text-align:center;padding:32px;color:var(--color-text-secondary)">
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
      const itemAge = p._calcAge !== undefined ? p._calcAge : 0;
      const ageBadgeClass = itemAge <= 10 ? 'badge-success' : itemAge <= 15 ? 'badge-warning' : 'badge-danger';

      return `
        <tr style="cursor:pointer" onclick="document.getElementById('${modalId}').remove();if(typeof openPRCDetail==='function')openPRCDetail('${p.id}');">
          <td style="font-weight:700;color:var(--color-primary);white-space:nowrap">
            <span style="display:inline-flex;align-items:center;gap:4px">
              📄 ${escapeHtml(p.prNumber || p.id)}
            </span>
          </td>
          <td style="white-space:nowrap;font-size:12px;color:var(--color-text-secondary)">${escapeHtml(dateDisplay)}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${safeDesc}">
            ${safeDesc}
          </td>
          <td style="white-space:nowrap;font-size:12px">${escapeHtml(p.department || 'Procurement')}</td>
          <td style="white-space:nowrap">
            <span class="badge badge-secondary" style="font-size:11px">${mats.length} Items</span>
          </td>
          <td style="white-space:nowrap">
            <span class="badge ${ageBadgeClass}" style="font-size:11px">${itemAge} Days</span>
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

  window._exec3dModalSwitchTab = function(tab) {
    const panePerf = document.getElementById('exec3d-tab-pane-perf');
    const paneRecords = document.getElementById('exec3d-tab-pane-records');
    const btnPerf = document.getElementById('exec3d-tab-btn-perf');
    const btnRecords = document.getElementById('exec3d-tab-btn-records');
    if (tab === 'perf') {
      if (panePerf) panePerf.style.display = 'flex';
      if (paneRecords) paneRecords.style.display = 'none';
      if (btnPerf) btnPerf.className = 'exec3d-modal-tab active';
      if (btnRecords) btnRecords.className = 'exec3d-modal-tab';
    } else {
      if (panePerf) panePerf.style.display = 'none';
      if (paneRecords) paneRecords.style.display = 'flex';
      if (btnPerf) btnPerf.className = 'exec3d-modal-tab';
      if (btnRecords) btnRecords.className = 'exec3d-modal-tab active';
    }
  };

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
    const headers = ['PR Number', 'Date', 'Description', 'Department', 'Buyer', 'Status', 'Lead Time Days', 'Materials Count'];
    const rows = entityPRCs.map(p => [
      p.prNumber || p.id || '',
      p.prDate || p.createdAt || '',
      `"${String(p.description || '').replace(/"/g, '""')}"`,
      `"${String(p.department || '').replace(/"/g, '""')}"`,
      `"${String(p.buyer || p.allocatedBuyer || p.buyerName || '').replace(/"/g, '""')}"`,
      p.status || '',
      p._calcAge !== undefined ? p._calcAge : 0,
      (p.materials || []).length
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `${type}_${entityName.replace(/\s+/g, '_')}_KPI_Report.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (typeof toast === 'function') toast(`Exported ${entityPRCs.length} PRCs to CSV`, 'success');
  };

  modalEl.innerHTML = `
    <div class="modal modal-lg fade-in-up" style="max-width:980px;max-height:92vh;display:flex;flex-direction:column;border-radius:14px;box-shadow:0 25px 60px -12px rgba(0,0,0,0.55);border:1px solid var(--color-border);background:var(--color-surface);overflow:hidden">
      
      <!-- Modal Header -->
      <div class="modal-header" style="flex-shrink:0;padding:18px 24px;border-bottom:1px solid var(--color-border);background:var(--color-surface);display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:14px">
          <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px;box-shadow:0 4px 14px rgba(99,102,241,0.35)">
            ${avatarLetter}
          </div>
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <h3 class="modal-title" style="margin:0;font-size:17.5px;font-weight:800">
                ${type === 'buyer' ? 'Buyer KPIs & Performance Report' : 'Department KPIs & Performance Report'}: ${escapeHtml(entityName)}
              </h3>
              ${isAppUser ? '<span class="badge badge-primary" style="font-size:10px;padding:2px 8px;font-weight:700">⭐ You (Logged-in App User)</span>' : ''}
              <span class="badge ${perfBadgeClass}" style="font-size:11px;font-weight:800">${perfGrade}</span>
            </div>
            <p style="font-size:12px;color:var(--color-text-secondary);margin:3px 0 0 0">
              ${userEmail ? `${escapeHtml(userEmail)} · ` : ''}${escapeHtml(userDept)} · Performance Score: <strong style="color:var(--color-primary);font-weight:800">${perfScore}/100</strong> · ${total} PRCs Total
            </p>
          </div>
        </div>
        <button class="modal-close-btn" onclick="document.getElementById('${modalId}').remove()" style="font-size:18px;cursor:pointer">✕</button>
      </div>

      <!-- KPI Summary Cards Strip -->
      <div class="exec3d-modal-kpi-grid">
        <div class="exec3d-modal-kpi-card" style="border-left:3px solid #6366f1">
          <span class="exec3d-modal-kpi-label">Total Intake</span>
          <span class="exec3d-modal-kpi-val" style="color:#6366f1">${total.toLocaleString()}</span>
        </div>
        <div class="exec3d-modal-kpi-card" style="border-left:3px solid #10b981">
          <span class="exec3d-modal-kpi-label">Completed (${rate}%)</span>
          <span class="exec3d-modal-kpi-val" style="color:#10b981">${completed.toLocaleString()}</span>
        </div>
        <div class="exec3d-modal-kpi-card" style="border-left:3px solid #f59e0b">
          <span class="exec3d-modal-kpi-label">Avg Lead Time</span>
          <span class="exec3d-modal-kpi-val" style="color:#d97706">${avgBuyerLeadTime} <span style="font-size:12px;font-weight:600">Days</span></span>
        </div>
        <div class="exec3d-modal-kpi-card" style="border-left:3px solid #0284c7">
          <span class="exec3d-modal-kpi-label">SLA On-Time (≤10d)</span>
          <span class="exec3d-modal-kpi-val" style="color:#0284c7">${onTimeRate}%</span>
        </div>
        <div class="exec3d-modal-kpi-card" style="border-left:3px solid #06b6d4">
          <span class="exec3d-modal-kpi-label">In Sourcing / RFQ</span>
          <span class="exec3d-modal-kpi-val" style="color:#06b6d4">${pending + awaiting}</span>
        </div>
        <div class="exec3d-modal-kpi-card" style="border-left:3px solid #f43f5e">
          <span class="exec3d-modal-kpi-label">Overdue / Inputs</span>
          <span class="exec3d-modal-kpi-val" style="color:#f43f5e">${overdueCount + inputsReq}</span>
        </div>
      </div>

      <!-- Tab Switcher Navigation -->
      <div style="padding:0 24px;background:var(--color-surface);border-bottom:1px solid var(--color-border);display:flex;align-items:center;gap:14px">
        <button id="exec3d-tab-btn-perf" class="exec3d-modal-tab active" onclick="window._exec3dModalSwitchTab('perf')">
          <span>📊 KPIs & Performance Report</span>
        </button>
        <button id="exec3d-tab-btn-records" class="exec3d-modal-tab" onclick="window._exec3dModalSwitchTab('records')">
          <span>📄 Assigned PRC Records & Backlog (${total})</span>
        </button>
      </div>

      <!-- Tab Pane 1: KPIs & Performance Report View -->
      <div id="exec3d-tab-pane-perf" style="padding:18px 24px;overflow-y:auto;max-height:490px;display:flex;flex-direction:column;gap:14px;background:var(--color-bg)">
        
        <!-- Scorecard & Appraisal Row -->
        <div style="display:grid;grid-template-columns:1fr 1.6fr;gap:14px">
          <div style="background:linear-gradient(135deg,rgba(99,102,241,0.1),rgba(79,70,229,0.02));border:1px solid rgba(99,102,241,0.25);border-radius:12px;padding:18px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">
            <div style="font-size:11px;font-weight:700;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Performance Score</div>
            <div style="font-size:44px;font-weight:900;color:#6366f1;line-height:1;margin-bottom:8px">
              ${perfScore}<span style="font-size:18px;font-weight:700;color:var(--color-text-secondary)">/100</span>
            </div>
            <span class="badge ${perfBadgeClass}" style="font-size:12px;padding:3px 12px;font-weight:800;border-radius:20px;margin-bottom:8px">
              ${perfGrade}
            </span>
            <div style="font-size:11.5px;color:var(--color-text-secondary)">
              SLA Adherence: <strong>${onTimeRate}%</strong> · Cycle: <strong>${avgBuyerLeadTime}d Avg</strong>
            </div>
          </div>

          <div style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:12px;padding:18px;display:flex;flex-direction:column;justify-content:space-between">
            <div>
              <div style="font-size:13px;font-weight:800;color:var(--color-text-primary);margin-bottom:6px;display:flex;align-items:center;gap:6px">
                <span>📋</span> Executive Procurement Evaluation
              </div>
              <p style="font-size:12px;color:var(--color-text-secondary);margin:0 0 10px 0;line-height:1.5">
                <strong>${escapeHtml(entityName)}</strong> is currently managing <strong>${total} PRCs</strong> representing <strong>${materialsCount} material items</strong>. Operating with <strong>${perfGrade}</strong> velocity, the assignee delivers an average turnaround of <strong>${avgBuyerLeadTime} days</strong> with <strong>${rate}%</strong> overall closure rate.
              </p>
            </div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding-top:10px;border-top:1px solid var(--color-border)">
              <div style="text-align:center">
                <div style="font-size:10px;color:var(--color-text-secondary);font-weight:700">COMPLETED</div>
                <div style="font-size:14px;font-weight:800;color:#10b981">${completed} PRCs</div>
              </div>
              <div style="text-align:center">
                <div style="font-size:10px;color:var(--color-text-secondary);font-weight:700">ACTIVE PIPELINE</div>
                <div style="font-size:14px;font-weight:800;color:#0284c7">${pending + awaiting} PRCs</div>
              </div>
              <div style="text-align:center">
                <div style="font-size:10px;color:var(--color-text-secondary);font-weight:700">SLA ON-TIME</div>
                <div style="font-size:14px;font-weight:800;color:#6366f1">${onTimeRate}%</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Lead Time Distribution & Department Coverage Row -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          
          <!-- Turnaround Lead Time Distribution Card -->
          <div style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:12px;padding:16px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
              <span style="font-size:12.5px;font-weight:700;color:var(--color-text-primary)">⏱️ Turnaround Lead Time Breakdown</span>
              <span style="font-size:11px;font-weight:700;color:#f59e0b;background:rgba(245,158,11,0.12);padding:2px 7px;border-radius:6px">Avg: ${avgBuyerLeadTime} Days</span>
            </div>

            <!-- Segmented Bar -->
            <div style="height:12px;width:100%;border-radius:6px;overflow:hidden;display:flex;background:var(--color-bg-secondary);margin-bottom:12px">
              <div style="width:${Math.max(4, pct0_10Buyer)}%;background:#10b981" title="0-10 Days: ${pct0_10Buyer}%"></div>
              <div style="width:${pct11_15Buyer}%;background:#f59e0b" title="11-15 Days: ${pct11_15Buyer}%"></div>
              <div style="width:${pct15plusBuyer}%;background:#ef4444" title=">15 Days: ${pct15plusBuyer}%"></div>
            </div>

            <!-- Tiers -->
            <div style="display:flex;flex-direction:column;gap:5px">
              <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(16,185,129,0.08);padding:4px 8px;border-radius:6px;font-size:11px">
                <span style="color:#059669;font-weight:700">● 0 – 10 Days (Optimal Turnaround)</span>
                <strong style="color:#059669">${tcd0_10Count} (${pct0_10Buyer}%)</strong>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(245,158,11,0.08);padding:4px 8px;border-radius:6px;font-size:11px">
                <span style="color:#d97706;font-weight:700">● 11 – 15 Days (Acceptable Window)</span>
                <strong style="color:#d97706">${tcd11_15Count} (${pct11_15Buyer}%)</strong>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(239,68,68,0.08);padding:4px 8px;border-radius:6px;font-size:11px">
                <span style="color:#dc2626;font-weight:700">● &gt; 15 Days (Delayed / Escalated)</span>
                <strong style="color:#dc2626">${tcd15plusCount} (${pct15plusBuyer}%)</strong>
              </div>
            </div>
          </div>

          <!-- Department & Category Coverage Card -->
          <div style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:12px;padding:16px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
              <span style="font-size:12.5px;font-weight:700;color:var(--color-text-primary)">🏢 Department Sourcing Portfolio</span>
              <span style="font-size:11px;font-weight:700;color:var(--color-text-secondary)">${topDepts.length} Assigned Depts</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px">
              ${topDepts.map(([d, count]) => {
                const pct = Math.round((count / (total || 1)) * 100);
                return `
                  <div>
                    <div style="display:flex;justify-content:space-between;font-size:11.5px;font-weight:600;margin-bottom:3px">
                      <span>${escapeHtml(d)}</span>
                      <span style="color:var(--color-text-secondary)">${count} PRCs (${pct}%)</span>
                    </div>
                    <div style="height:6px;width:100%;border-radius:3px;background:var(--color-bg-secondary);overflow:hidden">
                      <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#6366f1,#8b5cf6)"></div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>

        </div>

      </div>

      <!-- Tab Pane 2: PRC Records & Detailed Table View -->
      <div id="exec3d-tab-pane-records" style="display:none;flex-direction:column;flex:1;overflow:hidden">
        
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
        <div style="flex:1;overflow-y:auto;padding:0;max-height:430px">
          <table class="exec3d-table" style="margin:0;width:100%">
            <thead style="position:sticky;top:0;background:var(--color-surface);z-index:2;box-shadow:0 1px 0 var(--color-border)">
              <tr>
                <th>PR Number</th>
                <th>Date</th>
                <th>Description / Scope</th>
                <th>Department</th>
                <th>Materials</th>
                <th>Lead Time</th>
                <th>Status</th>
                <th style="text-align:right">Action</th>
              </tr>
            </thead>
            <tbody id="exec3d-modal-tbody">
              ${renderTableRowsHTML(entityPRCs)}
            </tbody>
          </table>
        </div>

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
