// Luogu AI Analyzer - Background Service Worker
// 处理 GLM API 请求，绕过 CORS 限制
// 监听 SPA 路由变化，自动注入 content script

const DEFAULT_GLM_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

// ==================== 获取存储的配置 ====================
async function getConfig() {
  try {
    const result = await chrome.storage.sync.get('lgAiConfig');
    return result.lgAiConfig || {};
  } catch (e) {
    return {};
  }
}

// ==================== SPA 路由监听 & 自动注入 ====================

/**
 * 检查 URL 是否是洛谷提交记录页面
 * 洛谷提交记录 URL 格式：https://www.luogu.com.cn/record/{id}
 */
function isLuoguRecordPage(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'www.luogu.com.cn') return false;
    const pathname = u.pathname;
    // 提交记录详情页：/record/{id}
    if (/\/record\/\d+/.test(pathname)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * 向指定 tab 注入 content script
 */
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    console.log('[Luogu AI] content.js 注入成功, tab:', tabId);

    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content.css']
      });
      console.log('[Luogu AI] content.css 注入成功, tab:', tabId);
    } catch (cssErr) {
      console.log('[Luogu AI] CSS 注入跳过（可能已存在）:', cssErr.message);
    }
  } catch (err) {
    console.error('[Luogu AI] 注入 content script 失败:', err.message);
  }
}

/**
 * 获取注入标记 key
 */
function getInjectionKey(tabId, url) {
  return `lg_injected_${tabId}_${url}`;
}

/**
 * 设置注入标记（防止重复注入）
 */
async function markInjected(tabId, url) {
  try {
    await chrome.storage.session.set({ [getInjectionKey(tabId, url)]: true });
  } catch (e) {
    // storage.session 可能不可用，忽略
  }
}

/**
 * 检查是否已注入
 */
async function isAlreadyInjected(tabId, url) {
  try {
    const result = await chrome.storage.session.get(getInjectionKey(tabId, url));
    return !!result[getInjectionKey(tabId, url)];
  } catch (e) {
    return false;
  }
}

// 监听 SPA 路由变化（history.pushState / replaceState）
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  const { tabId, url, frameId } = details;

  // 只处理主框架
  if (frameId !== 0) return;

  if (!isLuoguRecordPage(url)) return;

  // 检查是否已注入
  if (await isAlreadyInjected(tabId, url)) return;

  console.log('[Luogu AI] 检测到提交记录页面导航，主动注入, URL:', url);
  await markInjected(tabId, url);
  await injectContentScript(tabId);
});

// 监听页面完成加载（处理直接打开/刷新的情况）
chrome.webNavigation.onCompleted.addListener(async (details) => {
  const { tabId, url, frameId } = details;

  if (frameId !== 0) return;
  if (!isLuoguRecordPage(url)) return;

  // manifest 中的 content_scripts 会自动加载
  await markInjected(tabId, url);
});

