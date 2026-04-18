/**
 * popup.js - Popup 控制面板邏輯
 * 
 * 功能：
 * 1. 顯示擴充功能啟用/停用狀態
 * 2. 載入並顯示可用字幕語言
 * 3. 管理使用者偏好設定
 */
(function () {
  'use strict';

  // ==================== DOM 元素 ====================

  const toggleEnabled = document.getElementById('toggle-enabled');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const languageSelect = document.getElementById('language-select');
  const fontSizeGroup = document.getElementById('font-size-group');
  const positionGroup = document.getElementById('position-group');
  const opacitySlider = document.getElementById('opacity-slider');
  const opacityValue = document.getElementById('opacity-value');
  const popupContainer = document.querySelector('.popup-container');

  // ==================== 狀態 ====================

  let currentTabId = null;
  let isNetflixTab = false;

  // ==================== 初始化 ====================

  async function init() {
    // 取得當前分頁
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    currentTabId = tab.id;
    isNetflixTab = tab.url && tab.url.includes('netflix.com');

    // 載入儲存的設定
    const stored = await chrome.storage.local.get(['isEnabled', 'settings', 'secondLanguage']);

    // 設定開關狀態
    if (stored.isEnabled !== undefined) {
      toggleEnabled.checked = stored.isEnabled;
    }
    updateDisabledState();

    // 設定偏好
    if (stored.settings) {
      applyStoredSettings(stored.settings);
    }

    if (isNetflixTab) {
      // 向 Content Script 要求目前狀態
      try {
        const response = await chrome.tabs.sendMessage(currentTabId, { type: 'GET_STATE' });
        if (response) {
          updateUI(response, stored.secondLanguage);
        }
      } catch (e) {
        // Content Script 可能尚未載入
        setStatus('warning', '請重新整理 Netflix 頁面');
      }
    } else {
      setStatus('error', '請開啟 Netflix 後使用');
      languageSelect.disabled = true;
    }
  }

  async function updateUI(state, savedLanguage) {
    if (state.isWatchPage) {
      if (state.availableTracks && state.availableTracks.length > 0) {
        setStatus('active', `已偵測到 ${state.availableTracks.length} 種字幕語言`);
        populateLanguages(state.availableTracks, state.currentSecondLanguage || savedLanguage);
      } else {
        setStatus('warning', '正在偵測字幕軌道...');
        languageSelect.disabled = true;

        // 主動觸發重新偵測
        try {
          await chrome.tabs.sendMessage(currentTabId, { type: 'RETRY_DETECT' });
        } catch (e) { }

        // 多次重試，每次間隔 2 秒
        let retryCount = 0;
        const maxRetries = 10;
        const retryInterval = setInterval(async () => {
          retryCount++;
          if (retryCount > maxRetries) {
            clearInterval(retryInterval);
            setStatus('warning', '未偵測到字幕，請確認影片已播放並重新開啟此面板');
            return;
          }
          try {
            const response = await chrome.tabs.sendMessage(currentTabId, { type: 'GET_STATE' });
            if (response && response.availableTracks && response.availableTracks.length > 0) {
              clearInterval(retryInterval);
              updateUI(response, savedLanguage);
            } else {
              setStatus('warning', `正在偵測字幕軌道... (${retryCount}/${maxRetries})`);
            }
          } catch (e) {
            clearInterval(retryInterval);
            setStatus('error', '通訊失敗，請重新整理 Netflix 頁面');
          }
        }, 2000);
      }
    } else {
      setStatus('warning', '請播放影片以偵測字幕');
      languageSelect.disabled = true;
    }
  }

  // ==================== UI 更新 ====================

  function setStatus(type, text) {
    statusDot.className = 'status-dot ' + type;
    statusText.textContent = text;
  }

  function populateLanguages(tracks, selectedLanguage) {
    languageSelect.innerHTML = '<option value="">-- 選擇第二字幕語言 --</option>';

    // 語言顯示名稱對照表
    const langNames = {
      'en': '英文 English',
      'ja': '日文 日本語',
      'ko': '韓文 한국어',
      'zh-Hans': '簡體中文',
      'zh-Hant': '繁體中文',
      'zh-TW': '繁體中文（台灣）',
      'zh-CN': '簡體中文（中國）',
      'es': '西班牙文 Español',
      'fr': '法文 Français',
      'de': '德文 Deutsch',
      'it': '義大利文 Italiano',
      'pt': '葡萄牙文 Português',
      'pt-BR': '巴西葡萄牙文',
      'ar': '阿拉伯文 العربية',
      'hi': '印地文 हिन्दी',
      'th': '泰文 ไทย',
      'vi': '越南文 Tiếng Việt',
      'id': '印尼文 Bahasa Indonesia',
      'ms': '馬來文 Bahasa Melayu',
      'tl': '菲律賓文 Filipino',
      'tr': '土耳其文 Türkçe',
      'pl': '波蘭文 Polski',
      'nl': '荷蘭文 Nederlands',
      'sv': '瑞典文 Svenska',
      'da': '丹麥文 Dansk',
      'fi': '芬蘭文 Suomi',
      'no': '挪威文 Norsk',
      'ru': '俄文 Русский',
      'uk': '烏克蘭文 Українська',
      'el': '希臘文 Ελληνικά',
      'he': '希伯來文 עברית',
      'ro': '羅馬尼亞文 Română',
      'cs': '捷克文 Čeština',
      'hu': '匈牙利文 Magyar'
    };

    tracks.forEach(track => {
      const option = document.createElement('option');
      option.value = track.bcp47 || track.language;
      
      // 使用自訂名稱或 Netflix 提供的名稱
      const displayName = langNames[track.bcp47] || 
                          langNames[track.language] || 
                          track.displayName || 
                          track.language;
      option.textContent = displayName;

      if (selectedLanguage && (track.bcp47 === selectedLanguage || track.language === selectedLanguage)) {
        option.selected = true;
      }

      languageSelect.appendChild(option);
    });

    languageSelect.disabled = false;
  }

  function applyStoredSettings(settings) {
    if (settings.fontSize) {
      setActiveButton(fontSizeGroup, settings.fontSize);
    }
    if (settings.position) {
      setActiveButton(positionGroup, settings.position);
    }
    if (settings.opacity !== undefined) {
      const percent = Math.round(settings.opacity * 100);
      opacitySlider.value = percent;
      opacityValue.textContent = percent + '%';
    }
  }

  function setActiveButton(group, value) {
    group.querySelectorAll('.btn-option').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === value);
    });
  }

  function updateDisabledState() {
    if (toggleEnabled.checked) {
      popupContainer.classList.remove('disabled');
    } else {
      popupContainer.classList.add('disabled');
    }
  }

  // ==================== 事件處理 ====================

  // 啟用/停用切換
  toggleEnabled.addEventListener('change', async () => {
    const enabled = toggleEnabled.checked;
    updateDisabledState();

    await chrome.storage.local.set({ isEnabled: enabled });

    if (currentTabId && isNetflixTab) {
      try {
        await chrome.tabs.sendMessage(currentTabId, {
          type: 'SET_ENABLED',
          data: { enabled }
        });
      } catch (e) { }
    }
  });

  // 語言選擇
  languageSelect.addEventListener('change', async () => {
    const language = languageSelect.value;

    if (!language) return;

    await chrome.storage.local.set({ secondLanguage: language });

    if (currentTabId && isNetflixTab) {
      try {
        await chrome.tabs.sendMessage(currentTabId, {
          type: 'SET_SECOND_LANGUAGE',
          data: { language }
        });
        setStatus('active', '載入字幕中...');
      } catch (e) {
        setStatus('error', '通訊失敗，請重新整理頁面');
      }
    }
  });

  // 字體大小
  fontSizeGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-option');
    if (!btn) return;

    setActiveButton(fontSizeGroup, btn.dataset.value);
    sendSettingsUpdate({ fontSize: btn.dataset.value });
  });

  // 字幕位置
  positionGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-option');
    if (!btn) return;

    setActiveButton(positionGroup, btn.dataset.value);
    sendSettingsUpdate({ position: btn.dataset.value });
  });

  // 透明度
  opacitySlider.addEventListener('input', () => {
    const value = parseInt(opacitySlider.value);
    opacityValue.textContent = value + '%';
    sendSettingsUpdate({ opacity: value / 100 });
  });

  async function sendSettingsUpdate(settingsPartial) {
    // 讀取完整設定再更新
    const stored = await chrome.storage.local.get(['settings']);
    const settings = { ...(stored.settings || {}), ...settingsPartial };
    await chrome.storage.local.set({ settings });

    if (currentTabId && isNetflixTab) {
      try {
        await chrome.tabs.sendMessage(currentTabId, {
          type: 'UPDATE_SETTINGS',
          data: settingsPartial
        });
      } catch (e) { }
    }
  }

  // ==================== 啟動 ====================

  init();
})();
