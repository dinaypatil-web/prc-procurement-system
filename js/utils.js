// =========================================================
// UTILITY HELPERS
// =========================================================

/** Parse any date representation into a valid Date object or null */
export function parseDateObj(d) {
  if (!d && d !== 0) return null;
  if (d instanceof Date) {
    if (isNaN(d.getTime())) return null;
    let y = d.getFullYear();
    if (y < 100) { d = new Date(d.getTime()); d.setFullYear(2000 + y); }
    else if (y >= 1900 && y < 1970) { d = new Date(d.getTime()); d.setFullYear(2000 + (y % 100)); }
    return d;
  }

  // Handle numeric Excel serial date (e.g. 44000 - 48000 is ~2020 - 2031)
  if (typeof d === 'number' || (/^\d{5}(\.\d+)?$/.test(String(d).trim()))) {
    const num = typeof d === 'number' ? d : parseFloat(d);
    if (!isNaN(num) && num > 30000 && num < 60000) {
      // Excel epoch starts Dec 30, 1899 (25569 days to 1970-01-01)
      const dt = new Date(Math.round((num - 25569) * 86400 * 1000));
      if (!isNaN(dt.getTime())) return dt;
    }
  }

  let s = String(d).trim();
  if (!s || s === '—' || s === 'undefined' || s === 'null') return null;

  // Normalize separators: replace multiple spaces, commas with single space
  s = s.replace(/,/g, ' ').replace(/\s+/g, ' ');

  // 1. Handle YYYY-MM-DD or YYYY/MM/DD (4-digit year first)
  const ymdMatch = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10) - 1;
    const day = parseInt(ymdMatch[3], 10);
    const dt = new Date(year, month, day);
    if (!isNaN(dt.getTime())) return dt;
  }

  // 2. Handle DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY (en-GB / Indian format)
  // Supports both 4-digit and 2-digit years: e.g. 06/05/2026 or 06/05/26
  const dmYMatch = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  if (dmYMatch) {
    const day = parseInt(dmYMatch[1], 10);
    const month = parseInt(dmYMatch[2], 10) - 1;
    let year = parseInt(dmYMatch[3], 10);
    if (year < 100) {
      year = year <= 50 ? 2000 + year : 1900 + year;
    }
    const dt = new Date(year, month, day);
    if (!isNaN(dt.getTime())) return dt;
  }

  // 3. Handle DD MMM YYYY or DD-MMM-YY (e.g. "01-Apr-2026", "1-Apr-26", "01 Apr 2026")
  const dMmmYMatch = s.match(/^(\d{1,2})[\/\-\s]+([A-Za-z]{3,9})[\/\-\s]+(\d{2,4})/);
  if (dMmmYMatch) {
    const day = parseInt(dMmmYMatch[1], 10);
    const monStr = dMmmYMatch[2];
    let year = parseInt(dMmmYMatch[3], 10);
    if (year < 100) {
      year = year <= 50 ? 2000 + year : 1900 + year;
    }
    const dt = new Date(`${monStr} ${day}, ${year}`);
    if (!isNaN(dt.getTime())) return dt;
  }

  // 4. Handle MMM DD, YYYY or MMM-DD-YYYY (e.g. "Apr 01, 2026", "April 1, 2026")
  const mmmDYMatch = s.match(/^([A-Za-z]{3,9})[\/\-\s]+(\d{1,2})[,\/\-\s]+(\d{2,4})/);
  if (mmmDYMatch) {
    const monStr = mmmDYMatch[1];
    const day = parseInt(mmmDYMatch[2], 10);
    let year = parseInt(mmmDYMatch[3], 10);
    if (year < 100) {
      year = year <= 50 ? 2000 + year : 1900 + year;
    }
    const dt = new Date(`${monStr} ${day}, ${year}`);
    if (!isNaN(dt.getTime())) return dt;
  }

  // 5. Fallback to standard parse with year sanitization
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) {
    let y = dt.getFullYear();
    if (y < 100) {
      dt.setFullYear(2000 + y);
    } else if (y >= 1900 && y < 1970) {
      dt.setFullYear(2000 + (y % 100));
    }
    return dt;
  }

  return null;
}

