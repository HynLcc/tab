# Tab

**Keep tabs on your tabs.**

Tab is a Chrome extension that replaces your new tab page with a dashboard of everything you have open. Tabs are grouped by domain, with homepages (Gmail, X, LinkedIn, etc.) pulled into their own group. Close tabs with a confetti burst.

No server. No account. No external API calls. Just a Chrome extension.

---

## Attribution

This repository is a modified derivative of [Tab Out](https://github.com/zarazhangrui/tab-out) by Zara Zhang.

- Original project license: MIT
- This repository preserves the original MIT license and attribution
- Changes here include renaming the extension to `Tab`, UI adjustments, sound removal, manual browser-color matching, and the new `dock-panel` entry point for future controls

If you reuse or redistribute this repo, keep the original copyright and license notice.

---

## What Changed From Original Tab Out

This fork keeps the original local-first Chrome extension model, but changes the product and interface direction quite a bit.

- Renamed the extension from `Tab Out` to `Tab`
- Kept it as a pure Chrome extension with no server, no account, and no external API dependency
- Reworked the visual system and layout to feel quieter, more editorial, and more browser-native
- Removed sound from the interaction flow
- Added manual browser-color matching so the background can be tuned intentionally
- Expanded the dock from a simple color entry point into a real lightweight control panel

### Product and branding

- Extension name changed to `Tab`
- Manifest title and browser action title updated to `Tab`
- README rewritten around the forked product instead of the upstream wording

### UI and layout

- Reworked typography and spacing across the dashboard
- Moved the open-tab stat into the header instead of keeping it in the footer
- Removed the footer stat block
- Tightened and simplified header composition
- Added a reusable metadata separator dot treatment in the interface
- Iterated mission/domain card typography and spacing
- Adjusted responsive behavior for the header and dock

### Tab management behavior

- Kept grouped-by-domain browsing as the main interaction model
- Kept the dedicated `Homepages` grouping for inbox and home surfaces like Gmail, X, GitHub, YouTube, and LinkedIn
- Kept duplicate-tab detection and duplicate cleanup actions
- Kept save-for-later behavior backed by `chrome.storage.local`
- Kept localhost grouping improvements such as showing port numbers where useful

### Theme and dock

- Added manual theme-color control for browser/background matching
- Added reset-to-default theme behavior
- Moved the dock launcher to the top-left corner
- Changed the dock launcher dot to white so it stays legible against green-toned backgrounds
- Expanded the dock into a real control surface instead of a placeholder entry point

### Dock features added in this fork

- `Theme`: manually change the page background color
- `Density`: switch between `compact`, `cozy`, and `airy` tab-density modes
- `Sort`: reorder groups using `smart`, `size`, or `alpha`
- `Filter`: focus the dashboard on `everything`, `duplicates`, or `homepages`
- `Saved Sidebar`: show or hide the right-side saved-for-later column
- `Refresh`: force a fresh dashboard render from current browser state

All dock preferences are stored locally in `chrome.storage.local`.

### Interaction changes

- Removed sound from close interactions
- Kept visual feedback centered on motion and confetti rather than audio

### What stayed the same

- It is still a local-first Chrome extension
- It still works directly with Chrome tabs and local extension storage
- It still does not send browsing data to any server
- It still preserves the original project's MIT license and attribution

---

## Install with a coding agent

Send your coding agent (Claude Code, Codex, etc.) this repo and say **"install this"**:

`<this repository URL>`

The agent will walk you through it. Takes about 1 minute.

---

## Features

- **See all your tabs at a glance** on a clean grid, grouped by domain
- **Homepages group** pulls Gmail inbox, X home, YouTube, LinkedIn, GitHub homepages into one card
- **Close tabs with style** with a confetti burst
- **Duplicate detection** flags when you have the same page open twice, with one-click cleanup
- **Click any tab to jump to it** across windows, no new tab opened
- **Save for later** bookmark tabs to a checklist before closing them
- **Localhost grouping** shows port numbers next to each tab so you can tell your vibe coding projects apart
- **Expandable groups** show the first 8 tabs with a clickable "+N more"
- **100% local** your data never leaves your machine
- **Pure Chrome extension** no server, no Node.js, no npm, no setup beyond loading the extension

---

## Manual Setup

**1. Clone the repo**

```bash
git clone <this repository URL>
```

**2. Load the Chrome extension**

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Navigate to the `extension/` folder inside the cloned repo and select it

**3. Open a new tab**

You'll see Tab.

---

## How it works

```
You open a new tab
  -> Tab shows your open tabs grouped by domain
  -> Homepages (Gmail, X, etc.) get their own group at the top
  -> Click any tab title to jump to it
  -> Close groups you're done with (confetti)
  -> Save tabs for later before closing them
```

Everything runs inside the Chrome extension. No external server, no API calls, no data sent anywhere. Saved tabs are stored in `chrome.storage.local`.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | chrome.storage.local |
| Animations | CSS transitions + JS confetti particles |

---

## License

MIT

---

Originally created by [Zara Zhang](https://x.com/zarazhangrui), modified in this repository under the MIT license.
