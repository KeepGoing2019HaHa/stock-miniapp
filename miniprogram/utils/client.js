const { uuidFromBytes } = require('./model');
const STORAGE_KEY = 'stock-miniapp.session.v1';

function clientError(message, kind, status) {
  const error = new Error(message);
  error.kind = kind;
  error.status = status || 0;
  return error;
}

function expiryTime(value) {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return typeof value === 'string' ? new Date(value).getTime() : NaN;
}

function createClient(platform, config) {
  let session = null;
  let generation = 0;
  let loginFlight = null;
  const listeners = [];
  try {
    const saved = platform.getStorageSync(STORAGE_KEY);
    if (saved && typeof saved.access_token === 'string' && saved.access_token &&
      expiryTime(saved.expires_at) > Date.now()) {
      session = saved;
    } else {
      platform.removeStorageSync(STORAGE_KEY);
    }
  } catch (_) {
    session = null;
    console.warn('[stock-miniapp] 无法读取或清理本地登录记录，已按未登录处理。请检查微信存储空间。');
  }

  function notify() {
    listeners.slice().forEach((listener) => listener());
  }

  function persist(next) {
    try {
      platform.setStorageSync(STORAGE_KEY, next);
    } catch (_) {
      throw clientError('无法保存登录或请求记录，请检查微信存储空间后重试。', 'storage');
    }
    session = next;
  }

  function clearSession() {
    session = null;
    generation += 1;
    // 即使本地删除失败，已撤销/过期的凭证也不会再被当前会话使用。
    try {
      platform.removeStorageSync(STORAGE_KEY);
    } catch (_) {
      console.warn('[stock-miniapp] 无法删除本地登录记录；当前会话已清除。请检查微信存储空间。');
    }
    notify();
  }

  function isAuthenticated() {
    if (session && expiryTime(session.expires_at) <= Date.now()) clearSession();
    return !!session;
  }

  function ensureCurrent(expected) {
    if (expected !== generation) throw clientError('登录状态已变更，请重新操作。', 'stale');
  }

  function requireSession() {
    if (!isAuthenticated()) throw clientError('登录已过期，请重新微信登录。', 'auth', 401);
  }

  function request(method, path, data, authenticated = true) {
    if (authenticated) {
      try { requireSession(); } catch (error) { return Promise.reject(error); }
    }
    const expected = generation;
    const base = config.API_BASE_URL.replace(/\/+$/, '');
    if (base === 'https://your-domain.example') {
      return Promise.reject(clientError('服务地址尚未配置，请联系维护者设置 config.js。', 'config'));
    }
    const header = { 'content-type': 'application/json' };
    if (authenticated) header.Authorization = `Bearer ${session.access_token}`;
    return new Promise((resolve, reject) => {
      platform.request({
        url: `${base}${path}`,
        method,
        data,
        header,
        timeout: config.REQUEST_TIMEOUT_MS,
        success(response) {
          try {
            ensureCurrent(expected);
            const status = response.statusCode;
            if (status >= 200 && status < 300) {
              resolve(response.data);
              return;
            }
            if (status === 401 && authenticated) {
              clearSession();
              reject(clientError('登录已过期，请重新微信登录。', 'auth', status));
              return;
            }
            const detail = response.data && response.data.detail;
            const fallback = status === 429 ? '请求频繁或今日额度已用完，请稍后再试。' :
              status === 503 ? '服务繁忙或尚未配置，请稍后重试。' : `请求未成功（${status}），请稍后重试。`;
            reject(clientError(typeof detail === 'string' ? detail : fallback, 'http', status));
          } catch (error) {
            reject(error);
          }
        },
        fail() {
          if (expected !== generation) {
            reject(clientError('登录状态已变更，请重新操作。', 'stale'));
          } else {
            reject(clientError('网络连接失败，无法确认服务器状态。请检查网络后重试。', 'network'));
          }
        }
      });
    });
  }

  function login() {
    if (loginFlight) return loginFlight;
    const expected = generation;
    const flight = new Promise((resolve, reject) => {
      platform.login({
        success(response) {
          if (response.code) resolve(response.code);
          else reject(clientError('微信未返回登录凭证，请重新尝试。', 'login'));
        },
        fail() { reject(clientError('微信登录失败，请稍后重试。', 'login')); }
      });
    }).then((code) => {
      ensureCurrent(expected);
      return request('POST', '/api/auth/wechat', { code }, false);
    }).then((response) => {
      ensureCurrent(expected);
      if (!response || typeof response.access_token !== 'string' || !response.access_token ||
        !(expiryTime(response.expires_at) > Date.now())) {
        throw clientError('登录响应不完整，请联系维护者。', 'protocol');
      }
      persist({
        access_token: response.access_token,
        expires_at: response.expires_at,
        selectedJobId: '',
        pendingSubmission: null
      });
      generation += 1;
      notify();
    });
    loginFlight = flight;
    const cleanup = () => { if (loginFlight === flight) loginFlight = null; };
    flight.then(cleanup, cleanup);
    return flight;
  }

  function getPending() {
    return session && session.pendingSubmission ?
      Object.assign({}, session.pendingSubmission) : null;
  }

  async function prepareSubmission(ticker, analysisDate) {
    requireSession();
    if (session.pendingSubmission) return getPending();
    const expected = generation;
    const requestId = await new Promise((resolve, reject) => {
      if (typeof platform.getRandomValues !== 'function') {
        reject(clientError('微信版本较旧，请升级后重试。', 'random'));
        return;
      }
      platform.getRandomValues({
        length: 16,
        success(response) {
          try { resolve(uuidFromBytes(new Uint8Array(response.randomValues))); }
          catch (_) { reject(clientError('无法生成请求编号，请重试。', 'random')); }
        },
        fail() { reject(clientError('无法生成请求编号，请重试。', 'random')); }
      });
    });
    ensureCurrent(expected);
    requireSession();
    if (session.pendingSubmission) return getPending();
    const pending = { ticker, analysis_date: analysisDate, request_id: requestId };
    persist(Object.assign({}, session, { pendingSubmission: pending }));
    return Object.assign({}, pending);
  }

  function setSelectedJobId(id) {
    requireSession();
    persist(Object.assign({}, session, { selectedJobId: id }));
  }

  function finishSubmission(id) {
    requireSession();
    persist(Object.assign({}, session, { selectedJobId: id, pendingSubmission: null }));
  }

  function clearPending() {
    requireSession();
    persist(Object.assign({}, session, { pendingSubmission: null }));
  }

  async function logout() {
    const expected = generation;
    await request('DELETE', '/api/session');
    ensureCurrent(expected);
    clearSession();
  }

  return {
    request, login, logout, isAuthenticated, prepareSubmission, getPending,
    setSelectedJobId, finishSubmission, clearPending,
    getSelectedJobId: () => session ? session.selectedJobId || '' : '',
    getGeneration: () => generation,
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }
  };
}

module.exports = { createClient, STORAGE_KEY };
