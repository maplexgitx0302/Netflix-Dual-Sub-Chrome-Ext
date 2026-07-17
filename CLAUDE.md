# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Chrome extension (Manifest V3) that displays a secondary subtitle track alongside Netflix's native subtitles — useful for language learning and multi-lingual viewing.

## Development Workflow

No build step. Load directly into Chrome:
1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this folder

After any code change, click the reload icon on the extension card in `chrome://extensions/`, then hard-refresh the Netflix tab.

When committing a user-visible fix or feature, bump `version` in `manifest.json` and update the version/last-updated line at the top of `README.md`.

Quick syntax validation (no test suite exists):
```
node --check content/content.js content/injected.js content/subtitle-renderer.js popup/popup.js background/service-worker.js
```

## Architecture

The extension spans four isolated JavaScript contexts that communicate via message passing:

```
Netflix Page (MAIN World)
    injected.js  ←→  window.postMessage  ←→  content.js (ISOLATED World)
                                                    ↕ chrome.tabs.sendMessage
                                              popup.js (Extension Popup)

service-worker.js (Background) — only writes default settings on install
```

`popup.js` talks directly to `content.js` via `chrome.tabs.sendMessage` and shares
state through `chrome.storage.local`. The background service worker is not on the
runtime message path; it only seeds defaults on first install.

### Why the injected script exists

Chrome content scripts run in an isolated JavaScript world and cannot access `window.netflix` or intercept XHR/Fetch. `injected.js` is inserted into the MAIN world (declared as a web-accessible resource in `manifest.json`) to bridge this gap. It communicates back to `content.js` via `window.postMessage`.

### Module responsibilities

| File | Context | Role |
|------|---------|------|
| `background/service-worker.js` | Background | Seeds default settings on install (`chrome.runtime.onInstalled`) |
| `content/content.js` | Content Script | Orchestrator — injects `injected.js`, bridges messages, owns renderer lifecycle, manages `subtitleContentCache` |
| `content/subtitle-renderer.js` | Content Script | Parses TTML/WebVTT/JSON, renders overlay div, drives timing via `timeupdate` |
| `content/injected.js` | MAIN World | Intercepts XHR/Fetch, accesses Netflix Player API to discover subtitle tracks and trigger downloads |
| `popup/popup.js` | Popup | UI controls, settings read/write via `chrome.storage.local` |

### Subtitle delivery flow

Netflix no longer returns download URLs from `getTimedTextTrackList()`. The actual subtitle content reaches the extension through **XHR/Fetch interception only**:

1. **Passive interception** — `injected.js` monkey-patches `XMLHttpRequest` and `window.fetch`. When Netflix downloads any subtitle file (WebVTT or TTML), `looksLikeSubtitleContent()` detects it and `SUBTITLE_FILE_INTERCEPTED` is posted to `content.js`, which caches it in `subtitleContentCache` keyed by language code.

2. **Language selection** — when the user picks a language in the popup, `selectSecondLanguage()` in `content.js` checks `subtitleContentCache` first (before even looking up the track). If found, it loads immediately. If the track has no `downloadUrls` (the normal case today), it posts `FETCH_SUBTITLE_VIA_PLAYER` to `injected.js`.

3. **Active switch fallback** — `injected.js` handles `FETCH_SUBTITLE_VIA_PLAYER` by trying ~10 possible Player API setter method names (e.g. `setTimedTextTrack`, `selectTimedTextTrack`, …) to switch Netflix's player to that language, which triggers a subtitle download that the XHR interceptor catches. It restores the original track as soon as the interceptor catches a subtitle **whose language matches the switch target** (`pendingSwitchRestore` + `pendingSwitchLanguage`), with a 2-second timeout as a fallback, then posts `SUBTITLE_SWITCH_DONE`. The language match matters: during episode transitions Netflix concurrently downloads the *native* track, and restoring on that would abort the switch before the target language ever downloads. An intercepted subtitle with no detectable language during a pending switch is assumed to be the switch target.

4. **Cache hit after switch** — the `SUBTITLE_SWITCH_DONE` handler in `content.js` checks the cache and loads the subtitle if present.

