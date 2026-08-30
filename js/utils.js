// =========================================================
// UTILITY HELPERS
// =========================================================

/** Parse any date representation into a valid Date object or null */
export function parseDateObj(d) {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d;

  const s = String(d).trim();
  if (!s || s === '—' || s === 'undefined' || s === 'null') return null;

  // 1. Try ISO / YYYY-MM-DD or standard parse first
  let dt = new Date(s);
  if (!isNaN(dt.getTime())) return dt;

  // 2. Handle DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const dmYMatch = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
  if (dmYMatch) {
    const day = parseInt(dmYMatch[1], 10);
    const month = parseInt(dmYMatch[2], 10) - 1;
    const year = parseInt(dmYMatch[3], 10);
    dt = new Date(year, month, day);
    if (!isNaN(dt.getTime())) return dt;
  }

  // 3. Handle DD MMM YYYY (e.g. "01 Aug 2026" or "1 Aug 2026")
  const dMmmYMatch = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/);
  if (dMmmYMatch) {
    dt = new Date(`${dMmmYMatch[2]} ${dMmmYMatch[1]}, ${dMmmYMatch[3]}`);
    if (!isNaN(dt.getTime())) return dt;
  }

  return null;
}

/** Format date as DD/MM/YYYY */
export function fmtDate(d) {
  if (!d) return '—';
  const dt = parseDateObj(d);
  if (!dt) return String(d);
  return dt.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}

/** Convert any raw date string to YYYY-MM-DD for HTML input type="date" */
export function toInputDateVal(d) {
  if (!d) return '';
  const dt = parseDateObj(d);
  if (!dt) return '';
  const year = dt.getFullYear();
  const month = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Format datetime as DD MMM YYYY HH:MM */
export function fmtDateTime(d) {
  if (!d) return '—';
  const dt = parseDateObj(d);
  if (!dt) return String(d);
  return dt.toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

/** Format number with commas */
export function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US');
}

/** Format currency */
export function fmtCurrency(n, currency = 'KWD') {
  if (!n && n !== 0) return '—';
  return new Intl.NumberFormat('en-US', { style:'currency', currency, minimumFractionDigits:3 }).format(n);
}

/** Relative time (e.g. "3 days ago") */
export function timeAgo(d) {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 1)    return 'just now';
  if (mins < 60)   return `${mins}m ago`;
  if (hours < 24)  return `${hours}h ago`;
  if (days === 1)  return 'yesterday';
  if (days < 30)   return `${days} days ago`;
  return fmtDate(d);
}

/** Truncate string */
export function truncate(str, len = 40) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

/** Debounce */
export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Deep clone */
export function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Generate UUID */
export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,
        c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}

/** CSV string from array of objects */
export function toCSV(rows, columns) {
  const header = columns.map(c => `"${c.label}"`).join(',');
  const data   = rows.map(r =>
    columns.map(c => {
      const v = c.accessor ? c.accessor(r) : (r[c.key] ?? '');
      return `"${String(v).replace(/"/g, '""')}"`;
    }).join(',')
  );
  return [header, ...data].join('\n');
}

/** Download blob */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href    = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Download text file */
export function downloadText(text, filename, mime = 'text/plain') {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

/** Show toast notification */
export function toast(message, type = 'info', duration = 4000) {
  if (typeof document === 'undefined') {
    return;
  }
  const container = document.getElementById('toast-container');
  if (!container) return;

  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    <span style="font-size:16px">${icons[type]||'ℹ️'}</span>
    <span style="flex:1">${message}</span>
    <button onclick="this.parentElement.remove()" style="border:none;background:none;cursor:pointer;color:inherit;font-size:16px;padding:0 4px">×</button>
  `;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, duration);
}

/** Confirm dialog (returns promise) */
export function confirm(message, title = 'Confirm Action') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `
      <div class="modal modal-sm fade-in-up">
        <div class="modal-header">
          <h3 class="modal-title">${title}</h3>
        </div>
        <div class="modal-body">
          <p style="color:var(--color-text-secondary)">${message}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="confirm-cancel">Cancel</button>
          <button class="btn btn-danger"    id="confirm-ok">Confirm</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#confirm-cancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('#confirm-ok').onclick     = () => { overlay.remove(); resolve(true); };
    overlay.onclick = e => { if (e.target === overlay) { overlay.remove(); resolve(false); } };
  });
}

