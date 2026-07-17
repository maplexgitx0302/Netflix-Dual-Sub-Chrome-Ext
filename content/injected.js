/**
 * injected.js - 注入到 Netflix 頁面 MAIN world 的攔截腳本
 * 
 * 功能：
 * 1. Monkey-patch XMLHttpRequest 和 fetch 來攔截字幕與 manifest 請求
 * 2. 嘗試存取 Netflix Cadmium Player API 取得字幕軌道
 * 3. 攔截字幕資料並轉發給 Content Script
 */
(function () {
  'use strict';

  // 避免重複注入
  if (window.__nfDualSubInjected) return;
  window.__nfDualSubInjected = true;

  const LOG_PREFIX = '[NF雙語字幕]';

  // 主動切換字幕軌道時的還原函式；攔截器抓到目標語言字幕後會立即呼叫以縮短原生字幕閃爍
  let pendingSwitchRestore = null;
  // 目前主動切換的目標語言；用來判斷攔截到的字幕是否就是要抓的那個
  // （換集時 Netflix 可能同時在下載原生字幕，不能攔到任何字幕就還原）
  let pendingSwitchLanguage = null;

  // ==================== 工具函式 ====================

  /**
   * 傳送訊息給 Content Script
   */
  function postToContentScript(type, data) {
    window.postMessage({
      source: 'nf-dual-sub-injected',
      type: type,
      data: data
    }, '*');
  }

  /**
   * 判斷 URL 是否為影片/音訊串流（需排除）
   * /range/ 開頭的是 media segments，不是字幕
   */
  function isMediaStreamUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return url.includes('/range/') || url.includes('/audio/') || url.includes('/video/');
  }

  /**
   * 判斷回應內容是否為字幕檔案（VTT 或 TTML/XML）
   */
  function looksLikeSubtitleContent(text) {
    if (!text || text.length < 20) return false;
    return text.startsWith('WEBVTT') ||
      (text.includes('<?xml') && (text.includes('timedtext') || text.includes('<tt ') || text.includes('<TT ')));
  }

  /**
   * 從 URL 嘗試提取語言代碼
   * 只接受 BCP-47 形狀的值；字幕 CDN 上的 o/v/e 等參數是不透明值，不能當語言用
   */
  function extractLanguageFromUrl(url) {
    try {
      const params = new URL(url).searchParams;
      const lang = params.get('lang') || params.get('bcp47') || params.get('language') || params.get('locale');
      if (lang && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lang)) return lang;
    } catch (e) {}
    return null;
  }

  /**
   * 取得目前作用中的 Netflix Cadmium player（尚未就緒時回傳 null）
   * 優先挑選 watch 開頭的 session：換集或預覽時 session 清單可能殘留
   * 預告片/billboard 的 session，直接取最後一個會拿到錯誤的 player。
   */
  function getActivePlayer() {
    try {
      const videoPlayer = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
      if (!videoPlayer) return null;
      const sessionIds = videoPlayer.getAllPlayerSessionIds?.();
      if (!sessionIds || !sessionIds.length) return null;
      const watchIds = sessionIds.filter(id => typeof id === 'string' && id.startsWith('watch'));
      const candidates = watchIds.length ? watchIds : sessionIds;
      return videoPlayer.getVideoPlayerBySessionId(candidates[candidates.length - 1]) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 判斷是否為「關閉/Off」佔位軌道。
   * Netflix 的 Off 軌道會帶著影片原始語言的 bcp47（例如日文影片的 Off 軌 bcp47 = "ja"），
   * 依語言碼比對時會搶在真正的語言軌道之前被選中，導致切換後只抓到近乎空白的佔位字幕。
   */
  function isOffTrack(t) {
    if (!t) return false;
    if (t.isNoneTrack === true) return true;
    const name = (t.displayName || t.languageDescription || '').trim().toLowerCase();
    return name === 'off' || name === 'none' || name === '關閉' || name === '关闭';
  }

  /**
   * 是否為強制字幕（forced narrative）軌道
   */
  function isForcedTrack(t) {
    return !!(t && (t.isForced || t.isForcedNarrative));
  }

  /**
   * 從 Player API 取得目前啟用的字幕語言
   * Off 軌道回傳 null：它帶著原始語言的 bcp47，會讓攔截到的檔案被錯誤歸類
   */
  function getCurrentPlayerSubtitleLanguage() {
    try {
      const player = getActivePlayer();
      if (!player) return null;
      const track = player.getTimedTextTrack?.() || player.getCurrentTimedTextTrack?.() || player.getActiveTimedTextTrack?.();
      if (track && !isOffTrack(track)) return track.bcp47 || track.language || null;
    } catch (e) {}
    return null;
  }

  /**
   * 嘗試從回應文字中找到 timedtexttracks 資訊
   */
  function tryExtractTracksFromText(text) {
    if (!text || typeof text !== 'string') return null;
    // 快速判斷：回應中是否包含關鍵字
    if (!text.includes('timedtexttracks')) return null;

    try {
      const data = JSON.parse(text);
      return extractSubtitleTracks(data);
    } catch (e) {
      // 可能不是 JSON，嘗試在字串中尋找 JSON 片段
      try {
        const match = text.match(/"timedtexttracks"\s*:\s*\[/);
        if (match) {
          // 嘗試從 match 位置解析
          const startIdx = text.lastIndexOf('{', match.index);
          if (startIdx !== -1) {
            // 找到對應的結束括號（簡易方式：往後找足夠長的 JSON）
            let braceCount = 0;
            let endIdx = startIdx;
            for (let i = startIdx; i < text.length && i < startIdx + 500000; i++) {
              if (text[i] === '{') braceCount++;
              if (text[i] === '}') braceCount--;
              if (braceCount === 0) {
                endIdx = i + 1;
                break;
              }
            }
            const jsonStr = text.substring(startIdx, endIdx);
            const parsed = JSON.parse(jsonStr);
            return extractSubtitleTracks(parsed);
          }
        }
      } catch (e2) {
        // 靜默失敗
      }
    }
    return null;
  }

  /**
   * 從 metadata/manifest 回應中提取可用字幕軌道資訊
   */
  function extractSubtitleTracks(data) {
    const tracks = [];

    const findTracks = (obj, depth = 0) => {
      if (depth > 12 || !obj || typeof obj !== 'object') return;

      // 尋找 timedtexttracks 陣列
      if (Array.isArray(obj.timedtexttracks)) {
        obj.timedtexttracks.forEach(track => {
          if (track && track.language && !isOffTrack(track) && !isForcedTrack(track)) {
            const trackInfo = {
              language: track.language,
              bcp47: track.bcp47 || track.language,
              displayName: track.languageDescription || track.language,
              trackType: track.trackType || 'SUBTITLES',
              isForced: track.isForced || false,
              rawTrackType: track.rawTrackType || '',
              downloadUrls: [],
              trackId: track.new_track_id || track.trackId || ''
            };

            // 提取下載 URL（嘗試多種可能的欄位名稱）
            const dlFields = ['ttDownloadables', 'downloadables', 'downloadUrls', 'streams', 'urls'];
            for (const field of dlFields) {
              if (!track[field] || typeof track[field] !== 'object') continue;
              const container = track[field];
              if (Array.isArray(container)) {
                container.forEach(item => {
                  const u = typeof item === 'string' ? item : (item.url || item.downloadUrl);
                  if (u) trackInfo.downloadUrls.push({ format: 'unknown', url: u });
                });
              } else {
                Object.keys(container).forEach(format => {
                  const downloadable = container[format];
                  if (!downloadable) return;
                  if (typeof downloadable === 'string') {
                    trackInfo.downloadUrls.push({ format, url: downloadable });
                    return;
                  }
                  if (downloadable.downloadUrls) {
                    Object.values(downloadable.downloadUrls).forEach(url => {
                      if (typeof url === 'string') trackInfo.downloadUrls.push({ format, url });
                    });
                  }
                  if (downloadable.urls) {
                    (Array.isArray(downloadable.urls) ? downloadable.urls : Object.values(downloadable.urls)).forEach(urlObj => {
                      const u = typeof urlObj === 'string' ? urlObj : urlObj.url;
                      if (u) trackInfo.downloadUrls.push({ format, url: u });
                    });
                  }
                });
              }
              if (trackInfo.downloadUrls.length > 0) break;
            }

            // 只加入有下載連結的非強制字幕軌道
            if (!trackInfo.isForced && trackInfo.downloadUrls.length > 0) {
              tracks.push(trackInfo);
            }
          }
        });
        return; // 找到了就不再深入
      }

      // 遞迴搜尋
      if (Array.isArray(obj)) {
        obj.forEach(item => findTracks(item, depth + 1));
      } else {
        Object.values(obj).forEach(value => findTracks(value, depth + 1));
      }
    };

    findTracks(data);

    // 去重（根據 bcp47）
    const uniqueTracks = [];
    const seen = new Set();
    tracks.forEach(track => {
      const key = track.bcp47 || track.language;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueTracks.push(track);
      }
    });

    return uniqueTracks.length > 0 ? uniqueTracks : null;
  }

  // ==================== 方法 1：攔截 XHR ====================

  const OriginalXHR = window.XMLHttpRequest;
  const originalXhrOpen = OriginalXHR.prototype.open;
  const originalXhrSend = OriginalXHR.prototype.send;

  OriginalXHR.prototype.open = function (method, url, ...args) {
    this._nfDualSubUrl = typeof url === 'string' ? url : String(url);
    this._nfDualSubMethod = method;
    return originalXhrOpen.apply(this, [method, url, ...args]);
  };

  OriginalXHR.prototype.send = function (body) {
    const url = this._nfDualSubUrl || '';
    const xhr = this;

    // 排除 media stream 請求
    if (isMediaStreamUrl(url)) {
      return originalXhrSend.apply(this, arguments);
    }

    // 監聽所有 netflix.com 相關的 XHR 回應，檢查是否含有字幕軌道資訊
    xhr.addEventListener('load', function () {
      if (xhr.status !== 200) return;
      try {
        let text = null;
        if (xhr.responseType === '' || xhr.responseType === 'text') {
          text = xhr.responseText;
        } else if (xhr.responseType === 'json' && xhr.response) {
          // Netflix manifest 可能使用 responseType='json'
          const tracks = extractSubtitleTracks(xhr.response);
          if (tracks && tracks.length > 0) {
            console.log(LOG_PREFIX, `[XHR/JSON] 發現 ${tracks.length} 個字幕軌道，來源: ${url.substring(0, 100)}`);
            postToContentScript('SUBTITLE_TRACKS_FOUND', { tracks });
          }
          return;
        }
        if (text) {
          if (looksLikeSubtitleContent(text)) {
            let lang = extractLanguageFromUrl(url) || getCurrentPlayerSubtitleLanguage();
            // 主動切換期間攔到無法判斷語言的字幕，視為切換目標語言
            if (!lang && pendingSwitchLanguage) lang = pendingSwitchLanguage;
            console.log(LOG_PREFIX, `[XHR] 攔截到字幕檔案，語言: ${lang || '未知'}，來源: ${url.substring(0, 80)}`);
            postToContentScript('SUBTITLE_FILE_INTERCEPTED', { url, language: lang, content: text });
            // 僅在抓到「目標語言」時才還原軌道；換集時原生字幕也會同時下載，不能誤觸發
            if (pendingSwitchRestore && lang === pendingSwitchLanguage) pendingSwitchRestore();
            return;
          }
          const tracks = tryExtractTracksFromText(text);
          if (tracks && tracks.length > 0) {
            console.log(LOG_PREFIX, `[XHR] 發現 ${tracks.length} 個字幕軌道，來源: ${url.substring(0, 100)}`);
            postToContentScript('SUBTITLE_TRACKS_FOUND', { tracks });
          }
        }
      } catch (e) {
        // 靜默
      }
    });

    return originalXhrSend.apply(this, arguments);
  };

  // ==================== 方法 2：攔截 Fetch ====================

  const originalFetch = window.fetch;

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : '');

    const fetchPromise = originalFetch.apply(this, arguments);

    // 排除 media stream 請求
    if (isMediaStreamUrl(url)) {
      return fetchPromise;
    }

    fetchPromise.then(response => {
      const cloned = response.clone();
      cloned.text().then(text => {
        try {
          if (looksLikeSubtitleContent(text)) {
            let lang = extractLanguageFromUrl(url) || getCurrentPlayerSubtitleLanguage();
            // 主動切換期間攔到無法判斷語言的字幕，視為切換目標語言
            if (!lang && pendingSwitchLanguage) lang = pendingSwitchLanguage;
            console.log(LOG_PREFIX, `[Fetch] 攔截到字幕檔案，語言: ${lang || '未知'}，來源: ${url.substring(0, 80)}`);
            postToContentScript('SUBTITLE_FILE_INTERCEPTED', { url, language: lang, content: text });
            // 僅在抓到「目標語言」時才還原軌道；換集時原生字幕也會同時下載，不能誤觸發
            if (pendingSwitchRestore && lang === pendingSwitchLanguage) pendingSwitchRestore();
            return;
          }
          const tracks = tryExtractTracksFromText(text);
          if (tracks && tracks.length > 0) {
            console.log(LOG_PREFIX, `[Fetch] 發現 ${tracks.length} 個字幕軌道，來源: ${url.substring(0, 100)}`);
            postToContentScript('SUBTITLE_TRACKS_FOUND', { tracks });
          }
        } catch (e) {
          // 靜默
        }
      }).catch(() => {});
    }).catch(() => {});

    return fetchPromise;
  };

  // ==================== 方法 3：Netflix Cadmium Player API ====================

  let playerApiAttempts = 0;
  let playerApiTimer = null; // 確保同時只有一條重試鏈，避免多個入口堆疊
  const MAX_PLAYER_API_ATTEMPTS = 30; // 最多嘗試 30 次（30 秒）

  function tryGetPlayerAPI() {
    playerApiAttempts++;
    if (playerApiAttempts > MAX_PLAYER_API_ATTEMPTS) {
      console.log(LOG_PREFIX, '[Player API] 已達最大嘗試次數，停止偵測');
      return;
    }

    try {
      // 方式 A：透過 netflix.appContext
      const player = getActivePlayer();
      if (player) {
        // 首次成功取得 player 時，輸出所有字幕相關方法供偵錯
        if (playerApiAttempts <= 2) {
          try {
            const found = new Set();
            let proto = player;
            while (proto && proto !== Object.prototype) {
              Object.getOwnPropertyNames(proto).forEach(n => {
                if (!found.has(n) && typeof player[n] === 'function' &&
                    /(text|sub|caption|track|timed|select|setLang)/i.test(n)) {
                  found.add(n);
                }
              });
              proto = Object.getPrototypeOf(proto);
            }
            console.log(LOG_PREFIX, '[Player API] 字幕相關方法:', found.size ? [...found].join(', ') : '(無)');
          } catch (e) {}
        }
        const textTrackList = player.getTimedTextTrackList?.();
        if (textTrackList && textTrackList.length > 0) {
          // 先嘗試從 player 內部 manifest 取得含有 download URLs 的軌道資訊
          let manifestTracks = null;
          try {
            // 嘗試多個可能的路徑取得 manifest
            const manifest = player.getManifest?.() ||
                             player.getMovieManifest?.() ||
                             player.getPlaybackInfo?.();
            if (manifest && manifest.timedtexttracks) {
              manifestTracks = {};
              manifest.timedtexttracks.forEach(mt => {
                const key = mt.bcp47 || mt.language;
                if (key) manifestTracks[key] = mt;
              });
            }
          } catch (e) {}

          const tracks = textTrackList.filter(t => !isOffTrack(t) && !isForcedTrack(t)).map(t => {
            const lang = t.bcp47 || t.language || '';
            let downloadUrls = [];

            // 優先使用 manifest 中的 download URLs
            if (manifestTracks && manifestTracks[lang] && manifestTracks[lang].ttDownloadables) {
              downloadUrls = extractDownloadUrls(manifestTracks[lang].ttDownloadables);
            }
            // 其次使用 track 本身的
            if (downloadUrls.length === 0 && t.ttDownloadables) {
              downloadUrls = extractDownloadUrls(t.ttDownloadables);
            }

            return {
              language: t.language || t.bcp47 || '',
              bcp47: lang,
              displayName: t.displayName || t.languageDescription || t.language || '',
              trackType: t.trackType || 'SUBTITLES',
              isForced: t.isForced || false,
              rawTrackType: t.rawTrackType || '',
              downloadUrls: downloadUrls,
              trackId: t.trackId || ''
            };
          }).filter(t => !t.isForced && t.language);

          if (tracks.length > 0) {
            console.log(LOG_PREFIX, `[Player API] 發現 ${tracks.length} 個字幕軌道`);
            // 輸出每個軌道的 download URL 數量以利偵錯
            tracks.forEach(t => {
              console.log(LOG_PREFIX, `  - ${t.displayName} (${t.bcp47}): ${t.downloadUrls.length} 個下載連結`);
            });
            postToContentScript('SUBTITLE_TRACKS_FOUND', { tracks });
            return; // 成功，停止重試
          }
        }
      }
    } catch (e) {
      // Player API 可能尚未就緒
    }

    // 方式 B：嘗試從 DOM 中的 React 內部狀態取得
    try {
      const playerContainer = document.querySelector('.watch-video--player-view') ||
                               document.querySelector('[data-uia="player"]');
      if (playerContainer) {
        // 嘗試尋找 React fiber
        const fiberKey = Object.keys(playerContainer).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        if (fiberKey) {
          let fiber = playerContainer[fiberKey];
          let attempts = 0;
          while (fiber && attempts < 50) {
            if (fiber.memoizedProps?.manifest?.timedtexttracks) {
              const tracks = extractSubtitleTracks({ timedtexttracks: fiber.memoizedProps.manifest.timedtexttracks });
              if (tracks && tracks.length > 0) {
                console.log(LOG_PREFIX, `[React Fiber] 發現 ${tracks.length} 個字幕軌道`);
                postToContentScript('SUBTITLE_TRACKS_FOUND', { tracks });
                return;
              }
            }
            // 往上遍歷
            fiber = fiber.return;
            attempts++;
          }
        }
      }
    } catch (e) {
      // 靜默
    }

    // 尚未成功，繼續重試（單一計時器，避免重複入口造成多條並行重試鏈）
    if (playerApiTimer) clearTimeout(playerApiTimer);
    playerApiTimer = setTimeout(tryGetPlayerAPI, 1000);
  }

  function extractDownloadUrls(ttDownloadables) {
    const urls = [];
    try {
      Object.keys(ttDownloadables).forEach(format => {
        const dl = ttDownloadables[format];
        if (dl && dl.downloadUrls) {
          Object.values(dl.downloadUrls).forEach(url => {
            if (typeof url === 'string') urls.push({ format, url });
          });
        }
        if (dl && dl.urls) {
          (Array.isArray(dl.urls) ? dl.urls : Object.values(dl.urls)).forEach(u => {
            const s = typeof u === 'string' ? u : u.url;
            if (s) urls.push({ format, url: s });
          });
        }
      });
    } catch (e) {}
    return urls;
  }

  // ==================== 方法 4：監聽 Netflix 的 cadmium player 事件 ====================

  // 有些版本的 Netflix player 會廣播事件
  function setupPlayerEventListener() {
    try {
      // 監聽 Netflix player 的 API 變化
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1 && (node.tagName === 'VIDEO' || node.querySelector?.('video'))) {
              console.log(LOG_PREFIX, '[DOM] 偵測到影片元素，嘗試取得 Player API...');
              // 稍等片刻讓 Netflix player 完全初始化
              setTimeout(tryGetPlayerAPI, 2000);
            }
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }

  // ==================== 主動請求字幕 ====================

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'nf-dual-sub-content') return;

    if (event.data.type === 'FETCH_SUBTITLE') {
      const { url, language } = event.data.data;
      console.log(LOG_PREFIX, `正在請求 ${language} 字幕:`, url.substring(0, 120));

      // 使用原始 fetch 避免再次觸發攔截
      originalFetch(url)
        .then(response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        })
        .then(text => {
          console.log(LOG_PREFIX, `${language} 字幕已下載 (${text.length} bytes)`);
          postToContentScript('SECOND_SUBTITLE_LOADED', {
            language: language,
            data: text,
            url: url
          });
        })
        .catch(error => {
          console.error(LOG_PREFIX, `請求 ${language} 字幕失敗:`, error);
          postToContentScript('SECOND_SUBTITLE_ERROR', {
            language: language,
            error: error.message
          });
        });
    }

    if (event.data.type === 'RETRY_PLAYER_API') {
      playerApiAttempts = 0;
      tryGetPlayerAPI();
    }

    // 當 track 沒有 downloadUrls 時，透過 Player API 的 manifest 搜尋
    if (event.data.type === 'FETCH_SUBTITLE_VIA_PLAYER') {
      const { language } = event.data.data;
      console.log(LOG_PREFIX, `[Player API] 嘗試透過 manifest 取得 ${language} 字幕...`);

      try {
        const player = getActivePlayer();

        if (player) {
          // 嘗試多種方式取得 manifest
          let manifest = null;
          const methods = ['getManifest', 'getMovieManifest', 'getPlaybackInfo'];
          for (const method of methods) {
            try {
              if (typeof player[method] === 'function') {
                manifest = player[method]();
                if (manifest && manifest.timedtexttracks) break;
                manifest = null;
              }
            } catch (e) {}
          }

          // 也嘗試遍歷 player 的屬性找到 manifest
          if (!manifest) {
            try {
              for (const key of Object.keys(player)) {
                const val = player[key];
                if (val && typeof val === 'object' && val.timedtexttracks) {
                  manifest = val;
                  break;
                }
              }
            } catch (e) {}
          }

          if (manifest && manifest.timedtexttracks) {
            const matchingTrack = manifest.timedtexttracks.find(t =>
              (t.bcp47 === language || t.language === language) &&
              !isForcedTrack(t) && !isOffTrack(t)
            );

            if (matchingTrack && matchingTrack.ttDownloadables) {
              const urls = extractDownloadUrls(matchingTrack.ttDownloadables);
              if (urls.length > 0) {
                console.log(LOG_PREFIX, `[Player API] 找到 ${language} 的 ${urls.length} 個下載連結`);
                const bestUrl = urls[0].url;
                originalFetch(bestUrl)
                  .then(r => r.text())
                  .then(text => {
                    console.log(LOG_PREFIX, `[Player API] ${language} 字幕已下載 (${text.length} bytes)`);
                    postToContentScript('SECOND_SUBTITLE_LOADED', {
                      language: language,
                      data: text,
                      url: bestUrl
                    });
                  })
                  .catch(err => {
                    console.error(LOG_PREFIX, `[Player API] 下載失敗:`, err);
                    postToContentScript('SECOND_SUBTITLE_ERROR', { language, error: err.message });
                  });
                return;
              }
            }
          }
        }
        console.log(LOG_PREFIX, `[Player API] manifest 無 ${language} 下載連結，嘗試主動切換...`);

        // 最後手段：嘗試透過切換字幕軌道來觸發 Netflix 下載該語言的字幕
        // 下載完成後會被 XHR 攔截器捕捉並快取
        let switchSucceeded = false;
        try {
          if (player) {
            const tList = player.getTimedTextTrackList?.() || [];
            const targetTrack = tList.find(t =>
              (t.bcp47 === language || t.language === language) &&
              !isOffTrack(t) && !isForcedTrack(t)
            );
            if (targetTrack) {
              // 記住原本的軌道
              let origTrack = null;
              try { origTrack = player.getTimedTextTrack?.() || player.getCurrentTimedTextTrack?.(); } catch (e) {}

              const switchMethods = [
                'setTimedTextTrack', 'selectTimedTextTrack', 'changeTimedTextTrack',
                'setTextTrack', 'selectTextTrack', 'changeTextTrack',
                'setSubtitleTrack', 'switchTimedTextTrack', 'setTrack', 'selectTrack'
              ];
              for (const m of switchMethods) {
                if (typeof player[m] !== 'function') continue;
                // 嘗試傳入 track 物件
                for (const arg of [targetTrack, targetTrack.trackId, targetTrack.bcp47].filter(Boolean)) {
                  try {
                    player[m](arg);
                    switchSucceeded = true;
                    console.log(LOG_PREFIX, `[Player API] 透過 ${m} 切換至 ${language}，等待 XHR 攔截...`);

                    // 可重複呼叫的還原函式：攔截器抓到目標語言後立即還原，2 秒為安全逾時
                    let restored = false;
                    const restore = () => {
                      if (restored) return;
                      restored = true;
                      pendingSwitchRestore = null;
                      pendingSwitchLanguage = null;
                      try { if (origTrack) player[m](origTrack); } catch (e) {}
                      postToContentScript('SUBTITLE_SWITCH_DONE', { language });
                    };
                    pendingSwitchRestore = restore;
                    pendingSwitchLanguage = language;
                    setTimeout(restore, 2000);
                    break;
                  } catch (e) {}
                }
                if (switchSucceeded) break;
              }
            }
          }
        } catch (e) {}

        if (!switchSucceeded) {
          console.log(LOG_PREFIX, `[Player API] 無法主動切換至 ${language}，等待 XHR 被動攔截字幕...`);
          // 不發送錯誤：XHR 攔截器會在 Netflix 下載字幕時自動捕捉
        }
      } catch (e) {
        console.error(LOG_PREFIX, '[Player API] 錯誤:', e);
        postToContentScript('SECOND_SUBTITLE_ERROR', { language, error: e.message });
      }
    }
  });

  // ==================== 啟動 ====================

  setupPlayerEventListener();

  // 頁面載入一段時間後也嘗試 Player API
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(tryGetPlayerAPI, 3000);
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      setTimeout(tryGetPlayerAPI, 3000);
    });
  }

  console.log(LOG_PREFIX, '攔截腳本已載入（v2 - 多重偵測策略）');
})();
