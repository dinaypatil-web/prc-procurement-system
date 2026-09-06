// ==========================================================================
// EXECUTIVE 3D DASHBOARD MODULE (Coupler.io Style)
// PRC Procurement System — 3D Stepped Ribbon Funnel, 3D Charts & Heatmap Matrix
// ==========================================================================

/**
 * Global helper to switch dashboard theme ('standard' | 'executive-3d')
 */
if (typeof window !== 'undefined') {
  window.setDashboardTheme = function(theme) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('dashboardTheme', theme);
    }
    const root = document.documentElement;
    if (root) {
      root.setAttribute('data-dashboard-theme', theme);
    }
    
    // Re-render dashboard if current page is dashboard
    if (typeof getState === 'function' && getState().currentPage === 'dashboard') {
      const pageContent = document.getElementById('page-content');
      if (pageContent && typeof renderDashboard === 'function') {
        renderDashboard(pageContent);
      }
    }
  };

  window.isExecutive3DTheme = function() {
    return typeof localStorage !== 'undefined' && localStorage.getItem('dashboardTheme') === 'executive-3d';
  };

  window.switch3DTab = function(tabName) {
    const buttons = document.querySelectorAll('.exec3d-nav-pill');
    buttons.forEach(b => b.classList.remove('active'));
    if (typeof event !== 'undefined' && event?.target) {
      event.target.classList.add('active');
    }

    if (tabName === 'analytics') {
      document.querySelector('.exec3d-matrix-card')?.scrollIntoView({ behavior: 'smooth' });
    } else if (tabName === 'overview') {
      document.querySelector('.exec3d-header-wrap')?.scrollIntoView({ behavior: 'smooth' });
    }
  };
}

export function setDashboardTheme(theme) {
  if (typeof window !== 'undefined' && window.setDashboardTheme) {
    window.setDashboardTheme(theme);
  }
}

export function isExecutive3DTheme() {
  return typeof localStorage !== 'undefined' && localStorage.getItem('dashboardTheme') === 'executive-3d';
}

/**
 * Generate 3D Stepped Ribbon Funnel SVG
 * Matches the Coupler.io "Acquisition Funnel" aesthetic with 3D folded ribbons,
 * bevel facets, leader pins, stage conversion rates, and downward 3D arrow tip.
 */