/** Animate counter from 0 to target */
export function animateCounter(el, target, duration = 1000) {
  const start = performance.now();
  const update = now => {
    const t = Math.min((now - start) / duration, 1);
    const ease = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2;
    el.textContent = fmtNum(Math.round(ease * target));
    if (t < 1) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

/** Add ripple effect to element */
export function addRipple(el, e) {
  const rect   = el.getBoundingClientRect();
  const size   = Math.max(rect.width, rect.height);
  const x      = e.clientX - rect.left - size / 2;
  const y      = e.clientY - rect.top  - size / 2;
  const ripple = document.createElement('span');
  ripple.className = 'ripple';
  ripple.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px`;
  el.appendChild(ripple);
  setTimeout(() => ripple.remove(), 700);
}

/** Priority color helper */
export function priorityChipClass(p) {
  const m = { Critical:'chip-critical', High:'chip-high', Medium:'chip-medium', Low:'chip-low' };
  return m[p] || 'chip-medium';
}

/** Highlight search term in string */
export function highlight(text, query) {
  if (!query || !text) return text || '';
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi');
  return String(text).replace(re, '<mark style="background:rgba(59,130,246,0.2);color:inherit;border-radius:2px;padding:0 2px">$1</mark>');
}

/** Extract unique values from array of objects by key */
export function uniqueBy(arr, key) {
  return [...new Set(arr.map(i => i[key]).filter(Boolean))].sort();
}

/** Group array by key */
export function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = item[key] || 'Unknown';
    if (!acc[k]) acc[k] = [];
    acc[k].push(item);
    return acc;
  }, {});
}

/** Compute monthly distribution */
export function monthlyDistribution(prcs, dateField = 'createdAt') {
  const months = {};
  prcs.forEach(p => {
    const raw = p[dateField] || p.allocationDate || p.prDate || p.createdAt;
    const dt = parseDateObj(raw);
    if (!dt) return;

    const year = dt.getFullYear();
    const month = String(dt.getMonth() + 1).padStart(2, '0');
    const key = `${year}-${month}`;
    months[key] = (months[key] || 0) + 1;
  });
  return Object.entries(months).sort(([a],[b]) => a.localeCompare(b));
}

/** Compute monthly distribution comparing PRCs created vs TCDs finalized */
export function monthlyPRCVsTCDDistribution(prcs = [], tcds = []) {
  const prcMonths = {};
  const tcdMonths = {};
  const allMonths = new Set();

  // 1. Tally Monthly PRCs
  prcs.forEach(p => {
    const raw = p.createdAt || p.prDate || p.allocationDate || p.updatedAt;
    const dt = parseDateObj(raw);
    if (!dt) return;
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    prcMonths[key] = (prcMonths[key] || 0) + 1;
    allMonths.add(key);
  });

  // 2. Tally Monthly TCDs (from TCDs collection and PRC/material records with tcdNumber & tcdDate)
  const countedTcdKeys = new Set();

  // A. From TCDs collection
  (tcds || []).forEach(t => {
    const tcdNum = String(t.tcdNumber || t.id || '').trim();
    const raw = t.tcdDate || t.approvedAt || t.createdAt || t.updatedAt;
    const dt = parseDateObj(raw);
    if (!dt || !tcdNum) return;
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    const dedupeKey = `${tcdNum}::${key}`;
    if (!countedTcdKeys.has(dedupeKey)) {
      countedTcdKeys.add(dedupeKey);
      tcdMonths[key] = (tcdMonths[key] || 0) + 1;
      allMonths.add(key);
    }
  });

  // B. Also include any TCDs recorded on PRCs/materials not already counted
  prcs.forEach(p => {
    const pTcdNum = String(p.tcdNumber || '').trim();
    const pRaw = p.tcdDate || p.tcdApprovedDate;
    if (pTcdNum && pRaw) {
      const dt = parseDateObj(pRaw);
      if (dt) {
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
        const dedupeKey = `${pTcdNum}::${key}`;
        if (!countedTcdKeys.has(dedupeKey)) {
          countedTcdKeys.add(dedupeKey);
          tcdMonths[key] = (tcdMonths[key] || 0) + 1;
          allMonths.add(key);
        }
      }
    }

    (p.materials || []).forEach(m => {
      const mTcdNum = String(m.tcdNumber || '').trim();
      const mRaw = m.tcdDate || m.tcdApprovedDate;
      if (mTcdNum && mRaw) {
        const dt = parseDateObj(mRaw);
        if (dt) {
          const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
          const dedupeKey = `${mTcdNum}::${key}`;
          if (!countedTcdKeys.has(dedupeKey)) {
            countedTcdKeys.add(dedupeKey);
            tcdMonths[key] = (tcdMonths[key] || 0) + 1;
            allMonths.add(key);
          }
        }
      }
    });
  });

  // Sorted chronological month keys
  const sortedMonthKeys = Array.from(allMonths).sort((a, b) => a.localeCompare(b));

  return sortedMonthKeys.map(m => {
    const [y, mm] = m.split('-');
    const dt = new Date(parseInt(y, 10), parseInt(mm, 10) - 1, 1);
    const label = !isNaN(dt.getTime())
      ? dt.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
      : m;

    const tcdCount = tcdMonths[m] || 0;
    return {
      monthKey: m,
      label,
      prcCount: prcMonths[m] || 0,
      tcdCount,
      poCount: tcdCount // backward compatibility alias
    };
  }).filter(item => item.prcCount > 0); // Hide periods where PRC count is 0
}

/** Compute weekly distribution for the last N weeks (default 10) comparing PRCs created vs TCDs finalized */
export function weeklyPRCVsTCDDistribution(prcs = [], tcds = [], numWeeks = 10) {
  const allTimestamps = [];

  // Collect all valid dates from PRCs
  prcs.forEach(p => {
    const raw = p.createdAt || p.prDate || p.allocationDate || p.updatedAt;
    const dt = parseDateObj(raw);
    if (dt) allTimestamps.push(dt.getTime());
  });

  // Collect dates from TCDs
  (tcds || []).forEach(t => {
    const raw = t.tcdDate || t.approvedAt || t.createdAt || t.updatedAt;
    const dt = parseDateObj(raw);
    if (dt) allTimestamps.push(dt.getTime());
  });

  // Collect dates from PRC TCD fields & materials
  prcs.forEach(p => {
    if (p.tcdDate || p.tcdApprovedDate) {
      const dt = parseDateObj(p.tcdDate || p.tcdApprovedDate);
      if (dt) allTimestamps.push(dt.getTime());
    }
    (p.materials || []).forEach(m => {
      if (m.tcdDate || m.tcdApprovedDate) {
        const dt = parseDateObj(m.tcdDate || m.tcdApprovedDate);
        if (dt) allTimestamps.push(dt.getTime());
      }
    });
  });

  // Anchor date: use max date in data if available, or today
  const now = new Date();
  const maxTs = allTimestamps.length ? Math.max(...allTimestamps) : now.getTime();
  const anchorDate = new Date(maxTs);

  // Determine Monday of the current/anchor week
  const day = anchorDate.getDay(); // 0 is Sunday
  const diffToMon = anchorDate.getDate() - day + (day === 0 ? -6 : 1);
  const currentWeekMon = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), diffToMon, 0, 0, 0, 0);

  // Generate N consecutive weekly buckets ending at currentWeekMon
  const weeks = [];
  for (let i = numWeeks - 1; i >= 0; i--) {
    const start = new Date(currentWeekMon.getFullYear(), currentWeekMon.getMonth(), currentWeekMon.getDate() - i * 7, 0, 0, 0, 0);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 5, 59, 999);

    const startStr = start.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const endStr = end.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const endYearStr = end.toLocaleDateString('en-GB', { year: '2-digit' });

    weeks.push({
      weekIndex: numWeeks - i,
      label: startStr,
      fullLabel: `${startStr} – ${endStr} '${endYearStr}`,
      start: start.getTime(),
      end: end.getTime(),
      prcCount: 0,
      tcdCount: 0,
      poCount: 0
    });
  }

  // 1. Tally PRCs
  prcs.forEach(p => {
    const raw = p.createdAt || p.prDate || p.allocationDate || p.updatedAt;
    const dt = parseDateObj(raw);
    if (!dt) return;
    const ts = dt.getTime();
    const w = weeks.find(wk => ts >= wk.start && ts <= wk.end);
    if (w) w.prcCount++;
  });

  // 2. Tally TCDs (deduplicated by TCD number per week)
  const countedTcdKeys = new Set();

  (tcds || []).forEach(t => {
    const tcdNum = String(t.tcdNumber || t.id || '').trim();
    const raw = t.tcdDate || t.approvedAt || t.createdAt || t.updatedAt;
    const dt = parseDateObj(raw);
    if (!dt || !tcdNum) return;
    const ts = dt.getTime();
    const w = weeks.find(wk => ts >= wk.start && ts <= wk.end);
    if (w) {
      const dedupeKey = `${tcdNum}::${w.start}`;
      if (!countedTcdKeys.has(dedupeKey)) {
        countedTcdKeys.add(dedupeKey);
        w.tcdCount++;
        w.poCount++;
      }
    }
  });

  prcs.forEach(p => {
    const pTcdNum = String(p.tcdNumber || '').trim();
    const pRaw = p.tcdDate || p.tcdApprovedDate;
    if (pTcdNum && pRaw) {
      const dt = parseDateObj(pRaw);
      if (dt) {
        const ts = dt.getTime();
        const w = weeks.find(wk => ts >= wk.start && ts <= wk.end);
        if (w) {
          const dedupeKey = `${pTcdNum}::${w.start}`;
          if (!countedTcdKeys.has(dedupeKey)) {
            countedTcdKeys.add(dedupeKey);
            w.tcdCount++;
            w.poCount++;
          }
        }
      }
    }

    (p.materials || []).forEach(m => {
      const mTcdNum = String(m.tcdNumber || '').trim();
      const mRaw = m.tcdDate || m.tcdApprovedDate;
      if (mTcdNum && mRaw) {
        const dt = parseDateObj(mRaw);
        if (dt) {
          const ts = dt.getTime();
          const w = weeks.find(wk => ts >= wk.start && ts <= wk.end);
          if (w) {
            const dedupeKey = `${mTcdNum}::${w.start}`;
            if (!countedTcdKeys.has(dedupeKey)) {
              countedTcdKeys.add(dedupeKey);
              w.tcdCount++;
              w.poCount++;
            }
          }
        }
      }
    });
  });

  // Hide periods where PRC count is 0
  return weeks.filter(w => w.prcCount > 0);
}

