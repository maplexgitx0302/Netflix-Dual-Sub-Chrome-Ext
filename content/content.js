/**
 * content.js - Content Script
 * 
 * 功能：
 * 1. 注入 injected.js 到頁面 MAIN world
 * 2. 橋接 injected.js 與 Service Worker 的通訊
 * 3. 管理字幕渲染器的生命週期
 * 4. 偵測 Netflix 頁面導航（SPA）
 */
(function () {
  'use strict';

  const LOG_PREFIX = '[NF雙語字幕-Content]';

  // ==================== 狀態 ====================

  let renderer = null;
  let availableTracks = [];
  let currentSecondLanguage = null;
  let isEnabled = true;
  let currentSettings = {};
  let lastUrl = location.href;
  const subtitleContentCache = {}; // language → subtitle text

  // ==================== 注入 injected.js ====================

  function injectScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/injected.js');
    script.onload = function () {
      this.remove(); // 載入後移除 script 標籤
    };
    (document.head || document.documentElement).appendChild(script);
    console.log(LOG_PREFIX, 'injected.js 已注入');
  }

  // 在 document_start 時立即注入
  injectScript();

  // ==================== 字幕渲染管理 ====================

  function initRenderer() {
    if (!renderer) {
      renderer = new SubtitleRenderer.Renderer();
    }
    return renderer;
  }

  function destroyRenderer() {
    if (renderer) {
      renderer.stop();
      renderer = null;
    }
  }

  // ==================== 訊息處理：來自 injected.js ====================

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'nf-dual-sub-injected') return;

    const { type, data } = event.data;

    switch (type) {
      case 'SUBTITLE_TRACKS_FOUND':
        handleTracksFound(data.tracks);
        break;

      case 'SUBTITLE_DATA_INTERCEPTED':
        // 可以用來快取字幕資料
        break;

      case 'SUBTITLE_FILE_INTERCEPTED':
        if (data.content && data.language) {
          subtitleContentCache[data.language] = data.content;
          console.log(LOG_PREFIX, `[快取] 已快取 ${data.language} 字幕內容`);
          if (data.language === currentSecondLanguage) {
            handleSecondSubtitleLoaded({ language: data.language, data: data.content, url: data.url });
          }
        }
        break;

      case 'SECOND_SUBTITLE_LOADED':
        handleSecondSubtitleLoaded(data);
        break;

      case 'SUBTITLE_SWITCH_DONE':
        // Player 切換完成，檢查快取是否有目標語言的內容
        if (data.language === currentSecondLanguage && subtitleContentCache[data.language]) {
          console.log(LOG_PREFIX, `[快取] SWITCH_DONE 後使用快取的 ${data.language} 字幕`);
          handleSecondSubtitleLoaded({ language: data.language, data: subtitleContentCache[data.language] });
        } else if (data.language === currentSecondLanguage) {
          console.warn(LOG_PREFIX, `[切換] 切換後仍無法取得 ${data.language} 字幕快取`);
        }
        break;

      case 'SECOND_SUBTITLE_ERROR':
        console.error(LOG_PREFIX, `第二字幕載入失敗 (${data.language}):`, data.error);
        break;
    }
  });

  // ==================== 訊息處理：來自 Popup 和 Service Worker ====================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'GET_STATE':
        sendResponse({
          isEnabled: isEnabled,
          availableTracks: availableTracks,
          currentSecondLanguage: currentSecondLanguage,
          isWatchPage: isWatchPage()
        });
        return true;

      case 'SET_ENABLED':
        isEnabled = message.data.enabled;
        if (isEnabled && renderer) {
          renderer.setVisible(true);
        } else if (!isEnabled && renderer) {
          renderer.setVisible(false);
        }
        sendResponse({ success: true });
        return true;

      case 'SET_SECOND_LANGUAGE':
        selectSecondLanguage(message.data.language);
        sendResponse({ success: true });
        return true;

      case 'UPDATE_SETTINGS':
        currentSettings = { ...currentSettings, ...message.data };
        if (renderer) {
          renderer.updateSettings(currentSettings);
        }
        // 儲存設定
        chrome.storage.local.set({ settings: currentSettings });
        sendResponse({ success: true });
        return true;

      case 'GET_AVAILABLE_TRACKS':
        sendResponse({ tracks: availableTracks });
        return true;

      case 'RETRY_DETECT':
        // 重新觸發 Player API 偵測
        console.log(LOG_PREFIX, '手動觸發重新偵測字幕軌道...');
        window.postMessage({
          source: 'nf-dual-sub-content',
          type: 'RETRY_PLAYER_API'
        }, '*');
        sendResponse({ success: true });
        return true;
    }
  });

  // ==================== 核心邏輯 ====================

  /**
   * 處理發現的字幕軌道
   */
  function handleTracksFound(tracks) {
    if (!tracks || tracks.length === 0) return;

    availableTracks = tracks;
    console.log(LOG_PREFIX, `可用字幕語言:`, tracks.map(t => `${t.displayName} (${t.bcp47})`).join(', '));

    // 通知 popup 和 background
    chrome.runtime.sendMessage({
      type: 'TRACKS_UPDATED',
      data: { tracks: tracks }
    }).catch(() => { }); // popup 可能沒開啟

    // 如果有之前選擇的語言，自動載入
    if (currentSecondLanguage) {
      selectSecondLanguage(currentSecondLanguage);
    } else {
      // 從儲存中讀取上次選擇
      chrome.storage.local.get(['secondLanguage', 'settings', 'isEnabled'], (result) => {
        if (result.isEnabled !== undefined) {
          isEnabled = result.isEnabled;
        }
        if (result.settings) {
          currentSettings = result.settings;
        }
        if (result.secondLanguage) {
          selectSecondLanguage(result.secondLanguage);
        }
      });
    }
  }

  /**
   * 選擇第二語言字幕
   */
  function selectSecondLanguage(language) {
    if (!language) return;

    currentSecondLanguage = language;

    // 儲存選擇
    chrome.storage.local.set({ secondLanguage: language });

    // 尋找對應的軌道
    const track = availableTracks.find(t =>
      t.bcp47 === language || t.language === language
    );

    if (!track) {
      console.warn(LOG_PREFIX, `找不到語言 ${language} 的字幕軌道`);
      return;
    }

    if (track.downloadUrls.length === 0) {
      if (subtitleContentCache[language]) {
        console.log(LOG_PREFIX, `[快取] 使用快取的 ${language} 字幕`);
        handleSecondSubtitleLoaded({ language, data: subtitleContentCache[language] });
        return;
      }
      console.log(LOG_PREFIX, `語言 ${language} 沒有直接的下載連結，嘗試透過 Player API 取得...`);
      window.postMessage({
        source: 'nf-dual-sub-content',
        type: 'FETCH_SUBTITLE_VIA_PLAYER',
        data: { language: language }
      }, '*');
      return;
    }

    // 選擇最佳格式（優先 WebVTT，其次 TTML/DFXP）
    let bestUrl = null;
    const preferredFormats = ['webvtt-lssdh-ios8', 'dfxp-ls-sdh', 'simplesdh', 'nflx-cmisc'];

    for (const preferred of preferredFormats) {
      const match = track.downloadUrls.find(d =>
        d.format.toLowerCase().includes(preferred.toLowerCase())
      );
      if (match) {
        bestUrl = match.url;
        break;
      }
    }

    // 如果沒有偏好格式，使用第一個可用的
    if (!bestUrl && track.downloadUrls.length > 0) {
      bestUrl = track.downloadUrls[0].url;
    }

    if (bestUrl) {
      console.log(LOG_PREFIX, `正在載入 ${track.displayName} (${track.bcp47}) 字幕...`);

      // 透過 injected.js 請求字幕（使用頁面的 cookie/session）
      window.postMessage({
        source: 'nf-dual-sub-content',
        type: 'FETCH_SUBTITLE',
        data: {
          url: bestUrl,
          language: language
        }
      }, '*');
    }
  }

  /**
   * 處理第二字幕載入完成
   */
  function handleSecondSubtitleLoaded(data) {
    console.log(LOG_PREFIX, `${data.language} 字幕已載入`);

    const r = initRenderer();

    // 載入字幕數據
    const cueCount = r.loadSubtitles(data.data);

    if (cueCount > 0) {
      // 套用儲存的設定
      if (Object.keys(currentSettings).length > 0) {
        r.updateSettings(currentSettings);
      }

      // 啟動渲染
      r.start();
      r.setVisible(isEnabled);

      console.log(LOG_PREFIX, `第二字幕已啟動 (${cueCount} 段)`);
    } else {
      console.warn(LOG_PREFIX, '字幕解析結果為空');
    }
  }

  // ==================== Netflix SPA 導航偵測 ====================

  function isWatchPage() {
    return location.pathname.startsWith('/watch');
  }

  function checkUrlChange() {
    if (location.href !== lastUrl) {
      const wasWatch = lastUrl.includes('/watch');
      lastUrl = location.href;

      if (!isWatchPage() && wasWatch) {
        // 離開觀看頁面
        destroyRenderer();
        availableTracks = [];
      } else if (isWatchPage() && !wasWatch) {
        // 進入觀看頁面
        // 等待 Netflix 播放器初始化
        availableTracks = [];
      }
    }
  }

  // 定期檢查 URL 變更（Netflix 使用 History API）
  setInterval(checkUrlChange, 1000);

  // 也監聽 popstate 事件
  window.addEventListener('popstate', checkUrlChange);

  // 監聽 history.pushState
  const originalPushState = history.pushState;
  history.pushState = function () {
    originalPushState.apply(this, arguments);
    checkUrlChange();
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function () {
    originalReplaceState.apply(this, arguments);
    checkUrlChange();
  };

  // ==================== 初始化 ====================

  // 載入儲存的設定
  chrome.storage.local.get(['isEnabled', 'settings', 'secondLanguage'], (result) => {
    if (result.isEnabled !== undefined) {
      isEnabled = result.isEnabled;
    }
    if (result.settings) {
      currentSettings = result.settings;
    }
    if (result.secondLanguage) {
      currentSecondLanguage = result.secondLanguage;
    }
  });

  console.log(LOG_PREFIX, 'Content Script 已載入');
})();