/** Check if a date string or Date object matches today (local time) */
export function isTodayDate(d) {
  if (!d) return false;
  const dt = parseDateObj(d);
  if (!dt) return false;
  const now = new Date();
  return dt.getFullYear() === now.getFullYear() &&
         dt.getMonth() === now.getMonth() &&
         dt.getDate() === now.getDate();
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

/** Compute monthly distribution comparing PRCs created vs TCDs finalized, starting from the oldest PRC date in user records */
export function monthlyPRCVsTCDDistribution(prcs = [], tcds = []) {
  const prcMonths = {};
  const tcdMonths = {};
  let oldestDate = null;
  let newestDate = null;

  // Track oldest and newest dates strictly from the user's PRC & Material records (sanitized for realistic modern years >= 2000)
  const currentYear = new Date().getFullYear();
  const updatePrcDateBounds = (raw) => {
    if (!raw) return;
    const dt = parseDateObj(raw);
    if (!dt || isNaN(dt.getTime())) return;
    const y = dt.getFullYear();
    if (y < 2000 || y > currentYear + 2) return;
    if (!oldestDate || dt < oldestDate) oldestDate = dt;
    if (!newestDate || dt > newestDate) newestDate = dt;
  };

  // 1. Tally Monthly PRCs & determine starting month strictly from the oldest PRC date in user records
  prcs.forEach(p => {
    // Prioritize actual PR Date from PRC header or line materials
    const prcDateRaw = p.prDate || (p.materials || []).find(m => m.prDate)?.prDate;
    if (prcDateRaw) {
      updatePrcDateBounds(prcDateRaw);
    } else {
      updatePrcDateBounds(p.createdAt);
      updatePrcDateBounds(p.allocationDate);
      updatePrcDateBounds(p.allocatedDate);
    }

    (p.materials || []).forEach(m => {
      if (m.prDate) updatePrcDateBounds(m.prDate);
    });

    const raw = p.prDate || p.createdAt || p.allocationDate || p.updatedAt;
    const dt = parseDateObj(raw);
    if (!dt || dt.getFullYear() < 2000) return;
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    prcMonths[key] = (prcMonths[key] || 0) + 1;
  });

  // 2. Tally Monthly TCDs (from TCDs collection and PRC/material records with tcdNumber & tcdDate)
  const countedTcdKeys = new Set();

  (tcds || []).forEach(t => {
    const tcdNum = String(t.tcdNumber || t.id || '').trim();
    const raw = t.tcdDate || t.approvedAt || t.createdAt || t.updatedAt;
    const dt = parseDateObj(raw);
    if (!dt || !tcdNum || dt.getFullYear() < 2000) return;
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    const dedupeKey = `${tcdNum}::${key}`;
    if (!countedTcdKeys.has(dedupeKey)) {
      countedTcdKeys.add(dedupeKey);
      tcdMonths[key] = (tcdMonths[key] || 0) + 1;
    }
  });

  prcs.forEach(p => {
    const pTcdNum = String(p.tcdNumber || '').trim();
    const pRaw = p.tcdDate || p.tcdApprovedDate;
    if (pTcdNum && pRaw) {
      const dt = parseDateObj(pRaw);
      if (dt && dt.getFullYear() >= 2000) {
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
        const dedupeKey = `${pTcdNum}::${key}`;
        if (!countedTcdKeys.has(dedupeKey)) {
          countedTcdKeys.add(dedupeKey);
          tcdMonths[key] = (tcdMonths[key] || 0) + 1;
        }
      }
    }

    (p.materials || []).forEach(m => {
      const mTcdNum = String(m.tcdNumber || '').trim();
      const mRaw = m.tcdDate || m.tcdApprovedDate;
      if (mTcdNum && mRaw) {
        const dt = parseDateObj(mRaw);
        if (dt && dt.getFullYear() >= 2000) {
          const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
          const dedupeKey = `${mTcdNum}::${key}`;
          if (!countedTcdKeys.has(dedupeKey)) {
            countedTcdKeys.add(dedupeKey);
            tcdMonths[key] = (tcdMonths[key] || 0) + 1;
          }
        }
      }
    });
  });

  // Determine starting month strictly from user's oldest PRC date (up to current/latest month)
  const now = new Date();
  const startDt = oldestDate || now;
  const endDt = (newestDate && newestDate > now) ? newestDate : now;

  let curYear = startDt.getFullYear();
  let curMonth = startDt.getMonth() + 1; // 1-indexed

  const endYear = Math.max(curYear, endDt.getFullYear());
  const endMonth = endDt.getMonth() + 1;

  const continuousMonthKeys = [];
  while (curYear < endYear || (curYear === endYear && curMonth <= endMonth)) {
    const key = `${curYear}-${String(curMonth).padStart(2, '0')}`;
    continuousMonthKeys.push(key);
    curMonth++;
    if (curMonth > 12) {
      curMonth = 1;
      curYear++;
    }
  }

  return continuousMonthKeys.map(m => {
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
  });
}

/** Compute weekly distribution for the last N weeks (default 10) comparing PRCs created vs TCDs finalized */
export function weeklyPRCVsTCDDistribution(prcs = [], tcds = [], numWeeks = 10, offsetWeeks = 0) {
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

  // Anchor date: use max date in data if available, or today + offsetWeeks
  const now = new Date();
  const maxTs = allTimestamps.length ? Math.max(...allTimestamps) : now.getTime();
  const anchorDate = new Date(maxTs + (offsetWeeks * 7 * 86400000));

  // Determine Monday of the current/anchor week
  const day = anchorDate.getDay(); // 0 is Sunday
  const diffToMon = anchorDate.getDate() - day + (day === 0 ? -6 : 1);
  const currentWeekMon = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), diffToMon, 0, 0, 0, 0);

  // Generate N consecutive weekly buckets ending at currentWeekMon
  const weeks = [];
  for (let i = numWeeks - 1; i >= 0; i--) {
    const start = new Date(currentWeekMon.getFullYear(), currentWeekMon.getMonth(), currentWeekMon.getDate() - i * 7, 0, 0, 0, 0);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59, 999);

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

  return weeks;
}