/** Compute weekly distribution for a specific month (including 2 weeks prior & 2 weeks later) comparing PRCs vs TCDs */
export function weeklyPRCVsTCDDistributionForMonth(prcs = [], tcds = [], monthKey = '') {
  if (!monthKey) return [];
  const [yStr, mStr] = monthKey.split('-');
  const year = parseInt(yStr, 10);
  const month = parseInt(mStr, 10); // 1-indexed (1 to 12)

  if (isNaN(year) || isNaN(month)) return [];

  const firstDayOfMonth = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const lastDayOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

  // 2 weeks (14 days) prior to 1st of month
  const windowStart = new Date(year, month - 1, 1 - 14, 0, 0, 0, 0);
  // 2 weeks (14 days) after last day of month
  const windowEnd = new Date(lastDayOfMonth.getFullYear(), lastDayOfMonth.getMonth(), lastDayOfMonth.getDate() + 14, 23, 59, 59, 999);

  // Determine Monday of the start week
  const day = windowStart.getDay();
  const diffToMon = windowStart.getDate() - day + (day === 0 ? -6 : 1);
  let curMon = new Date(windowStart.getFullYear(), windowStart.getMonth(), diffToMon, 0, 0, 0, 0);

  const weeks = [];
  let weekIndex = 1;

  while (curMon.getTime() <= windowEnd.getTime()) {
    const wStart = new Date(curMon.getTime());
    const wEnd = new Date(curMon.getFullYear(), curMon.getMonth(), curMon.getDate() + 6, 23, 59, 59, 999);

    const startStr = wStart.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const endStr = wEnd.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const endYearStr = wEnd.toLocaleDateString('en-GB', { year: '2-digit' });

    // Check if this week falls inside the target month
    const isTargetMonth = (wStart.getMonth() === month - 1 && wStart.getFullYear() === year) ||
                          (wEnd.getMonth() === month - 1 && wEnd.getFullYear() === year);

    weeks.push({
      weekIndex: weekIndex++,
      label: startStr,
      fullLabel: `${startStr} – ${endStr} '${endYearStr}`,
      isTargetMonth,
      start: wStart.getTime(),
      end: wEnd.getTime(),
      prcCount: 0,
      tcdCount: 0,
      poCount: 0
    });

    // Advance to next Monday
    curMon = new Date(curMon.getFullYear(), curMon.getMonth(), curMon.getDate() + 7, 0, 0, 0, 0);
  }

  // 1. Tally PRCs
  prcs.forEach(p => {
    const raw = p.createdAt || p.prDate || p.allocationDate || p.updatedAt;
    const dt = parseDateObj(raw);
    if (!dt) return;
    const ts = dt.getTime();
    const w = weeks.find(wk => ts >= wk.start && ts <= wk.end);
    if (w) w.prcCount++;
  });

  // 2. Tally TCDs (deduplicated by TCD number per week)
  const countedTcdKeys = new Set();

  (tcds || []).forEach(t => {
    const tcdNum = String(t.tcdNumber || t.id || '').trim();
    const raw = t.tcdDate || t.approvedAt || t.createdAt || t.updatedAt;
    const dt = parseDateObj(raw);
    if (!dt || !tcdNum) return;
    const ts = dt.getTime();
    const w = weeks.find(wk => ts >= wk.start && ts <= wk.end);
    if (w) {
      const dedupeKey = `${tcdNum}::${w.start}`;
      if (!countedTcdKeys.has(dedupeKey)) {
        countedTcdKeys.add(dedupeKey);
        w.tcdCount++;
        w.poCount++;
      }
    }
  });

  prcs.forEach(p => {
    const pTcdNum = String(p.tcdNumber || '').trim();
    const pRaw = p.tcdDate || p.tcdApprovedDate;
    if (pTcdNum && pRaw) {
      const dt = parseDateObj(pRaw);
      if (dt) {
        const ts = dt.getTime();
        const w = weeks.find(wk => ts >= wk.start && ts <= wk.end);
        if (w) {
          const dedupeKey = `${pTcdNum}::${w.start}`;
          if (!countedTcdKeys.has(dedupeKey)) {
            countedTcdKeys.add(dedupeKey);
            w.tcdCount++;
            w.poCount++;
          }
        }
      }
    }

    (p.materials || []).forEach(m => {
      const mTcdNum = String(m.tcdNumber || '').trim();
      const mRaw = m.tcdDate || m.tcdApprovedDate;
      if (mTcdNum && mRaw) {
        const dt = parseDateObj(mRaw);
        if (dt) {
          const ts = dt.getTime();
          const w = weeks.find(wk => ts >= wk.start && ts <= wk.end);
          if (w) {
            const dedupeKey = `${mTcdNum}::${w.start}`;
            if (!countedTcdKeys.has(dedupeKey)) {
              countedTcdKeys.add(dedupeKey);
              w.tcdCount++;
              w.poCount++;
            }
          }
        }
      }
    });
  });

  // Hide periods where PRC count is 0
  return weeks.filter(w => w.prcCount > 0);
}

