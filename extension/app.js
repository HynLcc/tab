/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';

const DEFAULT_THEME_COLOR = '#e3ead7';
const DEFAULT_DOCK_PREFERENCES = {
  density: 'cozy',
  sort: 'smart',
  filter: 'all',
  showSidebar: true,
};
const DEFAULT_SIDEBAR_PANEL_STATE = {
  favorites: false,
  deferred: false,
};
const DOCK_DENSITY_OPTIONS = new Set(['compact', 'cozy', 'airy']);
const DOCK_SORT_OPTIONS = new Set(['smart', 'size', 'alpha']);
const DOCK_FILTER_OPTIONS = new Set(['all', 'duplicates', 'homepages']);
const STORAGE_KEYS = {
  deferred: 'deferred',
  favorites: 'favoriteLinks',
};
const INTERACTION_KINDS = {
  tabLink: 'tab-link',
};
const INTERACTION_TARGETS = {
  deferred: {
    accepts: new Set([INTERACTION_KINDS.tabLink]),
    actionId: 'save-for-later',
    dropEffect: 'move',
  },
  favorites: {
    accepts: new Set([INTERACTION_KINDS.tabLink]),
    actionId: 'save-common-url',
    dropEffect: 'copy',
  },
};
const CHROME_TAB_GROUP_NONE = -1;
const CHROME_GROUP_DROP_PREFIX = 'chrome-group-';
let dockPreferences = { ...DEFAULT_DOCK_PREFERENCES };
let sidebarPanelState = { ...DEFAULT_SIDEBAR_PANEL_STATE };
let activeDragPayload = null;
let activeDragSource = null;


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];
let chromeTabGroups = [];

function normalizeHexColor(value) {
  if (typeof value !== 'string') return DEFAULT_THEME_COLOR;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return '#' + trimmed.slice(1).split('').map(ch => ch + ch).join('').toLowerCase();
  }
  return DEFAULT_THEME_COLOR;
}

function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex);
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function mixHexColors(base, target, weight = 0.5) {
  const a = hexToRgb(base);
  const b = hexToRgb(target);
  return rgbToHex({
    r: a.r * (1 - weight) + b.r * weight,
    g: a.g * (1 - weight) + b.g * weight,
    b: a.b * (1 - weight) + b.b * weight,
  });
}

function normalizeDockPreferences(raw = {}) {
  const density = DOCK_DENSITY_OPTIONS.has(raw.density) ? raw.density : DEFAULT_DOCK_PREFERENCES.density;
  const sort = DOCK_SORT_OPTIONS.has(raw.sort) ? raw.sort : DEFAULT_DOCK_PREFERENCES.sort;
  const filter = DOCK_FILTER_OPTIONS.has(raw.filter) ? raw.filter : DEFAULT_DOCK_PREFERENCES.filter;
  const showSidebar = typeof raw.showSidebar === 'boolean' ? raw.showSidebar : DEFAULT_DOCK_PREFERENCES.showSidebar;
  return { density, sort, filter, showSidebar };
}

function normalizeSidebarPanelState(raw = {}) {
  return {
    favorites: typeof raw.favorites === 'boolean' ? raw.favorites : DEFAULT_SIDEBAR_PANEL_STATE.favorites,
    deferred: typeof raw.deferred === 'boolean' ? raw.deferred : DEFAULT_SIDEBAR_PANEL_STATE.deferred,
  };
}

async function getAppearanceSettings() {
  const { appearance = {} } = await chrome.storage.local.get('appearance');
  return appearance;
}

async function saveAppearanceSettings(patch) {
  const appearance = await getAppearanceSettings();
  const next = { ...appearance, ...patch };
  await chrome.storage.local.set({ appearance: next });
  return next;
}

function updateDockControlUI() {
  document.body.dataset.density = dockPreferences.density;
  document.body.classList.toggle('hide-deferred-column', !dockPreferences.showSidebar);

  document.querySelectorAll('[data-action="set-dock-density"]').forEach(el => {
    el.classList.toggle('is-active', el.dataset.density === dockPreferences.density);
  });
  document.querySelectorAll('[data-action="set-dock-sort"]').forEach(el => {
    el.classList.toggle('is-active', el.dataset.sort === dockPreferences.sort);
  });
  document.querySelectorAll('[data-action="set-dock-filter"]').forEach(el => {
    el.classList.toggle('is-active', el.dataset.filter === dockPreferences.filter);
  });
  document.querySelectorAll('[data-action="set-sidebar-visibility"]').forEach(el => {
    const wantsShow = el.dataset.sidebar === 'show';
    el.classList.toggle('is-active', wantsShow === dockPreferences.showSidebar);
  });

  const dockHint = document.getElementById('dockHint');
  if (dockHint) {
    const sidebarLabel = dockPreferences.showSidebar ? 'sidebar on' : 'sidebar hidden';
    dockHint.textContent = `Density ${dockPreferences.density}. Sorted ${dockPreferences.sort}. Filter ${dockPreferences.filter}. ${sidebarLabel}.`;
  }
}

async function loadDockPreferences() {
  try {
    const appearance = await getAppearanceSettings();
    dockPreferences = normalizeDockPreferences(appearance.dock || {});
    sidebarPanelState = normalizeSidebarPanelState(appearance.sidebarPanels || {});
  } catch {
    dockPreferences = { ...DEFAULT_DOCK_PREFERENCES };
    sidebarPanelState = { ...DEFAULT_SIDEBAR_PANEL_STATE };
  }
  updateDockControlUI();
}