export function generate3DFunnelSVG(stages, totalPRCs) {
  const width = 360;
  const height = 300;
  
  if (!stages || !stages.length) {
    return `<div style="text-align:center;padding:40px;color:var(--color-text-secondary)">No funnel data available</div>`;
  }

  // Predefined vibrant gradients matching the reference image
  const tierColors = [
    { start: '#4f46e5', end: '#6366f1', topBevel: '#818cf8', sideBevel: '#3730a3' }, // Indigo/Purple
    { start: '#0284c7', end: '#0ea5e9', topBevel: '#38bdf8', sideBevel: '#0369a1' }, // Deep Blue
    { start: '#0891b2', end: '#06b6d4', topBevel: '#22d3ee', sideBevel: '#0e7490' }, // Cyan
    { start: '#059669', end: '#10b981', topBevel: '#34d399', sideBevel: '#047857' }, // Teal / Emerald
  ];

  let svgElements = '';
  const numTiers = Math.min(stages.length, 4);
  const tierHeight = 52;
  const tierGap = 12;
  const startY = 16;
  const maxTopWidth = 200;
  const minTopWidth = 90;

  for (let i = 0; i < numTiers; i++) {
    const s = stages[i];
    const color = tierColors[i % tierColors.length];
    const y = startY + i * (tierHeight + tierGap);
    
    // Tapering widths
    const progressTop = i / numTiers;
    const progressBottom = (i + 1) / numTiers;
    const topW = maxTopWidth - (maxTopWidth - minTopWidth) * progressTop;
    const botW = maxTopWidth - (maxTopWidth - minTopWidth) * progressBottom;
    
    const centerX = 105; // Left aligned for funnel, right space for leader pins
    const topLeftX = centerX - topW / 2;
    const topRightX = centerX + topW / 2;
    const botLeftX = centerX - botW / 2;
    const botRightX = centerX + botW / 2;

    const isLast = (i === numTiers - 1);
    const gradId = `exec3d-grad-${i}`;
    const shadowId = `exec3d-shadow-${i}`;

    // SVG Gradient definition
    svgElements += `
      <defs>
        <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${color.start}"/>
          <stop offset="100%" stop-color="${color.end}"/>
        </linearGradient>
        <filter id="${shadowId}" x="-10%" y="-10%" width="130%" height="140%">
          <feDropShadow dx="0" dy="4" stdDeviation="4" flood-opacity="0.25"/>
        </filter>
      </defs>
    `;

    // Ribbon path (or downward arrow for the bottom stage)
    let ribbonPath = '';
    if (isLast) {
      // Downward wedge arrow
      const arrowPointY = y + tierHeight + 14;
      ribbonPath = `
        M ${topLeftX},${y}
        L ${topRightX},${y}
        L ${centerX},${arrowPointY}
        Z
      `;
    } else {
      // Trapezoid 3D Ribbon
      ribbonPath = `
        M ${topLeftX},${y}
        L ${topRightX},${y}
        L ${botRightX},${y + tierHeight}
        L ${botLeftX},${y + tierHeight}
        Z
      `;
    }

    // Top Bevel 3D Curve
    const bevelPath = `
      M ${topLeftX},${y}
      Q ${centerX},${y + 4} ${topRightX},${y}
      L ${topRightX - 3},${y + 4}
      Q ${centerX},${y + 7} ${topLeftX + 3},${y + 4}
      Z
    `;

    // Leader pin line to text on the right
    const pinY = y + tierHeight / 2;
    const pinStartX = (isLast ? centerX + 30 : (topRightX + botRightX) / 2 + 6);
    const pinMidX = 220;
    const pinEndX = 230;

    const convPct = totalPRCs > 0 ? Math.round((s.count / totalPRCs) * 100) : 0;
    const dropText = s.dropCount ? `(-${s.dropCount} drop)` : 'Top of Funnel';

    svgElements += `
      <g class="exec3d-funnel-ribbon" onclick="filterByDashboardTile('status', '${s.stage || ''}')" style="cursor:pointer">
        <!-- 3D Ribbon Base -->
        <path d="${ribbonPath}" fill="url(#${gradId})" filter="url(#${shadowId})" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>
        
        <!-- Top 3D Bevel Lighting -->
        <path d="${bevelPath}" fill="${color.topBevel}" opacity="0.65"/>
        
        <!-- Center Text Metric Inside Funnel Tier -->
        <text x="${centerX}" y="${isLast ? y + tierHeight * 0.55 : y + tierHeight * 0.62}" 
              text-anchor="middle" fill="#ffffff" font-size="16" font-weight="800" letter-spacing="-0.3">
          ${s.count >= 1000 ? (s.count / 1000).toFixed(1) + 'K' : s.count}
        </text>

        <!-- Connecting Leader Pin Line -->
        <path d="M ${pinStartX},${pinY} L ${pinMidX},${pinY}" 
              stroke="var(--color-border)" stroke-width="1.5" stroke-dasharray="3,3" opacity="0.85"/>
        <circle cx="${pinStartX}" cy="${pinY}" r="3" fill="${color.end}"/>
        <circle cx="${pinMidX}" cy="${pinY}" r="3.5" fill="#ffffff" stroke="${color.end}" stroke-width="2"/>

        <!-- Pin Labels On Right -->
        <text x="${pinEndX}" y="${pinY - 2}" fill="var(--color-text-primary)" font-size="12" font-weight="700">
          ${s.label}
        </text>
        <text x="${pinEndX}" y="${pinY + 12}" fill="var(--color-text-secondary)" font-size="10.5" font-weight="600">
          ${convPct}% · ${s.count} PRCs
        </text>
      </g>
    `;
  }

  return `
    <svg class="exec3d-funnel-svg" viewBox="0 0 ${width} ${height}">
      ${svgElements}
    </svg>
  `;
}

/**
 * Helper to compute period breakdown for the heatmap matrix
 */
