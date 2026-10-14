const { display } = require('../../utils/evolution');

function initialData() {
  return { authed: false, loading: false, error: '', hasData: false, champion: null,
    summary: { samples: 0, labelled: 0, fresh: 0 }, items: [], next: null, back: false, updated: '' };
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
    if (this.data.authed !== this.client.isAuthenticated()) return this.syncSession();
    return this.refresh();
  },
  onHide() {
    this._visible = false;
    this._epoch += 1;
    this._flight = null;
    this.setData({ loading: false });
  },
  onUnload() {
    this._alive = false;
    this.onHide();
    if (this._unsubscribe) this._unsubscribe();
  },
  syncSession() {
    this._epoch += 1;
    this._flight = null;
    this._cursors = [null];
    this.setData(Object.assign(initialData(), { authed: this.client.isAuthenticated() }));
    if (this._visible) return this.refresh();
  },
  onGoLogin() { wx.switchTab({ url: '/pages/index/index' }); },
  refresh(cursors) {
    if (!this._alive || !this._visible || !this.data.authed) return Promise.resolve();
    const selected = cursors || this._cursors;
    const generation = this.client.getGeneration();
    const key = JSON.stringify([selected, generation]);
    if (this._flight && this._flight.key === key) return this._flight.promise;
    const epoch = ++this._epoch;
    const active = () => this._alive && this._visible && this.data.authed &&
      epoch === this._epoch && generation === this.client.getGeneration();
    const flight = { key };
    this._flight = flight;
    this.setData({ loading: true, error: '' });
    const before = selected[selected.length - 1];
    flight.promise = this.client.request('GET', '/api/evolution' +
      (before ? '?before=' + encodeURIComponent(before) : '')).then((response) => {
      if (!active()) return;
      const data = display(response);
      this._cursors = selected;
      this.setData(Object.assign(data, { hasData: true, back: selected.length > 1 }));
    }).catch((error) => {
      if (active()) this.setData({ error: error.message });
    }).finally(() => {
      if (this._flight === flight) this._flight = null;
      if (active()) this.setData({ loading: false });
    });
    return flight.promise;
  },
  onRefresh() { return this.refresh(); },
  async onPullDownRefresh() {
    try { await this.refresh(); } finally { wx.stopPullDownRefresh(); }
  },
  onNext() {
    if (!this.data.loading && this.data.next) return this.refresh(this._cursors.concat(this.data.next));
  },
  onBack() {
    if (!this.data.loading && this._cursors.length > 1) return this.refresh(this._cursors.slice(0, -1));
  },
  onToggle(event) {
    const day = event.currentTarget.dataset.day;
    this.setData({ items: this.data.items.map((item) => item.day === day ?
      Object.assign({}, item, { open: !item.open }) : item) });
  }
});