async function saveDockPreferences(patch) {
  dockPreferences = normalizeDockPreferences({ ...dockPreferences, ...patch });
  updateDockControlUI();
  const appearance = await getAppearanceSettings();
  await chrome.storage.local.set({
    appearance: {
      ...appearance,
      dock: dockPreferences,
    },
  });
}

async function saveSidebarPanelState(patch) {
  sidebarPanelState = normalizeSidebarPanelState({ ...sidebarPanelState, ...patch });
  updateSidebarPanelsUI();
  const appearance = await getAppearanceSettings();
  await chrome.storage.local.set({
    appearance: {
      ...appearance,
      sidebarPanels: sidebarPanelState,
    },
  });
}

function applyThemeColor(color) {
  const normalized = normalizeHexColor(color);
  const root = document.documentElement;

  root.style.setProperty('--browser-accent', normalized);

  const input = document.getElementById('dockColorInput');
  if (input && input.value !== normalized) input.value = normalized;
}

async function loadThemeColor() {
  try {
    const appearance = await getAppearanceSettings();
    applyThemeColor(appearance.themeColor || DEFAULT_THEME_COLOR);
  } catch {
    applyThemeColor(DEFAULT_THEME_COLOR);
  }
}

async function saveThemeColor(color) {
  const normalized = normalizeHexColor(color);
  applyThemeColor(normalized);
  await saveAppearanceSettings({ themeColor: normalized });
}

async function resetThemeColor() {
  applyThemeColor(DEFAULT_THEME_COLOR);
  const appearance = await getAppearanceSettings();
  const next = { ...appearance };
  delete next.themeColor;
  await chrome.storage.local.set({ appearance: next });
}

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    try {
      chromeTabGroups = chrome.tabGroups?.query ? await chrome.tabGroups.query({}) : [];
    } catch {
      chromeTabGroups = [];
    }

    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      index:    t.index,
      groupId:  Number.isInteger(t.groupId) ? t.groupId : CHROME_TAB_GROUP_NONE,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
    chromeTabGroups = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
function parseDatasetInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

async function focusTab(url, tabId = null) {
  if (Number.isInteger(tabId)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.id !== undefined) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return true;
      }
    } catch {
      // Fall back to URL matching below when a tab no longer exists.
    }
  }

  if (!url) return false;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return false;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
  return true;
}

async function openOrFocusTab(url) {
  if (!url) return;
  const focused = await focusTab(url);
  if (!focused) {
    await chrome.tabs.create({ url });
  }
}

async function closeSingleTabByUrl(url) {
  if (!url) return false;
  const allTabs = await chrome.tabs.query({});
  const match = allTabs.find(t => t.url === url);
  if (!match) return false;
  await chrome.tabs.remove(match.id);
  return true;
}

async function closeSingleTabByIdOrUrl(tabId, url) {
  if (Number.isInteger(tabId)) {
    try {
      await chrome.tabs.remove(tabId);
      return true;
    } catch {
      // Fall back to URL matching if the tab was already moved or closed.
    }
  }
  return closeSingleTabByUrl(url);
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { [STORAGE_KEYS.deferred]: deferred = [] } = await chrome.storage.local.get(STORAGE_KEYS.deferred);
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ [STORAGE_KEYS.deferred]: deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { [STORAGE_KEYS.deferred]: deferred = [] } = await chrome.storage.local.get(STORAGE_KEYS.deferred);
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { [STORAGE_KEYS.deferred]: deferred = [] } = await chrome.storage.local.get(STORAGE_KEYS.deferred);
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ [STORAGE_KEYS.deferred]: deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { [STORAGE_KEYS.deferred]: deferred = [] } = await chrome.storage.local.get(STORAGE_KEYS.deferred);
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ [STORAGE_KEYS.deferred]: deferred });
  }
}

async function saveFavoriteLink(link) {
  const { [STORAGE_KEYS.favorites]: favorites = [] } = await chrome.storage.local.get(STORAGE_KEYS.favorites);
  const now = new Date().toISOString();
  const existing = favorites.find(item => !item.dismissed && item.url === link.url);

  if (existing) {
    existing.title = link.title || existing.title;
    existing.updatedAt = now;
    await chrome.storage.local.set({ [STORAGE_KEYS.favorites]: favorites });
    return { status: 'existing', item: existing };
  }

  const item = {
    id: Date.now().toString(),
    url: link.url,
    title: link.title,
    createdAt: now,
    updatedAt: now,
    dismissed: false,
  };

  favorites.unshift(item);
  await chrome.storage.local.set({ [STORAGE_KEYS.favorites]: favorites });
  return { status: 'created', item };
}

async function getFavoriteLinks() {
  const { [STORAGE_KEYS.favorites]: favorites = [] } = await chrome.storage.local.get(STORAGE_KEYS.favorites);
  return favorites
    .filter(item => !item.dismissed)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
}

