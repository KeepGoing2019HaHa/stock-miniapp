const { formatTime } = require('../../utils/model');
const { WINDOWS, validTicker, validateDashboard, metrics, displayHistory, displayLessons } = require('../../utils/daily');

function initialData() {
  return {
    authed: false, ticker: 'NVDA', inputTicker: 'NVDA', tickers: [],
    windows: WINDOWS, window: 'all', loading: false, error: '', hasData: false,
    tracked: false, updatedLabel: '', metrics: [], counts: null, baseline: '—',
    mixedVersions: false, history: [], lessons: [], historyNext: null, lessonNext: null,
    historyBack: false, lessonBack: false
  };
}

Page({
  data: initialData(),

  onLoad() {
    this._alive = true;
    this._visible = false;
    this._epoch = 0;
    this.client = getApp().client;
    this._unsubscribe = this.client.subscribe(() => this.syncSession());
    this.syncSession();
  },

  onShow() {
    this._visible = true;
    if (this.client.isAuthenticated() !== this.data.authed) return this.syncSession();
    if (this.data.authed) return this.refresh();
  },

  onHide() {
    this._visible = false;
    this._epoch += 1;
    this._flight = null;
    this.setData({ loading: false });
  },

  onUnload() {
    this._alive = false;
    this._visible = false;
    this._epoch += 1;
    this._flight = null;
    if (this._unsubscribe) this._unsubscribe();
  },

  syncSession() {
    this._epoch += 1;
    this._flight = null;
    this._snapshot = null;
    this._catalog = null;
    this._historyCursors = [null];
    this._lessonCursors = [null];
    this.setData(Object.assign(initialData(), { authed: this.client.isAuthenticated() }));
    if (this.data.authed && this._visible) return this.refresh();
  },

  current(generation, epoch) {
    return this._alive && this._visible && this.data.authed &&
      this.client.getGeneration() === generation && this._epoch === epoch;
  },

  onGoLogin() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onInput(event) {
    this.setData({ inputTicker: event.detail.value });
  },

  onSearch() {
    return this.selectTicker(this.data.inputTicker.trim().toUpperCase());
  },

  onSelectTicker(event) {
    return this.selectTicker(event.currentTarget.dataset.ticker);
  },

  selectTicker(ticker) {
    if (!validTicker(ticker)) {
      this.setData({ error: '每日复盘只支持美股代码，例如 NVDA、MSFT、AAPL 或 BRK-B。' });
      return Promise.resolve();
    }
    this._epoch += 1;
    this._flight = null;
    this._snapshot = null;
    this._historyCursors = [null];
    this._lessonCursors = [null];
    this.setData({
      ticker, inputTicker: ticker, hasData: false, history: [], lessons: [],
      counts: null, metrics: [], error: '', historyNext: null, lessonNext: null,
      historyBack: false, lessonBack: false
    });
    return this.refresh();
  },

  refresh(historyCursors, lessonCursors) {
    if (!this.data.authed || !this._alive || !this._visible) return Promise.resolve();
    const history = historyCursors || this._historyCursors;
    const lessons = lessonCursors || this._lessonCursors;
    const ticker = this.data.ticker;
    const generation = this.client.getGeneration();
    const key = JSON.stringify([ticker, history, lessons, generation]);
    if (this._flight && this._flight.key === key) return this._flight.promise;
    const epoch = ++this._epoch;
    const flight = { key };
    this._flight = flight;
    this.setData({ loading: true, error: '' });
    flight.promise = (async () => {
      if (!this._catalog) {
        const catalog = await this.client.request('GET', '/api/daily');
        if (!this.current(generation, epoch)) return;
        if (!catalog || !Array.isArray(catalog.tickers) || !catalog.tickers.every(validTicker)) {
          throw new Error('每日跟踪股票列表不完整，请刷新重试。');
        }
        this._catalog = catalog.tickers;
        this.setData({ tickers: catalog.tickers });
      }
      const params = [];
      if (history[history.length - 1]) params.push(`before=${encodeURIComponent(history[history.length - 1])}`);
      if (lessons[lessons.length - 1]) params.push(`lesson_before=${lessons[lessons.length - 1]}`);
      const path = `/api/daily/${encodeURIComponent(ticker)}${params.length ? '?' + params.join('&') : ''}`;
      const response = await this.client.request('GET', path);
      if (!this.current(generation, epoch)) return;
      this._snapshot = validateDashboard(response, ticker);
      this._historyCursors = history;
      this._lessonCursors = lessons;
      this.setData(Object.assign(metrics(response.summary, this.data.window), {
        hasData: true, tracked: response.tracked, updatedLabel: formatTime(response.generated_at),
        history: displayHistory(response.history.items), lessons: displayLessons(response.lessons.items),
        historyNext: response.history.next_before, lessonNext: response.lessons.next_before,
        historyBack: history.length > 1, lessonBack: lessons.length > 1
      }));
    })().catch((error) => {
      if (this.current(generation, epoch)) this.setData({ error: error.message });
    }).finally(() => {
      if (this._flight === flight) this._flight = null;
      if (this.current(generation, epoch)) this.setData({ loading: false });
    });
    return flight.promise;
  },

  onWindow(event) {
    const window = event.currentTarget.dataset.key;
    if (!WINDOWS.some((item) => item.key === window)) return;
    this.setData(Object.assign({ window }, this._snapshot ? metrics(this._snapshot.summary, window) : {}));
  },

  onRefresh() {
    return this.refresh();
  },

  async onPullDownRefresh() {
    try { await this.refresh(); }
    finally { wx.stopPullDownRefresh(); }
  },

  onHistoryNext() {
    if (!this.data.loading && this.data.historyNext) {
      return this.refresh(this._historyCursors.concat(this.data.historyNext));
    }
  },

  onHistoryBack() {
    if (!this.data.loading && this._historyCursors.length > 1) {
      return this.refresh(this._historyCursors.slice(0, -1));
    }
  },

  onLessonNext() {
    if (!this.data.loading && this.data.lessonNext) {
      return this.refresh(null, this._lessonCursors.concat(this.data.lessonNext));
    }
  },

  onLessonBack() {
    if (!this.data.loading && this._lessonCursors.length > 1) {
      return this.refresh(null, this._lessonCursors.slice(0, -1));
    }
  },

  onToggleDay(event) {
    const id = Number(event.currentTarget.dataset.id);
    this.setData({ history: this.data.history.map((item) =>
      item.id === id ? Object.assign({}, item, { open: !item.open }) : item
    ) });
  }
});
