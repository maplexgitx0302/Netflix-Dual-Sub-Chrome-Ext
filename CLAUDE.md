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

## Architecture

The extension spans four isolated JavaScript contexts that communicate via message passing:

```
Netflix Page (MAIN World)
    injected.js  ←→  window.postMessage  ←→  content.js (ISOLATED World)
                                                    ↕ chrome.runtime.sendMessage
                                              service-worker.js (Background)
                                                    ↕ chrome.runtime.sendMessage
                                              popup.js (Extension Popup)
```

### Why the injected script exists

Chrome content scripts run in an isolated JavaScript world and cannot access `window.netflix` or intercept XHR/Fetch. `injected.js` is inserted into the MAIN world (declared as a web-accessible resource in `manifest.json`) to bridge this gap. It communicates back to `content.js` via `window.postMessage`.

### Module responsibilities

| File | Context | Role |
|------|---------|------|
| `background/service-worker.js` | Background | State cache per tab, message routing, tab cleanup |
| `content/content.js` | Content Script | Orchestrator — injects `injected.js`, bridges messages, owns renderer lifecycle, manages `subtitleContentCache` |
| `content/subtitle-renderer.js` | Content Script | Parses TTML/WebVTT/JSON, renders overlay div, drives timing via `timeupdate` |
| `content/injected.js` | MAIN World | Intercepts XHR/Fetch, accesses Netflix Player API to discover subtitle tracks and trigger downloads |
| `popup/popup.js` | Popup | UI controls, settings read/write via `chrome.storage.local` |

### Subtitle delivery flow

Netflix no longer returns download URLs from `getTimedTextTrackList()`. The actual subtitle content reaches the extension through **XHR/Fetch interception only**:

1. **Passive interception** — `injected.js` monkey-patches `XMLHttpRequest` and `window.fetch`. When Netflix downloads any subtitle file (WebVTT or TTML), `looksLikeSubtitleContent()` detects it and `SUBTITLE_FILE_INTERCEPTED` is posted to `content.js`, which caches it in `subtitleContentCache` keyed by language code.

2. **Language selection** — when the user picks a language in the popup, `selectSecondLanguage()` in `content.js` checks `subtitleContentCache` first. If found, it loads immediately. If not, it posts `FETCH_SUBTITLE_VIA_PLAYER` to `injected.js`.

3. **Active switch fallback** — `injected.js` handles `FETCH_SUBTITLE_VIA_PLAYER` by trying ~10 possible Player API setter method names (e.g. `setTimedTextTrack`, `selectTimedTextTrack`, …) to switch Netflix's player to that language, which triggers a subtitle download that the XHR interceptor catches. After 2 seconds it restores the original track and posts `SUBTITLE_SWITCH_DONE`.

4. **Cache hit after switch** — the `SUBTITLE_SWITCH_DONE` handler in `content.js` checks the cache and loads the subtitle if present.

### Subtitle format support (subtitle-renderer.js)

Handles three formats, auto-detected:
- **TTML/DFXP** — XML `<p>` elements; supports Netflix tick-based timing (`Nt` = N/10,000,000 sec)
- **WebVTT** — standard VTT cue parsing
- **JSON** — Netflix-specific JSON envelope

Cue lookup at playback time uses binary search for performance.

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

- URL changes are monitored via History API patching in `content.js` because Netflix is a SPA.
- The video element can be replaced; a `MutationObserver` in `subtitle-renderer.js` re-attaches the `timeupdate` listener.
- Fullscreen restructures the DOM; the renderer re-attaches after a 500 ms delay.
- Subtitle track metadata arrives asynchronously; `popup.js` retries detection up to 10 times at 2-second intervals.
- `subtitleContentCache` in `content.js` persists subtitle content across language switches within the same page session.