async function dismissFavoriteLink(id) {
  const { [STORAGE_KEYS.favorites]: favorites = [] } = await chrome.storage.local.get(STORAGE_KEYS.favorites);
  const item = favorites.find(entry => entry.id === id);
  if (!item) return false;
  item.dismissed = true;
  await chrome.storage.local.set({ [STORAGE_KEYS.favorites]: favorites });
  return true;
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.innerHTML = '<span class="section-count-text">0 domains</span>';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createTabInteractionPayload(tab) {
  if (!tab || !tab.url) return null;
  return {
    kind: INTERACTION_KINDS.tabLink,
    tabId: Number.isInteger(tab.id) ? tab.id : null,
    windowId: Number.isInteger(tab.windowId) ? tab.windowId : null,
    groupId: Number.isInteger(tab.groupId) ? tab.groupId : CHROME_TAB_GROUP_NONE,
    url: tab.url,
    title: tab.title || tab.url,
  };
}

function getTabPayloadFromElement(element) {
  if (!element) return null;
  return createTabInteractionPayload({
    id: parseDatasetInt(element.dataset.tabId),
    windowId: parseDatasetInt(element.dataset.windowId),
    groupId: parseDatasetInt(element.dataset.groupId),
    url: element.dataset.tabUrl,
    title: element.dataset.tabTitle || element.getAttribute('title') || element.dataset.tabUrl,
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
  group:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.9" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 6.75h9m-9 5.25h9m-9 5.25h5.25M4.5 5.25A1.5 1.5 0 0 1 6 3.75h12A1.5 1.5 0 0 1 19.5 5.25v13.5A1.5 1.5 0 0 1 18 20.25H6A1.5 1.5 0 0 1 4.5 18.75V5.25Z" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];
const TAB_GROUP_COLORS = ['blue', 'cyan', 'green', 'orange', 'pink', 'purple', 'red', 'yellow'];
const CHROME_GROUP_COLOR_HEX = {
  grey:   '#6f767d',
  blue:   '#1a73e8',
  red:    '#d93025',
  yellow: '#f9ab00',
  green:  '#188038',
  pink:   '#d01884',
  purple: '#9334e6',
  cyan:   '#007b83',
  orange: '#fa903e',
};

function getStableDomainId(domain) {
  return 'domain-' + String(domain).toLowerCase().replace(/[^a-z0-9]/g, '-');
}

function getStableChromeGroupId(groupId) {
  return `chrome-${groupId}`;
}

function getChromeGroupDropTargetId(groupId) {
  return `${CHROME_GROUP_DROP_PREFIX}${groupId}`;
}

function getChromeGroupIdFromDropTarget(targetId) {
  if (!targetId || !targetId.startsWith(CHROME_GROUP_DROP_PREFIX)) return null;
  return parseDatasetInt(targetId.slice(CHROME_GROUP_DROP_PREFIX.length));
}

function getChromeGroupById(groupId) {
  return chromeTabGroups.find(group => group.id === groupId) || null;
}

function getChromeGroupLabel(group) {
  const title = (group?.title || '').trim();
  return title || 'Untitled group';
}

function getGroupLabel(group) {
  if (group?.kind === 'chrome-group') return getChromeGroupLabel(group);
  return group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
}

function hashString(value) {
  let hash = 0;
  for (const char of value) {
    hash = ((hash << 5) - hash) + char.charCodeAt(0);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getTabGroupColor(group) {
  const key = `${group.domain}:${getGroupLabel(group)}`;
  return TAB_GROUP_COLORS[hashString(key) % TAB_GROUP_COLORS.length];
}

function getChromeGroupStyle(group) {
  const hex = CHROME_GROUP_COLOR_HEX[group.color] || CHROME_GROUP_COLOR_HEX.grey;
  const { r, g, b } = hexToRgb(hex);
  return `--group-accent:${hex};--group-accent-rgb:${r},${g},${b};`;
}

function buildChromeGroupCards(realTabs) {
  const byGroupId = new Map(chromeTabGroups.map(group => [
    group.id,
    {
      ...group,
      kind: 'chrome-group',
      tabs: [],
      firstTabIndex: Number.POSITIVE_INFINITY,
    },
  ]));

  for (const tab of realTabs) {
    const group = byGroupId.get(tab.groupId);
    if (!group) continue;
    group.tabs.push(tab);
    if (Number.isInteger(tab.index)) {
      group.firstTabIndex = Math.min(group.firstTabIndex, tab.index);
    }
  }

  return Array.from(byGroupId.values())
    .filter(group => group.tabs.length > 0)
    .sort((a, b) => {
      if (a.windowId !== b.windowId) return a.windowId - b.windowId;
      return a.firstTabIndex - b.firstTabIndex;
    });
}

function getDashboardGroupLabel(group) {
  return group.kind === 'chrome-group' ? getChromeGroupLabel(group) : getGroupLabel(group);
}

async function groupTabsIntoChromeGroups(group) {
  const tabs = (group.tabs || []).filter(tab => Number.isInteger(tab.id));
  if (tabs.length === 0) {
    return { groupedTabs: 0, createdGroups: 0, windowsTouched: 0 };
  }

  const byWindow = new Map();
  for (const tab of tabs) {
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId).push(tab);
  }

  const title = getGroupLabel(group);
  const color = getTabGroupColor(group);
  let groupedTabs = 0;
  let createdGroups = 0;

  for (const [, windowTabs] of byWindow) {
    const tabIds = windowTabs.map(tab => tab.id);
    if (tabIds.length === 0) continue;
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, { title, color, collapsed: false });
    groupedTabs += tabIds.length;
    createdGroups += 1;
  }

  return {
    groupedTabs,
    createdGroups,
    windowsTouched: byWindow.size,
  };
}

async function groupMultipleDomainSets(groups) {
  let groupedTabs = 0;
  let createdGroups = 0;
  let windowsTouched = 0;

  for (const group of groups) {
    const result = await groupTabsIntoChromeGroups(group);
    groupedTabs += result.groupedTabs;
    createdGroups += result.createdGroups;
    windowsTouched += result.windowsTouched;
  }

  return { groupedTabs, createdGroups, windowsTouched };
}

async function moveTabToChromeGroup(payload, targetGroupId) {
  const tabId = parseDatasetInt(payload?.tabId);
  if (!Number.isInteger(tabId) || !Number.isInteger(targetGroupId)) {
    return { moved: false, reason: 'missing-tab' };
  }

  const targetGroup = await chrome.tabGroups.get(targetGroupId);
  const tab = await chrome.tabs.get(tabId);
  if (!targetGroup || !tab?.id) return { moved: false, reason: 'missing-target' };
  if (tab.groupId === targetGroupId) return { moved: false, reason: 'same-group' };

  let tabToGroupId = tab.id;
  if (tab.windowId !== targetGroup.windowId) {
    const moved = await chrome.tabs.move(tab.id, {
      windowId: targetGroup.windowId,
      index: -1,
    });
    tabToGroupId = Array.isArray(moved) ? moved[0]?.id : moved?.id;
  }

  if (!Number.isInteger(tabToGroupId)) {
    return { moved: false, reason: 'missing-tab' };
  }

  await chrome.tabs.group({ tabIds: [tabToGroupId], groupId: targetGroupId });
  await chrome.tabGroups.update(targetGroupId, { collapsed: false });
  await fetchOpenTabs();
  return { moved: true, targetGroup };
}

async function ungroupChromeGroupTabs(groupId) {
  const allTabs = await chrome.tabs.query({});
  const tabIds = allTabs
    .filter(tab => tab.groupId === groupId && Number.isInteger(tab.id))
    .map(tab => tab.id);
  if (tabIds.length === 0) return 0;
  await chrome.tabs.ungroup(tabIds);
  await fetchOpenTabs();
  return tabIds.length;
}

async function closeChromeGroupTabs(groupId) {
  const allTabs = await chrome.tabs.query({});
  const tabIds = allTabs
    .filter(tab => tab.groupId === groupId && Number.isInteger(tab.id))
    .map(tab => tab.id);
  if (tabIds.length === 0) return 0;
  await chrome.tabs.remove(tabIds);
  await fetchOpenTabs();
  return tabIds.length;
}

function getGroupDuplicateMeta(group) {
  const tabs = group.tabs || [];
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const duplicateEntries = Object.entries(urlCounts).filter(([, count]) => count > 1);
  const duplicateTabs = duplicateEntries.reduce((sum, [, count]) => sum + count - 1, 0);
  return {
    urlCounts,
    duplicateEntries,
    duplicateTabs,
    hasDupes: duplicateEntries.length > 0,
  };
}

function getDisplayedDomainGroups(groups) {
  const filtered = groups.filter(group => {
    if (dockPreferences.filter === 'duplicates') return getGroupDuplicateMeta(group).hasDupes;
    if (dockPreferences.filter === 'homepages') return group.domain === '__landing-pages__';
    return true;
  });

  return filtered.sort((a, b) => {
    if (dockPreferences.sort === 'alpha') {
      const aLabel = (a.label || friendlyDomain(a.domain)).toLowerCase();
      const bLabel = (b.label || friendlyDomain(b.domain)).toLowerCase();
      return aLabel.localeCompare(bLabel);
    }

    if (dockPreferences.sort === 'size') {
      if (b.tabs.length !== a.tabs.length) return b.tabs.length - a.tabs.length;
      const aLabel = (a.label || friendlyDomain(a.domain)).toLowerCase();
      const bLabel = (b.label || friendlyDomain(b.domain)).toLowerCase();
      return aLabel.localeCompare(bLabel);
    }

    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aDupes = getGroupDuplicateMeta(a).duplicateTabs;
    const bDupes = getGroupDuplicateMeta(b).duplicateTabs;
    if (bDupes !== aDupes) return bDupes - aDupes;
    if (b.tabs.length !== a.tabs.length) return b.tabs.length - a.tabs.length;

    const aLabel = (a.label || friendlyDomain(a.domain)).toLowerCase();
    const bLabel = (b.label || friendlyDomain(b.domain)).toLowerCase();
    return aLabel.localeCompare(bLabel);
  });
}

function getDisplayedDashboardGroups(groups) {
  const filtered = groups.filter(group => {
    if (dockPreferences.filter === 'duplicates') return getGroupDuplicateMeta(group).hasDupes;
    if (dockPreferences.filter === 'homepages') return group.domain === '__landing-pages__';
    return true;
  });

  return filtered.sort((a, b) => {
    if (dockPreferences.sort === 'alpha') {
      return getDashboardGroupLabel(a).toLowerCase().localeCompare(getDashboardGroupLabel(b).toLowerCase());
    }

    if (dockPreferences.sort === 'size') {
      if (b.tabs.length !== a.tabs.length) return b.tabs.length - a.tabs.length;
      return getDashboardGroupLabel(a).toLowerCase().localeCompare(getDashboardGroupLabel(b).toLowerCase());
    }

    const aIsChrome = a.kind === 'chrome-group';
    const bIsChrome = b.kind === 'chrome-group';
    if (aIsChrome !== bIsChrome) return aIsChrome ? -1 : 1;
    if (aIsChrome && bIsChrome) {
      if (a.windowId !== b.windowId) return a.windowId - b.windowId;
      return a.firstTabIndex - b.firstTabIndex;
    }

    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aDupes = getGroupDuplicateMeta(a).duplicateTabs;
    const bDupes = getGroupDuplicateMeta(b).duplicateTabs;
    if (bDupes !== aDupes) return bDupes - aDupes;
    if (b.tabs.length !== a.tabs.length) return b.tabs.length - a.tabs.length;

    return getDashboardGroupLabel(a).toLowerCase().localeCompare(getDashboardGroupLabel(b).toLowerCase());
  });
}


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function renderTabChip(tab, urlCounts = {}, groupDomain = '') {
  let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), groupDomain);

  try {
    const parsed = new URL(tab.url);
    if (parsed.hostname === 'localhost' && parsed.port) {
      label = `${parsed.port} ${label}`;
    }
  } catch {}

  const count = urlCounts[tab.url] || 1;
  const dupeTag = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
  const chipClass = count > 1 ? ' chip-has-dupes' : '';
  const safeUrl = escapeHtml(tab.url || '');
  const safeTitle = escapeHtml(label);
  const safeTabId = Number.isInteger(tab.id) ? String(tab.id) : '';
  const safeWindowId = Number.isInteger(tab.windowId) ? String(tab.windowId) : '';
  const safeGroupId = Number.isInteger(tab.groupId) ? String(tab.groupId) : '';
  let domain = '';
  try { domain = new URL(tab.url).hostname; } catch {}
  const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';

  return `<div class="page-chip clickable${chipClass}" draggable="true" data-transfer-kind="${INTERACTION_KINDS.tabLink}" data-action="focus-tab" data-tab-id="${safeTabId}" data-window-id="${safeWindowId}" data-group-id="${safeGroupId}" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="${safeTitle}">
    ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
    <span class="chip-text">${safeTitle}</span>${dupeTag}
    <div class="chip-actions">
      <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
      </button>
      <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>
  </div>`;
}

function buildOverflowChips(hiddenTabs, urlCounts = {}, groupDomain = '') {
  const hiddenChips = hiddenTabs.map(tab => renderTabChip(tab, urlCounts, groupDomain)).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = getStableDomainId(group.domain);

  // Count duplicates (exact URL match)
  const { urlCounts, duplicateEntries: dupeUrls, hasDupes, duplicateTabs: totalExtras } = getGroupDuplicateMeta(group);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => renderTabChip(tab, urlCounts, group.domain)).join('')
    + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts, group.domain) : '');

  let actionsHtml = `
    <button class="action-btn group-tabs" data-action="group-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.group}
      Group tabs
    </button>
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${getGroupLabel(group)}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}

function renderChromeGroupCard(group) {
  const tabs = group.tabs || [];
  const tabCount = tabs.length;
  const stableId = getStableChromeGroupId(group.id);
  const dropTargetId = getChromeGroupDropTargetId(group.id);
  const { urlCounts, duplicateEntries: dupeUrls, hasDupes, duplicateTabs: totalExtras } = getGroupDuplicateMeta(group);
  const groupTitle = escapeHtml(getChromeGroupLabel(group));

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const groupSwatch = '<span class="chrome-group-swatch" aria-hidden="true"></span>';

  const collapsedBadge = group.collapsed
    ? `<span class="open-tabs-badge chrome-group-state">collapsed</span>`
    : '';

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount = uniqueTabs.length - visibleTabs.length;
  const pageChips = visibleTabs.map(tab => renderTabChip(tab, urlCounts, '')).join('')
    + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts, '') : '');

  let actionsHtml = `
    <button class="action-btn ungroup-tabs" data-action="ungroup-chrome-group" data-chrome-group-id="${group.id}">
      ${ICONS.group}
      Ungroup
    </button>
    <button class="action-btn close-tabs" data-action="close-chrome-group-tabs" data-chrome-group-id="${group.id}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card chrome-group-card ${hasDupes ? 'has-amber-bar' : ''}" data-domain-id="${stableId}" data-chrome-group-id="${group.id}" data-drop-target="${dropTargetId}" style="${getChromeGroupStyle(group)}" title="Move a tab into ${groupTitle}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${groupTitle}</span>
          ${groupSwatch}
          ${tabBadge}
          ${collapsedBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}

