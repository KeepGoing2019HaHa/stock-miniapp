/* Unit-test platform doubles stay here; the application always uses wx.login. */
const assert = require('node:assert/strict');
const { createClient, STORAGE_KEY } = require('../utils/client');
const model = require('../utils/model');
const config = { API_BASE_URL: 'https://api.example.test/', REQUEST_TIMEOUT_MS: 20000 };
const tests = [];
const test = (name, run) => tests.push({ name, run });
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const savedSession = (extra) => Object.assign({
  access_token: 'opaque-unit-test-token',
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  selectedJobId: '', pendingSubmission: null
}, extra);
const quota = {
  daily_limit: 3, used_today: 0, remaining_today: 3, quota_date: '2026-09-28',
  analysis_date_max: '2026-09-28', timezone: 'Asia/Shanghai'
};
const job = (id, status = 'queued') => ({
  id, status, ticker: 'NVDA', analysis_date: '2026-09-28',
  created_at: '2026-09-28T03:00:00Z', error: null, result: null
});

function fakeWx(initial) {
  const store = {};
  if (initial) store[STORAGE_KEY] = clone(initial);
  const platform = {
    store, requests: [], loginCalls: 0, randomCalls: 0, failStorage: false,
    getStorageSync(key) { return clone(store[key]); },
    setStorageSync(key, value) {
      if (platform.failStorage) throw new Error('disk full');
      store[key] = clone(value);
    },
    removeStorageSync(key) { delete store[key]; },
    login(options) {
      platform.loginCalls += 1;
      options.success({ code: 'unit-test-sdk-code' });
    },
    getRandomValues(options) {
      platform.randomCalls += 1;
      options.success({ randomValues: new Uint8Array(16).fill(platform.randomCalls).buffer });
    },
    request(options) { platform.requests.push(Object.assign({ done: false }, options)); },
    stopPullDownRefresh() {},
    next(method, path) {
      const request = platform.requests.find((item) =>
        !item.done && item.method === method && item.url === config.API_BASE_URL.replace(/\/$/, '') + path);
      assert.ok(request, `Missing request ${method} ${path}`);
      return request;
    },
    respond(request, statusCode, data) {
      assert.equal(request.done, false);
      request.done = true;
      request.success({ statusCode, data });
    },
    fail(request) {
      assert.equal(request.done, false);
      request.done = true;
      request.fail({ errMsg: 'request:fail unit-test offline' });
    }
  };
  return platform;
}

let definition;
global.Page = (value) => { definition = value; };
require('../pages/index/index');
function mount(client, platform) {
  global.getApp = () => ({ client });
  global.wx = platform;
  const page = Object.assign({}, definition, {
    data: clone(definition.data),
    setData(values) { Object.assign(this.data, values); }
  });
  page.onLoad();
  return page;
}

test('UUID has version 4 and RFC variant without mutating the source', () => {
  const bytes = new Uint8Array(16).fill(255);
  const id = model.uuidFromBytes(bytes);
  assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(bytes[6], 255);
  assert.throws(() => model.uuidFromBytes(new Uint8Array(15)));
});

test('Dates validate calendar boundaries and server maximum', () => {
  assert.equal(model.validDate('2024-02-29'), true);
  assert.equal(model.validDate('2025-02-29'), false);
  assert.equal(model.validateForm('NVDA', '2026-09-28', '2026-09-28'), '');
  assert.equal(model.validateForm('0700.HK', '2026-09-28', '2026-09-28'), '');
  assert.equal(model.validateForm('600519.SS', '2026-09-28', '2026-09-28'), '');
  assert.notEqual(model.validateForm('NVDA', '2026-09-29', '2026-09-28'), '');
  assert.notEqual(model.validateForm('<script>', '2026-09-28', '2026-09-28'), '');
  assert.equal(model.formatTime('2026-09-28T18:00:00Z'), '2026-09-29 02:00');
});

