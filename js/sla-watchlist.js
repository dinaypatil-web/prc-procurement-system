// ==========================================================================
// PROACTIVE 10-DAY TCD SLA WATCHLIST & BUYER ACTION REGISTER MODULE
// PRC Procurement System — Alerts buyers to process PRCs within 10-day SLA
// ==========================================================================

import { getSLAWatchlistPRCs, getPRCSLAInfo } from './status-engine.js';
import { getState, updatePRC, isSuperAdmin } from './state.js';
import { toast, escapeHtml, escapeJsString, fmtDate } from './utils.js';

let currentSLATab = 'all'; // 'all' | 'action_needed' | 'overdue' | 'action_planned'
let currentSLASearch = '';

/**
 * Generates the HTML for the 10-Day SLA Watchlist Widget
 */
export function renderSLAWatchlistHTML(prcs, buyerFilter = null) {
  const watchlist = getSLAWatchlistPRCs(prcs, buyerFilter);

  // Compute metric counts
  const totalCount = watchlist.length;
  const overdueCount = watchlist.filter(item => item.sla.slaCategory === 'overdue').length;
  const criticalCount = watchlist.filter(item => item.sla.slaCategory === 'critical').length;
  const warningCount = watchlist.filter(item => item.sla.slaCategory === 'warning').length;
  const actionNeededCount = watchlist.filter(item => !item.sla.hasActionPlan).length;
  const actionPlannedCount = watchlist.filter(item => item.sla.hasActionPlan).length;

  // Filter based on active tab
  let filteredList = watchlist;
  if (currentSLATab === 'action_needed') {
    filteredList = watchlist.filter(item => !item.sla.hasActionPlan);
  } else if (currentSLATab === 'overdue') {
    filteredList = watchlist.filter(item => item.sla.slaCategory === 'overdue' || item.sla.slaCategory === 'critical');
  } else if (currentSLATab === 'action_planned') {
    filteredList = watchlist.filter(item => item.sla.hasActionPlan);
  }

  // Filter based on search query
  if (currentSLASearch) {
    const q = currentSLASearch.trim().toLowerCase();
    filteredList = filteredList.filter(item => {
      const p = item.prc;
      const sla = item.sla;
      return (
        (p.prNumber || '').toLowerCase().includes(q) ||
        (sla.buyer || '').toLowerCase().includes(q) ||
        (p.department || '').toLowerCase().includes(q) ||
        (p.job || '').toLowerCase().includes(q) ||
        (sla.actionPlan || '').toLowerCase().includes(q) ||
        (p.materials || []).some(m => (m.matCode || '').toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q))
      );
    });
  }

  return `
<div class="sla-watchlist-card card" id="sla-watchlist-section" style="margin-top:24px;border:1px solid var(--color-border);border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.04);background:var(--color-surface)">
  <!-- ── 1. HEADER & KPI ALERT BAR ────────────────────────── -->
  <div style="padding:18px 22px;border-bottom:1px solid var(--color-border);background:linear-gradient(to right, rgba(239,68,68,0.03), rgba(245,158,11,0.03), var(--color-surface))">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:42px;height:42px;border-radius:10px;background:linear-gradient(135deg,#f59e0b,#ef4444);display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;box-shadow:0 2px 8px rgba(239,68,68,0.25)">
          ⏱️
        </div>
        <div>
          <div style="display:flex;align-items:center;gap:8px">
            <h3 style="font-size:16px;font-weight:800;margin:0;color:var(--color-text);letter-spacing:-0.2px">
              Proactive 10-Day SLA Watchlist & Buyer Action Register
            </h3>
            <span class="badge" style="background:rgba(239,68,68,0.12);color:#dc2626;font-size:11px;font-weight:800;padding:2px 8px;border-radius:12px;border:1px solid rgba(239,68,68,0.25)">
              10-Day TCD Target
            </span>
          </div>
          <p style="font-size:12px;color:var(--color-text-secondary);margin:3px 0 0 0">
            PRCs pending TCD creation · Set proactive action notes to stay ahead of turnaround SLA benchmarks. Reminders persist until TCD is created.
          </p>
        </div>
      </div>

      <!-- Live KPI Summary Pills -->
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:6px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);padding:6px 12px;border-radius:8px" title="PRCs exceeding 10 days since allocation">
          <span style="font-size:12px">🚨</span>
          <span style="font-size:12px;font-weight:700;color:#dc2626">${overdueCount} Overdue</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;background:rgba(249,115,22,0.1);border:1px solid rgba(249,115,22,0.25);padding:6px 12px;border-radius:8px" title="PRCs between 7 to 10 days (≤ 3 days left)">
          <span style="font-size:12px">⚠️</span>
          <span style="font-size:12px;font-weight:700;color:#ea580c">${criticalCount} Critical</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.25);padding:6px 12px;border-radius:8px" title="PRCs requiring buyer action plans">
          <span style="font-size:12px">📝</span>
          <span style="font-size:12px;font-weight:700;color:#2563eb">${actionNeededCount} Need Action Note</span>
        </div>
      </div>
    </div>

    <!-- Alert Banner when Action Notes are Missing on Overdue/Critical PRCs -->
    ${(overdueCount > 0 || actionNeededCount > 0) ? `
    <div style="margin-top:14px;background:rgba(239,68,68,0.06);border-left:4px solid #ef4444;border-radius:6px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:14px">🔔</span>
        <span style="font-size:12.5px;color:var(--color-text);font-weight:600">
          <strong>${actionNeededCount} active PRC(s)</strong> require buyer action notes to accelerate quotation follow-up and TCD preparation.
        </span>
      </div>
      <button class="btn btn-xs" style="background:#ef4444;color:#fff;font-weight:700;border:none;border-radius:6px;padding:4px 10px;cursor:pointer" onclick="window.switchSLAWatchlistTab('action_needed')">
        Show Actions Required (${actionNeededCount}) →
      </button>
    </div>
    ` : ''}
  </div>

  <!-- ── 2. FILTER TABS & SEARCH BAR ──────────────────────── -->
  <div style="padding:12px 22px;border-bottom:1px solid var(--color-border);background:var(--color-surface);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      <button class="btn btn-xs ${currentSLATab === 'all' ? 'btn-primary' : 'btn-ghost'}" style="font-weight:700;border-radius:6px;padding:5px 12px" onclick="window.switchSLAWatchlistTab('all')">
        All Active Pending (${totalCount})
      </button>
      <button class="btn btn-xs ${currentSLATab === 'action_needed' ? 'btn-primary' : 'btn-ghost'}" style="font-weight:700;border-radius:6px;padding:5px 12px;color:${currentSLATab === 'action_needed' ? '#fff' : '#ea580c'}" onclick="window.switchSLAWatchlistTab('action_needed')">
        ⚠️ Action Needed (${actionNeededCount})
      </button>
      <button class="btn btn-xs ${currentSLATab === 'overdue' ? 'btn-primary' : 'btn-ghost'}" style="font-weight:700;border-radius:6px;padding:5px 12px;color:${currentSLATab === 'overdue' ? '#fff' : '#dc2626'}" onclick="window.switchSLAWatchlistTab('overdue')">
        🚨 Overdue & Critical (${overdueCount + criticalCount})
      </button>
      <button class="btn btn-xs ${currentSLATab === 'action_planned' ? 'btn-primary' : 'btn-ghost'}" style="font-weight:700;border-radius:6px;padding:5px 12px;color:${currentSLATab === 'action_planned' ? '#fff' : '#16a34a'}" onclick="window.switchSLAWatchlistTab('action_planned')">
        ✅ Action Planned (${actionPlannedCount})
      </button>
    </div>

    <!-- Live Search -->
    <div style="display:flex;align-items:center;gap:8px">
      <div style="position:relative">
        <input 
          type="text" 
          placeholder="Filter PRCs, buyers, items..." 
          value="${escapeHtml(currentSLASearch)}" 
          oninput="window.handleSLASearch(this.value)"
          class="form-control form-control-sm" 
          style="width:220px;padding-left:26px;font-size:12px;border-radius:6px"
        />
        <span style="position:absolute;left:8px;top:50%;transform:translateY(-50%);font-size:11px;opacity:0.6">🔍</span>
      </div>
      ${currentSLASearch ? `
        <button class="btn btn-ghost btn-xs" onclick="window.handleSLASearch('')" style="font-size:11px">Clear</button>
      ` : ''}
    </div>
  </div>

  <!-- ── 3. WATCHLIST TABLE ───────────────────────────────── -->
  <div style="overflow-x:auto;max-height:520px;position:relative">
    <table class="table" style="width:100%;margin:0;font-size:12.5px;border-collapse:collapse">
      <thead style="position:sticky;top:0;background:var(--color-surface-2);z-index:2;border-bottom:2px solid var(--color-border)">
        <tr>
          <th style="padding:10px 14px;text-align:left;font-weight:700">PRC Number & Date</th>
          <th style="padding:10px 14px;text-align:left;font-weight:700">Buyer Assigned</th>
          <th style="padding:10px 14px;text-align:left;font-weight:700">Current Pipeline Stage</th>
          <th style="padding:10px 14px;text-align:left;font-weight:700">10-Day SLA Progress</th>
          <th style="padding:10px 14px;text-align:left;font-weight:700;min-width:280px">Proactive Buyer Action Plan & Reminder</th>
          <th style="padding:10px 14px;text-align:right;font-weight:700">Quick Action</th>
        </tr>
      </thead>
      <tbody>
        ${filteredList.length === 0 ? `
        <tr>
          <td colspan="6" style="text-align:center;padding:40px 20px;color:var(--color-text-secondary)">
            <div style="font-size:32px;margin-bottom:8px">🎉</div>
            <div style="font-weight:700;font-size:14px">No PRCs currently in this category!</div>
            <p style="font-size:12px;margin:4px 0 0 0">All PRCs are either on track, actioned, or finalized into TCDs.</p>
          </td>
        </tr>
        ` : filteredList.map(item => {
          const p = item.prc;
          const sla = item.sla;
          const mats = p.materials || [];
          const matCount = mats.length;
          const firstMat = mats[0]?.description || mats[0]?.matCode || 'Materials';

          // Progress bar percentage (capped at 100%)
          const pct = Math.min(100, Math.round((sla.elapsedDays / 10) * 100));

          // SLA Badge styling
          let badgeBg = 'rgba(16,185,129,0.1)';
          let badgeColor = '#059669';
          let badgeBorder = 'rgba(16,185,129,0.3)';
          let barBg = '#10b981';

          if (sla.slaCategory === 'overdue') {
            badgeBg = 'rgba(239,68,68,0.12)';
            badgeColor = '#dc2626';
            badgeBorder = 'rgba(239,68,68,0.35)';
            barBg = '#ef4444';
          } else if (sla.slaCategory === 'critical') {
            badgeBg = 'rgba(249,115,22,0.12)';
            badgeColor = '#ea580c';
            badgeBorder = 'rgba(249,115,22,0.35)';
            barBg = '#f97316';
          } else if (sla.slaCategory === 'warning') {
            badgeBg = 'rgba(234,179,8,0.12)';
            badgeColor = '#ca8a04';
            badgeBorder = 'rgba(234,179,8,0.35)';
            barBg = '#eab308';
          }

          return `
          <tr style="border-bottom:1px solid var(--color-border);transition:background 0.15s ease" onmouseover="this.style.background='var(--color-surface-2)'" onmouseout="this.style.background='transparent'">
            <!-- PRC Number & Requisition Info -->
            <td style="padding:12px 14px;vertical-align:top">
              <div style="font-weight:700;color:var(--color-primary);cursor:pointer;display:inline-flex;align-items:center;gap:4px" onclick="if(typeof openPRCModal==='function')openPRCModal('${escapeJsString(p.id)}')">
                <span>📄</span>
                <span>${escapeHtml(p.prNumber || p.id)}</span>
              </div>
              <div style="font-size:11px;color:var(--color-text-secondary);margin-top:3px">
                Req Date: ${fmtDate(p.prDate || p.createdAt)} · ${matCount} Item${matCount !== 1 ? 's' : ''}
              </div>
              <div style="font-size:11px;color:var(--color-text-secondary);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(firstMat)}">
                ${escapeHtml(firstMat)}
              </div>
            </td>

            <!-- Buyer Assigned -->
            <td style="padding:12px 14px;vertical-align:top">
              <div style="font-weight:600;display:inline-flex;align-items:center;gap:5px">
                <span>👤</span>
                <span>${escapeHtml(sla.buyer || 'Unassigned')}</span>
              </div>
              <div style="font-size:11px;color:var(--color-text-secondary);margin-top:2px">
                ${sla.hasAlloc ? `Alloc: ${fmtDate(sla.allocDate)}` : '<span style="color:#f59e0b">Pending Allocation</span>'}
              </div>
            </td>

            <!-- Current Stage -->
            <td style="padding:12px 14px;vertical-align:top">
              <span class="badge" style="font-size:11px;padding:3px 8px;font-weight:700;background:var(--color-surface-2);border:1px solid var(--color-border)">
                ${escapeHtml(sla.stageLabel)}
              </span>
              <div style="font-size:11px;color:var(--color-text-secondary);margin-top:4px">
                Status: <strong>${escapeHtml(p.status || 'Pending')}</strong>
              </div>
            </td>

            <!-- 10-Day SLA Progress Bar & Badge -->
            <td style="padding:12px 14px;vertical-align:top;min-width:170px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
                <span style="font-size:11.5px;font-weight:700">Day ${sla.elapsedDays} of 10</span>
                <span class="badge" style="font-size:10px;font-weight:800;padding:2px 6px;border-radius:6px;background:${badgeBg};color:${badgeColor};border:1px solid ${badgeBorder}">
                  ${escapeHtml(sla.slaLabel)}
                </span>
              </div>
              <!-- Progress Bar -->
              <div style="width:100%;height:6px;background:var(--color-border);border-radius:3px;overflow:hidden">
                <div style="width:${pct}%;height:100%;background:${barBg};border-radius:3px;transition:width 0.3s ease"></div>
              </div>
              <div style="font-size:10.5px;color:var(--color-text-secondary);margin-top:4px">
                ${sla.elapsedDays <= 10 ? `⏱️ ${10 - sla.elapsedDays} day(s) left for TCD` : `⚠️ Exceeded SLA by ${sla.elapsedDays - 10} day(s)`}
              </div>
            </td>

            <!-- Buyer Action Plan & Reminders -->
            <td style="padding:12px 14px;vertical-align:top">
              ${sla.hasActionPlan ? `
                <div style="background:var(--color-surface-2);border:1px solid var(--color-border);border-left:3px solid #3b82f6;border-radius:6px;padding:8px 10px">
                  <div style="font-size:12px;font-weight:600;color:var(--color-text);line-height:1.4">
                    ${escapeHtml(sla.actionPlan)}
                  </div>
                  <div style="font-size:10.5px;color:var(--color-text-secondary);margin-top:5px;display:flex;align-items:center;justify-content:space-between;gap:8px">
                    <span>
                      ${sla.actionDate ? `🎯 Target: <strong>${fmtDate(sla.actionDate)}</strong> · ` : ''}
                      ${sla.actionUpdatedBy ? `By: ${escapeHtml(sla.actionUpdatedBy)}` : ''}
                    </span>
                    <button class="btn btn-ghost btn-xs" style="padding:1px 6px;font-size:10.5px;color:var(--color-primary);font-weight:700" onclick="window.openSLAActionModal('${escapeJsString(p.id)}')">
                      Edit Plan ✏️
                    </button>
                  </div>
                </div>
              ` : `
                <button 
                  class="btn btn-xs hover-lift" 
                  style="background:rgba(239,68,68,0.08);color:#dc2626;border:1px dashed rgba(239,68,68,0.4);font-weight:700;padding:6px 12px;border-radius:6px;width:100%;text-align:left;display:flex;align-items:center;justify-content:space-between"
                  onclick="window.openSLAActionModal('${escapeJsString(p.id)}')"
                  title="Click to record proactive action note"
                >
                  <span>⚠️ No Action Note Mentioned</span>
                  <span style="font-weight:800">+ Add Action Plan →</span>
                </button>
              `}
            </td>

            <!-- Quick Action Buttons -->
            <td style="padding:12px 14px;vertical-align:top;text-align:right">
              <div style="display:inline-flex;flex-direction:column;gap:4px;align-items:flex-end">
                <button class="btn btn-secondary btn-xs" style="padding:4px 8px;font-size:11px;font-weight:600" onclick="window.openSLAActionModal('${escapeJsString(p.id)}')">
                  📝 Set Action
                </button>
                <button class="btn btn-ghost btn-xs" style="padding:2px 8px;font-size:11px" onclick="if(typeof openPRCModal==='function')openPRCModal('${escapeJsString(p.id)}')">
                  Details 🔍
                </button>
              </div>
            </td>
          </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  </div>

  <!-- ── 4. FOOTER NOTE ───────────────────────────────────── -->
  <div style="padding:10px 20px;border-top:1px solid var(--color-border);background:var(--color-surface-2);font-size:11.5px;color:var(--color-text-secondary);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
    <span>💡 <strong>Proactive SLA Tip:</strong> Action plans keep buyers accountable and remind team members on every dashboard load until a TCD document is generated.</span>
    <span>Showing <strong>${filteredList.length}</strong> of <strong>${totalCount}</strong> watchlist PRCs</span>
  </div>