function renderDashboardGroupCard(group) {
  return group.kind === 'chrome-group' ? renderChromeGroupCard(group) : renderDomainCard(group);
}


/* ----------------------------------------------------------------
   SIDEBAR — Common URLs + Saved for Later
   ---------------------------------------------------------------- */

/**
 * renderSidebarColumn()
 *
 * Renders the right-side sidebar. It always stays available as a drop zone
 * when the user wants the sidebar shown, even if its sections are empty.
 */
async function renderSidebarColumn() {
  const column = document.getElementById('deferredColumn');
  if (!column) return;

  if (!dockPreferences.showSidebar) {
    column.style.display = 'none';
    return;
  }

  column.style.display = 'block';
  await Promise.all([
    renderFavoriteLinksSection(),
    renderDeferredSection(),
  ]);
  updateSidebarPanelsUI();
}

function updateSidebarPanelsUI() {
  document.querySelectorAll('.sidebar-panel[data-panel]').forEach(panel => {
    const panelKey = panel.dataset.panel;
    const isCollapsed = !!sidebarPanelState[panelKey];
    const body = panel.querySelector('.sidebar-panel-body');
    const toggle = panel.querySelector('.sidebar-toggle');

    panel.classList.toggle('is-collapsed', isCollapsed);
    if (body) body.hidden = isCollapsed;
    if (toggle) toggle.setAttribute('aria-expanded', String(!isCollapsed));
  });
}