test('Only definite rejection clears an uncertain request', () => {
  [400, 401, 403, 409, 422].forEach((status) => assert.ok(model.isDefiniteRejection({ status })));
  [0, 408, 425, 429, 500, 502, 503, 504].forEach((status) => assert.equal(model.isDefiniteRejection({ status }), false));
});

test('Real login flow exchanges only a wx.login code, then uses opaque bearer token', async () => {
  const platform = fakeWx();
  const client = createClient(platform, config);
  const first = client.login();
  const duplicate = client.login();
  assert.equal(first, duplicate);
  await tick();
  assert.equal(platform.loginCalls, 1);
  const exchange = platform.next('POST', '/api/auth/wechat');
  assert.deepEqual(exchange.data, { code: 'unit-test-sdk-code' });
  assert.equal(exchange.header.Authorization, undefined);
  platform.respond(exchange, 200, savedSession());
  await first;
  assert.ok(client.isAuthenticated());
  const me = client.request('GET', '/api/me');
  const request = platform.next('GET', '/api/me');
  assert.equal(request.header.Authorization, 'Bearer opaque-unit-test-token');
  platform.respond(request, 200, quota);
  assert.deepEqual(await me, quota);
});

test('Expired local credentials are never sent', async () => {
  const platform = fakeWx(savedSession({ expires_at: '2020-01-01T00:00:00Z' }));
  const client = createClient(platform, config);
  assert.equal(client.isAuthenticated(), false);
  await assert.rejects(client.request('GET', '/api/me'), (error) => error.kind === 'auth');
  assert.equal(platform.requests.length, 0);
  assert.equal(platform.store[STORAGE_KEY], undefined);
});

test('Initial storage read or cleanup failure logs a safe warning without credential data', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const brokenRead = fakeWx(savedSession());
    brokenRead.getStorageSync = () => { throw new Error('opaque-unit-test-token'); };
    assert.equal(createClient(brokenRead, config).isAuthenticated(), false);
    const brokenCleanup = fakeWx(savedSession({ expires_at: '2020-01-01T00:00:00Z' }));
    brokenCleanup.removeStorageSync = () => { throw new Error('opaque-unit-test-token'); };
    assert.equal(createClient(brokenCleanup, config).isAuthenticated(), false);
    assert.equal(warnings.length, 2);
    warnings.forEach((warning) => {
      assert.match(warning, /无法读取或清理本地登录记录/);
      assert.equal(warning.includes('opaque-unit-test-token'), false);
    });
  } finally {
    console.warn = originalWarn;
  }
});

test('Request ID is stored before POST, survives restart, and retries unchanged', async () => {
  const platform = fakeWx(savedSession());
  const client = createClient(platform, config);
  const first = await client.prepareSubmission('NVDA', '2026-09-28');
  assert.equal(platform.store[STORAGE_KEY].pendingSubmission.request_id, first.request_id);
  assert.equal(platform.requests.length, 0);
  const restored = createClient(platform, config);
  const retry = await restored.prepareSubmission('AAPL', '2026-09-27');
  assert.deepEqual(retry, first);
  assert.equal(platform.randomCalls, 1);
  restored.finishSubmission('accepted-job');
  assert.equal(restored.getPending(), null);
  assert.equal(createClient(platform, config).getSelectedJobId(), 'accepted-job');
});

test('Storage failure prevents a new submission from going to the server', async () => {
  const platform = fakeWx(savedSession());
  const client = createClient(platform, config);
  platform.failStorage = true;
  await assert.rejects(client.prepareSubmission('NVDA', '2026-09-28'), (error) => error.kind === 'storage');
  assert.equal(client.getPending(), null);
  assert.equal(platform.requests.length, 0);
});

test('Logout retains session after network failure and clears only after server confirmation', async () => {
  const platform = fakeWx(savedSession({ selectedJobId: 'private-job' }));
  const client = createClient(platform, config);
  const failed = client.logout();
  const assertion = assert.rejects(failed, (error) => error.kind === 'network');
  platform.fail(platform.next('DELETE', '/api/session'));
  await assertion;
  assert.ok(client.isAuthenticated());
  assert.equal(client.getSelectedJobId(), 'private-job');
  const success = client.logout();
  platform.respond(platform.next('DELETE', '/api/session'), 204, '');
  await success;
  assert.equal(client.isAuthenticated(), false);
  assert.equal(platform.store[STORAGE_KEY], undefined);
});

