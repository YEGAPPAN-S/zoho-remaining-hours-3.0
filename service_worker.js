// ============================
// Constants
// ============================
const TARGET_URL = "https://people.zoho.in/humbletreecloud/zp#attendance/entry/summary-mode:list";
const ZOHO_HOST_RE = /^https:\/\/people\.zoho\.(in|com)\//i; // match the hosts you granted

// ============================
// Click behavior: icon click → open/focus page → wait → open popup
// ============================
chrome.action.onClicked.addListener(async () => {
  try {
    const tab = await openOrFocusZoho();
    // Ensure window focused + tab active
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });

    // Wait until tab is ready (SPA hash routes can be 'complete' already; we still add a short fallback delay)
    await waitForTabReady(tab.id, 3000);

    // Programmatically open the popup (must have a popup set)
    await chrome.action.setPopup({ popup: "popup.html" });
    try {
      await chrome.action.openPopup();
    } finally {
      // Return to "no default popup" so left-click continues to trigger onClicked
      await chrome.action.setPopup({ popup: "" });
    }
  } catch (e) {
    // Not fatal; just no-op
    console.warn("action.onClicked handler failed:", e);
  }
});

async function openOrFocusZoho() {
  const tabs = await chrome.tabs.query({});
  // Prefer an existing Zoho People tab
  let existing = tabs.find(t => t.url && ZOHO_HOST_RE.test(t.url));
  if (existing) {
    // Navigate that tab to the exact Summary URL (hash route) and focus it
    await chrome.tabs.update(existing.id, { url: TARGET_URL, active: true });
    return existing;
  }
  // Otherwise create a new one
  const created = await chrome.tabs.create({ url: TARGET_URL, active: true });
  return created;
}

// Resolve when the tab becomes 'complete' or after a timeout (SPA-friendly)
function waitForTabReady(tabId, timeoutMs = 2500) {
  return new Promise(async (resolve) => {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === "complete") {
        // Add a tiny delay so the DOM settles on SPA hash loads
        setTimeout(resolve, 200);
        return;
      }
    } catch (_) {
      // tab might be gone; resolve
      return resolve();
    }

    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(id, info) {
      if (id !== tabId) return;
      if (info.status === "complete" || info.url === TARGET_URL) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // slight settle delay for SPA
        setTimeout(resolve, 200);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ============================
// Badge refresher (unchanged features, tolerant extractor)
// ============================
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('badgeRefresh', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'badgeRefresh') {
    updateBadgeFromAnyZohoTab().catch(() => {});
  }
});

// Also allow popup to nudge us to update immediately
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'updateBadgeFromPopup' && typeof msg.remainingSeconds === 'number') {
    setBadge(msg.remainingSeconds);
  }
});

function setBadge(remainingSeconds) {
  const hrsRounded = Math.max(0, Math.ceil(remainingSeconds / 3600));
  chrome.action.setBadgeBackgroundColor({ color: '#5bbad5' });
  chrome.action.setBadgeText({ text: hrsRounded ? `${hrsRounded}h` : '' });
}

async function updateBadgeFromAnyZohoTab() {
  const { targetHours = 8 } = await chrome.storage.sync.get({ targetHours: 8 });

  const tabs = await chrome.tabs.query({});
  const zohoTabs = tabs.filter(t => t?.url && ZOHO_HOST_RE.test(t.url));
  if (!zohoTabs.length) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }

  const targetSeconds = Math.round(targetHours * 3600);

  for (const tab of zohoTabs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => {
          // tolerant worked-hours mini extractor (runs in page)
          const HRS_TOKEN_RE = /\b(hrs(?:\s*worked)?|hours?|heures|stunden|std\.?|horas|ore)\b/i;
          const TIME_HMS_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;

          const row = document.querySelector('tr.today-active, tr.zpl_crntday') ||
                      Array.from(document.querySelectorAll('tr[aria-label], tr')).find(tr => {
                        const al = tr.getAttribute?.('aria-label') || '';
                        const cell = tr.querySelector('td,th')?.textContent || '';
                        return /\btoday\b/i.test(al) || /\btoday\b/i.test((cell || '').trim());
                      });

          if (!row) return { workedText: null };

          const blocks = Array.from(row.querySelectorAll('.zpl_attentrydtls'));
          for (let i = blocks.length - 1; i >= 0; i--) {
            const el = blocks[i];
            const emText = (el.querySelector('em')?.textContent || '').trim();
            if (HRS_TOKEN_RE.test(emText)) {
              const b = el.querySelector('b, strong, time');
              const v = b?.textContent?.trim();
              if (v && TIME_HMS_RE.test(v)) return { workedText: v.match(TIME_HMS_RE)[0] };
            }
          }
          for (let i = blocks.length - 1; i >= 0; i--) {
            const txt = blocks[i].textContent || '';
            const m = txt.match(new RegExp(`(${TIME_HMS_RE.source})\\s*${HRS_TOKEN_RE.source}`, 'i'));
            if (m) return { workedText: m[1] };
          }
          const rowTxt = row.textContent || '';
          const m = rowTxt.match(new RegExp(`(${TIME_HMS_RE.source})\\s*${HRS_TOKEN_RE.source}`, 'i'));
          return { workedText: m ? m[1] : null };
        }
      });

      const hit = (results || []).map(r => r?.result).find(r => r && r.workedText);
      if (hit && hit.workedText) {
        const workedSec = hmsToSeconds(hit.workedText);
        const remaining = Math.max(0, Math.round(targetHours * 3600) - workedSec);
        setBadge(remaining);
        return; // first good tab is enough
      }
    } catch {
      // continue to next tab
    }
  }

  chrome.action.setBadgeText({ text: '' });
}

function hmsToSeconds(hms) {
  const parts = hms.trim().split(':').map(p => parseInt(p, 10));
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}