async function renderFavoriteLinksSection() {
  const list = document.getElementById('favoritesList');
  const empty = document.getElementById('favoritesEmpty');
  const countEl = document.getElementById('favoritesCount');

  if (!list || !empty || !countEl) return;

  try {
    const favorites = await getFavoriteLinks();

    if (favorites.length > 0) {
      countEl.textContent = `${favorites.length} item${favorites.length !== 1 ? 's' : ''}`;
      list.innerHTML = favorites.map(item => renderFavoriteItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      countEl.textContent = '';
      list.innerHTML = '';
      list.style.display = 'none';
      empty.style.display = 'block';
    }
  } catch (err) {
    console.warn('[tab-out] Could not load favorite links:', err);
    countEl.textContent = '';
    list.innerHTML = '';
    list.style.display = 'none';
    empty.style.display = 'block';
  }
}

async function renderDeferredSection() {
  const list = document.getElementById('deferredList');
  const empty = document.getElementById('deferredEmpty');
  const countEl = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!list || !empty || !countEl || !archiveEl || !archiveCountEl || !archiveList) return;

  try {
    const { active, archived } = await getSavedTabs();

    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    list.innerHTML = '';
    list.style.display = 'none';
    empty.style.display = 'block';
    countEl.textContent = '';
    archiveEl.style.display = 'none';
  }
}

function renderFavoriteItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
  const title = escapeHtml(item.title || item.url);
  const safeUrl = escapeHtml(item.url || '');
  const ago = timeAgo(item.updatedAt || item.createdAt);

  return `
    <div class="favorite-item" data-favorite-id="${item.id}">
      <button class="favorite-link" type="button" data-action="open-favorite-link" data-favorite-url="${safeUrl}" title="${title}">
        ${faviconUrl ? `<img src="${faviconUrl}" alt="" class="favorite-favicon" onerror="this.style.display='none'">` : ''}
        <span class="favorite-link-text">${title}</span>
      </button>
      <div class="favorite-meta">
        <span>${escapeHtml(domain)}</span>
        <span>${escapeHtml(ago)}</span>
      </div>
      <button class="favorite-dismiss" type="button" data-action="dismiss-favorite-link" data-favorite-id="${item.id}" title="Remove from common urls">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
  const ago = timeAgo(item.savedAt);
  const title = escapeHtml(item.title || item.url);
  const safeUrl = escapeHtml(item.url || '');

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${safeUrl}" target="_blank" rel="noopener" class="deferred-title" title="${title}">
          ${faviconUrl ? `<img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">` : ''}${title}
        </a>
        <div class="deferred-meta">
          <span>${escapeHtml(domain)}</span>
          <span>${escapeHtml(ago)}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  const title = escapeHtml(item.title || item.url);
  const safeUrl = escapeHtml(item.url || '');
  return `
    <div class="archive-item">
      <a href="${safeUrl}" target="_blank" rel="noopener" class="archive-item-title" title="${title}">
        ${title}
      </a>
      <span class="archive-item-date">${escapeHtml(ago)}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();
  const chromeGroupCards = buildChromeGroupCards(realTabs);
  const chromeGroupedTabIds = new Set(
    chromeGroupCards.flatMap(group => group.tabs.map(tab => tab.id))
  );
  const ungroupedRealTabs = realTabs.filter(tab => !chromeGroupedTabIds.has(tab.id));

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of ungroupedRealTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');
  const displayedDomainGroups = getDisplayedDomainGroups(domainGroups);
  const displayedGroups      = getDisplayedDashboardGroups([...chromeGroupCards, ...domainGroups]);
  const sectionTitles = {
    all: 'Groups & tabs',
    duplicates: 'Duplicate cleanup',
    homepages: 'Homepages',
  };

  if (displayedGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = sectionTitles[dockPreferences.filter] || 'Open tabs';
    const countParts = [];
    const visibleChromeGroups = displayedGroups.filter(group => group.kind === 'chrome-group').length;
    const visibleDomainGroups = displayedGroups.length - visibleChromeGroups;
    if (visibleChromeGroups > 0) countParts.push(`${visibleChromeGroups} group${visibleChromeGroups !== 1 ? 's' : ''}`);
    if (visibleDomainGroups > 0) countParts.push(`${visibleDomainGroups} domain${visibleDomainGroups !== 1 ? 's' : ''}`);
    const groupAllButton = displayedDomainGroups.length > 0
      ? `<button class="action-btn group-tabs" data-action="group-all-domain-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.group} Group ungrouped ${displayedDomainGroups.length}</button>`
      : '';
    openTabsSectionCount.innerHTML = `<span class="section-count-text">${countParts.join(' / ') || '0 groups'}</span><span class="meta-separator section-separator" aria-hidden="true"></span>${groupAllButton}<button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.innerHTML = displayedGroups.map(g => renderDashboardGroupCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'block';
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = sectionTitles[dockPreferences.filter] || 'Open tabs';
    openTabsMissionsEl.innerHTML = '<div style="font-size:13px;color:var(--muted);padding:12px 0">Nothing matches this dock filter right now.</div>';
    openTabsSectionCount.innerHTML = `<span class="section-count-text">0 groups</span><span class="meta-separator section-separator" aria-hidden="true"></span><button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
  }

  // --- Footer stats ---
  const statTabsHeader = document.getElementById('statTabsHeader');
  if (statTabsHeader) statTabsHeader.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render sidebar targets ("Common urls" + "Saved for later") ---
  await renderSidebarColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}