test('Storage deletion failure warns but does not prevent a server-revoked logout', async () => {
  const platform = fakeWx(savedSession({ selectedJobId: 'private-job' }));
  const client = createClient(platform, config);
  const page = mount(client, platform);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    platform.removeStorageSync = () => { throw new Error('opaque-unit-test-token'); };
    const logout = page.onLogout();
    platform.respond(platform.next('DELETE', '/api/session'), 204, '');
    await logout;
    assert.equal(client.isAuthenticated(), false);
    assert.equal(page.data.authed, false);
    assert.equal(page.data.selectedId, '');
    assert.equal(page.data.logoutError, '');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /无法删除本地登录记录/);
    assert.equal(warnings[0].includes('opaque-unit-test-token'), false);
  } finally {
    console.warn = originalWarn;
    page.onUnload();
  }
});

test('401 invalidates the current session and all pending old responses', async () => {
  const platform = fakeWx(savedSession());
  const client = createClient(platform, config);
  const first = client.request('GET', '/api/me');
  const second = client.request('GET', '/api/predictions');
  const firstAssertion = assert.rejects(first, (error) => error.kind === 'auth');
  const secondAssertion = assert.rejects(second, (error) => error.kind === 'stale');
  platform.respond(platform.next('GET', '/api/me'), 401, { detail: '登录过期' });
  platform.respond(platform.next('GET', '/api/predictions'), 200, { items: [job('old')] });
  await Promise.all([firstAssertion, secondAssertion]);
  assert.equal(client.isAuthenticated(), false);
});

test('Late prior-user 401 cannot revoke a newly logged-in session', async () => {
  const platform = fakeWx(savedSession());
  const client = createClient(platform, config);
  const stale = client.request('GET', '/api/me');
  const staleAssertion = assert.rejects(stale, (error) => error.kind === 'stale');
  const exit = client.logout();
  platform.respond(platform.next('DELETE', '/api/session'), 204, '');
  await exit;
  const login = client.login();
  await tick();
  platform.respond(platform.next('POST', '/api/auth/wechat'), 200, savedSession({ access_token: 'second-user-token' }));
  await login;
  platform.respond(platform.next('GET', '/api/me'), 401, {});
  await staleAssertion;
  assert.ok(client.isAuthenticated());
  assert.equal(platform.store[STORAGE_KEY].access_token, 'second-user-token');
});

test('Readable backend 422/429/503 errors are preserved', async () => {
  const platform = fakeWx(savedSession());
  const client = createClient(platform, config);
  for (const status of [422, 429, 503]) {
    const pending = client.request('POST', '/api/predictions', {});
    const assertion = assert.rejects(pending, (error) => error.status === status && error.message === '服务端中文提示');
    platform.respond(platform.next('POST', '/api/predictions'), status, { detail: '服务端中文提示' });
    await assertion;
  }
});

test('Hidden polling stops; onShow reuses in-flight work and always fetches selected detail', async () => {
  const platform = fakeWx(savedSession({ selectedJobId: 'saved-job' }));
  const client = createClient(platform, config);
  const page = mount(client, platform);
  page.onShow();
  page.onHide();
  page.onShow();
  assert.equal(platform.requests.length, 2);
  platform.respond(platform.next('GET', '/api/me'), 200, quota);
  platform.respond(platform.next('GET', '/api/predictions'), 200, { items: [job('saved-job')] });
  await tick();
  assert.equal(platform.requests.length, 3);
  page.onHide();
  platform.respond(platform.next('GET', '/api/predictions/saved-job'), 200, job('saved-job', 'running'));
  await tick();
  assert.equal(page.data.selected.status, 'running');
  assert.equal(page._pollTimer, null);
  page.onShow();
  page.onShow();
  assert.equal(platform.requests.length, 5);
  platform.respond(platform.next('GET', '/api/me'), 200, quota);
  platform.respond(platform.next('GET', '/api/predictions'), 200, { items: [job('saved-job', 'running')] });
  await tick();
  platform.respond(platform.next('GET', '/api/predictions/saved-job'), 200, job('saved-job', 'succeeded'));
  await tick();
  assert.equal(page.data.selected.status, 'succeeded');
  assert.equal(page._pollTimer, null);
  page.onUnload();
});

