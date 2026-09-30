const config = require('../../config');
const {
  isActive, displayJob, displaySummary, reportSections, ratingLabel,
  validateForm, isDefiniteRejection, validDate
} = require('../../utils/model');

function initialData() {
  return {
    authed: false, consent: false, loggingIn: false, loggingOut: false,
    refreshing: false, submitting: false, jobLoading: false,
    authError: '', pageError: '', jobError: '', submitError: '', logoutError: '',
    ticker: 'NVDA', analysisDate: '', maxDate: '', me: null,
    history: [], selectedId: '', selected: null, hasActive: false,
    pending: null, sections: [], rating: ''
  };
}

Page({
  data: initialData(),

  onLoad() {
    this._alive = true;
    this._visible = false;
    this._details = {};
    this._selectionEpoch = 0;
    this.client = getApp().client;
    this._unsubscribe = this.client.subscribe(() => this.syncSession());
    this.syncSession();
  },

  onShow() {
    this._visible = true;
    if (this.client && this.client.isAuthenticated()) this.refreshAll();
  },

  onHide() {
    this._visible = false;
    this.stopPolling();
  },

  onUnload() {
    this._alive = false;
    this._visible = false;
    this.stopPolling();
    if (this._unsubscribe) this._unsubscribe();
  },

  syncSession() {
    const previouslyAuthed = this.data.authed;
    this.stopPolling();
    this._selectionEpoch += 1;
    const authed = this.client.isAuthenticated();
    const pending = this.client.getPending();
    this.setData(Object.assign(initialData(), {
      authed,
      pending,
      selectedId: this.client.getSelectedJobId(),
      ticker: pending ? pending.ticker : 'NVDA',
      analysisDate: pending ? pending.analysis_date : '',
      authError: previouslyAuthed && !authed ? '当前登录已结束，请重新微信登录。' : ''
    }));
    if (authed && this._visible) this.refreshAll();
  },

  isCurrent(generation) {
    return this._alive && generation === this.client.getGeneration() && this.data.authed;
  },

  onConsent(event) {
    this.setData({ consent: event.detail.value.indexOf('agree') >= 0, authError: '' });
  },

  async onLogin() {
    if (this.data.loggingIn) return;
    if (!this.data.consent) {
      this.setData({ authError: '请先阅读并同意下方登录与研究提示。' });
      return;
    }
    const generation = this.client.getGeneration();
    this.setData({ loggingIn: true, authError: '' });
    try {
      await this.client.login();
    } catch (error) {
      if (this._alive && generation === this.client.getGeneration()) {
        this.setData({ authError: error.message });
      }
    } finally {
      if (this._alive && generation === this.client.getGeneration()) {
        this.setData({ loggingIn: false });
      }
    }
  },

  onTicker(event) {
    if (!this.data.pending) this.setData({ ticker: event.detail.value, submitError: '' });
  },

  onDate(event) {
    if (!this.data.pending) this.setData({ analysisDate: event.detail.value, submitError: '' });
  },

  onExample(event) {
    if (!this.data.pending && !this.data.submitting) {
      this.setData({ ticker: event.currentTarget.dataset.ticker, submitError: '' });
    }
  },

  updateActivity() {
    this.setData({
      hasActive: this.data.history.some(isActive) || isActive(this.data.selected)
    });
  },

  refreshAll() {
    if (!this.data.authed || !this._alive || !this._visible) return Promise.resolve();
    const generation = this.client.getGeneration();
    if (this._refreshFlight && this._refreshFlight.generation === generation) {
      return this._refreshFlight.promise;
    }
    this.stopPolling();
    this.setData({ refreshing: true });
    const flight = { generation };
    this._refreshFlight = flight;
    flight.promise = (async () => {
      const errors = [];
      await Promise.all([
        this.client.request('GET', '/api/me').then((me) => {
          if (!this.isCurrent(generation)) return;
          if (!me || !validDate(me.analysis_date_max) ||
            !Number.isFinite(me.remaining_today) || !Number.isFinite(me.used_today) ||
            !Number.isFinite(me.daily_limit)) {
            throw new Error('额度响应不完整，请刷新重试。');
          }
          this.setData({
            me,
            maxDate: me.analysis_date_max,
            analysisDate: this.data.analysisDate || me.analysis_date_max
          });
        }).catch((error) => errors.push(error.message)),
        this.client.request('GET', '/api/predictions').then((response) => {
          if (!this.isCurrent(generation)) return;
          if (!response || !Array.isArray(response.items)) {
            throw new Error('任务列表响应不完整，请刷新重试。');
          }
          const history = response.items.slice(0, 20).map(displaySummary);
          this.setData({ history });
          if (!this.data.selectedId && history.length) {
            const active = history.find(isActive);
            const id = (active || history[0]).id;
            this.client.setSelectedJobId(id);
            this._selectionEpoch += 1;
            this.setData({ selectedId: id });
          }
          this.updateActivity();
        }).catch((error) => errors.push(error.message))
      ]);
      if (!this.isCurrent(generation)) return;
      this.setData({ pageError: errors.length ? errors.join(' ') : '' });
      if (this.data.selectedId && this._visible) await this.loadSelected();
    })().catch((error) => {
      if (this.isCurrent(generation)) this.setData({ pageError: error.message });
    }).finally(() => {
      if (this._refreshFlight === flight) this._refreshFlight = null;
      if (this.isCurrent(generation)) {
        this.setData({ refreshing: false });
        this.schedulePolling();
      }
    });
    return flight.promise;
  },

  async onPullDownRefresh() {
    try { await this.refreshAll(); }
    finally { wx.stopPullDownRefresh(); }
  },

  onRefresh() {
    return this.refreshAll();
  },

  async onSelectJob(event) {
    const id = event.currentTarget.dataset.id;
    if (!id || !this.data.authed) return;
    try {
      this.client.setSelectedJobId(id);
      if (id !== this.data.selectedId) {
        this._selectionEpoch += 1;
        this.setData({ selectedId: id, selected: null, sections: [], rating: '', jobError: '' });
      }
      await this.loadSelected();
    } catch (error) {
      if (this._alive && this.data.authed) this.setData({ jobError: error.message });
    }
  },

  loadSelected() {
    const id = this.data.selectedId;
    if (!id || !this.data.authed) return Promise.resolve();
    const generation = this.client.getGeneration();
    const epoch = this._selectionEpoch;
    const key = `${generation}:${id}`;
    // 同一任务复用在途请求；切换任务后仅当前选择可更新界面。
    if (!this._details[key]) {
      const request = this.client.request('GET', `/api/predictions/${encodeURIComponent(id)}`);
      this._details[key] = request;
      const cleanup = () => { if (this._details[key] === request) delete this._details[key]; };
      request.then(cleanup, cleanup);
    }
    this.setData({ jobLoading: true });
    const current = () => this.isCurrent(generation) &&
      this.data.selectedId === id && this._selectionEpoch === epoch;
    return this._details[key].then((job) => {
      if (!current()) return;
      if (!job || job.id !== id) throw new Error('任务响应不完整，请重试读取。');
      const oldSections = this.data.sections;
      const sections = reportSections(job.result).map((section) => {
        const old = oldSections.find((item) => item.key === section.key);
        return Object.assign({}, section, { open: old ? old.open : false });
      });
      const result = job.result ? {
        rating: job.result.rating,
        final_decision: job.result.final_decision,
        disclaimer: job.result.disclaimer
      } : null;
      this.setData({
        selected: displayJob(Object.assign({}, job, { result })), sections,
        rating: ratingLabel(job.result && job.result.rating),
        jobError: '',
        history: this.data.history.map((item) => item.id === id ? displaySummary(job) : item)
      });
      this.updateActivity();
    }).catch((error) => {
      if (current()) this.setData({ jobError: `暂时无法读取任务状态：${error.message} 这不代表任务失败。` });
    }).finally(() => {
      if (current()) {
        this.setData({ jobLoading: false });
        this.schedulePolling();
      }
    });
  },

  onRetryDetail() {
    return this.loadSelected();
  },

  stopPolling() {
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = null;
  },

  schedulePolling() {
    this.stopPolling();
    if (!this._alive || !this._visible || !this.data.authed || !this.data.hasActive) return;
    this._pollTimer = setTimeout(() => {
      this._pollTimer = null;
      this.refreshAll();
    }, config.POLL_INTERVAL_MS);
  },

  async onSubmit() {
    if (this.data.submitting || this.data.loggingOut || !this.data.authed) return;
    const generation = this.client.getGeneration();
    const ticker = this.data.ticker.trim().toUpperCase();
    if (!this.data.pending) {
      if (!this.data.me) {
        this.setData({ submitError: '尚未获取今日额度，请刷新后重试。' });
        return;
      }
      if (this.data.me.remaining_today <= 0) {
        this.setData({ submitError: '今日研究额度已用完，请在北京时间次日额度重置后再试。' });
        return;
      }
      if (this.data.hasActive) {
        this.setData({ submitError: '当前已有排队或研究中的任务，请等待其结束后再提交。' });
        return;
      }
      const error = validateForm(ticker, this.data.analysisDate, this.data.maxDate);
      if (error) { this.setData({ submitError: error }); return; }
    }
    this.setData({ submitting: true, submitError: '', ticker });
    try {
      const pending = await this.client.prepareSubmission(ticker, this.data.analysisDate);
      if (!this.isCurrent(generation)) return;
      this.setData({ pending });
      const job = await this.client.request('POST', '/api/predictions', pending);
      if (!this.isCurrent(generation)) return;
      if (!job || typeof job.id !== 'string' || !job.id) {
        throw new Error('服务端未返回任务编号，提交状态仍未确认。');
      }
      this.client.finishSubmission(job.id);
      this._selectionEpoch += 1;
      this.setData({
        pending: null, selectedId: job.id, selected: displaySummary(job),
        sections: [], rating: '', jobError: '', submitting: false
      });
      this.updateActivity();
      const existing = this._refreshFlight;
      if (existing && existing.generation === generation) await existing.promise;
      if (this.isCurrent(generation)) await this.refreshAll();
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      let message = error.message;
      if (isDefiniteRejection(error)) {
        try { this.client.clearPending(); }
        catch (storageError) { message += ` ${storageError.message}`; }
      }
      this.setData({ pending: this.client.getPending(), submitError: message });
      if (isDefiniteRejection(error)) this.refreshAll();
    } finally {
      if (this.isCurrent(generation)) this.setData({ submitting: false });
    }
  },

  onToggleReport(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({
      sections: this.data.sections.map((item) =>
        item.key === key ? Object.assign({}, item, { open: !item.open }) : item)
    });
  },

  async onLogout() {
    if (this.data.loggingOut || this.data.submitting) return;
    const generation = this.client.getGeneration();
    this.setData({ loggingOut: true, logoutError: '' });
    try {
      await this.client.logout();
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.setData({ logoutError: `退出尚未确认，仍保留当前登录。${error.message}` });
      }
    } finally {
      if (this.isCurrent(generation)) this.setData({ loggingOut: false });
    }
  }
});