/** Compute weekly distribution for a specific month (including 2 weeks prior & 2 weeks later) comparing PRCs vs TCDs */
export function weeklyPRCVsTCDDistributionForMonth(prcs = [], tcds = [], monthKey = '') {
  if (!monthKey) return [];
  const [yStr, mStr] = monthKey.split('-');
  const year = parseInt(yStr, 10);
  const month = parseInt(mStr, 10); // 1-indexed (1 to 12)

  if (isNaN(year) || isNaN(month)) return [];

  const firstDayOfMonth = new Date(year, month - 1, 1);
  const lastDayOfMonth = new Date(year, month, 0);

  // Align start to the Monday of the week that contains the 1st of the month
  const firstDayWeekday = firstDayOfMonth.getDay(); // 0 = Sun, 1 = Mon ...
  const diffToFirstMon = firstDayWeekday === 0 ? -6 : 1 - firstDayWeekday;
  const monthStartMon = new Date(year, month - 1, 1 + diffToFirstMon, 0, 0, 0, 0);

  // Start 2 weeks prior (14 days earlier)
  const windowStartMon = new Date(monthStartMon.getTime() - 14 * 86400000);

  // Align end to the Sunday of the week that contains the last day of the month
  const lastDayWeekday = lastDayOfMonth.getDay();
  const diffToLastSun = lastDayWeekday === 0 ? 0 : 7 - lastDayWeekday;
  const monthEndSun = new Date(year, month - 1, lastDayOfMonth.getDate() + diffToLastSun, 23, 59, 59, 999);

  // End 2 weeks later (14 days after)
  const windowEndSun = new Date(monthEndSun.getTime() + 14 * 86400000);

  // Generate weekly buckets (from windowStartMon to windowEndSun)
  const weeks = [];
  let cur = new Date(windowStartMon.getTime());
  let wIndex = 1;

  while (cur.getTime() <= windowEndSun.getTime()) {
    const wStart = new Date(cur.getTime());
    const wEnd = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 6, 23, 59, 59, 999);

    const startStr = wStart.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const endStr = wEnd.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const endYearStr = wEnd.toLocaleDateString('en-GB', { year: '2-digit' });

    // Check if this week overlaps with target month
    const isTargetMonth = (wStart.getMonth() === month - 1 && wStart.getFullYear() === year) ||
                          (wEnd.getMonth() === month - 1 && wEnd.getFullYear() === year);

    weeks.push({
      weekIndex: wIndex++,
      label: startStr,
      fullLabel: `${startStr} – ${endStr} '${endYearStr}`,
      start: wStart.getTime(),
      end: wEnd.getTime(),
      isTargetMonth,
      prcCount: 0,
      tcdCount: 0,
      poCount: 0
    });

    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 7, 0, 0, 0, 0);
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

  return weeks;
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
      shortLabel: dayName,
      dateLabel: dayDate,
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

  return days;
}

/** Get min and max timestamps across all PRCs and TCDs for timeline scrubbing */
export function getDatasetDateBounds(prcs = [], tcds = []) {
  let minTs = Infinity;
  let maxTs = -Infinity;

  const check = (raw) => {
    if (!raw) return;
    const dt = parseDateObj(raw);
    if (!dt) return;
    const ts = dt.getTime();
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
  };

  prcs.forEach(p => {
    check(p.createdAt);
    check(p.allocationDate);
    check(p.prDate);
    check(p.tcdDate);
    check(p.poDate);
    (p.materials || []).forEach(m => {
      check(m.allocationDate);
      check(m.tcdDate);
      check(m.poDate);
    });
  });

  (tcds || []).forEach(t => {
    check(t.tcdDate);
    check(t.createdAt);
    check(t.approvedDate);
  });

  const now = Date.now();
  if (minTs === Infinity) minTs = now - 90 * 86400000;
  if (maxTs === -Infinity) maxTs = now;

  return {
    minTs: minTs - 7 * 86400000,
    maxTs: Math.max(maxTs + 7 * 86400000, now + 7 * 86400000)
  };
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

