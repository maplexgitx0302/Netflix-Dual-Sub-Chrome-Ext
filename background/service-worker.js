/**
 * service-worker.js - Background Service Worker
 *
 * 功能：
 * 1. 處理安裝事件並寫入預設設定
 * 2. 更新時補齊新增的設定鍵（保留使用者既有設定）
 *
 * 註：Popup 直接向 Content Script 查詢狀態（GET_STATE），
 *     因此這裡不再需要快取字幕軌道或轉發訊息。
 */

const DEFAULT_SETTINGS = {
  fontSize: 'medium',
  position: 'above',
  opacity: 0.9,
  fontColor: '#ffffff',
  bgColor: 'rgba(0, 0, 0, 0.75)'
};

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[NF雙語字幕] 擴充功能已安裝');
    chrome.storage.local.set({
      isEnabled: true,
      secondLanguage: null,
      settings: DEFAULT_SETTINGS
    });
  } else if (details.reason === 'update') {
    console.log('[NF雙語字幕] 擴充功能已更新至', chrome.runtime.getManifest().version);
    // 新版本若新增設定鍵，以預設值補齊；使用者已設定的值不受影響
    chrome.storage.local.get(['settings'], (result) => {
      chrome.storage.local.set({
        settings: { ...DEFAULT_SETTINGS, ...(result.settings || {}) }
      });
    });
  }
});