**The "Off" track trap** — Netflix's `getTimedTextTrackList()` starts with an "Off"
placeholder track that carries the *original audio language's* bcp47 (e.g. `ja` on an
anime). Any lookup by language code must exclude it (`isOffTrack()` in `injected.js`,
which checks `isNoneTrack` plus Off/關閉 display names) — otherwise selecting the
original language matches the Off track first, the active switch flips subtitles to
"Off", Netflix downloads a near-empty placeholder file, and that ~1-cue file gets
cached in `subtitleContentCache` under the real language code, permanently shadowing
the real subtitle for the rest of the episode. Forced-narrative tracks
(`isForcedNarrative`) are excluded for the same reason. `getCurrentPlayerSubtitleLanguage()`
also returns `null` while the Off track is active so intercepted files aren't
mislabeled with its bcp47.

### Subtitle format support (subtitle-renderer.js)

Handles three formats, auto-detected:
- **TTML/DFXP** — XML `<p>` elements; supports Netflix tick-based timing (`Nt` = N/10,000,000 sec)
- **WebVTT** — standard VTT cue parsing
- **JSON** — Netflix-specific JSON envelope

Cue lookup at playback time uses binary search for performance.

**Vertical ordering of stacked lines** — Netflix often emits a multi-line subtitle as
several positioned cues whose document order does *not* match their on-screen order. Each
cue records a `position` (TTML `region`/`tts:origin` Y value, or WebVTT `line:` setting).
When more than one cue is visible at once *and* all of them carry a position, `_onTimeUpdate`
sorts them top-to-bottom before rendering so the lines aren't swapped. Cues without position
data keep their original order (no regression for single-cue subtitles).

### Renderer positioning

The overlay `div` is appended to `document.body` with `position: fixed` set via **inline styles only** — never CSS classes — to prevent Netflix's page CSS from overriding it. `_repositionContainer()` runs on a 500 ms timer and tries to find `.player-timedtext-text-container` (or fallbacks) via `getBoundingClientRect()` to place the overlay just above the native subtitle. Fallback is `bottom: 22%`.

### Settings schema (`chrome.storage.local`)

```js
{
  isEnabled: boolean,
  secondLanguage: "language-code",   // BCP-47 tag, e.g. "en", "zh-Hant"
  settings: {
    fontSize: "small" | "medium" | "large",  // 1.8 / 2.4 / 3.0 em
    position: "above" | "below",     // relative to native Netflix subtitles
    opacity: 0–1,
    fontColor: "#ffffff",
    bgColor: "rgba(...)"
  }
}
```

### Netflix SPA considerations

- URL changes are detected in `content.js` by polling `location.href` every 1 s plus a `popstate` listener. Patching `history.pushState` in the content script does **not** work — the content script's isolated-world `history` binding never sees Netflix's own MAIN-world `pushState` calls.
- **Episode changes** (watch→watch navigation, e.g. auto-play next episode) are detected by comparing the `/watch/<id>` video ID in `checkUrlChange()`. On a change, `resetForNewEpisode()` clears `subtitleContentCache`, drops `availableTracks`, destroys the renderer, and re-posts `RETRY_PLAYER_API` **after a 1.5 s delay** — firing immediately tends to reach the previous episode's still-live player session and report stale tracks, which stops the retry chain prematurely. `getActivePlayer()` in `injected.js` also prefers session IDs starting with `watch` over trailer/billboard sessions.
- **Episode-change watchdog** — the subtitle reload chain (detect tracks → select language → active switch → intercept) can fail silently at several points during a transition. `startEpisodeRetry()` in `content.js` re-posts `RETRY_PLAYER_API` every 4 s (max 6 tries) until `handleSecondSubtitleLoaded` succeeds (`secondSubtitleLoaded` flag); each round re-enters the full chain via `handleTracksFound` → `selectSecondLanguage`. The previously selected language is preserved across episodes.
- The video element can be replaced; a `MutationObserver` in `subtitle-renderer.js` re-attaches the `timeupdate` listener. The observer callback is throttled (~250 ms) since Netflix mutates the DOM constantly.
- Fullscreen restructures the DOM; the renderer re-attaches after a 500 ms delay.
- Subtitle track metadata arrives asynchronously; `popup.js` retries detection up to 10 times at 2-second intervals. In `injected.js`, the Player-API detection loop funnels all retries through a single timer (`playerApiTimer`) so repeated entry points don't stack parallel retry chains.
- `subtitleContentCache` in `content.js` persists subtitle content across language switches within the same episode; it is cleared on episode change and when leaving the watch page.