test('Task read errors retain server status, never pretend the task failed', async () => {
  const platform = fakeWx(savedSession({ selectedJobId: 'running-job' }));
  const client = createClient(platform, config);
  const page = mount(client, platform);
  page.setData({ selected: job('running-job', 'running') });
  const pending = page.loadSelected();
  platform.fail(platform.next('GET', '/api/predictions/running-job'));
  await pending;
  assert.equal(page.data.selected.status, 'running');
  assert.match(page.data.jobError, /不代表任务失败/);
  page.onUnload();
});

test('Uncertain POST then 429 then 200 keeps the same UUID and parameters despite quota changes', async () => {
  const platform = fakeWx(savedSession());
  const client = createClient(platform, config);
  const page = mount(client, platform);
  page._visible = true;
  page.setData({ me: quota, maxDate: quota.analysis_date_max, analysisDate: quota.analysis_date_max });
  const first = page.onSubmit();
  await tick();
  const request = platform.next('POST', '/api/predictions');
  const requestId = request.data.request_id;
  platform.fail(request);
  await first;
  assert.equal(page.data.pending.request_id, requestId);
  page.setData({ me: Object.assign({}, quota, { remaining_today: 0 }), hasActive: true });
  const retry = page.onSubmit();
  await tick();
  const retryRequest = platform.next('POST', '/api/predictions');
  assert.equal(retryRequest.data.request_id, requestId);
  platform.respond(retryRequest, 429, { detail: '请求过于频繁，请稍后重试' });
  await retry;
  assert.deepEqual(page.data.pending, request.data);
  assert.deepEqual(platform.store[STORAGE_KEY].pendingSubmission, request.data);
  assert.equal(page.data.submitError, '请求过于频繁，请稍后重试');
  page.setData({ me: Object.assign({}, quota, { used_today: 3, remaining_today: 0 }), hasActive: false });
  const finalRetry = page.onSubmit();
  await tick();
  const finalRequest = platform.next('POST', '/api/predictions');
  assert.deepEqual(finalRequest.data, request.data);
  assert.equal(platform.randomCalls, 1);
  platform.respond(finalRequest, 200, job('accepted-job'));
  await tick();
  platform.respond(platform.next('GET', '/api/me'), 200, quota);
  platform.respond(platform.next('GET', '/api/predictions'), 200, { items: [job('accepted-job')] });
  await tick();
  platform.respond(platform.next('GET', '/api/predictions/accepted-job'), 200, job('accepted-job'));
  await finalRetry;
  assert.equal(page.data.pending, null);
  assert.equal(client.getSelectedJobId(), 'accepted-job');
  page.onUnload();
});

test('Missing quota, exhausted quota and active task submission guards each show an explicit error', async () => {
  const platform = fakeWx(savedSession());
  const client = createClient(platform, config);
  const page = mount(client, platform);
  page.setData({ maxDate: quota.analysis_date_max, analysisDate: quota.analysis_date_max });
  const cases = [
    { me: null, hasActive: false, message: /尚未获取今日额度/ },
    { me: Object.assign({}, quota, { remaining_today: 0 }), hasActive: false, message: /今日研究额度已用完/ },
    { me: quota, hasActive: true, message: /已有排队或研究中的任务/ }
  ];
  for (const entry of cases) {
    page.setData({ me: entry.me, hasActive: entry.hasActive, submitError: '' });
    await page.onSubmit();
    assert.match(page.data.submitError, entry.message);
  }
  assert.equal(platform.requests.length, 0);
  assert.equal(platform.randomCalls, 0);
  assert.equal(client.getPending(), null);
  page.onUnload();
});