</div>
  `;
}

// ═══════════════════════════════════════════════════════════
// GLOBAL CONTROLLERS & ACTION MODAL
// ═══════════════════════════════════════════════════════════

if (typeof window !== 'undefined') {
  /**
   * Switch active filter tab on SLA Watchlist
   */
  window.switchSLAWatchlistTab = function(tab) {
    currentSLATab = tab;
    refreshSLAWatchlistDOM();
  };

  /**
   * Filter SLA Watchlist by text query
   */
  window.handleSLASearch = function(query) {
    currentSLASearch = query;
    refreshSLAWatchlistDOM();
  };

  /**
   * Open the Buyer Proactive Action Modal
   */
  window.openSLAActionModal = function(prcId) {
    const state = getState();
    const prc = (state.prcs || []).find(p => p.id === prcId);
    if (!prc) {
      toast('PRC record not found', 'error');
      return;
    }

    const sla = getPRCSLAInfo(prc);
    const existingPlan = prc.slaActionPlan || '';
    const existingDate = prc.slaActionDate || '';

    // Quick action plan presets for 1-click selection
    const presets = [
      '📞 Vendor quote follow-up in progress; awaiting revised quotation',
      '📤 RFQ floated to approved vendors; quotations expected shortly',
      '❓ Technical clarification raised with project site engineer',
      '📉 Commercial price negotiation underway with L1 bidder',
      '🔍 Identifying alternate suppliers due to high quote rates',
      '⏳ TCD draft prepared; pending final review & authorization'
    ];

    const modalId = 'sla-action-modal';
    let modalEl = document.getElementById(modalId);
    if (!modalEl) {
      modalEl = document.createElement('div');
      modalEl.id = modalId;
      modalEl.className = 'modal-overlay';
      document.body.appendChild(modalEl);
    }

    modalEl.innerHTML = `
