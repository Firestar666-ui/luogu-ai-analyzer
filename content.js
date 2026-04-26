// Luogu AI Analyzer - Content Script
// 在洛谷提交记录页面注入 AI 分析功能

(function () {
  'use strict';

  // ==================== 全局控制器（跨实例共享） ====================
  // 所有 IIFE 实例共享同一个控制器，确保只有一个实例有效
  const CTRL = window.__LG_AI_CTRL = window.__LG_AI_CTRL || {
    instanceId: 0,
    routeCheckInterval: null,
    mutationObserver: null,
    pushStateInstalled: false,
    // 销毁所有资源（供新实例调用，清理旧实例）
    destroy() {
      if (this.routeCheckInterval) {
        clearInterval(this.routeCheckInterval);
        this.routeCheckInterval = null;
      }
      if (this.mutationObserver) {
        this.mutationObserver.disconnect();
        this.mutationObserver = null;
      }
      // 清理旧按钮和面板
      const oldBtn = document.getElementById('lg-ai-analyze-btn');
      if (oldBtn) oldBtn.remove();
      const oldPanel = document.getElementById('lg-ai-panel');
      if (oldPanel) oldPanel.remove();
    }
  };

  // 当前实例的 ID
  const myInstanceId = ++CTRL.instanceId;

  // 清理旧实例的所有资源
  CTRL.destroy();

  // ==================== 洛谷语言 ID 映射表 ====================
  const LUOGU_LANGUAGE_MAP = {
    2:  'C++17',
    3:  'C++14',
    4:  'C++11',
    5:  'C++',
    6:  'Pascal',
    7:  'C',
    8:  'Python3',
    9:  'PyPy3',
    10: 'Pascal(PascalABC)',
    11: 'R',
    12: 'Java 8',
    13: 'Node.js',
    14: 'Ruby',
    15: 'Go',
    16: 'Rust',
    17: 'PHP',
    18: 'C# Mono',
    19: 'Visual Basic Mono',
    20: 'Haskell',
    21: 'Kotlin/JVM',
    22: 'Scala',
    23: 'Perl',
    24: 'Python2',
    25: 'C++17 (Clang)',
    26: 'C++14 (Clang)',
    27: 'C++11 (Clang)',
    28: 'C++ (Clang)',
    29: 'C (Clang)',
    30: 'Brainfuck',
    31: 'Whitespace',
    32: 'Tcl/Tk',
    33: 'Text',
    34: 'Free Pascal',
    35: 'Lua',
    36: 'OCaml',
    37: 'Swift'
  };

  /**
   * 将洛谷语言 ID 映射为可读语言名称
   */
  function mapLuoguLanguageId(langId) {
    return LUOGU_LANGUAGE_MAP[langId] || `Language(${langId})`;
  }

  // ==================== Context 有效性检测 ====================

  function isContextValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  /**
   * 安全的 chrome.runtime.sendMessage 封装
   * 返回 Promise，context 失效时 reject
   */
  function safeSendMessage(message) {
    return new Promise((resolve, reject) => {
      if (!isContextValid()) {
        reject(new Error('EXT_CONTEXT_INVALID'));
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  // ==================== 状态管理 ====================
  let analyzerState = {
    isAnalyzing: false,
    result: null,
    activeTab: 'method',
    buttonInjected: false,
    panelInjected: false,
    streamContent: '', // 流式输出累积内容
    apiLanguage: null, // 从 API 获取的语言名称
    apiProblemPid: null // 从 API 获取的题目 PID（如 P1001）
  };

  // 全局变量用于路由检测
  let lastUrl = location.href;
  let lastRecordId = null;

  // ==================== 工具函数 ====================

  /**
   * 从 URL 中提取洛谷记录 ID
   * 洛谷提交记录页 URL 格式：https://www.luogu.com.cn/record/12345678
   */
  function getLuoguRecordId() {
    const match = window.location.pathname.match(/\/record\/(\d+)/);
    return match ? match[1] : null;
  }

  /**
   * 检查是否在洛谷提交记录详情页
   */
  function isLuoguRecordPage() {
    const pathname = location.pathname;
    // 提交记录详情页：/record/{id}
    if (/\/record\/\d+/.test(pathname)) return true;
    return false;
  }

  /**
   * 在 content script 上下文中直接获取洛谷提交记录
   * ⚠️ 必须在 content script 里发请求，而不是走 background 代理：
   *    background（Service Worker）发出的 fetch 没有用户登录 Cookie，
   *    洛谷返回的 JSON 中 record 为空，导致无法获取代码。
   *    content script 的 fetch 在页面上下文中执行，能携带完整的登录状态。
   */
  /**
   * 获取提交的代码
   * 通过 background script 代理请求
   */
  async function fetchSubmittedCode() {
    const recordId = getLuoguRecordId();
    if (!recordId) {
      return null;
    }

    let record = null;

    // 方案1：background + ?_contentOnly=1 参数
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'FETCH_LUOGU_RECORD',
        recordId: recordId
      });
      if (resp?.success && resp?.data) {
        record = resp.data;
      }
    } catch (e) {
      console.warn('[Luogu AI] 方案1 fetch 失败:', e.message);
    }

    // 方案2：content script 直接 fetch（绕过 background）
    if (!record) {
      try {
        const resp = await fetch(
          `https://www.luogu.com.cn/record/${recordId}`,
          { credentials: 'include' }
        );
        if (resp.ok) {
          const contentType = resp.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const data = await resp.json();
            record = data?.currentData?.record || data?.data?.record;
          }
        }
      } catch (e) {
        console.warn('[Luogu AI] 方案2 fetch 失败:', e.message);
      }
    }

    if (!record) {
      console.error('[Luogu AI] 获取提交记录失败: 两个方案均无法获取 record');
      return null;
    }

    const sourceCode = record.sourceCode || record.code || null;
    if (!sourceCode) {
      console.error('[Luogu AI] 获取提交记录成功但无代码字段');
      return null;
    }

    const langId = record.language;
    const langName = mapLuoguLanguageId(langId);
    analyzerState.apiLanguage = langName;

    const pid = record.problem?.pid || null;
    if (pid) {
      analyzerState.apiProblemPid = pid;
    }

    console.log('[Luogu AI] 代码获取成功，长度:', sourceCode.length, '| 语言:', langName, '| 题目:', pid || '未知');

    // 构建运行结果对象
    const runResult = {
      time: record.time != null ? record.time : null,
      memory: record.memory != null ? record.memory : null,
      score: record.score != null ? record.score : null
    };

    console.log('[Luogu AI] 运行结果：',
      '时间:', runResult.time != null ? runResult.time + 'ms' : '未知',
      '| 内存:', runResult.memory != null ? runResult.memory + 'KB' : '未知',
      '| 得分:', runResult.score != null ? runResult.score : '未知'
    );

    return {
      code: sourceCode,
      runResult,
      pid
    };
  }

  /**
   * 获取编程语言（优先使用 API 返回值）
   */
  function getLanguage() {
    if (analyzerState.apiLanguage) {
      return analyzerState.apiLanguage;
    }
    // Fallback：尝试从页面 DOM 获取（精度较低）
    const langEl = document.querySelector('.lang-name, .language-tag, [class*="language"]');
    if (langEl && langEl.textContent.trim()) return langEl.textContent.trim();
    return 'C++';
  }

  /**
   * 获取题目 PID（优先使用 API 返回值）
   */
  function getProblemPid() {
    return analyzerState.apiProblemPid || null;
  }

  /**
   * 在 content script 上下文中直接获取洛谷题目信息
   * ⚠️ 必须在 content script 里发请求，而不是走 background 代理：
   *    background（Service Worker）发出的 fetch 会被洛谷服务端识别，
   *    返回的 JSON 中 currentData 为 false，无法获取题目数据。
   *    content script 的 fetch 在页面上下文中执行，能携带完整的
   *    浏览器 Cookie/UA，洛谷才会返回带 currentData.problem 的完整 JSON。
   */
  async function fetchProblemInfoDirect(pid) {
    const difficultyMap = {
      0: '暂无评定', 1: '入门', 2: '普及−', 3: '普及/提高−',
      4: '普及+/提高', 5: '提高+/省选−', 6: '省选/NOI−', 7: 'NOI/NOI+/CTSC'
    };

    // 辅助函数：将洛谷 problem 对象转换为分析所需的格式
    function buildProblemInfo(pid, problem) {
      let rawContent = problem.content;
      // 如果 content 不是字符串，尝试转换（洛谷可能返回 RichText 对象）
      if (typeof rawContent !== 'string') {
        if (rawContent && typeof rawContent === 'object') {
          // 可能是洛谷的 RichText 对象：{ richText: "...", ... }
          rawContent = rawContent.richText || rawContent.text || rawContent.html || JSON.stringify(rawContent);
        } else {
          rawContent = '';
        }
      }
      const content = (rawContent || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim()
        .slice(0, 800);

      const tags = (problem.tags || []).map(t =>
        typeof t === 'object' ? (t.name || String(t)) : String(t)
      );

      return {
        pid,
        title: problem.title || pid,
        difficulty: difficultyMap[problem.difficulty] ?? '未知',
        content,
        tags
      };
    }

    // 固定使用策略2：x-lentille-request: content-only（策略1总是返回HTML，已弃用）
    let response;
    try {
      response = await fetch(
        `https://www.luogu.com.cn/problem/${pid}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: {
            'x-lentille-request': 'content-only',
            'Accept': 'application/json, text/plain, */*',
            'Referer': `https://www.luogu.com.cn/problem/${pid}`
          }
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (e) {
      console.warn('[Luogu AI] [题目fetch] 获取题目信息失败:', e.message);
      return null;
    }

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      console.warn('[Luogu AI] [题目fetch] JSON 解析失败:', parseErr.message);
      return null;
    }

    // 如果 data.data === false，说明无权限/未登录状态
    if (data.data === false) {
      if (data.currentData?.problem) {
        return buildProblemInfo(pid, data.currentData.problem);
      }
      return null;
    }

    // 优先尝试 data.data.problem（从日志看这是新结构）
    const problemViaData = data?.data?.problem;
    if (problemViaData) {
      return buildProblemInfo(pid, problemViaData);
    }

    // 尝试 data.data.currentData.problem（可能还存在这种结构）
    const problemViaCurrentData = data?.data?.currentData?.problem;
    if (problemViaCurrentData) {
      return buildProblemInfo(pid, problemViaCurrentData);
    }

    // 降级尝试旧结构 data.currentData.problem
    const problemViaOld = data?.currentData?.problem;
    if (problemViaOld) {
      return buildProblemInfo(pid, problemViaOld);
    }

    return null;
  }

  // ==================== AI 调用 ====================

  function buildPrompt(code, language, problemInfo, runResult) {
    const problemContext = problemInfo
      ? `题目编号：${problemInfo.pid || '未知'}
题目名称：${problemInfo.title}
难度：${problemInfo.difficulty}
相关标签：${problemInfo.tags?.join(', ') || '未知'}

题目描述：
${problemInfo.content || '（无详细描述）'}`
      : '（请根据代码内容自行判断题目类型）';

    // 构建运行结果描述
    let runContext = '';
    if (runResult) {
      const parts = [];
      if (runResult.time != null) {
        parts.push(`执行用时：${runResult.time} ms`);
      }
      if (runResult.memory != null) {
        parts.push(`内存消耗：${Math.round(runResult.memory / 1024 * 100) / 100} MB（${runResult.memory} KB）`);
      }
      if (runResult.score != null) {
        parts.push(`本次得分：${runResult.score} 分`);
      }
      if (parts.length > 0) {
        runContext = `\n本次提交运行结果：\n${parts.join('\n')}\n`;
      }
    }

    return `你是一位资深算法工程师，请对以下已在洛谷（Luogu）提交通过的代码进行深度分析。

${problemContext}
${runContext}
提交的代码（语言：${language}）：
\`\`\`${language}
${code}
\`\`\`

请严格按照以下 JSON 格式返回分析结果，不要包含任何其他文字，只返回 JSON：

{
  "celebration": "一句鼓励的话（20字以内，积极向上）",
  "method": {
    "current": ["当前使用的算法/方法标签，数组格式，例如：动态规划、哈希表"],
    "suggestion": "建议的更优解法（如果当前已是最优则说明即可，20字以内）",
    "core": "这道题的核心考察点（一句话，30字以内）"
  },
  "complexity": {
    "timeCurrentBig": "当前时间复杂度（数学符号形式，例如：O(n²)）",
    "spaceCurrentBig": "当前空间复杂度（数学符号形式）",
    "timeSuggestBig": "建议时间复杂度（如已最优则与当前相同）",
    "spaceSuggestBig": "建议空间复杂度（如已最优则与当前相同）",
    "tip": "效率优化建议（一句话，40字以内，如已最优则说明）"
  },
  "style": {
    "score": 85,
    "naming": "命名规范评价（一句话，30字以内）",
    "structure": "代码结构评价（一句话，30字以内）",
    "readability": "可读性评价（一句话，30字以内）",
    "suggestion": "总体风格建议（一句话，40字以内）"
  }
}`;
  }

  /**
   * 启动 AI 分析（根据配置自动选择流式/非流式）
   */
  function startStreamAnalysis(code, language, problemInfo, runResult, config) {
    const prompt = buildPrompt(code, language, problemInfo, runResult);
    const useStream = config?.streamOutput !== false;

    // 重置流式内容
    analyzerState.streamContent = '';

    if (useStream) {
      // 流式模式：显示流式输出区域
      showStreamOutput();
    }

    if (!isContextValid()) {
      showError('扩展已更新，请刷新页面后重试');
      analyzerState.isAnalyzing = false;
      return;
    }
    safeSendMessage({
      type: 'GLM_API_STREAM',
      payload: {
        messages: [
          {
            role: 'system',
            content: '你是一位专业的算法工程师和代码审查专家，专注于洛谷（Luogu）算法题目分析。你必须严格按照用户指定的 JSON 格式返回结果，不包含任何额外文字。'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7
      }
    }).catch(err => {
      console.error('[Luogu AI] 发送分析请求失败:', err);
      if (err.message === 'EXT_CONTEXT_INVALID') {
        showError('扩展已更新，请刷新页面后重试');
      } else {
        showError('发送分析请求失败: ' + err.message);
      }
      analyzerState.isAnalyzing = false;
    });
  }

  /**
   * 显示流式输出区域
   */
  function showStreamOutput() {
    const container = document.getElementById('lg-ai-tab-content');
    if (!container) return;

    container.innerHTML = `
      <div class="lc-ai-stream-container" id="lg-ai-stream-container">
        <div class="lc-ai-stream-header">
          <div class="lc-ai-stream-status">
            <span class="lc-ai-stream-dot"></span>
            <span class="lc-ai-stream-text">正在连接 AI...</span>
          </div>
        </div>
        <div class="lc-ai-stream-content" id="lg-ai-stream-content">
          <div class="lc-ai-stream-placeholder">
            <div class="lc-ai-loading-spinner"></div>
            <div>正在请求 AI 分析，请稍候...</div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * 更新流式输出内容 - 真正实时更新
   */
  function updateStreamContent(chunk, fullContent) {
    const container = document.getElementById('lg-ai-stream-content');
    const statusText = document.querySelector('.lc-ai-stream-text');
    if (!container) return;

    analyzerState.streamContent = fullContent;

    if (statusText && statusText.textContent === '正在连接 AI...') {
      statusText.textContent = 'AI 正在分析中...';
    }

    if (container.querySelector('.lc-ai-stream-placeholder')) {
      container.innerHTML = '';
    }

    let parsedData = null;
    try {
      parsedData = parseAIResponse(fullContent);
    } catch (e) {
      // 还不能完整解析，显示原始文本
    }

    if (parsedData) {
      container.innerHTML = renderStreamPreview(parsedData);
    } else {
      container.innerHTML = `<pre class="lc-ai-stream-raw">${escapeHtml(fullContent)}<span class="lc-ai-cursor">▋</span></pre>`;
    }

    container.scrollTop = container.scrollHeight;
  }

  /**
   * 渲染流式预览（部分数据）
   */
  function renderStreamPreview(data) {
    let html = '<div class="lc-ai-stream-preview">';

    if (data.celebration) {
      html += `<div class="lc-ai-stream-section">
        <div class="lc-ai-stream-section-title">🎉 鼓励</div>
        <div class="lc-ai-stream-section-content">${escapeHtml(data.celebration)}</div>
      </div>`;
    }

    if (data.method) {
      html += `<div class="lc-ai-stream-section">
        <div class="lc-ai-stream-section-title">🐾 方法</div>
        <div class="lc-ai-stream-section-content">`;
      if (data.method.current) {
        const current = Array.isArray(data.method.current) ? data.method.current.join(', ') : data.method.current;
        html += `<div>当前: ${escapeHtml(current)}</div>`;
      }
      if (data.method.suggestion) {
        html += `<div>建议: ${escapeHtml(data.method.suggestion)}</div>`;
      }
      html += `</div></div>`;
    }

    if (data.complexity) {
      html += `<div class="lc-ai-stream-section">
        <div class="lc-ai-stream-section-title">⚡ 复杂度</div>
        <div class="lc-ai-stream-section-content">`;
      if (data.complexity.timeCurrentBig) {
        html += `<div>时间: ${escapeHtml(data.complexity.timeCurrentBig)}</div>`;
      }
      if (data.complexity.spaceCurrentBig) {
        html += `<div>空间: ${escapeHtml(data.complexity.spaceCurrentBig)}</div>`;
      }
      html += `</div></div>`;
    }

    if (data.style) {
      html += `<div class="lc-ai-stream-section">
        <div class="lc-ai-stream-section-title">🎨 代码风格</div>
        <div class="lc-ai-stream-section-content">`;
      if (data.style.score) {
        html += `<div>评分: ${data.style.score}/100</div>`;
      }
      if (data.style.suggestion) {
        html += `<div>${escapeHtml(data.style.suggestion)}</div>`;
      }
      html += `</div></div>`;
    }

    html += '</div>';
    return html;
  }

  /**
   * 完成流式输出
   */
  function finishStreamOutput(fullContent) {
    const statusText = document.querySelector('.lc-ai-stream-text');
    const statusDot = document.querySelector('.lc-ai-stream-dot');

    if (statusText) statusText.textContent = '分析完成';
    if (statusDot) statusDot.classList.add('done');

    try {
      const result = parseAIResponse(fullContent);
      analyzerState.result = result;

      // 更新庆祝语
      const celebrationText = document.getElementById('lg-ai-celebration-text');
      if (celebrationText && result.celebration) {
        celebrationText.textContent = result.celebration;
      }

      // 延迟后切换到正常 Tab 视图
      setTimeout(() => {
        analyzerState.activeTab = 'method';
        const panel = document.getElementById('lg-ai-panel');
        if (panel) {
          panel.querySelectorAll('.lc-ai-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === 'method');
          });
        }
        renderTabContent(result, 'method');
      }, 1500);

      // 读取配置，按开关触发通知与历史记录
      safeSendMessage({ type: 'GET_CONFIG' }).then(resp => {
        const config = resp?.data || {};
        const problemTitle = analyzerState.apiProblemPid || '未知题目';

        // 分析完成通知
        if (config.showNotification !== false) {
          safeSendMessage({
            type: 'SHOW_NOTIFICATION',
            title: '✨ AI 分析完成',
            body: `「${problemTitle}」代码分析已完成，点击面板查看结果`
          }).catch(() => {});
        }

        // 保存历史记录
        if (config.saveHistory !== false) {
          const record = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            problemPid: problemTitle,
            language: analyzerState.apiLanguage || '未知',
            result: result
          };
          safeSendMessage({ type: 'SAVE_HISTORY', record }).catch(() => {});
        }
      }).catch(() => {
        // 读取配置失败时，默认执行通知和历史
        safeSendMessage({
          type: 'SHOW_NOTIFICATION',
          title: '✨ AI 分析完成',
          body: '代码分析已完成，点击面板查看结果'
        }).catch(() => {});
        const record = {
          id: Date.now(),
          timestamp: new Date().toISOString(),
          problemPid: analyzerState.apiProblemPid || '未知题目',
          language: analyzerState.apiLanguage || '未知',
          result: result
        };
        safeSendMessage({ type: 'SAVE_HISTORY', record }).catch(() => {});
      });

    } catch (error) {
      showError('解析分析结果失败: ' + error.message);
    }

    analyzerState.isAnalyzing = false;
  }

  /**
   * 处理流式错误
   */
  function handleStreamError(error) {
    const statusText = document.querySelector('.lc-ai-stream-text');
    if (statusText) {
      statusText.textContent = '分析失败';
      statusText.style.color = '#ef4444';
    }
    showError(error);
    analyzerState.isAnalyzing = false;
  }

  /**
   * HTML 转义
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * 解析 AI 返回的 JSON
   */
  function parseAIResponse(rawText) {
    try {
      return JSON.parse(rawText);
    } catch (e) {
      const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[1]);
        } catch (e2) {}
      }

      const braceMatch = rawText.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        try {
          return JSON.parse(braceMatch[0]);
        } catch (e3) {}
      }

      throw new Error('无法解析 AI 返回的 JSON 格式');
    }
  }

  // ==================== UI 注入 ====================

  /**
   * 清理旧元素
   */
  function cleanupOldElements() {
    const oldBtn = document.getElementById('lg-ai-analyze-btn');
    const oldPanel = document.getElementById('lg-ai-panel');
    if (oldBtn) {
      oldBtn.remove();
    }
    if (oldPanel) {
      oldPanel.remove();
    }
    analyzerState.buttonInjected = false;
    analyzerState.panelInjected = false;
    analyzerState.result = null;
    analyzerState.streamContent = '';
    analyzerState.apiLanguage = null;
    analyzerState.apiProblemPid = null;
  }

  /**
   * 注入分析按钮 - 固定在页面底部右侧，只显示图标
   */
  function injectAnalyzeButton() {
    if (analyzerState.buttonInjected) return;
    if (document.getElementById('lg-ai-analyze-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'lg-ai-analyze-btn';
    btn.className = 'lc-ai-btn';
    btn.innerHTML = `<span class="lc-ai-btn-icon">✨</span>`;
    btn.title = '洛谷 AI 分析';
    btn.addEventListener('click', handleAnalyzeClick);

    btn.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 9999;
      width: 44px;
      height: 44px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: linear-gradient(135deg, #7c3aed, #6d28d9);
      color: #fff;
      border: none;
      cursor: pointer;
      box-shadow: 0 3px 12px rgba(124, 58, 237, 0.45);
      transition: all 0.25s ease;
      font-size: 18px;
    `;

    document.body.appendChild(btn);
    analyzerState.buttonInjected = true;
  }

  /**
   * 创建分析面板
   */
  function createAnalysisPanel() {
    const existing = document.getElementById('lg-ai-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'lg-ai-panel';
    panel.className = 'lc-ai-panel';
    panel.innerHTML = `
      <div class="lc-ai-panel-inner">
        <div class="lc-ai-celebration" id="lg-ai-celebration">
          <span class="lc-ai-celebration-emoji">🎉</span>
          <span class="lc-ai-celebration-text" id="lg-ai-celebration-text">分析中...</span>
          <button class="lc-ai-close-btn" id="lg-ai-close-btn" title="关闭">✕</button>
        </div>
        <div class="lc-ai-tabs">
          <button class="lc-ai-tab active" data-tab="method">
            <span class="tab-icon">🐾</span> 方法
          </button>
          <button class="lc-ai-tab" data-tab="complexity">
            <span class="tab-icon">⚡</span> 运行效率
          </button>
          <button class="lc-ai-tab" data-tab="style">
            <span class="tab-icon">🎨</span> 代码风格
          </button>
        </div>
        <div class="lc-ai-tab-content" id="lg-ai-tab-content">
          <div class="lc-ai-loading" id="lg-ai-loading">
            <div class="lc-ai-loading-dots">
              <span></span><span></span><span></span>
            </div>
            <p>AI 正在分析你的代码...</p>
            <p class="lc-ai-loading-sub">获取题目信息 · 分析算法 · 评估效率</p>
          </div>
        </div>
      </div>
    `;

    panel.querySelectorAll('.lc-ai-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        panel.querySelectorAll('.lc-ai-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        analyzerState.activeTab = tab.dataset.tab;
        if (analyzerState.result) {
          renderTabContent(analyzerState.result, analyzerState.activeTab);
        }
      });
    });

    const closeBtn = panel.querySelector('#lg-ai-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        panel.style.display = 'none';
        analyzerState.panelInjected = false;
      });
    }

    return panel;
  }

  function renderTabContent(data, tab) {
    const container = document.getElementById('lg-ai-tab-content');
    if (!container) return;

    const loading = document.getElementById('lg-ai-loading');
    if (loading) loading.remove();

    container.innerHTML = '';

    switch (tab) {
      case 'method':
        container.innerHTML = renderMethodTab(data.method);
        break;
      case 'complexity':
        container.innerHTML = renderComplexityTab(data.complexity);
        break;
      case 'style':
        container.innerHTML = renderStyleTab(data.style);
        break;
    }
  }

  function renderMethodTab(method) {
    if (!method) return '<div class="lc-ai-error">数据解析失败</div>';

    const currentTags = Array.isArray(method.current)
      ? method.current.map(tag => `<span class="lc-ai-tag">${tag}</span>`).join('')
      : `<span class="lc-ai-tag">${method.current}</span>`;

    return `
      <div class="lc-ai-section">
        <div class="lc-ai-row">
          <span class="lc-ai-label">当前</span>
          <div class="lc-ai-tags">${currentTags}</div>
        </div>
        <div class="lc-ai-divider"></div>
        <div class="lc-ai-row">
          <span class="lc-ai-label">建议</span>
          <span class="lc-ai-value lc-ai-suggest">${method.suggestion || '当前方法已是最优'}</span>
        </div>
        <div class="lc-ai-divider"></div>
        <div class="lc-ai-row">
          <span class="lc-ai-label">核心考察</span>
          <span class="lc-ai-value lc-ai-bold">${method.core || '—'}</span>
        </div>
      </div>
    `;
  }

  function renderComplexityTab(complexity) {
    if (!complexity) return '<div class="lc-ai-error">数据解析失败</div>';

    const isSameTime = complexity.timeCurrentBig === complexity.timeSuggestBig;
    const isSameSpace = complexity.spaceCurrentBig === complexity.spaceSuggestBig;

    return `
      <div class="lc-ai-section">
        <div class="lc-ai-complexity-grid">
          <div class="lc-ai-complexity-item">
            <div class="lc-ai-complexity-label">时间复杂度</div>
            <div class="lc-ai-complexity-current">${complexity.timeCurrentBig || 'O(?)'}</div>
            ${!isSameTime ? `<div class="lc-ai-complexity-arrow">↓</div><div class="lc-ai-complexity-suggest">${complexity.timeSuggestBig}</div>` : '<div class="lc-ai-complexity-optimal">✓ 已最优</div>'}
          </div>
          <div class="lc-ai-complexity-divider"></div>
          <div class="lc-ai-complexity-item">
            <div class="lc-ai-complexity-label">空间复杂度</div>
            <div class="lc-ai-complexity-current">${complexity.spaceCurrentBig || 'O(?)'}</div>
            ${!isSameSpace ? `<div class="lc-ai-complexity-arrow">↓</div><div class="lc-ai-complexity-suggest">${complexity.spaceSuggestBig}</div>` : '<div class="lc-ai-complexity-optimal">✓ 已最优</div>'}
          </div>
        </div>
        <div class="lc-ai-divider"></div>
        <div class="lc-ai-row">
          <span class="lc-ai-label">优化建议</span>
          <span class="lc-ai-value">${complexity.tip || '当前效率已经很好'}</span>
        </div>
      </div>
    `;
  }

  function renderStyleTab(style) {
    if (!style) return '<div class="lc-ai-error">数据解析失败</div>';

    const score = style.score || 80;
    const scoreColor = score >= 90 ? '#22c55e' : score >= 75 ? '#a78bfa' : score >= 60 ? '#f59e0b' : '#ef4444';
    const circumference = 2 * Math.PI * 28;
    const offset = circumference * (1 - score / 100);

    return `
      <div class="lc-ai-section">
        <div class="lc-ai-style-header">
          <div class="lc-ai-score-circle">
            <svg width="72" height="72" viewBox="0 0 72 72">
              <circle cx="36" cy="36" r="28" fill="none" stroke="#2d2d3d" stroke-width="6"/>
              <circle cx="36" cy="36" r="28" fill="none" stroke="${scoreColor}" stroke-width="6"
                stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
                stroke-linecap="round" transform="rotate(-90 36 36)"/>
            </svg>
            <div class="lc-ai-score-num" style="color:${scoreColor}">${score}</div>
          </div>
          <div class="lc-ai-style-summary">
            <p>${style.suggestion || '代码风格总体良好'}</p>
          </div>
        </div>
        <div class="lc-ai-divider"></div>
        <div class="lc-ai-row">
          <span class="lc-ai-label">命名规范</span>
          <span class="lc-ai-value">${style.naming || '—'}</span>
        </div>
        <div class="lc-ai-divider"></div>
        <div class="lc-ai-row">
          <span class="lc-ai-label">代码结构</span>
          <span class="lc-ai-value">${style.structure || '—'}</span>
        </div>
        <div class="lc-ai-divider"></div>
        <div class="lc-ai-row">
          <span class="lc-ai-label">可读性</span>
          <span class="lc-ai-value">${style.readability || '—'}</span>
        </div>
      </div>
    `;
  }

  function showError(message) {
    const container = document.getElementById('lg-ai-tab-content');
    if (!container) return;

    container.innerHTML = `
      <div class="lc-ai-error-box">
        <div class="lc-ai-error-icon">⚠️</div>
        <div class="lc-ai-error-msg">${message}</div>
        <button class="lc-ai-retry-btn" onclick="document.getElementById('lg-ai-analyze-btn').click()">
          重试
        </button>
      </div>
    `;

    analyzerState.isAnalyzing = false;
  }

  // ==================== 主流程 ====================

  async function handleAnalyzeClick() {
    if (analyzerState.isAnalyzing) return;

    if (!isContextValid()) {
      showError('扩展已更新，请刷新页面后重试');
      return;
    }

    analyzerState.isAnalyzing = true;

    let panel = document.getElementById('lg-ai-panel');
    if (!panel) {
      panel = createAnalysisPanel();
      injectPanel(panel);
    } else {
      panel.style.display = 'block';
    }

    try {
      // 先读取配置，决定流式/非流式模式
      let config = {};
      try {
        const configResp = await safeSendMessage({ type: 'GET_CONFIG' });
        if (configResp?.success) config = configResp.data || {};
      } catch (e) {
        // 读取配置失败，使用默认（流式）
      }

      const useStream = config.streamOutput !== false;

      if (useStream) {
        showStreamOutput();
      }

      const language = getLanguage();
      const pid = getProblemPid();

      // 先获取代码（包含从 API 获取的 pid）
      const codeResult = await fetchSubmittedCode();
      const code = codeResult?.code || null;
      const runResult = codeResult?.runResult || null;
      const pidFromRecord = codeResult?.pid || null;

      // 直接在 content script 中获取题目信息（不走 background 代理）
      // 原因：background Service Worker 的 fetch 被洛谷识别，currentData 返回 false
      let problemInfo = null;
      if (pidFromRecord) {
        try {
          problemInfo = await fetchProblemInfoDirect(pidFromRecord);
        } catch (err) {
          console.warn('[Luogu AI] 获取题目信息异常:', err.message);
        }
      }

      if (!code || code.trim().length < 5) {
        throw new Error('无法获取提交代码，请确保已登录洛谷且在提交记录详情页');
      }

      if (problemInfo) {
        console.log('[Luogu AI] 题目：', problemInfo.title,
          '| 难度:', problemInfo.difficulty,
          '| 标签:', problemInfo.tags?.join(', ') || '无');
      }

      // 启动分析（传入配置）
      startStreamAnalysis(code, language, problemInfo, runResult, config);

    } catch (error) {
      console.error('[Luogu AI] 分析失败:', error);
      if (error.message === 'EXT_CONTEXT_INVALID') {
        showError('扩展已更新，请刷新页面后重试');
      } else {
        showError(error.message || '分析失败，请重试');
      }
      analyzerState.isAnalyzing = false;
    }
  }

  function injectPanel(panel) {
    // 洛谷提交记录页常见的容器选择器
    const containerSelectors = [
      '.am-container',
      '.lg-main-container',
      '[class*="record-info"]',
      '[class*="submission"]',
      'main',
      '#app'
    ];

    for (const sel of containerSelectors) {
      const target = document.querySelector(sel);
      if (target) {
        target.insertBefore(panel, target.firstChild);
        analyzerState.panelInjected = true;
        return;
      }
    }

    // 兜底：固定到左侧
    panel.style.cssText = `
      position: fixed;
      top: 60px;
      left: 0;
      width: 360px;
      max-height: calc(100vh - 80px);
      overflow-y: auto;
      z-index: 9998;
      border-radius: 0 12px 12px 0;
    `;
    document.body.appendChild(panel);
    analyzerState.panelInjected = true;
  }

  // ==================== 初始化与路由检测 ====================

  function init() {
    if (CTRL.instanceId !== myInstanceId) return;

    if (!isLuoguRecordPage()) return;

    injectAnalyzeButton();

    let attempts = 0;
    const maxAttempts = 10;

    const checkAndInject = () => {
      if (CTRL.instanceId !== myInstanceId) return;
      if (document.getElementById('lg-ai-analyze-btn')) return;

      attempts++;
      injectAnalyzeButton();

      if (attempts < maxAttempts && !document.getElementById('lg-ai-analyze-btn')) {
        setTimeout(checkAndInject, 1000);
      }
    };

    setTimeout(checkAndInject, 1000);
  }

  function handleUrlChange() {
    if (CTRL.instanceId !== myInstanceId) return;

    const currentUrl = location.href;
    const currentRecordId = getLuoguRecordId();

    const urlChanged = currentUrl !== lastUrl;
    const idChanged = currentRecordId !== lastRecordId;

    if (urlChanged || idChanged) {
      lastUrl = currentUrl;
      lastRecordId = currentRecordId;

      // 清理旧元素
      const oldBtn = document.getElementById('lg-ai-analyze-btn');
      if (oldBtn) oldBtn.remove();
      const oldPanel = document.getElementById('lg-ai-panel');
      if (oldPanel) oldPanel.remove();
      analyzerState.buttonInjected = false;
      analyzerState.panelInjected = false;
      analyzerState.result = null;
      analyzerState.streamContent = '';
      analyzerState.apiLanguage = null;
      analyzerState.apiProblemPid = null;

      if (isLuoguRecordPage()) {
        setTimeout(init, 300);
      }
    }
  }

  function setupRouteListener() {
    lastUrl = location.href;
    lastRecordId = getLuoguRecordId();

    // 覆盖 history.pushState（只安装一次）
    if (!CTRL.pushStateInstalled) {
      CTRL.pushStateInstalled = true;
      const originalPushState = history.pushState;
      history.pushState = function (...args) {
        originalPushState.apply(this, args);
        setTimeout(handleUrlChange, 100);
      };

      const originalReplaceState = history.replaceState;
      history.replaceState = function (...args) {
        originalReplaceState.apply(this, args);
        setTimeout(handleUrlChange, 100);
      };

      window.addEventListener('popstate', () => {
        setTimeout(handleUrlChange, 100);
      });
    }

    // URL 变化轮询（使用全局控制器，确保只有一个）
    if (CTRL.routeCheckInterval) {
      clearInterval(CTRL.routeCheckInterval);
    }
    CTRL.routeCheckInterval = setInterval(() => {
      handleUrlChange();
    }, 500);
  }

  function setupMutationObserver() {
    if (CTRL.mutationObserver) {
      CTRL.mutationObserver.disconnect();
    }

    CTRL.mutationObserver = new MutationObserver(() => {
      if (CTRL.instanceId !== myInstanceId) return;
      if (isLuoguRecordPage() && !document.getElementById('lg-ai-analyze-btn')) {
        analyzerState.buttonInjected = false;
        injectAnalyzeButton();
      }
    });

    CTRL.mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ==================== 监听来自 background 的消息 ====================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GLM_STREAM_DATA') {
      updateStreamContent(message.chunk, message.fullContent);
    } else if (message.type === 'GLM_STREAM_DONE') {
      finishStreamOutput(message.fullContent);
    } else if (message.type === 'GLM_STREAM_ERROR') {
      handleStreamError(message.error);
    } else if (message.type === 'LG_PING') {
      // background 用来检测 content script 是否存活
      sendResponse({ instanceId: myInstanceId });
    } else if (message.type === 'DEBUG_LOG') {
      // background 发出的调试日志
      console.log('[Luogu AI] [DEBUG]', message.message);
    }
  });

  // ==================== 启动 ====================

  setupRouteListener();
  setupMutationObserver();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