// 清理已关闭 tab 的注入标记
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const data = await chrome.storage.session.get(null);
    const keysToRemove = Object.keys(data).filter(k => k.startsWith(`lg_injected_${tabId}_`));
    if (keysToRemove.length > 0) {
      await chrome.storage.session.remove(keysToRemove);
    }
  } catch (e) {
    // 忽略
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GLM_API_REQUEST') {
    handleGLMRequest(message.payload)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GLM_API_STREAM') {
    // 根据配置决定是流式还是非流式
    getConfig().then(config => {
      if (config.streamOutput === false) {
        // 非流式模式：调用普通请求，完成后发送 DONE 消息
        handleGLMRequest(message.payload)
          .then(content => {
            chrome.tabs.sendMessage(sender.tab.id, {
              type: 'GLM_STREAM_DONE',
              fullContent: content
            }).catch(() => {});
          })
          .catch(err => {
            chrome.tabs.sendMessage(sender.tab.id, {
              type: 'GLM_STREAM_ERROR',
              error: err.message
            }).catch(() => {});
          });
      } else {
        handleGLMStream(message.payload, sender.tab.id);
      }
    });
    return true;
  }

  if (message.type === 'FETCH_PROBLEM_DESC') {
    console.log('[Luogu AI] 收到获取题目信息请求，pid:', message.pid);
    // 也给页面发送一条日志，方便调试
    if (sender.tab?.id) {
      chrome.tabs.sendMessage(sender.tab.id, {
        type: 'DEBUG_LOG',
        message: `background 收到 FETCH_PROBLEM_DESC，pid: ${message.pid}`
      }).catch(() => {/* 忽略错误 */});
    }
    
    fetchProblemDescription(message.pid, sender.tab?.id)
      .then(data => {
        // 检查是否真的成功（标题不等于 pid，且内容不为空）
        const isRealSuccess = data.title !== message.pid && data.content && data.content.length > 0;
        
        console.log('[Luogu AI] 获取题目信息完成，状态:', isRealSuccess ? '真实成功' : '兜底返回', '数据:', {
          title: data.title,
          difficulty: data.difficulty,
          contentLen: data.content?.length || 0,
          tagsLen: data.tags?.length || 0
        });
        
        // 发送完成日志到页面
        if (sender.tab?.id) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'DEBUG_LOG',
            message: `background 获取题目信息${isRealSuccess ? '成功' : '失败（使用兜底数据）'}，标题: ${data.title}，内容长度: ${data.content?.length || 0}`
          }).catch(() => {/* 忽略错误 */});
        }
        
        // 返回数据，添加 metadata 标记是否为真实数据
        sendResponse({ 
          success: true, 
          data,
          metadata: {
            isRealData: isRealSuccess,
            source: isRealSuccess ? 'api' : 'fallback'
          }
        });
      })
      .catch(err => {
        console.error('[Luogu AI] 获取题目信息异常:', err.message, 'pid:', message.pid);
        // 发送失败日志到页面
        if (sender.tab?.id) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'DEBUG_LOG',
            message: `background 获取题目信息异常: ${err.message} (pid: ${message.pid})`
          }).catch(() => {/* 忽略错误 */});
        }
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'FETCH_LUOGU_RECORD') {
    fetchLuoguRecord(message.recordId)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'LG_RELOAD') {
    // content script 请求重新注入（context 失效后的自修复尝试）
    const tabId = sender.tab?.id;
    if (tabId) {
      console.log('[Luogu AI] 收到重新注入请求, tab:', tabId);
      injectContentScript(tabId)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
    } else {
      sendResponse({ success: false, error: '无法获取 tab ID' });
    }
    return true;
  }

  // 获取配置
  if (message.type === 'GET_CONFIG') {
    getConfig()
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 分析完成通知
  if (message.type === 'SHOW_NOTIFICATION') {
    showAnalysisNotification(message.title, message.body);
    return false;
  }

  // 保存分析历史
  if (message.type === 'SAVE_HISTORY') {
    saveAnalysisHistory(message.record)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 读取历史记录
  if (message.type === 'GET_HISTORY') {
    getAnalysisHistory()
      .then(list => sendResponse({ success: true, data: list }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 清空历史记录
  if (message.type === 'CLEAR_HISTORY') {
    chrome.storage.local.remove('lgAiHistory')
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

/**
 * 调用 GLM-4-Flash API（非流式）
 */
async function handleGLMRequest(payload) {
  const config = await getConfig();
  const apiKey = config.apiKey || '';
  const apiUrl = config.apiUrl || DEFAULT_GLM_API_URL;
  const model = config.modelName || config.model || 'glm-4.7-flash';
  const { messages, temperature = 0.7 } = payload;

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model,
      messages,
      stream: false,
      temperature
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 请求失败: ${response.status} - ${errorText}`);
  }

  const result = await response.json();

  if (!result.choices || result.choices.length === 0) {
    throw new Error('API 返回数据格式异常');
  }

  return result.choices[0].message.content;
}

/**
 * 流式调用 GLM API - 真正实时推送
 */
async function handleGLMStream(payload, tabId) {
  const config = await getConfig();
  const apiKey = config.apiKey || '';
  const apiUrl = config.apiUrl || DEFAULT_GLM_API_URL;
  const model = config.modelName || config.model || 'glm-4.7-flash';
  const { messages, temperature = 0.7 } = payload;

  try {
    console.log('[Luogu AI] 开始流式请求，模型:', model, 'URL:', apiUrl);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages,
        stream: true,
        temperature
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 请求失败: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留不完整的最后一行

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        if (trimmedLine === 'data: [DONE]') continue;

        if (trimmedLine.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmedLine.slice(6));
            const delta = data.choices?.[0]?.delta?.content;

            if (delta && delta.length > 0) {
              fullContent += delta;

              try {
                chrome.tabs.sendMessage(tabId, {
                  type: 'GLM_STREAM_DATA',
                  chunk: delta,
                  fullContent: fullContent
                }).catch(() => {});
              } catch (e) {
                return;
              }
            }
          } catch (e) {
            console.log('[Luogu AI] 解析流式数据行失败:', trimmedLine.substring(0, 50));
          }
        }
      }
    }

    // 处理缓冲区中剩余的数据
    if (buffer.trim()) {
      const trimmedLine = buffer.trim();
      if (trimmedLine.startsWith('data: ') && trimmedLine !== 'data: [DONE]') {
        try {
          const data = JSON.parse(trimmedLine.slice(6));
          const delta = data.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
          }
        } catch (e) {}
      }
    }

    console.log('[Luogu AI] 流式输出完成，总长度:', fullContent.length);

    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'GLM_STREAM_DONE',
        fullContent: fullContent
      });
    } catch (e) {
      console.log('[Luogu AI] 发送完成消息失败');
    }

  } catch (error) {
    console.error('[Luogu AI] 流式请求失败:', error);
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'GLM_STREAM_ERROR',
        error: error.message
      });
    } catch (e) {}
  }
}

/**
 * 发送系统通知（分析完成提示）
 */
function showAnalysisNotification(title, body) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: title || '✨ AI 分析完成',
      message: body || '代码分析已完成，点击查看结果',
      priority: 1
    });
  } catch (e) {
    console.log('[Luogu AI] 发送通知失败:', e.message);
  }
}

/**
 * 保存分析历史到 local storage
 * 最多保留 50 条，超出时删除最旧的
 */
async function saveAnalysisHistory(record) {
  try {
    const result = await chrome.storage.local.get('lgAiHistory');
    const history = result.lgAiHistory || [];
    history.unshift(record);
    if (history.length > 50) history.splice(50);
    await chrome.storage.local.set({ lgAiHistory: history });
  } catch (e) {
    console.error('[Luogu AI] 保存历史失败:', e);
    throw e;
  }
}

/**
 * 读取历史记录
 */
async function getAnalysisHistory() {
  try {
    const result = await chrome.storage.local.get('lgAiHistory');
    return result.lgAiHistory || [];
  } catch (e) {
    return [];
  }
}

/**
 * 获取洛谷题目描述
 * 固定使用策略2（x-lentille-request: content-only）
 * 注意：content.js 已改为直接 fetch，此函数仅作备用
 */
async function fetchProblemDescription(pid, tabId) {
  function sendDebug(msg) {
    console.log('[Luogu AI]', msg);
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'DEBUG_LOG', message: msg }).catch(() => {});
    }
  }

  try {
    sendDebug(`background 获取洛谷题目信息: ${pid}`);

    const response = await fetch(
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

    const ct = response.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      throw new Error('题目 API 返回了 HTML');
    }

    const data = await response.json();
    const problem = data?.currentData?.problem;

    if (!problem) throw new Error('题目数据为空');

    const difficultyMap = {
      0: '暂无评定', 1: '入门', 2: '普及−', 3: '普及/提高−',
      4: '普及+/提高', 5: '提高+/省选−', 6: '省选/NOI−', 7: 'NOI/NOI+/CTSC'
    };

    const content = problem.content || '';
    const cleanContent = (typeof content === 'string' ? content : '')
      .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .trim().slice(0, 800);

    return {
      pid,
      title: problem.title || pid,
      difficulty: difficultyMap[problem.difficulty] || '未知',
      content: cleanContent,
      tags: (problem.tags || []).map(t => typeof t === 'object' ? (t.name || String(t)) : String(t))
    };
  } catch (e) {
    console.error('[Luogu AI] 获取题目信息异常:', e.message, 'pid:', pid);
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'DEBUG_LOG',
        message: `获取题目信息异常: ${e.message}`
      }).catch(() => {});
    }
    return { pid, title: pid, difficulty: '未知', content: '', tags: [] };
  }
}

/**
 * 获取洛谷提交记录详情
 * 固定使用策略2（x-lentille-request: content-only）
 * 注意：content.js 已改为直接 fetch，此函数仅作备用
 */
async function fetchLuoguRecord(recordId) {
  // 策略1：?_contentOnly=1 参数
  try {
    const response = await fetch(
      `https://www.luogu.com.cn/record/${recordId}?_contentOnly=1`,
      { credentials: 'include' }
    );
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
      const data = await response.json();
      const record = data?.currentData?.record || data?.data?.record;
      if (record) {
        console.log('[Luogu AI] [fetchLuoguRecord] 策略1成功');
        return record;
      }
    }
  } catch (e) {
    console.warn('[Luogu AI] [fetchLuoguRecord] 策略1失败:', e.message);
  }

  // 策略2：x-lentille-request header
  try {
    const response = await fetch(
      `https://www.luogu.com.cn/record/${recordId}`,
      {
        credentials: 'include',
        headers: {
          'x-lentille-request': 'content-only',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://www.luogu.com.cn/record/list'
        }
      }
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const record = data?.currentData?.record || data?.data?.record;
    if (record) {
      console.log('[Luogu AI] [fetchLuoguRecord] 策略2成功');
      return record;
    }
    throw new Error('无 record 字段');
  } catch (e) {
    console.error('[Luogu AI] fetchLuoguRecord 异常:', e.message);
    throw e;
  }
}
