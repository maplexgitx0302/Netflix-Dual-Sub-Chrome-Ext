/**
 * subtitle-renderer.js - 字幕解析、同步與渲染引擎
 * 
 * 功能：
 * 1. 解析 TTML/DFXP/WebVTT 格式的字幕
 * 2. 監聽影片時間更新，同步顯示字幕
 * 3. 在 Netflix 播放器上渲染第二語言字幕
 */

const SubtitleRenderer = (() => {
  'use strict';

  const LOG_PREFIX = '[NF雙語字幕-渲染]';

  // ==================== TTML/DFXP 解析器 ====================

  /**
   * 解析時間字串為秒數
   * 支援格式: "HH:MM:SS.mmm", "HH:MM:SS:FF", "123.456s", "12345ms", "12345t" (tick)
   */
  function parseTimeString(timeStr) {
    if (!timeStr) return 0;

    // tick-based format (Netflix 常用)
    const tickMatch = timeStr.match(/^(\d+)t$/);
    if (tickMatch) {
      // Netflix 使用 10,000,000 ticks per second
      return parseInt(tickMatch[1]) / 10000000;
    }

    // 毫秒格式
    const msMatch = timeStr.match(/^(\d+(?:\.\d+)?)ms$/);
    if (msMatch) {
      return parseFloat(msMatch[1]) / 1000;
    }

    // 秒格式
    const sMatch = timeStr.match(/^(\d+(?:\.\d+)?)s$/);
    if (sMatch) {
      return parseFloat(sMatch[1]);
    }

    // HH:MM:SS.mmm 或 HH:MM:SS:FF 格式
    const timeMatch = timeStr.match(/^(\d+):(\d+):(\d+)(?:[.:](\d+))?$/);
    if (timeMatch) {
      const hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      const seconds = parseInt(timeMatch[3]);
      const fraction = timeMatch[4] ? parseInt(timeMatch[4]) : 0;

      let totalSeconds = hours * 3600 + minutes * 60 + seconds;

      // 判斷小數部分位數
      if (timeMatch[4]) {
        const fractionStr = timeMatch[4];
        if (fractionStr.length <= 3) {
          // 毫秒
          totalSeconds += fraction / Math.pow(10, fractionStr.length);
        } else {
          // 可能是 frame，假設 30fps
          totalSeconds += fraction / 30;
        }
      }

      return totalSeconds;
    }

    return 0;
  }

  /**
   * 從 XML 文字節點中提取純文字（保留換行）
   */
  function extractTextFromNode(node) {
    let text = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent;
      } else if (child.nodeName === 'br' || child.localName === 'br') {
        text += '\n';
      } else if (child.nodeName === 'span' || child.localName === 'span') {
        text += extractTextFromNode(child);
      } else {
        text += extractTextFromNode(child);
      }
    }
    return text.trim();
  }

  /**
   * 解析 TTML/DFXP XML 字幕
   */
  function parseTTML(xmlText) {
    const cues = [];

    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'application/xml');

      // 檢查解析錯誤
      const parseError = doc.querySelector('parsererror');
      if (parseError) {
        console.warn(LOG_PREFIX, 'XML 解析警告:', parseError.textContent.substring(0, 100));
      }

      // 取得 tickRate（如果有的話）
      const ttElement = doc.querySelector('tt') || doc.documentElement;
      const tickRate = ttElement.getAttribute('ttp:tickRate') || 
                       ttElement.getAttributeNS('http://www.w3.org/ns/ttml#parameter', 'tickRate');

      // 尋找所有 <p> 元素（字幕段落）
      const paragraphs = doc.querySelectorAll('p');

      paragraphs.forEach(p => {
        const begin = p.getAttribute('begin');
        const end = p.getAttribute('end') || p.getAttribute('dur');
        const text = extractTextFromNode(p);

        if (begin && text) {
          let startTime = parseTimeString(begin);
          let endTime;

          if (p.getAttribute('end')) {
            endTime = parseTimeString(p.getAttribute('end'));
          } else if (p.getAttribute('dur')) {
            endTime = startTime + parseTimeString(p.getAttribute('dur'));
          } else {
            endTime = startTime + 5; // 預設顯示 5 秒
          }

          // 如果有自訂 tickRate，調整時間
          if (tickRate) {
            const rate = parseInt(tickRate);
            if (rate && rate !== 10000000) {
              // 重新計算 tick
              const beginTick = begin.match(/^(\d+)t$/);
              if (beginTick) {
                startTime = parseInt(beginTick[1]) / rate;
              }
              const endTick = (p.getAttribute('end') || '').match(/^(\d+)t$/);
              if (endTick) {
                endTime = parseInt(endTick[1]) / rate;
              }
            }
          }

          cues.push({
            startTime: startTime,
            endTime: endTime,
            text: text
          });
        }
      });

      // 按開始時間排序
      cues.sort((a, b) => a.startTime - b.startTime);

    } catch (e) {
      console.error(LOG_PREFIX, '解析 TTML 字幕失敗:', e);
    }

    return cues;
  }

  /**
   * 解析 WebVTT 字幕
   */
  function parseWebVTT(vttText) {
    const cues = [];
    const lines = vttText.split('\n');
    let i = 0;

    // 跳過 WEBVTT header
    while (i < lines.length && !lines[i].includes('-->')) {
      i++;
    }

    while (i < lines.length) {
      const line = lines[i].trim();

      if (line.includes('-->')) {
        const timeParts = line.split('-->');
        const startTime = parseVTTTime(timeParts[0].trim());
        const endTime = parseVTTTime(timeParts[1].trim().split(' ')[0]);

        let text = '';
        i++;
        while (i < lines.length && lines[i].trim() !== '') {
          if (text) text += '\n';
          text += lines[i].trim();
          i++;
        }

        if (text) {
          // 移除 HTML 標籤
          text = text.replace(/<[^>]+>/g, '');
          cues.push({ startTime, endTime, text });
        }
      } else {
        i++;
      }
    }

    return cues;
  }

  function parseVTTTime(timeStr) {
    const match = timeStr.match(/(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/);
    if (!match) return 0;
    const hours = match[1] ? parseInt(match[1]) : 0;
    return hours * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 1000;
  }

  /**
   * 自動偵測格式並解析字幕
   */
  function parseSubtitle(data) {
    if (!data) return [];

    const trimmed = data.trim();
    if (trimmed.startsWith('<?xml') || trimmed.startsWith('<tt') || trimmed.startsWith('<tt:tt')) {
      return parseTTML(trimmed);
    } else if (trimmed.startsWith('WEBVTT')) {
      return parseWebVTT(trimmed);
    } else {
      // 嘗試 JSON 格式
      try {
        const json = JSON.parse(trimmed);
        if (json && json.cues) {
          return json.cues.map(c => ({
            startTime: c.startTime / 1000 || 0,
            endTime: c.endTime / 1000 || 0,
            text: c.text || ''
          }));
        }
      } catch (e) {
        // 不是 JSON，嘗試 TTML
        if (trimmed.includes('<p ') || trimmed.includes('<p>')) {
          return parseTTML(`<?xml version="1.0"?><tt>${trimmed}</tt>`);
        }
      }
    }

    console.warn(LOG_PREFIX, '無法識別字幕格式');
    return [];
  }

  // ==================== 二分搜尋 ====================

  /**
   * 使用二分搜尋找到當前時間對應的字幕
   */
  function findCurrentCues(cues, currentTime) {
    if (!cues || cues.length === 0) return [];

    const results = [];

    // 二分搜尋找到第一個可能的字幕
    let low = 0;
    let high = cues.length - 1;
    let startIdx = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (cues[mid].endTime < currentTime) {
        low = mid + 1;
      } else {
        startIdx = mid;
        high = mid - 1;
      }
    }

    // 從 startIdx 開始，找到所有包含 currentTime 的字幕
    for (let i = startIdx; i < cues.length; i++) {
      if (cues[i].startTime > currentTime) break;
      if (cues[i].startTime <= currentTime && cues[i].endTime >= currentTime) {
        results.push(cues[i]);
      }
    }

    return results;
  }

  // ==================== 渲染器類別 ====================

  class Renderer {
    constructor() {
      this.cues = [];
      this.container = null;
      this.textElement = null;
      this.videoElement = null;
      this.animationFrameId = null;
      this.isActive = false;
      this.lastDisplayedText = '';
      this.settings = {
        fontSize: 'medium', // small, medium, large
        position: 'above',  // above, below
        opacity: 0.9,
        fontColor: '#ffffff',
        bgColor: 'rgba(0, 0, 0, 0.75)'
      };

      this._onTimeUpdate = this._onTimeUpdate.bind(this);
      this._onFullscreenChange = this._onFullscreenChange.bind(this);
      this._observerCallback = this._observerCallback.bind(this);

      this.domObserver = null;
      this._positionTimer = null;
    }

    /**
     * 載入字幕數據
     */
    loadSubtitles(data) {
      this.cues = parseSubtitle(data);
      console.log(LOG_PREFIX, `已載入 ${this.cues.length} 段字幕`);
      return this.cues.length;
    }

    /**
     * 更新設定
     */
    updateSettings(newSettings) {
      Object.assign(this.settings, newSettings);
      this._applyStyles();
    }

    /**
     * 啟動渲染器
     */
    start() {
      if (this.isActive) return;

      this._findVideoElement();
      if (!this.videoElement) {
        console.warn(LOG_PREFIX, '找不到影片元素，稍後重試...');
        setTimeout(() => this.start(), 2000);
        return;
      }

      this._createContainer();
      this._attachListeners();
      this.isActive = true;
      console.log(LOG_PREFIX, '渲染器已啟動');
    }

    /**
     * 停止渲染器
     */
    stop() {
      this.isActive = false;
      this._detachListeners();
      this._removeContainer();
      this.cues = [];
      this.lastDisplayedText = '';
      console.log(LOG_PREFIX, '渲染器已停止');
    }

    /**
     * 暫時隱藏/顯示（不銷毀）
     */
    setVisible(visible) {
      if (this.container) {
        this.container.style.display = visible ? 'flex' : 'none';
      }
    }

    /**
     * 尋找 Netflix 播放器中的 video 元素
     */
    _findVideoElement() {
      // Netflix 的 video 元素通常在特定的 player 容器中
      this.videoElement = document.querySelector('video');
    }

    /**
     * 建立字幕容器（掛在 body 上，所有關鍵樣式用 inline style 避免被 Netflix CSS 覆蓋）
     */
    _createContainer() {
      this._removeContainer();

      this.container = document.createElement('div');
      this.container.id = 'nf-dual-sub-container';
      Object.assign(this.container.style, {
        position: 'fixed',
        left: '0',
        right: '0',
        bottom: '22%',
        zIndex: '2147483646',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-end',
        pointerEvents: 'none',
        padding: '0 10%',
        boxSizing: 'border-box',
        transition: 'opacity 0.2s ease-in-out'
      });

      this.textElement = document.createElement('div');
      Object.assign(this.textElement.style, {
        display: 'inline-block',
        padding: '4px 12px',
        borderRadius: '4px',
        fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
        fontSize: '2.4em',
        fontWeight: '500',
        lineHeight: '1.4',
        textAlign: 'center',
        color: '#ffffff',
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        textShadow: '1px 1px 2px rgba(0, 0, 0, 0.8)',
        whiteSpace: 'pre-wrap',
        wordWrap: 'break-word',
        maxWidth: '80%',
        opacity: '1',
        transition: 'opacity 0.15s ease-in-out'
      });

      this.container.appendChild(this.textElement);
      
      const targetParent = document.fullscreenElement || document.body;
      targetParent.appendChild(this.container);

      this._applyStyles();
      this._repositionContainer();
    }

    /**
     * 動態定位：偵測 Netflix 原生字幕位置，將覆蓋層放在其正上方
     */
    _repositionContainer() {
      if (!this.container) return;

      if (this.settings.position === 'below') {
        this.container.style.bottom = '4%';
        return;
      }

      // 優先找實際文字容器（更精確），其次找外層容器
      const nfSub = document.querySelector('.player-timedtext-text-container') ||
                    document.querySelector('[class*="timedtext-text"]') ||
                    document.querySelector('.player-timedtext');

      if (nfSub) {
        const rect = nfSub.getBoundingClientRect();
        // 元素的底部在視口下半區才採用（避免誤判大容器）
        if (rect.bottom > window.innerHeight * 0.5 && rect.height < window.innerHeight * 0.4) {
          this.container.style.bottom = (window.innerHeight - rect.top + 12) + 'px';
          return;
        }
      }
      // fallback：Netflix 字幕通常在底部 10–15%，設 22% 確保在其上方
      this.container.style.bottom = '22%';
    }

    /**
     * 移除字幕容器
     */
    _removeContainer() {
      const existing = document.getElementById('nf-dual-sub-container');
      if (existing) {
        existing.remove();
      }
      this.container = null;
      this.textElement = null;
    }

    /**
     * 套用使用者設定到字幕樣式
     */
    _applyStyles() {
      if (!this.container || !this.textElement) return;

      const fontSizes = {
        small: '1.8em',
        medium: '2.4em',
        large: '3.0em'
      };

      this.textElement.style.fontSize = fontSizes[this.settings.fontSize] || '2.4em';
      this.textElement.style.color = this.settings.fontColor || '#ffffff';
      this.textElement.style.backgroundColor = this.settings.bgColor || 'rgba(0, 0, 0, 0.75)';
      this.container.style.opacity = String(this.settings.opacity !== undefined ? this.settings.opacity : 0.9);

      this._repositionContainer();
    }

    /**
     * 監聽事件
     */
    _attachListeners() {
      if (this.videoElement) {
        this.videoElement.addEventListener('timeupdate', this._onTimeUpdate);
      }

      document.addEventListener('fullscreenchange', this._onFullscreenChange);
      document.addEventListener('webkitfullscreenchange', this._onFullscreenChange);

      // 定期重新對齊 Netflix 原生字幕位置（字幕元素可能延遲出現）
      this._positionTimer = setInterval(() => this._repositionContainer(), 500);

      this.domObserver = new MutationObserver(this._observerCallback);
      this.domObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }

    /**
     * 移除事件監聽
     */
    _detachListeners() {
      if (this.videoElement) {
        this.videoElement.removeEventListener('timeupdate', this._onTimeUpdate);
      }

      document.removeEventListener('fullscreenchange', this._onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', this._onFullscreenChange);

      if (this._positionTimer) {
        clearInterval(this._positionTimer);
        this._positionTimer = null;
      }

      if (this.domObserver) {
        this.domObserver.disconnect();
        this.domObserver = null;
      }

      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
    }

    /**
     * 時間更新回呼
     */
    _onTimeUpdate() {
      if (!this.isActive || !this.videoElement || !this.textElement) return;

      const currentTime = this.videoElement.currentTime;
      const currentCues = findCurrentCues(this.cues, currentTime);

      const newText = currentCues.map(c => c.text).join('\n');

      if (newText !== this.lastDisplayedText) {
        this.lastDisplayedText = newText;

        if (newText) {
          this.textElement.innerHTML = newText.replace(/\n/g, '<br>');
          this.textElement.style.opacity = '1';
        } else {
          this.textElement.innerHTML = '';
          this.textElement.style.opacity = '0';
        }
      }
    }

    /**
     * 全螢幕變更處理
     */
    _onFullscreenChange() {
      // 確保在全螢幕時將容器移入全螢幕元素內，否則會被遮擋
      setTimeout(() => {
        if (!this.isActive) return;
        
        const container = document.getElementById('nf-dual-sub-container');
        const targetParent = document.fullscreenElement || document.body;
        
        if (container) {
          if (container.parentElement !== targetParent) {
            targetParent.appendChild(container);
            this._repositionContainer();
          }
        } else {
          this._createContainer();
        }
      }, 500);
    }

    /**
     * DOM 變化觀察回呼
     */
    _observerCallback(mutations) {
      // 偵測影片元素是否被替換
      if (!document.contains(this.videoElement)) {
        const newVideo = document.querySelector('video');
        if (newVideo && newVideo !== this.videoElement) {
          if (this.videoElement) {
            this.videoElement.removeEventListener('timeupdate', this._onTimeUpdate);
          }
          this.videoElement = newVideo;
          this.videoElement.addEventListener('timeupdate', this._onTimeUpdate);
        }
      }

      // 偵測容器是否被移除
      if (this.isActive && this.container && !document.contains(this.container)) {
        this._createContainer();
      }
    }
  }

  // 公開 API
  return {
    Renderer,
    parseSubtitle,
    parseTTML,
    parseWebVTT,
    findCurrentCues,
    parseTimeString
  };
})();