test('Definite submission rejection clears pending request for a new user action', async () => {
  const platform = fakeWx(savedSession());
  const client = createClient(platform, config);
  const page = mount(client, platform);
  page._visible = true;
  page.setData({ me: quota, maxDate: quota.analysis_date_max, analysisDate: quota.analysis_date_max });
  const first = page.onSubmit();
  await tick();
  platform.respond(platform.next('POST', '/api/predictions'), 422, { detail: '不支持该股票代码' });
  await first;
  assert.equal(client.getPending(), null);
  assert.equal(page.data.pending, null);
  assert.equal(page.data.submitError, '不支持该股票代码');
  platform.respond(platform.next('GET', '/api/me'), 200, quota);
  platform.respond(platform.next('GET', '/api/predictions'), 200, { items: [] });
  await tick();
  page.onUnload();
});

test('Selecting A, B, then A reuses A request and only paints the final selection', async () => {
  const platform = fakeWx(savedSession());
  const client = createClient(platform, config);
  const page = mount(client, platform);
  const choose = (id) => page.onSelectJob({ currentTarget: { dataset: { id } } });
  const a = choose('A');
  const b = choose('B');
  const aAgain = choose('A');
  assert.equal(platform.requests.length, 2);
  platform.respond(platform.next('GET', '/api/predictions/B'), 200, job('B'));
  await b;
  assert.equal(page.data.selected, null);
  platform.respond(platform.next('GET', '/api/predictions/A'), 200, job('A', 'succeeded'));
  await Promise.all([a, aAgain]);
  assert.equal(page.data.selected.id, 'A');
  page.onUnload();
});

test('Hiding during overview prevents a follow-on detail request until onShow', async () => {
  const platform = fakeWx(savedSession({ selectedJobId: 'saved-job' }));
  const client = createClient(platform, config);
  const page = mount(client, platform);
  page.onShow();
  page.onHide();
  platform.respond(platform.next('GET', '/api/me'), 200, quota);
  platform.respond(platform.next('GET', '/api/predictions'), 200, { items: [job('saved-job')] });
  await tick();
  assert.equal(platform.requests.length, 2);
  assert.equal(page._pollTimer, null);
  page.onShow();
  platform.respond(platform.next('GET', '/api/me'), 200, quota);
  platform.respond(platform.next('GET', '/api/predictions'), 200, { items: [job('saved-job')] });
  await tick();
  platform.respond(platform.next('GET', '/api/predictions/saved-job'), 200, job('saved-job'));
  await tick();
  assert.ok(page._pollTimer);
  page.onUnload();
  assert.equal(page._pollTimer, null);
});

test('Failure to persist an accepted POST retains the original retry identifier', async () => {
  const platform = fakeWx(savedSession());
  const client = createClient(platform, config);
  const page = mount(client, platform);
  page.setData({ me: quota, maxDate: quota.analysis_date_max, analysisDate: quota.analysis_date_max });
  const submission = page.onSubmit();
  await tick();
  const request = platform.next('POST', '/api/predictions');
  const id = request.data.request_id;
  platform.failStorage = true;
  platform.respond(request, 202, job('accepted-job'));
  await submission;
  assert.equal(page.data.pending.request_id, id);
  assert.equal(platform.store[STORAGE_KEY].pendingSubmission.request_id, id);
  assert.match(page.data.submitError, /保存/);
  page.onUnload();
});

test('An old pending draft is never carried into a new login session', async () => {
  const platform = fakeWx(savedSession());
  const client = createClient(platform, config);
  await client.prepareSubmission('NVDA', '2026-09-28');
  client.setSelectedJobId('private-job');
  const logout = client.logout();
  platform.respond(platform.next('DELETE', '/api/session'), 204, '');
  await logout;
  const login = client.login();
  await tick();
  platform.respond(platform.next('POST', '/api/auth/wechat'), 200, savedSession({ access_token: 'new-user-token' }));
  await login;
  assert.equal(client.getPending(), null);
  assert.equal(client.getSelectedJobId(), '');
});

