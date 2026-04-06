// server/updater.js
// ─────────────────────────────────────────────────────────────────────────────
// Auto-update checker for Tab Out.
//
// Think of this like a hotel concierge who quietly checks the news every few
// hours and leaves a note on your door if something important came in — but
// never wakes you up to do it.
//
// What this module does:
//   1. On startup, reads the current git commit SHA from the local machine
//      (basically "what version am I running right now?")
//   2. Asks the GitHub API "what's the latest commit on the main branch?"
//   3. Compares the two. If they differ, an update is available.
//   4. Repeats this check every 6 hours — not more, to be a good citizen
//      of the GitHub API (which has rate limits for anonymous callers).
//
// The result is stored in memory as a simple object — no database needed.
// Any part of the app can call getUpdateStatus() to read the current state.
//
// Failure modes are all handled gracefully:
//   - Offline? No crash — just logs a warning and keeps old status.
//   - Private repo? GitHub returns 404 — caught, no update shown.
//   - Rate limited? Same — caught silently.
//   - No git installed? execSync throws — caught, version shows as "unknown".
// ─────────────────────────────────────────────────────────────────────────────

const { execSync } = require('child_process');
const path         = require('path');

// The root directory of this project (one level above this file)
const PROJECT_ROOT = path.join(__dirname, '..');

// GitHub API URL for the latest commit on main.
// This endpoint is public for public repos and fails gracefully for private ones.
const GITHUB_API_URL = 'https://api.github.com/repos/zarazhangrui/tab-out/commits/main';

// How often to re-check: 6 hours in milliseconds
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// In-memory state
//
// This object holds everything the frontend needs to display an update banner.
// It's initialized with safe defaults — "no update available, not yet checked."
// ─────────────────────────────────────────────────────────────────────────────
let updateStatus = {
  updateAvailable: false,  // true if remote commit differs from local
  currentVersion:  '1.0.0', // semver from package.json (for display)
  latestCommit:    null,    // the remote HEAD commit SHA (or null if unchecked)
  checkedAt:       null,    // ISO timestamp of when we last checked
};

// ─────────────────────────────────────────────────────────────────────────────
// getLocalCommit()
//
// Runs `git rev-parse HEAD` in the project directory to find out what
// exact commit this running server is on.
//
// Returns a 40-character SHA string like "a3f9c2..." or null if git fails.
// ─────────────────────────────────────────────────────────────────────────────
function getLocalCommit() {
  try {
    // execSync runs a shell command and returns its stdout as a Buffer.
    // We trim() to strip the trailing newline git adds.
    const sha = execSync('git rev-parse HEAD', {
      cwd:     PROJECT_ROOT,  // run from the project root so git finds the right repo
      timeout: 5000,          // 5 second limit — don't hang the server
      encoding: 'utf8',
    }).trim();
    return sha;
  } catch (err) {
    // Git not installed, not a git repo, or some other failure.
    // This is non-fatal — we just can't detect updates.
    console.warn('[updater] Could not read local git commit:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getRemoteCommit()
//
// Fetches the latest commit SHA from GitHub's API.
//
// The GitHub API response for /repos/:owner/:repo/commits/:branch looks like:
//   { "sha": "a3f9c2...", "commit": { ... }, ... }
//
// We only need the top-level `sha` field.
//
// Returns a SHA string or null if anything goes wrong.
// ─────────────────────────────────────────────────────────────────────────────
async function getRemoteCommit() {
  try {
    const response = await fetch(GITHUB_API_URL, {
      headers: {
        // GitHub recommends always setting a User-Agent on API requests.
        // Without it, some requests get rejected.
        'User-Agent':  'tab-out-updater/1.0',
        // Request JSON explicitly (GitHub API supports multiple formats)
        'Accept':      'application/vnd.github.v3+json',
      },
      // 8 second timeout — don't block the server on a slow network
      signal: AbortSignal.timeout(8000),
    });

    // Non-200 responses: private repo (404), rate limited (403), etc.
    // We treat all of these as "can't check right now" — no crash, no update shown.
    if (!response.ok) {
      console.warn(`[updater] GitHub API returned HTTP ${response.status} — skipping update check`);
      return null;
    }

    const data = await response.json();

    // The SHA is at the top level of the commit object
    return data.sha || null;

  } catch (err) {
    // Network error, timeout, JSON parse failure — all handled here.
    console.warn('[updater] Could not reach GitHub API:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// checkForUpdates()
//
// The main check function. Compares local vs remote and updates in-memory state.
// This is called once on startup and then every 6 hours by the interval.
// ─────────────────────────────────────────────────────────────────────────────
async function checkForUpdates() {
  console.log('[updater] Checking for updates…');

  const localCommit  = getLocalCommit();
  const remoteCommit = await getRemoteCommit();

  // If either check failed, we can't make a determination — leave status as-is.
  if (!localCommit || !remoteCommit) {
    console.log('[updater] Update check incomplete — could not get one or both commit SHAs');
    return;
  }

  // Update is available if the two SHAs are different.
  // (Remote has moved ahead of what's currently running locally.)
  const updateAvailable = localCommit !== remoteCommit;

  // Persist the new status to our in-memory object
  updateStatus = {
    updateAvailable,
    currentVersion: require('../package.json').version,
    latestCommit:   remoteCommit,
    checkedAt:      new Date().toISOString(),
  };

  if (updateAvailable) {
    console.log(`[updater] Update available! Local: ${localCommit.slice(0, 7)} → Remote: ${remoteCommit.slice(0, 7)}`);
  } else {
    console.log(`[updater] Up to date (${localCommit.slice(0, 7)})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// startUpdateChecker()
//
// Called once when the server starts (from server/index.js).
// Runs an immediate check, then schedules one every 6 hours.
//
// Using setInterval with unref() is a Node.js best practice:
// unref() tells Node "this timer should NOT prevent the process from exiting."
// Without it, the server would hang open even if nothing else is running.
// ─────────────────────────────────────────────────────────────────────────────
function startUpdateChecker() {
  // Run first check immediately (async — won't block server startup)
  checkForUpdates().catch(err => {
    console.warn('[updater] Initial update check failed:', err.message);
  });

  // Then re-check every 6 hours
  const timer = setInterval(() => {
    checkForUpdates().catch(err => {
      console.warn('[updater] Scheduled update check failed:', err.message);
    });
  }, CHECK_INTERVAL_MS);

  // unref() prevents this interval from keeping the Node process alive
  // if the rest of the server shuts down for some reason.
  timer.unref();

  console.log('[updater] Update checker started — will check every 6 hours');
}

// ─────────────────────────────────────────────────────────────────────────────
// getUpdateStatus()
//
// Returns a copy of the current in-memory update status.
// Called by the API endpoint in routes.js.
//
// Returning a copy (via spread) prevents external code from accidentally
// mutating the in-memory state object.
// ─────────────────────────────────────────────────────────────────────────────
function getUpdateStatus() {
  return { ...updateStatus };
}

module.exports = { startUpdateChecker, getUpdateStatus };
