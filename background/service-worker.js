/**
 * service-worker.js - Background Service Worker
 *
 * 功能：
 * 1. 處理安裝事件並寫入預設設定
 *
 * 註：Popup 直接向 Content Script 查詢狀態（GET_STATE），
 *     因此這裡不再需要快取字幕軌道或轉發訊息。
 */

// ==================== 安裝/更新 ====================

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[NF雙語字幕] 擴充功能已安裝');

    // 設定預設值
    chrome.storage.local.set({
      isEnabled: true,
      secondLanguage: null,
      settings: {
        fontSize: 'medium',
        position: 'above',
        opacity: 0.9,
        fontColor: '#ffffff',
        bgColor: 'rgba(0, 0, 0, 0.75)'
      }
    });
  } else if (details.reason === 'update') {
    console.log('[NF雙語字幕] 擴充功能已更新至', chrome.runtime.getManifest().version);
  }
});