test('Logout clears prior-user UI and stale detail cannot repopulate it', async () => {
  const platform = fakeWx(savedSession({ selectedJobId: 'private-job' }));
  const client = createClient(platform, config);
  const page = mount(client, platform);
  const detail = page.loadSelected();
  const logout = page.onLogout();
  platform.respond(platform.next('DELETE', '/api/session'), 204, '');
  await logout;
  platform.respond(platform.next('GET', '/api/predictions/private-job'), 200, job('private-job'));
  await detail;
  assert.equal(page.data.authed, false);
  assert.equal(page.data.selected, null);
  assert.deepEqual(page.data.history, []);
  page.onUnload();
});

test('History stays summary-only and large reports have a single displayed copy across selections', async () => {
  const platform = fakeWx(savedSession({ selectedJobId: 'A' }));
  const client = createClient(platform, config);
  const page = mount(client, platform);
  const setData = page.setData.bind(page);
  page.setData = (values) => {
    assert.ok(Buffer.byteLength(JSON.stringify(values)) < 1024 * 1024, 'setData payload exceeds 1MB');
    setData(values);
  };
  const completed = (id) => Object.assign(job(id, 'succeeded'), {
    result: {
      rating: 'Hold', final_decision: `${id} 综合观点`, disclaimer: '仅供参考',
      reports: { market: `${id}-MARKET-${'x'.repeat(380000)}`, news: `${id}-NEWS-${'y'.repeat(380000)}` }
    }
  });
  const a = completed('A');
  const b = completed('B');
  page.onShow();
  platform.respond(platform.next('GET', '/api/me'), 200, quota);
  platform.respond(platform.next('GET', '/api/predictions'), 200, { items: [a, b] });
  await tick();
  assert.ok(page.data.history.every((item) => !Object.prototype.hasOwnProperty.call(item, 'result')));
  platform.respond(platform.next('GET', '/api/predictions/A'), 200, a);
  await tick();
  assert.equal(page.data.sections[0].body, a.result.reports.market);
  assert.equal(page.data.sections[1].body, a.result.reports.news);
  assert.deepEqual(page.data.selected.result, {
    rating: 'Hold', final_decision: 'A 综合观点', disclaimer: '仅供参考'
  });
  assert.ok(page.data.history.every((item) => !Object.prototype.hasOwnProperty.call(item, 'result')));
  assert.equal(JSON.stringify(page.data).split('A-MARKET-').length - 1, 1);
  page.onToggleReport({ currentTarget: { dataset: { key: 'market' } } });
  assert.equal(page.data.sections[0].open, true);
  const selection = page.onSelectJob({ currentTarget: { dataset: { id: 'B' } } });
  platform.respond(platform.next('GET', '/api/predictions/B'), 200, b);
  await selection;
  assert.equal(page.data.sections[0].body, b.result.reports.market);
  assert.equal(page.data.sections[1].body, b.result.reports.news);
  assert.equal(page.data.selected.result.final_decision, 'B 综合观点');
  assert.ok(page.data.history.every((item) => !Object.prototype.hasOwnProperty.call(item, 'result')));
  const state = JSON.stringify(page.data);
  assert.equal(state.includes('A-MARKET-'), false);
  assert.equal(state.split('B-MARKET-').length - 1, 1);
  assert.ok(Buffer.byteLength(state) < 1024 * 1024);
  assert.ok(a.result.reports && b.result.reports, 'original API objects must not be mutated');
  page.onUnload();
});

test('Reports remain literal text and unsupported ratings require review', () => {
  const untrusted = '<script>alert(1)</script>\n**plain markdown**';
  assert.equal(model.reportSections({ reports: { news: untrusted } })[0].body, untrusted);
  assert.equal(model.ratingLabel('REVIEW'), '需人工复核');
  assert.equal(model.ratingLabel('unexpected'), '需人工复核');
});

async function main() {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      console.log(`PASS ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${entry.name}\n${error.stack}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