function canTargetAcceptPayload(targetId, payload) {
  if (!targetId || !payload) return false;
  const target = getInteractionTarget(targetId);
  return !!target && target.accepts.has(payload.kind);
}

function getInteractionTarget(targetId) {
  if (!targetId) return null;
  if (INTERACTION_TARGETS[targetId]) return INTERACTION_TARGETS[targetId];

  const chromeGroupId = getChromeGroupIdFromDropTarget(targetId);
  if (Number.isInteger(chromeGroupId)) {
    return {
      accepts: new Set([INTERACTION_KINDS.tabLink]),
      actionId: 'move-to-chrome-group',
      dropEffect: 'move',
      chromeGroupId,
    };
  }

  return null;
}

function updateDropTargetUI(payload, activeTargetId = null) {
  const targetEls = document.querySelectorAll('[data-drop-target]');
  document.body.classList.toggle('is-dragging-tab', !!payload);

  targetEls.forEach(el => {
    const targetId = el.dataset.dropTarget;
    const accepts = canTargetAcceptPayload(targetId, payload);
    el.classList.toggle('is-drop-accepting', accepts);
    el.classList.toggle('is-drop-active', accepts && activeTargetId === targetId);
  });

  if (activeDragSource) {
    activeDragSource.classList.toggle('is-drag-origin', !!payload);
  }
}

function clearDragState() {
  activeDragPayload = null;
  if (activeDragSource) {
    activeDragSource.classList.remove('is-drag-origin');
  }
  activeDragSource = null;
  updateDropTargetUI(null, null);
}

const INTERACTION_ACTIONS = {
  'save-for-later': async (payload) => {
    await saveTabForLater({ url: payload.url, title: payload.title });
    await closeSingleTabByIdOrUrl(parseDatasetInt(payload.tabId), payload.url);
    await fetchOpenTabs();
    showToast('Saved for later');
    await renderDashboard();
    return true;
  },
  'save-common-url': async (payload) => {
    const result = await saveFavoriteLink({ url: payload.url, title: payload.title });
    showToast(result.status === 'existing' ? 'Already in common urls' : 'Added to common urls');
    await renderSidebarColumn();
    return true;
  },
  'move-to-chrome-group': async (payload, target) => {
    const result = await moveTabToChromeGroup(payload, target.chromeGroupId);
    if (result.reason === 'same-group') {
      showToast('Already in that group');
      return true;
    }
    if (!result.moved) {
      showToast('Could not move tab');
      return false;
    }
    const targetLabel = getChromeGroupLabel(result.targetGroup);
    showToast(`Moved tab to ${targetLabel}`);
    await renderDashboard();
    return true;
  },
};

async function runInteractionTarget(targetId, payload) {
  const target = getInteractionTarget(targetId);
  if (!target || !canTargetAcceptPayload(targetId, payload)) return false;
  const handler = INTERACTION_ACTIONS[target.actionId];
  if (!handler) return false;
  return handler(payload, target);
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('dragstart', (e) => {
  const sourceEl = e.target.closest('[data-transfer-kind]');
  if (!sourceEl) return;

  const payload = getTabPayloadFromElement(sourceEl);
  if (!payload) return;

  activeDragPayload = payload;
  activeDragSource = sourceEl;
  updateDropTargetUI(payload, null);

  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('application/x-tab-out-item', JSON.stringify(payload));
    e.dataTransfer.setData('text/plain', payload.url);
  }
});

document.addEventListener('dragover', (e) => {
  if (!activeDragPayload) return;

  const targetEl = e.target.closest('[data-drop-target]');
  const targetId = targetEl?.dataset.dropTarget;
  if (!canTargetAcceptPayload(targetId, activeDragPayload)) {
    updateDropTargetUI(activeDragPayload, null);
    return;
  }

  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = getInteractionTarget(targetId)?.dropEffect || 'move';
  }
  updateDropTargetUI(activeDragPayload, targetId);
});

document.addEventListener('drop', async (e) => {
  if (!activeDragPayload) return;

  const targetEl = e.target.closest('[data-drop-target]');
  const targetId = targetEl?.dataset.dropTarget;
  if (!canTargetAcceptPayload(targetId, activeDragPayload)) {
    clearDragState();
    return;
  }

  e.preventDefault();

  try {
    await runInteractionTarget(targetId, activeDragPayload);
  } catch (err) {
    console.error('[tab-out] Drag action failed:', err);
    showToast('Could not complete drag action');
  } finally {
    clearDragState();
  }
});