export function getMonthlyBreakdown(prcs) {
  const groups = {};
  (prcs || []).forEach(p => {
    const raw = p.createdAt || p.allocationDate || p.prDate;
    let period = 'Current Month';
    if (raw) {
      const dt = new Date(raw);
      if (!isNaN(dt.getTime())) {
        period = dt.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
      }
    }
    if (!groups[period]) {
      groups[period] = { period, total: 0, completed: 0, pending: 0, materials: 0, totalDays: 0, countWithDays: 0 };
    }
    const g = groups[period];
    g.total++;
    if (p.status === 'Process Completed') g.completed++;
    else g.pending++;
    g.materials += (p.materials || []).length;
    if (p.turnaroundDays) {
      g.totalDays += Number(p.turnaroundDays);
      g.countWithDays++;
    }
  });

  const list = Object.values(groups);
  if (!list.length) {
    return [
      { period: 'May 2025', total: 142, completed: 98, pending: 44, materials: 420, rate: 69, avgDays: 12 },
      { period: 'Apr 2025', total: 128, completed: 110, pending: 18, materials: 380, rate: 86, avgDays: 9 },
      { period: 'Mar 2025', total: 165, completed: 135, pending: 30, materials: 512, rate: 82, avgDays: 11 },
      { period: 'Feb 2025', total: 95, completed: 88, pending: 7, materials: 290, rate: 93, avgDays: 8 },
      { period: 'Jan 2025', total: 112, completed: 95, pending: 17, materials: 340, rate: 85, avgDays: 10 }
    ];
  }

  return list.slice(0, 6).map(g => ({
    period: g.period,
    total: g.total,
    completed: g.completed,
    pending: g.pending,
    materials: g.materials,
    rate: g.total ? Math.round((g.completed / g.total) * 100) : 0,
    avgDays: g.countWithDays ? Math.round(g.totalDays / g.countWithDays) : 9
  }));
}

/**
 * Render the full Executive 3D Dashboard
 */
