// ==========================
// Config & DOM refs
// ==========================
const DEFAULT_TARGET_SECONDS = 8 * 3600; // fallback 08:00
const OFFICE_START_MIN = 9 * 60;         // 09:00 (minutes from 00:00)
let autoTimer = null;

// Accept any Zoho People region TLD (e.g., .in, .com)
const ZOHO_HOST_RE = /^https:\/\/people\.zoho\.[^/]+\//i;

const workedValEl = document.getElementById('workedVal');
const remainingValEl = document.getElementById('remainingVal');
const overtimeRowEl = document.getElementById('overtimeRow');
const overtimeValEl = document.getElementById('overtimeVal');
const relieveValEl = document.getElementById('relieveVal');
const punchesValEl = document.getElementById('punchesVal');
const breakValEl = document.getElementById('breakVal');
const urlRowEl = document.getElementById('urlRow');
const errorRowEl = document.getElementById('errorRow');
const noteRowEl = document.getElementById('noteRow');
const targetDisplayEl = document.getElementById('targetDisplay');
const weekTableEl = document.getElementById('weekTable');
const weekTotalsEl = document.getElementById('weekTotals');
const targetSelectEl = document.getElementById('targetSelect');
const saveTargetBtn = document.getElementById('saveTargetBtn');
const refreshBtn = document.getElementById('refreshBtn');

// ==========================
// Utilities
// ==========================
function pad2(n){ return String(n).padStart(2,'0'); }
function secondsToHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(Math.abs(totalSeconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}
function time12hToMinutes(t) {
  const mm = String(t || '').match(/(\d+):(\d+)\s?(AM|PM)/i);
  if (!mm) return null;
  let h = parseInt(mm[1], 10) % 12;
  const m = parseInt(mm[2], 10);
  const ap = /PM/i.test(mm[3]) ? 12 : 0;
  return (h + ap) * 60 + m;
}
function setRemainingStyle(remSec) {
  remainingValEl.classList.remove('rem-ok', 'rem-warn', 'rem-danger');
  if (remSec <= 0) remainingValEl.classList.add('rem-ok');
  else if (remSec <= 30 * 60) remainingValEl.classList.add('rem-warn');
  else remainingValEl.classList.add('rem-danger');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}
function hhmmToSeconds(hhmm) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return DEFAULT_TARGET_SECONDS;
  const [h,m] = hhmm.split(':').map(n=>parseInt(n,10));
  return (h*3600 + m*60) || DEFAULT_TARGET_SECONDS;
}
function secondsToHHMM(sec) {
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  return `${pad2(h)}:${pad2(m)}`;
}
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
function setBadge(remainingSeconds) {
  const hrsRounded = Math.max(0, Math.ceil(remainingSeconds / 3600));
  chrome.action.setBadgeBackgroundColor({ color: '#5bbad5' });
  chrome.action.setBadgeText({ text: hrsRounded ? `${hrsRounded}h` : '' });
}
function setTargetDisplay(targetSeconds) {
  targetDisplayEl.textContent = `${secondsToHMS(targetSeconds)}`;
}

// Map stored seconds to one of the allowed HH:MM options
const ALLOWED_OPTIONS = ["04:00","06:00","06:30","07:00","08:00"];
function normalizeTargetSeconds(sec) {
  const hhmm = secondsToHHMM(sec);
  if (ALLOWED_OPTIONS.includes(hhmm)) return sec;
  // fallback to 08:00
  return hhmmToSeconds("08:00");
}