<div class="modal-box" style="max-width:580px;border-radius:14px;box-shadow:0 20px 40px rgba(0,0,0,0.25);overflow:hidden;background:var(--color-surface)">
  <!-- Modal Header -->
  <div class="modal-header" style="padding:16px 20px;border-bottom:1px solid var(--color-border);background:var(--color-surface-2);display:flex;align-items:center;justify-content:space-between">
    <div style="display:flex;align-items:center;gap:10px">
      <span style="font-size:22px">⏱️</span>
      <div>
        <h3 class="modal-title" style="margin:0;font-size:16px;font-weight:800">Record Proactive SLA Action Plan</h3>
        <p style="margin:2px 0 0 0;font-size:12px;color:var(--color-text-secondary)">
          PRC: <strong>${escapeHtml(prc.prNumber || prc.id)}</strong> · Day <strong>${sla.elapsedDays} of 10</strong> (${sla.slaLabel})
        </p>
      </div>
    </div>
    <button class="modal-close-btn" onclick="document.getElementById('${modalId}').classList.remove('open')">✕</button>
  </div>

  <!-- Modal Body -->
  <div class="modal-body" style="padding:20px">
    <!-- PRC Summary Card -->
    <div style="background:var(--color-surface-2);border:1px solid var(--color-border);border-radius:8px;padding:10px 14px;margin-bottom:16px;display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">
      <div>
        <span style="color:var(--color-text-secondary)">Buyer Assigned:</span>
        <div style="font-weight:700">${escapeHtml(sla.buyer || 'Unassigned')}</div>
      </div>
      <div>
        <span style="color:var(--color-text-secondary)">Current Stage:</span>
        <div style="font-weight:700">${escapeHtml(sla.stageLabel)}</div>
      </div>
      <div>
        <span style="color:var(--color-text-secondary)">Allocation Date:</span>
        <div>${sla.hasAlloc ? fmtDate(sla.allocDate) : 'Not allocated'}</div>
      </div>
      <div>
        <span style="color:var(--color-text-secondary)">10-Day SLA Target:</span>
        <div style="font-weight:700;color:${sla.slaBadgeColor}">${escapeHtml(sla.slaLabel)}</div>
      </div>
    </div>

    <!-- Quick Action Presets -->
    <div style="margin-bottom:14px">
      <label class="form-label" style="font-weight:700;font-size:12px;margin-bottom:6px;display:block">
        ⚡ 1-Click Action Presets:
      </label>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${presets.map(text => `
          <button 
            type="button" 
            class="btn btn-ghost btn-xs" 
            style="text-align:left;border:1px solid var(--color-border);border-radius:6px;padding:6px 10px;font-size:11.5px;line-height:1.3;white-space:normal"
            onclick="document.getElementById('sla-action-note-input').value = '${escapeJsString(text)}'"
          >
            ${escapeHtml(text)}
          </button>
        `).join('')}
      </div>
    </div>

    <!-- Custom Action Plan Input -->
    <div class="form-group" style="margin-bottom:14px">
      <label class="form-label" style="font-weight:700;font-size:12px">
        📝 Action to be Taken / Next Steps <span style="color:#ef4444">*</span>
      </label>
      <textarea 
        id="sla-action-note-input" 
        class="form-control" 
        rows="3" 
        placeholder="Detail the proactive steps you are taking to progress this PRC towards TCD..."
        style="font-size:12.5px;resize:vertical"
      >${escapeHtml(existingPlan)}</textarea>
      <span style="font-size:11px;color:var(--color-text-secondary);margin-top:3px;display:block">
        This note will display as an active reminder on the dashboard until the TCD is finalized.
      </span>
    </div>

    <!-- Target Resolution Date -->
    <div class="form-group" style="margin-bottom:8px">
      <label class="form-label" style="font-weight:700;font-size:12px">
        🎯 Target Action Deadline / Follow-up Date (Optional)
      </label>
      <input 
        type="date" 
        id="sla-action-date-input" 
        class="form-control form-control-sm" 
        value="${existingDate ? existingDate.split('T')[0] : ''}"
        style="width:200px;font-size:12px"
      />
    </div>
  </div>

  <!-- Modal Footer -->
  <div class="modal-footer" style="padding:14px 20px;border-top:1px solid var(--color-border);background:var(--color-surface-2);display:flex;align-items:center;justify-content:space-between">
    <button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById('${modalId}').classList.remove('open')">
      Cancel
    </button>
    <div style="display:flex;gap:8px">
      ${existingPlan ? `
        <button type="button" class="btn btn-danger btn-sm" onclick="window.clearPRCSLAAction('${escapeJsString(prcId)}')">
          Clear Note
        </button>
      ` : ''}
      <button type="button" class="btn btn-primary btn-sm" style="font-weight:700" onclick="window.submitPRCSLAAction('${escapeJsString(prcId)}')">
        Save Action Plan 💾
      </button>
    </div>
  </div>