/** Compute daily distribution for a specific week window comparing PRCs vs TCDs */
export function dailyPRCVsTCDDistributionForWeek(prcs = [], tcds = [], weekStartTs = 0, weekEndTs = 0) {
  if (!weekStartTs || !weekEndTs) return [];
  const startDt = new Date(weekStartTs);
  const endDt = new Date(weekEndTs);

  const days = [];
  let cur = new Date(startDt.getFullYear(), startDt.getMonth(), startDt.getDate(), 0, 0, 0, 0);
  const maxEnd = new Date(endDt.getFullYear(), endDt.getMonth(), endDt.getDate(), 23, 59, 59, 999);

  while (cur.getTime() <= maxEnd.getTime()) {
    const dStart = new Date(cur.getTime());
    const dEnd = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), 23, 59, 59, 999);

    const dayName = dStart.toLocaleDateString('en-GB', { weekday: 'short' });
    const dayDate = dStart.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const fullDate = dStart.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });

    days.push({
      dayKey: `${dStart.getFullYear()}-${String(dStart.getMonth() + 1).padStart(2, '0')}-${String(dStart.getDate()).padStart(2, '0')}`,
      label: `${dayName}, ${dayDate}`,
      fullLabel: fullDate,
      start: dStart.getTime(),
      end: dEnd.getTime(),
      prcCount: 0,
      tcdCount: 0,
      poCount: 0
    });

    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1, 0, 0, 0, 0);
  }

  // 1. Tally PRCs
  prcs.forEach(p => {
    const raw = p.createdAt || p.prDate || p.allocationDate || p.updatedAt;
    const dt = parseDateObj(raw);
    if (!dt) return;
    const ts = dt.getTime();
    const d = days.find(day => ts >= day.start && ts <= day.end);
    if (d) d.prcCount++;
  });

  // 2. Tally TCDs (deduplicated by TCD number per day)
  const countedTcdKeys = new Set();

  (tcds || []).forEach(t => {
    const tcdNum = String(t.tcdNumber || t.id || '').trim();
    const raw = t.tcdDate || t.approvedAt || t.createdAt || t.updatedAt;
    const dt = parseDateObj(raw);
    if (!dt || !tcdNum) return;
    const ts = dt.getTime();
    const d = days.find(day => ts >= day.start && ts <= day.end);
    if (d) {
      const dedupeKey = `${tcdNum}::${d.dayKey}`;
      if (!countedTcdKeys.has(dedupeKey)) {
        countedTcdKeys.add(dedupeKey);
        d.tcdCount++;
        d.poCount++;
      }
    }
  });

  prcs.forEach(p => {
    const pTcdNum = String(p.tcdNumber || '').trim();
    const pRaw = p.tcdDate || p.tcdApprovedDate;
    if (pTcdNum && pRaw) {
      const dt = parseDateObj(pRaw);
      if (dt) {
        const ts = dt.getTime();
        const d = days.find(day => ts >= day.start && ts <= day.end);
        if (d) {
          const dedupeKey = `${pTcdNum}::${d.dayKey}`;
          if (!countedTcdKeys.has(dedupeKey)) {
            countedTcdKeys.add(dedupeKey);
            d.tcdCount++;
            d.poCount++;
          }
        }
      }
    }

    (p.materials || []).forEach(m => {
      const mTcdNum = String(m.tcdNumber || '').trim();
      const mRaw = m.tcdDate || m.tcdApprovedDate;
      if (mTcdNum && mRaw) {
        const dt = parseDateObj(mRaw);
        if (dt) {
          const ts = dt.getTime();
          const d = days.find(day => ts >= day.start && ts <= day.end);
          if (d) {
            const dedupeKey = `${mTcdNum}::${d.dayKey}`;
            if (!countedTcdKeys.has(dedupeKey)) {
              countedTcdKeys.add(dedupeKey);
              d.tcdCount++;
              d.poCount++;
            }
          }
        }
      }
    });
  });

  // Hide periods where PRC count is 0
  return days.filter(d => d.prcCount > 0);
}