// ==========================
// In-page extractor (runs in Zoho)
// ==========================
function pageExtractor() {
  const HRS_TOKEN_RE = /\b(hrs(?:\s*worked)?|hours?|heures|stunden|std\.?|horas|ore)\b/i;
  const TIME_HMS_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;
  const PUNCH_12H = /\b(0?\d|1[0-2]):[0-5]\d\s?(AM|PM)\b/i;
  const toMin = (t) => {
    const mm = String(t || '').match(/(\d+):(\d+)\s?(AM|PM)/i);
    if (!mm) return null;
    let h = parseInt(mm[1], 10) % 12;
    const m = parseInt(mm[2], 10);
    const ap = /PM/i.test(mm[3]) ? 12 : 0;
    return (h + ap) * 60 + m;
  };

  const todayRow = document.querySelector('tr.today-active, tr.zpl_crntday');

  function workedFromRow(row) {
    if (!row) return null;
    const blocks = Array.from(row.querySelectorAll('.zpl_attentrydtls'));
    for (let i = blocks.length - 1; i >= 0; i--) {
      const el = blocks[i];
      const emText = (el.querySelector('em')?.textContent || '').trim();
      if (HRS_TOKEN_RE.test(emText)) {
        const b = el.querySelector('b, strong, time');
        const v = b?.textContent?.trim();
        if (v && TIME_HMS_RE.test(v)) return v.match(TIME_HMS_RE)[0];
      }
    }
    for (let i = blocks.length - 1; i >= 0; i--) {
      const txt = blocks[i].textContent || '';
      const m = txt.match(new RegExp(`(${TIME_HMS_RE.source})\\s*${HRS_TOKEN_RE.source}`, 'i'));
      if (m) return m[1];
    }
    const rowTxt = row.textContent || '';
    const m = rowTxt.match(new RegExp(`(${TIME_HMS_RE.source})\\s*${HRS_TOKEN_RE.source}`, 'i'));
    return m ? m[1] : null;
  }

  function extractOrderedPunches(scope) {
    const events = [];
    scope.querySelectorAll('span.zpl_attprgrsdot').forEach((dot, idx) => {
      const hint = dot.getAttribute('onmouseover') || dot.getAttribute('aria-label') || '';
      const m = hint.match(PUNCH_12H);
      if (!m) return;
      const time = m[0].toUpperCase();
      const cls = dot.className || '';
      const kind = /zpl_prsntBg/.test(cls) ? 'IN' : (/zpl_absntBg/.test(cls) ? 'OUT' : null);
      if (!kind) return;
      events.push({ time, kind, min: toMin(time), order: idx, src: 'dot' });
    });
    scope.querySelectorAll('.zpl_attentrydtls[aria-label]').forEach((el, idx) => {
      const al = el.getAttribute('aria-label') || '';
      const b  = el.querySelector('b, strong');
      const t  = (b?.textContent || '').trim();
      const m  = (t || al).match(PUNCH_12H);
      if (!m) return;
      const time = m[0].toUpperCase();
      let kind = null;
      if (/check[\s-]?in/i.test(al)) kind = 'IN';
      else if (/check[\s-]?out/i.test(al)) kind = 'OUT';
      if (!kind) return;
      const min = toMin(time);
      const dupe = events.some(e => e.kind === kind && e.min === min);
      if (!dupe) events.push({ time, kind, min, order: 1000 + idx, src: 'cell' });
    });
    events.sort((a, b) => (a.min - b.min) || (a.order - b.order));
    const uniq = [];
    const seen = new Set();
    for (const e of events) {
      const key = `${e.min}|${e.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(e);
    }
    return uniq;
  }

  function extractWeekFromTable(startRow, max = 7) {
    const out = [];
    let ptr = startRow;
    while (ptr && out.length < max) {
      const labelCell = ptr.querySelector('td, th');
      const labelText = (labelCell?.textContent || '').trim();
      const worked = workedFromRow(ptr);
      out.push({
        label: out.length === 0 ? 'Today' : (labelText.split(/\s+/).slice(0, 2).join(' ') || `D-${out.length}`),
        worked: worked || null
      });
      ptr = ptr.previousElementSibling;
    }
    return out;
  }

  if (todayRow) {
    const workedText = workedFromRow(todayRow);
    const punches = extractOrderedPunches(todayRow);
    const week = extractWeekFromTable(todayRow, 7);
    if (workedText) return { workedText, punches, week, source: 'today-row:table' };
  }

  const altRow = Array.from(document.querySelectorAll('tr[aria-label], tr'))
    .find(tr => {
      const al = tr.getAttribute?.('aria-label') || '';
      const cell = tr.querySelector('td,th')?.textContent || '';
      return /\btoday\b/i.test(al) || /\btoday\b/i.test((cell || '').trim());
    });

  if (altRow) {
    const workedText = workedFromRow(altRow);
    const punches = extractOrderedPunches(altRow);
    const week = extractWeekFromTable(altRow, 7);
    if (workedText) return { workedText, punches, week, source: 'today-row:fallback' };
  }

  const bodyTxt = document.body?.textContent || '';
  const m = bodyTxt.match(new RegExp(`(${TIME_HMS_RE.source})\\s*${HRS_TOKEN_RE.source}`, 'i'));
  if (m) return { workedText: m[1], punches: [], week: [], source: 'page-wide' };

  return { workedText: null, punches: [], week: [], source: 'not-found' };
}


// ==========================
// Render helpers (UI)
// ==========================
function renderPunchRows(pairs) {
  if (!pairs.length) return '—';

  const wrap = document.createElement('div');
  wrap.className = 'punch-rows';

  const makeTag = (kind, timeText) => {
    if (!timeText) {
      const e = document.createElement('span');
      e.className = 'tag-empty';
      e.textContent = '—';
      return e;
    }
    const span = document.createElement('span');
    span.className = `tag tag-${(kind || 'unk').toLowerCase()}`;
    span.innerHTML = `<span class="dot"></span><strong>${kind}</strong><span class="time">${escapeHtml(timeText)}</span>`;
    return span;
  };

  pairs.forEach(({ in: inEv, out: outEv, gapSec }) => {
    const row = document.createElement('div');
    row.className = 'punch-row';

    const gapCell = document.createElement('div');
    gapCell.className = 'gapcell';
    const gap = document.createElement('span');
    gap.className = 'gap-badge';
    gap.innerHTML = `<span class="dot"></span><span>${gapSec > 0 ? secondsToHMS(gapSec) : '—'}</span>`;
    gapCell.appendChild(gap);

    const pairCell = document.createElement('div');
    pairCell.className = 'paircell';
    pairCell.appendChild(makeTag('IN',  inEv?.time || null));

    const sep = document.createElement('span');
    sep.className = 'pair-sep';
    sep.textContent = '—';
    pairCell.appendChild(sep);

    pairCell.appendChild(makeTag('OUT', outEv?.time || null));

    row.appendChild(gapCell);
    row.appendChild(pairCell);
    wrap.appendChild(row);
  });

  return wrap;
}

function isWeekendLabel(label) {
  return /^\s*(sat|sun)\b/i.test(String(label || ''));
}

function renderWeek(week, targetSeconds) {
  weekTableEl.innerHTML = '';
  weekTotalsEl.innerHTML = '';
  if (!Array.isArray(week) || week.length === 0) return;

  let weekWorkedSec = 0;
  let weekTargetSec = 0;

  week.slice(0, 7).forEach(day => {
    const div = document.createElement('div');
    div.className = 'day';

    const workedSec = day.worked ? (() => {
      const m = day.worked.split(':').map(n=>parseInt(n,10));
      return (m[0]*3600) + (m[1]*60) + (m[2]||0);
    })() : 0;

    const isLeave = isWeekendLabel(day.label);
    const dayTarget = isLeave ? 0 : targetSeconds;

    const dayNet = workedSec - dayTarget; // + overtime, − deficit
    const netTxt = isLeave ? '(Leave)' : `(${dayNet >= 0 ? '+' : '−'}${secondsToHMS(Math.abs(dayNet))})`;
    const netClass = isLeave ? 'dim' : (dayNet >= 0 ? 'ot-pos' : 'ot-neg');

    weekWorkedSec += workedSec;
    weekTargetSec += dayTarget;

    div.innerHTML = `
      <div class="label">${escapeHtml(day.label)}</div>
      <div class="value mono ${isLeave ? 'dim' : ''}">
        ${day.worked ? day.worked : '00:00'} <span class="${netClass}">${netTxt}</span>
      </div>
    `;
    weekTableEl.appendChild(div);
  });

  const net = weekWorkedSec - weekTargetSec;
  const netClass = net >= 0 ? 'rem-ok' : 'rem-danger';

  weekTotalsEl.innerHTML = `
    <div class="muted">Week worked</div><div class="mono">${secondsToHMS(weekWorkedSec)}</div>
    <div class="muted">Week target</div><div class="mono">${secondsToHMS(weekTargetSec)}</div>
    <div class="muted">Net overtime</div><div class="mono ${netClass}">${net >= 0 ? '+' : '−'}${secondsToHMS(Math.abs(net))}</div>
  `;
}

function setRelievingTime(fromSeconds) {
  if (fromSeconds <= 0) {
    relieveValEl.textContent = 'Reached';
    return;
  }
  const eta = new Date(Date.now() + fromSeconds * 1000);
  const hh = eta.getHours();
  const mm = eta.getMinutes();
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const hr12 = ((hh + 11) % 12) + 1;
  relieveValEl.textContent = `${hr12}:${pad2(mm)} ${ampm}`;
}

// ==========================
// Core read + render
// ==========================
let isLoading = false;

function setLoadingState(loading) {
  isLoading = loading;
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.disabled = loading;
    refreshBtn.classList.toggle('spinning', loading);
  }
  if (loading) {
    workedValEl.textContent = '--';
    remainingValEl.textContent = '--';
    relieveValEl.textContent = '--';
    breakValEl.textContent = '--';
    punchesValEl.textContent = '--';
    overtimeRowEl.classList.add('hidden');
    errorRowEl.classList.add('hidden');
  }
}

async function readWorkedFromPage(isRetry = false) {
  if (isLoading && !isRetry) return;
  setLoadingState(true);
  const tab = await getActiveTab();
  urlRowEl.textContent = tab?.url || '';
  noteRowEl.textContent = '';
  errorRowEl.classList.add('hidden');
  errorRowEl.textContent = '';

  // Load / normalize target
  let { targetSeconds = DEFAULT_TARGET_SECONDS } = await chrome.storage.sync.get({
    targetSeconds: DEFAULT_TARGET_SECONDS
  });
  targetSeconds = normalizeTargetSeconds(targetSeconds);
  setTargetDisplay(targetSeconds);

  if (!tab || !ZOHO_HOST_RE.test(tab.url || '')) {
    setLoadingState(false);
    workedValEl.textContent = '—';
    remainingValEl.textContent = '—';
    overtimeRowEl.classList.add('hidden');
    breakValEl.textContent = '—';
    punchesValEl.textContent = '—';
    relieveValEl.textContent = '—';
    errorRowEl.textContent = 'Open the Zoho People attendance page (Summary view).';
    errorRowEl.classList.remove('hidden');
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: pageExtractor
    });

    const hits = (results || []).map(r => r?.result).filter(r => r && typeof r === 'object');
    const withWorked = hits.filter(h => h.workedText && /\d/.test(h.workedText));
    const preferred = withWorked[0] || hits[0];

    if (!preferred || !preferred.workedText) {
      if (!isRetry) {
        // Give the page a moment to finish rendering, then retry once
        setTimeout(() => readWorkedFromPage(true), 2000);
        return;
      }
      setLoadingState(false);
      workedValEl.textContent = '--';
      remainingValEl.textContent = '--';
      overtimeRowEl.classList.add('hidden');
      breakValEl.textContent = '--';
      punchesValEl.textContent = '--';
      relieveValEl.textContent = '--';
      errorRowEl.textContent = 'Could not find today\'s worked time. Try: reload the page, switch to Summary mode, scroll to Today.';
      errorRowEl.classList.remove('hidden');
      return;
    }

    // Build pairs & breaks
    const { pairs, breakTotal } = pairPunches(preferred.punches || []);

    // Compute worked using 09:00 clamp (captures any open/active session)
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const pairsWorkedSec = computeWorkedFromPairsClamped(pairs, nowMin);

    // Parse Zoho's directly-reported hours — authoritative for completed sessions
    // but may lag during an active session (open IN with no OUT yet)
    const wParts = (preferred.workedText || '').trim().split(':').map(p => parseInt(p, 10));
    const zohoWorkedSec = (wParts.length >= 2 && !wParts.some(isNaN))
      ? wParts[0] * 3600 + wParts[1] * 60 + (wParts[2] || 0)
      : 0;

    // Use whichever is higher: Zoho's value is authoritative for completed sessions;
    // pairs-based value covers any open session Zoho hasn't summed yet
    const workedClampedSec = Math.max(zohoWorkedSec, pairsWorkedSec);

    // Display worked
    workedValEl.textContent = secondsToHMS(workedClampedSec);

    // Remaining / Overtime
    const delta = Math.round(targetSeconds - workedClampedSec);
    const remainingSeconds = Math.max(0, delta);
    const overtimeSeconds = Math.max(0, -delta);

    remainingValEl.textContent = secondsToHMS(remainingSeconds);
    setRemainingStyle(remainingSeconds);

    if (overtimeSeconds > 0) {
      overtimeRowEl.classList.remove('hidden');
      overtimeValEl.textContent = `+${secondsToHMS(overtimeSeconds)}`;
    } else {
      overtimeRowEl.classList.add('hidden');
    }

    // Relieving time (ETA from now)
    setRelievingTime(remainingSeconds);

    // Punch detail UI
    punchesValEl.innerHTML = '';
    const punchNode = renderPunchRows(pairs);
    if (typeof punchNode === 'string') punchesValEl.textContent = punchNode;
    else punchesValEl.appendChild(punchNode);

    // Break total
    breakValEl.innerHTML = '';
    const breakChip = document.createElement('span');
    breakChip.className = 'break-chip';
    breakChip.textContent = pairs.length ? secondsToHMS(breakTotal) : '—';
    breakValEl.appendChild(breakChip);

    // Weekly (Zoho values; weekends treated as leave)
    renderWeek(preferred.week, targetSeconds);

    // Badge
    setBadge(remainingSeconds);

    // Note
    noteRowEl.textContent = `Source: ${preferred.source}`;

    // Nudge background to update badge
    chrome.runtime.sendMessage({ type: 'updateBadgeFromPopup', remainingSeconds });

    setLoadingState(false);

  } catch (err) {
    setLoadingState(false);
    workedValEl.textContent = '—';
    remainingValEl.textContent = '—';
    overtimeRowEl.classList.add('hidden');
    breakValEl.textContent = '—';
    punchesValEl.textContent = '—';
    relieveValEl.textContent = '—';
    errorRowEl.textContent = 'Error reading the page: ' + (err.message || String(err));
    errorRowEl.classList.remove('hidden');
  }
}

// ==========================
// Settings & auto update
// ==========================
refreshBtn.addEventListener('click', () => {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(readWorkedFromPage, 20000);
  readWorkedFromPage(true);
});

saveTargetBtn.addEventListener('click', async () => {
  const val = targetSelectEl.value;               // "HH:MM"
  const targetSeconds = hhmmToSeconds(val);
  await chrome.storage.sync.set({ targetSeconds });
  setTargetDisplay(targetSeconds);
  readWorkedFromPage();                           // instant recalc
});

// Init
(async function init() {
  let { targetSeconds = DEFAULT_TARGET_SECONDS } = await chrome.storage.sync.get({
    targetSeconds: DEFAULT_TARGET_SECONDS
  });
  targetSeconds = normalizeTargetSeconds(targetSeconds);

  // Pre-select option based on stored value
  const hhmm = secondsToHHMM(targetSeconds);
  if (ALLOWED_OPTIONS.includes(hhmm)) {
    targetSelectEl.value = hhmm;
  } else {
    targetSelectEl.value = "08:00";
    targetSeconds = hhmmToSeconds("08:00");
    await chrome.storage.sync.set({ targetSeconds });
  }

  setTargetDisplay(targetSeconds);

  // kick first compute
  readWorkedFromPage();

  // auto refresh every 20s
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(readWorkedFromPage, 20000);
})();







// ===== Robust pairing of IN/OUT + break total =====
function pairPunches(events) {
  // Keep only well-formed punch events and sort chronologically
  const seq = (events || [])
    .filter(e => (e && typeof e.min === 'number' && (e.kind === 'IN' || e.kind === 'OUT')))
    .sort((a, b) => (a.min - b.min) || ((a.kind === 'OUT') - (b.kind === 'OUT')));

  // Remove zero-duration IN→OUT pairs at the same minute (system artifacts that break pairing)
  const filtered = [];
  for (let i = 0; i < seq.length; i++) {
    if (seq[i].kind === 'IN' && i + 1 < seq.length &&
        seq[i + 1].kind === 'OUT' && seq[i].min === seq[i + 1].min) {
      i++; // skip both
    } else {
      filtered.push(seq[i]);
    }
  }

  const pairs = [];
  let openIn = null;
  let lastOutMin = null;

  for (const e of filtered) {
    if (e.kind === 'IN') {
      if (openIn) {
        // Two INs in a row → close the previous as an open segment (out=null)
        const gapSec = (lastOutMin != null && openIn.min > lastOutMin) ? (openIn.min - lastOutMin) * 60 : 0;
        pairs.push({ in: openIn, out: null, gapSec });
      }
      openIn = e;
    } else { // OUT
      if (openIn) {
        // Normal IN → OUT
        const gapSec = (lastOutMin != null && openIn.min > lastOutMin) ? (openIn.min - lastOutMin) * 60 : 0;
        pairs.push({ in: openIn, out: e, gapSec });
        openIn = null;
      } else {
        // Leading/spurious OUT without a prior IN → keep as right-only row
        pairs.push({ in: null, out: e, gapSec: 0 });
      }
      lastOutMin = e.min;
    }
  }

  // Trailing IN with no OUT yet (still working)
  if (openIn) {
    const gapSec = (lastOutMin != null && openIn.min > lastOutMin) ? (openIn.min - lastOutMin) * 60 : 0;
    pairs.push({ in: openIn, out: null, gapSec });
  }

  // Total break = sum of each OUT → next IN gap
  let breakTotal = 0;
  let prevOutMin = null;
  for (const e of filtered) {
    if (e.kind === 'OUT') {
      prevOutMin = e.min;
    } else if (e.kind === 'IN' && prevOutMin != null && e.min > prevOutMin) {
      breakTotal += (e.min - prevOutMin) * 60;
      prevOutMin = null;
    }
  }

  return { pairs, breakTotal };
}

// ===== Worked time clamped to [09:00, now] =====
// • Adds each IN→OUT segment (OUT defaults to "now" if missing)
// • If an OUT appears before any IN (user forgot to punch IN), we
//   count from office start (09:00) up to that OUT (clamped).
function computeWorkedFromPairsClamped(pairs, nowMin) {
  const START = OFFICE_START_MIN; // 540 = 09:00
  let totalSec = 0;

  for (const p of (pairs || [])) {
    let inMin  = p.in  ? p.in.min  : null;
    let outMin = p.out ? p.out.min : null;

    // OUT-only pair (bar with no dot in DOM) → skip, we don't know real IN time
    if (inMin == null && outMin != null) continue;

    // Open segment (working) → end at now
    if (inMin != null && outMin == null) outMin = nowMin;

    // If still malformed, skip
    if (inMin == null || outMin == null) continue;

    // Clamp to [09:00, now]
    const segStart = Math.max(inMin, START);
    const segEnd   = Math.min(outMin, nowMin);

    if (segEnd > segStart) {
      totalSec += (segEnd - segStart) * 60;
    }
  }

  return totalSec;
}
