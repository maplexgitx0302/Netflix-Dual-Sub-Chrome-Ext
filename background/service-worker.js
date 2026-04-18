/**
 * service-worker.js - Background Service Worker
 * 
 * 功能：
 * 1. 管理擴充功能狀態
 * 2. 協調 Content Script 與 Popup 之間的訊息傳遞
 * 3. 處理安裝/更新事件
 */

// ==================== 狀態 ====================

let cachedTracks = {};  // tabId -> tracks

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

// ==================== 訊息路由 ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'TRACKS_UPDATED':
      // 快取字幕軌道資訊
      if (sender.tab) {
        cachedTracks[sender.tab.id] = message.data.tracks;
      }
      break;

    case 'GET_CACHED_TRACKS':
      // Popup 請求快取的軌道資訊
      if (message.tabId && cachedTracks[message.tabId]) {
        sendResponse({ tracks: cachedTracks[message.tabId] });
      } else {
        sendResponse({ tracks: [] });
      }
      return true;
  }
});

// ==================== Tab 清理 ====================

chrome.tabs.onRemoved.addListener((tabId) => {
  delete cachedTracks[tabId];
});