// Backwards compatibility aliases
export const monthlyPRCVsPODistribution = monthlyPRCVsTCDDistribution;
export const weeklyPRCVsPODistribution = weeklyPRCVsTCDDistribution;
export const weeklyPRCVsPODistributionForMonth = weeklyPRCVsTCDDistributionForMonth;
export const dailyPRCVsPODistributionForWeek = dailyPRCVsTCDDistributionForWeek;

/** Enable mouse wheel horizontal scrolling when holding Shift on scrollable tables & containers */
export function enableTableHorizontalScroll() {
  document.addEventListener('wheel', (e) => {
    // Only scroll horizontally when Shift key is pressed (standard OS convention)
    if (e.shiftKey && e.deltaY !== 0) {
      const wrapper = e.target.closest('.table-wrapper, [data-scrollable="true"], .overflow-x-auto, table');
      const scrollTarget = wrapper ? (wrapper.classList?.contains('table-wrapper') ? wrapper : wrapper.closest('.table-wrapper') || wrapper.parentElement) : null;
      if (!scrollTarget) return;

      const maxScrollLeft = scrollTarget.scrollWidth - scrollTarget.clientWidth;
      if (maxScrollLeft > 1) {
        if (e.cancelable) e.preventDefault();
        scrollTarget.scrollLeft += e.deltaY;
      }
    }
  }, { passive: false });
}

/** Copy text to clipboard and display toast feedback */
export async function copyToClipboard(text, label = 'Reference Number', e = null) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  if (!text || text === '—' || text === 'null' || text === 'undefined') return;

  const cleanText = String(text).trim();
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(cleanText);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = cleanText;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    toast(`📋 Copied ${label}: ${cleanText}`, 'success', 2000);
  } catch (err) {
    console.error('Failed to copy to clipboard:', err);
    toast('Failed to copy to clipboard', 'error');
  }
}

if (typeof window !== 'undefined') {
  window.copyToClipboard = copyToClipboard;
}

