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

/** Enable mouse wheel horizontal scrolling on scrollable tables & containers */
export function enableTableHorizontalScroll() {
  document.addEventListener('wheel', (e) => {
    const wrapper = e.target.closest('.table-wrapper, [data-scrollable="true"], .overflow-x-auto, table');
    const scrollTarget = wrapper ? (wrapper.classList?.contains('table-wrapper') ? wrapper : wrapper.closest('.table-wrapper') || wrapper.parentElement) : null;
    if (!scrollTarget) return;

    const maxScrollLeft = scrollTarget.scrollWidth - scrollTarget.clientWidth;
    if (maxScrollLeft > 1) {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) {
        const current = scrollTarget.scrollLeft;
        if ((e.deltaY > 0 && current < maxScrollLeft - 1) || (e.deltaY < 0 && current > 1)) {
          if (e.cancelable) e.preventDefault();
          scrollTarget.scrollLeft += e.deltaY;
        }
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