</div>
    `;

    modalEl.classList.add('open');
  };

  /**
   * Save the action plan entered by user
   */
  window.submitPRCSLAAction = function(prcId) {
    const noteEl = document.getElementById('sla-action-note-input');
    const dateEl = document.getElementById('sla-action-date-input');
    const note = noteEl ? noteEl.value.trim() : '';
    const date = dateEl ? dateEl.value : null;

    if (!note) {
      toast('Please enter an action plan or select a preset', 'warning');
      return;
    }

    const state = getState();
    const currentUser = state.currentUser?.name || state.currentUser?.email || 'Buyer';
    const now = new Date().toISOString();

    updatePRC(prcId, {
      slaActionPlan: note,
      slaActionDate: date || null,
      slaActionUpdatedAt: now,
      slaActionUpdatedBy: currentUser
    });

    const modalEl = document.getElementById('sla-action-modal');
    if (modalEl) modalEl.classList.remove('open');

    toast(`✅ Proactive Action Plan recorded for PRC!`, 'success');
    refreshSLAWatchlistDOM();
  };

  /**
   * Clear an existing action plan
   */
  window.clearPRCSLAAction = function(prcId) {
    updatePRC(prcId, {
      slaActionPlan: '',
      slaActionDate: null,
      slaActionUpdatedAt: new Date().toISOString(),
      slaActionUpdatedBy: ''
    });

    const modalEl = document.getElementById('sla-action-modal');
    if (modalEl) modalEl.classList.remove('open');

    toast('Action plan cleared', 'info');
    refreshSLAWatchlistDOM();
  };
}

/**
 * Helper to dynamically refresh the SLA Watchlist DOM container
 */
function refreshSLAWatchlistDOM() {
  const container = document.getElementById('sla-watchlist-container');
  if (!container) return;

  const state = getState();
  const prcs = typeof window.getDashboardPRCs === 'function' ? window.getDashboardPRCs() : (state.prcs || []);
  const buyerFilter = typeof window.getDashboardBuyerFilter === 'function' ? window.getDashboardBuyerFilter() : null;

  container.innerHTML = renderSLAWatchlistHTML(prcs, buyerFilter);
}