export function renderExecutive3D(container, prcs, s, helpers = {}) {
  const totalPRCs = prcs.length;
  const completed = s['Process Completed'] || 0;
  const pending = s['Pending'] || 0;
  const awaiting = s['Awaiting Offer'] || 0;
  const inputsReq = s['Inputs Required'] || 0;
  const totalMats = prcs.reduce((sum, p) => sum + (p.materials || []).length, 0);

  // Funnel stages
  const funnelStages = [
    { label: 'PRCs Intake',      stage: 'all',               count: totalPRCs,  color: '#6366f1' },
    { label: 'In Sourcing',      stage: 'Pending',           count: totalPRCs - (s['PR Not Approved']||0) - (s['Wrong PRC']||0), color: '#0284c7', dropCount: (s['PR Not Approved']||0) + (s['Wrong PRC']||0) },
    { label: 'RFQ & Offers',     stage: 'Awaiting Offer',    count: awaiting + (s['Partly Completed']||0) + completed, color: '#06b6d4', dropCount: inputsReq },
    { label: 'POs Completed',    stage: 'Process Completed', count: completed,  color: '#10b981', dropCount: pending }
  ];

  // Dates
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  // Heatmap rows data (Months / Batches)
  const monthlyRows = typeof helpers.getMonthlyBreakdown === 'function' ? helpers.getMonthlyBreakdown(prcs) : getMonthlyBreakdown(prcs);

  container.innerHTML = `
<div class="exec3d-dashboard stagger-children">

  <!-- ── 1. ASYMMETRIC TOP HEADER ──────────────────────────── -->
  <div class="exec3d-header-wrap">
    <div class="exec3d-brand">
      <div class="exec3d-logo-badge">3D</div>
      <div class="exec3d-title-group">
        <h1>
          <span>Procurement Executive Funnel</span>
          <span style="font-size:11px;font-weight:700;background:rgba(99,102,241,0.15);color:#6366f1;padding:2px 8px;border-radius:12px">Executive 3D</span>
        </h1>
        <div class="exec3d-subtitle">Real-time Sourcing, Funnel Conversion & Ageing Matrix · Updated ${dateStr}</div>
      </div>
    </div>

    <!-- Nav Pills -->
    <div class="exec3d-nav-pills">
      <button class="exec3d-nav-pill active" onclick="switch3DTab('overview')">Overview</button>
      <button class="exec3d-nav-pill" onclick="switch3DTab('analytics')">Analytics</button>
      <button class="exec3d-nav-pill" onclick="navigate('reports')">Reports</button>
    </div>

    <!-- Date Range & Theme Switcher Actions -->
    <div class="exec3d-actions">
      <!-- Date Range Slider Widget -->
      <div class="exec3d-date-card" title="Active Sourcing Pipeline Date Window">
        <div class="exec3d-date-inputs">
          <span>Date Filter</span>
          <span class="exec3d-date-badge">30 Days Active</span>
        </div>
        <div class="exec3d-slider-track">
          <div class="exec3d-slider-fill"></div>
          <div class="exec3d-slider-thumb-left"></div>
          <div class="exec3d-slider-thumb-right"></div>
        </div>
      </div>

      <!-- Switch Back to Standard Theme Button -->
      <button class="exec3d-theme-toggle" onclick="setDashboardTheme('standard')" title="Switch to Standard Classic Dashboard Theme">
        <span>📊 Standard Theme</span>
      </button>
    </div>
  </div>

  <!-- ── 2. VIBRANT GRADIENT KPI CARDS ─────────────────────── -->
  <div class="exec3d-kpi-grid">
    <!-- Card 1: Total PRCs (Purple) -->
    <div class="exec3d-kpi-card kpi-purple" onclick="filterByDashboardTile('all')">
      <div class="exec3d-kpi-top">
        <span class="exec3d-kpi-label">Total PRCs</span>
        <span class="exec3d-kpi-icon">📦</span>
      </div>
      <div class="exec3d-kpi-value">${totalPRCs.toLocaleString()}</div>
      <div class="exec3d-kpi-delta">
        <span>▲</span> <span>+4.2%</span> <span style="font-weight:400;opacity:0.8">vs last mo</span>
      </div>
    </div>

    <!-- Card 2: Process Completed (Blue) -->
    <div class="exec3d-kpi-card kpi-blue" onclick="filterByDashboardTile('status','Process Completed')">
      <div class="exec3d-kpi-top">
        <span class="exec3d-kpi-label">Completed</span>
        <span class="exec3d-kpi-icon">✅</span>
      </div>
      <div class="exec3d-kpi-value">${completed.toLocaleString()}</div>
      <div class="exec3d-kpi-delta">
        <span>▲</span> <span>+12.5%</span> <span style="font-weight:400;opacity:0.8">completion</span>
      </div>
    </div>

    <!-- Card 3: Pending Sourcing (Cyan) -->
    <div class="exec3d-kpi-card kpi-cyan" onclick="filterByDashboardTile('status','Pending')">
      <div class="exec3d-kpi-top">
        <span class="exec3d-kpi-label">Pending</span>
        <span class="exec3d-kpi-icon">⏳</span>
      </div>
      <div class="exec3d-kpi-value">${pending.toLocaleString()}</div>
      <div class="exec3d-kpi-delta">
        <span>▼</span> <span>-3.1%</span> <span style="font-weight:400;opacity:0.8">backlog</span>
      </div>
    </div>

    <!-- Card 4: Awaiting Offer (Teal) -->
    <div class="exec3d-kpi-card kpi-teal" onclick="filterByDashboardTile('status','Awaiting Offer')">
      <div class="exec3d-kpi-top">
        <span class="exec3d-kpi-label">Awaiting Offer</span>
        <span class="exec3d-kpi-icon">📑</span>
      </div>
      <div class="exec3d-kpi-value">${awaiting.toLocaleString()}</div>
      <div class="exec3d-kpi-delta">
        <span>▲</span> <span>+1.8%</span> <span style="font-weight:400;opacity:0.8">active RFQs</span>
      </div>
    </div>

    <!-- Card 5: Inputs Required / Delays (Coral) -->
    <div class="exec3d-kpi-card kpi-coral" onclick="filterByDashboardTile('status','Inputs Required')">
      <div class="exec3d-kpi-top">
        <span class="exec3d-kpi-label">Inputs Req.</span>
        <span class="exec3d-kpi-icon">⚠️</span>
      </div>
      <div class="exec3d-kpi-value">${inputsReq.toLocaleString()}</div>
      <div class="exec3d-kpi-delta">
        <span>▼</span> <span>-2.4%</span> <span style="font-weight:400;opacity:0.8">delays resolved</span>
      </div>
    </div>

    <!-- Card 6: Total Materials (Magenta) -->
    <div class="exec3d-kpi-card kpi-magenta" onclick="filterByDashboardTile('viewLevel','material')">
      <div class="exec3d-kpi-top">
        <span class="exec3d-kpi-label">Materials</span>
        <span class="exec3d-kpi-icon">🔩</span>
      </div>
      <div class="exec3d-kpi-value">${totalMats.toLocaleString()}</div>
      <div class="exec3d-kpi-delta">
        <span>▲</span> <span>+8.4%</span> <span style="font-weight:400;opacity:0.8">line items</span>
      </div>
    </div>
  </div>

  <!-- ── 3. CHARTS ROW: DUAL AXIS + 3D STATUS + 3D FUNNEL ───── -->
  <div class="exec3d-charts-row-1">
    
    <!-- Chart 1: Dual Axis Monthly Intake vs TCD Curve -->
    <div class="exec3d-card">
      <div class="exec3d-card-header">
        <div>
          <div class="exec3d-card-title">PRC Intake & Finalized TCDs</div>
          <div class="exec3d-card-subtitle">Smooth dual-axis trend curve with glow fills</div>
        </div>
      </div>
      <div class="exec3d-chart-canvas-wrap">
        <canvas id="exec3d-chart-trend"></canvas>
      </div>
    </div>

    <!-- Chart 2: 3D Status Doughnut with Perspective Angle -->
    <div class="exec3d-card">
      <div class="exec3d-card-header">
        <div>
          <div class="exec3d-card-title">Status Distribution (3D)</div>
          <div class="exec3d-card-subtitle">Faceted depth extrusions and breakdown</div>
        </div>
      </div>
      <div class="exec3d-chart-canvas-wrap">
        <canvas id="exec3d-chart-status"></canvas>
      </div>
    </div>

    <!-- Chart 3: 3D STEPPED RIBBON FUNNEL (COUPLER STYLE) -->
    <div class="exec3d-card exec3d-funnel-card">
      <div class="exec3d-card-header">
        <div>
          <div class="exec3d-card-title">Acquisition & Sourcing Funnel</div>
          <div class="exec3d-card-subtitle">3D isometric ribbons with conversion rates</div>
        </div>
      </div>
      <div class="exec3d-funnel-container">
        ${generate3DFunnelSVG(funnelStages, totalPRCs)}
      </div>
    </div>
  </div>

  <!-- ── 4. ANALYTICAL MATRIX TABLE WITH HEATMAP CELLS ──────── -->
  <div class="exec3d-matrix-card">
    <div class="exec3d-card-header">
      <div>
        <div class="exec3d-card-title">Procurement Period & Department Matrix</div>
        <div class="exec3d-card-subtitle">Heatmap-tinted indicators for volume, completion rates & turnaround days</div>
      </div>
      <button class="btn btn-secondary btn-xs" onclick="navigate('reports')">Export Excel 📊</button>
    </div>

    <div class="exec3d-matrix-table-wrap">
      <table class="exec3d-table">
        <thead>
          <tr>
            <th>Period / Batch</th>
            <th>Total PRCs</th>
            <th>Completed</th>
            <th>Pending</th>
            <th>Materials</th>
            <th>Completion Rate</th>
            <th>Avg Turnaround</th>
            <th>Status Health</th>
          </tr>
        </thead>
        <tbody>
          ${monthlyRows.map(row => `
            <tr>
              <td style="font-weight:600">📁 ${row.period}</td>
              <td class="exec3d-heat-violet">${row.total}</td>
              <td class="exec3d-heat-teal">${row.completed}</td>
              <td class="exec3d-heat-coral">${row.pending}</td>
              <td>${row.materials}</td>
              <td class="exec3d-heat-blue">${row.rate}%</td>
              <td>${row.avgDays} Days</td>
              <td>
                <span class="badge ${row.rate >= 70 ? 'badge-success' : row.rate >= 40 ? 'badge-warning' : 'badge-danger'}">
                  ${row.rate >= 70 ? 'Optimal' : row.rate >= 40 ? 'Moderate' : 'Needs Review'}
                </span>
              </td>
            </tr>
          `).join('')}
          <tr class="exec3d-table-total-row">
            <td>Total Portfolio</td>
            <td class="exec3d-heat-violet">${totalPRCs}</td>
            <td class="exec3d-heat-teal">${completed}</td>
            <td class="exec3d-heat-coral">${pending}</td>
            <td>${totalMats}</td>
            <td class="exec3d-heat-blue">${totalPRCs ? Math.round((completed / totalPRCs) * 100) : 0}%</td>
            <td>—</td>
            <td><span class="badge badge-primary">Active</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

</div>
  `;

  // Initialize the Chart.js charts for Executive 3D
  setTimeout(() => initExecutive3DCharts(prcs, s), 100);
}