document.addEventListener('dragend', () => {
  clearDragState();
});

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) {
    const dockControl = document.getElementById('dockControl');
    if (dockControl && !dockControl.contains(e.target)) {
      dockControl.classList.remove('open');
    }
    return;
  }

  const action = actionEl.dataset.action;

  if (action === 'toggle-dock-panel') {
    const dockControl = document.getElementById('dockControl');
    if (dockControl) dockControl.classList.toggle('open');
    return;
  }

  if (action === 'refresh-dashboard') {
    await renderDashboard();
    showToast('Dashboard refreshed');
    return;
  }

  if (action === 'reset-dock-color') {
    await resetThemeColor();
    showToast('Theme reset');
    return;
  }

  if (action === 'set-dock-density') {
    const density = actionEl.dataset.density;
    if (!DOCK_DENSITY_OPTIONS.has(density)) return;
    await saveDockPreferences({ density });
    await renderDashboard();
    showToast(`Density set to ${density}`);
    return;
  }

  if (action === 'set-dock-sort') {
    const sort = actionEl.dataset.sort;
    if (!DOCK_SORT_OPTIONS.has(sort)) return;
    await saveDockPreferences({ sort });
    await renderDashboard();
    showToast(`Sorting by ${sort}`);
    return;
  }

  if (action === 'set-dock-filter') {
    const filter = actionEl.dataset.filter;
    if (!DOCK_FILTER_OPTIONS.has(filter)) return;
    await saveDockPreferences({ filter });
    await renderDashboard();
    showToast(filter === 'all' ? 'Showing all groups' : `Filter set to ${filter}`);
    return;
  }

  if (action === 'set-sidebar-visibility') {
    const showSidebar = actionEl.dataset.sidebar !== 'hide';
    await saveDockPreferences({ showSidebar });
    await renderDashboard();
    showToast(showSidebar ? 'Sidebar shown' : 'Sidebar hidden');
    return;
  }

  if (action === 'toggle-sidebar-panel') {
    const panelKey = actionEl.dataset.panel;
    if (!panelKey || !(panelKey in sidebarPanelState)) return;
    await saveSidebarPanelState({ [panelKey]: !sidebarPanelState[panelKey] });
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab pages');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  if (action === 'open-favorite-link') {
    e.preventDefault();
    const url = actionEl.dataset.favoriteUrl;
    if (!url) return;
    await openOrFocusTab(url);
    return;
  }

  if (action === 'dismiss-favorite-link') {
    const id = actionEl.dataset.favoriteId;
    if (!id) return;

    await dismissFavoriteLink(id);
    const item = actionEl.closest('.favorite-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderSidebarColumn();
      }, 300);
    } else {
      await renderSidebarColumn();
    }
    showToast('Removed from common urls');
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    const tabId = parseDatasetInt(actionEl.dataset.tabId);
    if (tabUrl || Number.isInteger(tabId)) await focusTab(tabUrl, tabId);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    const tabId = parseDatasetInt(actionEl.closest('.page-chip')?.dataset.tabId || actionEl.dataset.tabId);
    if (!tabUrl && !Number.isInteger(tabId)) return;

    // Close the tab in Chrome directly
    await closeSingleTabByIdOrUrl(tabId, tabUrl);
    await fetchOpenTabs();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabsHeader = document.getElementById('statTabsHeader');
    if (statTabsHeader) statTabsHeader.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const payload = getTabPayloadFromElement(actionEl.closest('.page-chip') || actionEl);
    if (!payload) return;

    try {
      await runInteractionTarget('deferred', payload);
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
    }
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderSidebarColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderSidebarColumn();
      }, 300);
    }
    return;
  }

  if (action === 'ungroup-chrome-group') {
    const groupId = parseDatasetInt(actionEl.dataset.chromeGroupId);
    if (!Number.isInteger(groupId)) return;

    try {
      const count = await ungroupChromeGroupTabs(groupId);
      await renderDashboard();
      showToast(count > 0 ? `Ungrouped ${count} tab${count !== 1 ? 's' : ''}` : 'Group is already empty');
    } catch (err) {
      console.error('[tab-out] Failed to ungroup Chrome group:', err);
      showToast('Could not ungroup tabs');
    }
    return;
  }

  if (action === 'close-chrome-group-tabs') {
    const groupId = parseDatasetInt(actionEl.dataset.chromeGroupId);
    if (!Number.isInteger(groupId)) return;

    try {
      const count = await closeChromeGroupTabs(groupId);
      await renderDashboard();
      showToast(count > 0 ? `Closed ${count} grouped tab${count !== 1 ? 's' : ''}` : 'Group is already empty');
    } catch (err) {
      console.error('[tab-out] Failed to close Chrome group tabs:', err);
      showToast('Could not close grouped tabs');
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'group-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group = domainGroups.find(g => getStableDomainId(g.domain) === domainId);
    if (!group) return;

    try {
      const result = await groupTabsIntoChromeGroups(group);
      if (result.groupedTabs === 0) {
        showToast('No tabs available to group');
        return;
      }
      const label = getGroupLabel(group);
      showToast(`Grouped ${result.groupedTabs} tab${result.groupedTabs !== 1 ? 's' : ''} into ${result.createdGroups} Chrome group${result.createdGroups !== 1 ? 's' : ''} for ${label}`);
      await renderDashboard();
    } catch (err) {
      console.error('[tab-out] Failed to group domain tabs:', err);
      showToast('Could not create Chrome tab group');
    }
    return;
  }

  if (action === 'group-all-domain-tabs') {
    const groups = getDisplayedDomainGroups(domainGroups);
    if (groups.length === 0) {
      showToast('Nothing to group right now');
      return;
    }

    try {
      const result = await groupMultipleDomainSets(groups);
      if (result.groupedTabs === 0) {
        showToast('No tabs available to group');
        return;
      }
      showToast(`Grouped ${result.groupedTabs} tabs into ${result.createdGroups} Chrome groups`);
      await renderDashboard();
    } catch (err) {
      console.error('[tab-out] Failed to group all domain tabs:', err);
      showToast('Could not group tabs');
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return getStableDomainId(g.domain) === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = getGroupLabel(group);
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabsHeader = document.getElementById('statTabsHeader');
    if (statTabsHeader) statTabsHeader.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id === 'dockColorInput') {
    await saveThemeColor(e.target.value);
    return;
  }

  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const dockControl = document.getElementById('dockControl');
  if (dockControl) dockControl.classList.remove('open');
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
loadThemeColor();
loadDockPreferences().then(renderDashboard);