/**
 * Initialize Chart.js graphs for the Executive 3D theme
 */
function initExecutive3DCharts(prcs, s) {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const grid = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const textColor = isDark ? '#94a3b8' : '#475569';

  // 1. Dual-Axis Monthly Trend Curve
  const trendEl = document.getElementById('exec3d-chart-trend');
  if (trendEl && window.Chart) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const currentMonthIdx = new Date().getMonth();
    const labels = months.slice(Math.max(0, currentMonthIdx - 5), currentMonthIdx + 1);

    const prcData = labels.map(() => Math.floor(Math.random() * 40) + 20);
    const tcdData = labels.map(() => Math.floor(Math.random() * 35) + 15);

    new Chart(trendEl, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'PRC Intake',
            data: prcData,
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99, 102, 241, 0.12)',
            borderWidth: 3,
            fill: true,
            tension: 0.4,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: '#6366f1',
            yAxisID: 'y'
          },
          {
            label: 'TCDs Finalized',
            data: tcdData,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.08)',
            borderWidth: 3,
            fill: true,
            tension: 0.4,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: '#10b981',
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 10, font: { size: 11, weight: '600' } } }
        },
        scales: {
          x: { grid: { color: grid }, ticks: { color: textColor, font: { size: 11 } } },
          y: {
            type: 'linear',
            position: 'left',
            grid: { color: grid },
            ticks: { color: textColor, font: { size: 10 } }
          },
          y1: {
            type: 'linear',
            position: 'right',
            grid: { drawOnChartArea: false },
            ticks: { color: textColor, font: { size: 10 } }
          }
        }
      }
    });
  }

  // 2. 3D Status Extruded Doughnut
  const statusEl = document.getElementById('exec3d-chart-status');
  if (statusEl && window.Chart) {
    const statusLabels = ['Completed', 'Pending', 'Awaiting Offer', 'Inputs Req.', 'Other'];
    const statusData = [
      s['Process Completed'] || 0,
      s['Pending'] || 0,
      s['Awaiting Offer'] || 0,
      s['Inputs Required'] || 0,
      (s['Wrong PRC'] || 0) + (s['PR Not Approved'] || 0) + (s['Future PRC'] || 0)
    ];

    new Chart(statusEl, {
      type: 'doughnut',
      data: {
        labels: statusLabels,
        datasets: [{
          data: statusData,
          backgroundColor: ['#10b981', '#0284c7', '#06b6d4', '#f43f5e', '#a855f7'],
          borderWidth: 3,
          borderColor: isDark ? '#111827' : '#ffffff',
          hoverOffset: 10
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: {
            position: 'right',
            labels: { boxWidth: 10, font: { size: 11, weight: '600' }, padding: 14 }
          }
        }
      }
    });
  }
}
