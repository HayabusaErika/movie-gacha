const store = require('../../utils/store');
const nfc = require('../../utils/nfc');
const movieInfo = require('../../utils/movie-info');
const palette = require('../../utils/palette');

const LIBRARY = require('../../data/library.js') || [];
const DRAWS_PER_DAY = 3;
const DAILY_PICKS = 3;
const MAX_SELECT = 3;
const REVIEW_MAX = 80;
const PASS_COLORS = ['#1F2A44', '#4A1D2E', '#134E4A', '#312E81', '#4C1D95', '#164E63', '#3F1D38', '#243B2A'];

function todayKey() {
  const now = new Date();
  return now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
}

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return function random() {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, random) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const temp = copy[i];
    copy[i] = copy[j];
    copy[j] = temp;
  }
  return copy;
}

function passColor(id) {
  return PASS_COLORS[hashString(String(id)) % PASS_COLORS.length];
}

function fullSizePoster(url) {
  const source = String(url || '');
  if (!/^https:\/\/img\d*\.doubanio\.com\//i.test(source)) return source;
  return source.replace(/\/view\/photo\/(?:[sml]_ratio_poster|[sml])\/public\//, '/view/photo/l/public/');
}

function shortReview(value) {
  const characters = Array.from(String(value || '').trim());
  return characters.slice(0, REVIEW_MAX).join('') + (characters.length > REVIEW_MAX ? '…' : '');
}

Page({
  data: {
    isWide: false,
    windowHeight: 814,
    posterHeight: 360,
    stackStep: 64,
    activeTab: 'collection',
    dailyList: [],
    dailyTaken: '',
    dailyNote: '每日 3 选 1',
    drawLeft: DRAWS_PER_DAY,
    drawDisabled: false,
    cards: [],
    ownedTotal: 0,
    selectedCount: 0,
    nfcSelection: false,
    query: '',
    emptyText: '还没有票根，先抽一张，或者收下今天的推荐',
    drawOverlay: false,
    drawCard: null,
    revealed: false,
    drawHint: '',
    detailOpen: false,
    detailCard: null,
    detailReview: '',
    detailReviewLength: 0,
    editingReview: false,
    ticketFlipped: false,
    reviewFocus: false,
    detailSelected: false,
    detailDaily: false,
    importOpen: false,
    importValue: '',
    importStatus: '',
    tradeOpen: false,
    myOffer: [],
    peerOffer: [],
    nfcText: '把另一台手机贴过来',
    nfcHint: '',
    broadcastOn: false,
    readingOn: false,
    canDeal: false,
    nfcActive: false,
    broadcastSupported: false,
    pendingExchange: false,
    simulatedTrade: false,
  },

  onLoad() {
    this.unloaded = false;
    this.byId = new Map(LIBRARY.map((card) => [card.id, card]));
    this.owned = {};
    this.selected = [];
    this.daily = { date: '', picks: [], taken: '', draws: 0 };
    this.reviews = {};
    this.peerReviews = {};
    this.peerOffer = [];
    this.tradeId = '';
    this.tradeSession = 0;
    this.appliedTrades = {};
    this.pendingNfcDeal = null;
    this.lastNfcReceipt = null;
    this.publishedOffer = null;
    this.broadcastTimer = null;
    this.failedPosters = new Set();
    this.posterFallbacks = new Set();
    const window = wx.getWindowInfo();
    this.setData({ isWide: window.windowWidth >= 640, windowHeight: window.windowHeight });

    const saved = store.load();
    if (saved.owned) this.owned = saved.owned;
    if (saved.reviews) this.reviews = saved.reviews;
    if (saved.daily) this.daily = Object.assign(this.daily, saved.daily);
    this.appliedTrades = saved.appliedTrades || {};
    this.pendingNfcDeal = saved.pendingNfcDeal || null;
    this.lastNfcReceipt = saved.lastNfcReceipt || null;
    this.publishedOffer = saved.publishedOffer || null;
    if (this.pendingNfcDeal) this.selected = this.pendingNfcDeal.mine.slice();
    else if (this.publishedOffer) this.selected = this.publishedOffer.cards.filter((id) => this.ownedCount(id) > 0);
    this.setData({ pendingExchange: !!this.pendingNfcDeal });

    if (!Object.keys(this.owned).some((id) => this.owned[id] > 0)) {
      this.setData({ activeTab: 'daily' });
    }
    this.ensureDaily();
    this.render();
    this.previewFirstCard();
  },

  onReady() {
    this.measureWallet();
  },

  onUnload() {
    this.unloaded = true;
    clearTimeout(this.searchTimer);
    clearTimeout(this.drawTimer);
    clearTimeout(this.reviewFocusTimer);
    clearTimeout(this.simulateTimer);
    this.tradeSession += 1;
    this.stopBroadcast();
    this.stopReading();
  },

  onHide() {
    this.tradeSession += 1;
    clearTimeout(this.simulateTimer);
    clearTimeout(this.reviewFocusTimer);
    this.setData({ reviewFocus: false, nfcActive: false });
    this.stopBroadcast();
    this.stopReading();
  },

  onShow() {
    if (!this.byId) return;
    const saved = store.load();
    if (saved.owned) this.owned = saved.owned;
    if (saved.reviews) this.reviews = saved.reviews;
    if (saved.daily) this.daily = Object.assign({ date: '', picks: [], taken: '', draws: 0 }, saved.daily);
    this.ensureDaily();
    this.render();
  },

  openRoom() {
    wx.navigateTo({ url: '/pages/room/room' });
  },

  onResize(event) {
    this.setData({ isWide: event.size.windowWidth >= 640, windowHeight: event.size.windowHeight }, () => this.measureWallet());
    if (!this.data.detailOpen) this.previewFirstCard();
  },

  measureWallet() {
    wx.nextTick(() => {
      if (this.unloaded) return;
      wx.createSelectorQuery().in(this).select('.wallet-scroll').boundingClientRect((rect) => {
        if (!rect || !rect.height || this.unloaded) return;
        const count = this.data.activeTab === 'daily' ? this.data.dailyList.length : this.data.cards.length;
        const stackStep = rect.height < 420 ? 52 : 64;
        const exposed = Math.min(Math.max(count - 1, 0), 3);
        const posterHeight = Math.max(160, Math.min(560, Math.floor(rect.height - 28 - exposed * stackStep)));
        if (posterHeight !== this.data.posterHeight || stackStep !== this.data.stackStep) {
          this.setData({ posterHeight, stackStep });
        }
      }).exec();
    });
  },

  /* ------------------------------------------------------------ 数据 */

  save() {
    return store.save({
      owned: this.owned, daily: this.daily, reviews: this.reviews,
      appliedTrades: this.appliedTrades, pendingNfcDeal: this.pendingNfcDeal,
      lastNfcReceipt: this.lastNfcReceipt,
      publishedOffer: this.publishedOffer,
    });
  },

  ownedCount(id) {
    return this.owned[id] || 0;
  },

  addOwned(id, amount) {
    this.owned[id] = this.ownedCount(id) + (amount || 1);
  },

  reviewOf(id) {
    const entry = this.reviews[id];
    if (!entry) return { mine: '', guests: [] };
    return { mine: entry.mine || '', guests: entry.guests || [] };
  },

  ensureDaily() {
    const today = todayKey();
    const sameDay = this.daily.date === today;
    if (sameDay && this.daily.picksSkin !== 'christmas' && this.daily.picks.length === DAILY_PICKS) return;
    const random = mulberry32(hashString(today));
    const curated = LIBRARY.filter((card) => Number(card.rating || 0) >= 8);
    const pool = curated.length >= DAILY_PICKS ? curated : LIBRARY;
    const picks = shuffle(pool, random).slice(0, DAILY_PICKS).map((card) => card.id);
    this.daily = { date: today, picks, taken: sameDay ? this.daily.taken : '', draws: sameDay ? this.daily.draws : 0 };
    this.save();
  },

  decorate(card) {
    const count = this.ownedCount(card.id);
    const review = this.reviewOf(card.id);
    const excerpt = review.mine || review.guests[0] || card.comment || '';
    const color = palette.cachedColor(card.poster) || passColor(card.id);
    return {
      id: card.id,
      title: card.title,
      rating: card.rating || '—',
      metaLine: [card.year, (card.genres || []).slice(0, 2).join(' / ')].filter(Boolean).join(' · '),
      director: (card.directors || [])[0] || '',
      posterSrc: this.failedPosters.has(card.id) ? '' : (this.posterFallbacks.has(card.id) ? card.poster : fullSizePoster(card.poster)),
      initial: (card.title || '?').trim().charAt(0) || '?',
      color,
      themeStyle: palette.theme(color),
      intro: movieInfo.introduction(card),
      introLabel: movieInfo.cachedIntro(card) ? '豆瓣简介' : '电影介绍',
      count,
      owned: count > 0,
      selected: this.selected.indexOf(card.id) >= 0,
      review: shortReview(excerpt),
      reviewLabel: review.mine ? '我的短评' : (review.guests[0] ? '碰一碰收到的短评' : '片库短评'),
      reviewCount: review.guests.length + (review.mine ? 1 : 0),
    };
  },

  loadMovieExtras(card) {
    movieInfo.load(card).then(() => this.refreshMovieCard(card.id)).catch(() => {});
    palette.fromPoster(card.poster).then(() => this.refreshMovieCard(card.id)).catch(() => {});
  },

  refreshMovieCard(id) {
    if (this.unloaded) return;
    const card = this.byId.get(id);
    if (!card) return;
    const patch = {};
    ['detailCard', 'drawCard'].forEach((key) => {
      if (this.data[key] && this.data[key].id === id) patch[key] = this.decorate(card);
    });
    this.setData(patch);
  },

  render() {
    const taken = this.daily.taken;
    const dailyList = this.daily.picks
      .map((id) => this.byId.get(id))
      .filter(Boolean)
      .map((card) => this.decorate(card));

    const query = (this.data.query || '').trim().toLowerCase();
    const cards = LIBRARY
      .filter((card) => this.ownedCount(card.id) > 0)
      .filter((card) => {
        if (!query) return true;
        const hay = [card.title, (card.genres || []).join(' '), (card.directors || []).join(' ')]
          .join(' ').toLowerCase();
        return hay.indexOf(query) >= 0;
      })
      .sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0))
      .map((card) => this.decorate(card));

    const ownedTotal = Object.keys(this.owned).filter((id) => this.owned[id] > 0).length;

    this.setData({
      dailyList,
      dailyTaken: taken,
      dailyNote: taken ? '今日已收下' : '每日 3 选 1',
      cards,
      ownedTotal,
      selectedCount: this.selected.length,
      emptyText: ownedTotal === 0 ? '还没有票根，先抽一张，或者收下今天的推荐' : '没有符合条件的票根',
      drawLeft: Math.max(0, DRAWS_PER_DAY - this.daily.draws),
      drawDisabled: this.daily.draws >= DRAWS_PER_DAY,
    }, () => this.measureWallet());
  },

  /* ------------------------------------------------------------ 抽卡 */

  drawOne() {
    this.ensureDaily();
    if (this.daily.draws >= DRAWS_PER_DAY) {
      wx.showToast({ title: '今天的 3 次抽完了', icon: 'none' });
      return;
    }
    const unowned = LIBRARY.filter((card) => this.ownedCount(card.id) === 0);
    const pool = unowned.length ? unowned : LIBRARY;
    const card = pool[Math.floor(Math.random() * pool.length)];
    if (!card) return;

    this.daily.draws += 1;
    this.addOwned(card.id, 1);
    this.save();

    this.setData({
      drawOverlay: true,
      drawCard: this.decorate(card),
      revealed: false,
      drawHint: '放映中…',
    });
    this.loadMovieExtras(card);
    wx.vibrateShort({ type: 'light', fail() {} });
    clearTimeout(this.drawTimer);
    this.drawTimer = setTimeout(() => {
      this.setData({ revealed: true, drawHint: '抽到了这部，已经放进收藏' });
    }, 500);
    this.render();
  },

  closeDraw() {
    clearTimeout(this.drawTimer);
    this.setData({ drawOverlay: false, revealed: false });
  },

  openDrawDetail() {
    const card = this.data.drawCard;
    if (!card || !this.data.revealed) return;
    this.closeDraw();
    this.openDetail({ currentTarget: { dataset: { id: card.id } } });
  },

  drawAgain() {
    this.closeDraw();
    setTimeout(() => this.drawOne(), 150);
  },

  /* ------------------------------------------------------------ 每日推荐 */

  takeDaily(event) {
    this.ensureDaily();
    const id = event.currentTarget.dataset.id;
    if (this.daily.taken) {
      wx.showToast({ title: '今天已经收下一部了', icon: 'none' });
      return;
    }
    if (this.daily.picks.indexOf(id) < 0 || !this.byId.has(id)) return;
    this.daily.taken = id;
    this.addOwned(id, 1);
    this.save();
    this.render();
    if (this.detailId === id) {
      this.setData({ detailCard: this.decorate(this.byId.get(id)) });
    }
    wx.vibrateShort({ type: 'medium', fail() {} });
    wx.showToast({ title: '已收下今天的推荐', icon: 'none' });
  },

  /* ------------------------------------------------------------ 票根详情 / 影评 */

  openDetail(event) {
    const id = event.currentTarget.dataset.id;
    const card = this.byId.get(id);
    if (!card) return;
    const review = this.reviewOf(id);
    clearTimeout(this.reviewFocusTimer);
    this.detailId = id;
    this.setData({
      detailOpen: true,
      detailCard: this.decorate(card),
      detailReview: review.mine,
      detailReviewLength: Array.from(review.mine).length,
      editingReview: false,
      ticketFlipped: false,
      reviewFocus: false,
      detailSelected: this.selected.indexOf(id) >= 0,
      detailDaily: this.data.activeTab === 'daily' && this.daily.picks.indexOf(id) >= 0,
    });
    this.loadMovieExtras(card);
  },

  closeDetail() {
    clearTimeout(this.reviewFocusTimer);
    this.detailId = '';
    this.setData({ detailOpen: false, editingReview: false, ticketFlipped: false, reviewFocus: false });
  },

  startReviewEdit() {
    const fromDraw = this.data.drawOverlay;
    if (fromDraw) this.openDrawDetail();
    clearTimeout(this.reviewFocusTimer);
    this.reviewFocusTimer = setTimeout(() => {
      this.setData({ editingReview: true, ticketFlipped: true, reviewFocus: false });
      this.reviewFocusTimer = setTimeout(() => this.setData({ reviewFocus: true }), 450);
    }, fromDraw ? 60 : 0);
  },

  showTicketFront() {
    clearTimeout(this.reviewFocusTimer);
    this.setData({ ticketFlipped: false, reviewFocus: false });
    wx.hideKeyboard();
  },

  cancelReviewEdit() {
    const text = this.reviewOf(this.detailId).mine;
    this.setData({ editingReview: false, detailReview: text, detailReviewLength: Array.from(text).length });
    this.showTicketFront();
  },

  onReviewInput(event) {
    const text = Array.from(event.detail.value).slice(0, REVIEW_MAX).join('');
    this.setData({ detailReview: text, detailReviewLength: Array.from(text).length });
  },

  saveReview() {
    const id = this.detailId;
    if (!id) return;
    clearTimeout(this.reviewFocusTimer);
    const text = Array.from(this.data.detailReview || '').slice(0, REVIEW_MAX).join('').trim();
    const entry = this.reviewOf(id);
    this.reviews[id] = { mine: text, guests: entry.guests };
    this.save();
    this.render();
    this.setData({
      detailCard: this.decorate(this.byId.get(id)),
      detailReview: text,
      detailReviewLength: Array.from(text).length,
      editingReview: false,
      reviewFocus: false,
    });
    wx.hideKeyboard();
    wx.showToast({ title: text ? '影评已保存' : '影评已清空', icon: 'none' });
  },

  toggleDetailSelect() {
    this.toggleSelection(this.detailId);
  },

  togglePosterSelect(event) {
    this.toggleSelection(String(event.currentTarget.dataset.id));
  },

  toggleSelection(id) {
    if (this.pendingNfcDeal) {
      wx.showToast({ title: '请先在碰一碰中继续确认上次交换', icon: 'none' });
      return;
    }
    if (!id || !this.ownedCount(id)) return;
    const index = this.selected.indexOf(id);
    if (index >= 0) {
      this.selected.splice(index, 1);
    } else {
      if (this.selected.length >= MAX_SELECT) {
        wx.showToast({ title: '最多选 ' + MAX_SELECT + ' 张', icon: 'none' });
        return;
      }
      this.selected.push(id);
      wx.vibrateShort({ type: 'light', fail() {} });
    }
    if (this.detailId === id) {
      this.setData({
        detailSelected: this.selected.indexOf(id) >= 0,
        detailCard: this.decorate(this.byId.get(id)),
      });
    }
    this.render();
  },

  /* ------------------------------------------------------------ 收藏搜索 */

  switchTab(event) {
    this.setData({ activeTab: event.currentTarget.dataset.tab }, () => this.measureWallet());
    this.previewFirstCard();
  },

  showDaily() {
    this.setData({ activeTab: 'daily' }, () => this.measureWallet());
    this.previewFirstCard();
  },

  previewFirstCard() {
    if (!this.data.isWide) return;
    const cards = this.data.activeTab === 'daily' ? this.data.dailyList : this.data.cards;
    if (cards.length) this.openDetail({ currentTarget: { dataset: { id: cards[0].id } } });
  },

  onSearch(event) {
    this.setData({ query: event.detail.value });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.render(), 180);
  },

  /* ------------------------------------------------------------ 交换 */

  myReviews() {
    const map = {};
    this.selected.forEach((id) => {
      const review = this.reviewOf(id).mine;
      if (review) map[id] = review;
    });
    return map;
  },

  validCards(ids) {
    return Array.isArray(ids) && ids.length > 0 && ids.length <= MAX_SELECT
      && new Set(ids).size === ids.length && ids.every((id) => typeof id === 'string' && this.byId.has(id));
  },

  sameCards(left, right) {
    return this.validCards(left) && this.validCards(right)
      && JSON.stringify(left.slice().sort()) === JSON.stringify(right.slice().sort());
  },

  openTrade() {
    if (!this.selected.length) {
      wx.showToast({ title: '先选要换出去的票根', icon: 'none' });
      return;
    }
    this.tradeSession += 1;
    clearTimeout(this.reviewFocusTimer);
    this.setData({ reviewFocus: false });
    wx.hideKeyboard();
    this.simulatedTrade = false;
    this.peerWritable = false;
    this.peerOffer = [];
    this.peerReviews = {};
    this.tradeId = '';
    if (this.pendingNfcDeal) {
      this.tradeId = this.pendingNfcDeal.trade;
      this.peerOffer = this.pendingNfcDeal.theirs.map((id) => this.decorate(this.byId.get(id)));
      this.peerReviews = this.pendingNfcDeal.theirReviews;
      this.peerWritable = true;
    }
    this.setData({
      tradeOpen: true,
      myOffer: this.selected.map((id) => this.decorate(this.byId.get(id))).filter(Boolean),
      peerOffer: this.peerOffer,
      nfcText: this.pendingNfcDeal ? '上次交换等待成交回执' : '安卓出示票根，另一台手机读取',
      nfcHint: this.pendingNfcDeal ? '请对方保持出示票根或重发成交回执，点击继续确认后再贴合' : 'iPhone 请从普通预览版进入，并用手机顶部贴近安卓的 NFC 区域',
      broadcastOn: false,
      readingOn: false,
      canDeal: !!this.pendingNfcDeal,
      nfcActive: false,
      broadcastSupported: nfc.hceSupported(),
      pendingExchange: !!this.pendingNfcDeal,
      simulatedTrade: false,
    });
  },

  closeTrade() {
    this.tradeSession += 1;
    clearTimeout(this.simulateTimer);
    this.stopBroadcast();
    this.stopReading();
    this.setData({ tradeOpen: false, nfcActive: false });
  },

  simulateTap() {
    if (this.data.nfcActive || this.pendingNfcDeal) return;
    this.stopReading();
    this.stopBroadcast();
    this.simulatedTrade = true;
    this.setData({ nfcActive: true, simulatedTrade: true, canDeal: false, nfcText: '正在模拟读取票根…' });
    wx.vibrateShort({ type: 'medium', fail() {} });
    const session = this.tradeSession;
    this.simulateTimer = setTimeout(() => {
      if (session !== this.tradeSession) return;
      const pool = LIBRARY.filter((card) => this.ownedCount(card.id) === 0);
      this.peerOffer = shuffle(pool.length ? pool : LIBRARY, Math.random).slice(0, 3).map((card) => this.decorate(card));
      this.setData({ nfcActive: false, peerOffer: this.peerOffer, nfcText: '模拟票根已就绪', canDeal: true, nfcHint: '演示会修改本机收藏' });
    }, 1100);
  },

  /* ------------------------------------------------------------ 真实 NFC */

  startBroadcast() {
    if (this.pendingNfcDeal || !this.selected.length || this.data.nfcActive || this.data.broadcastOn) return;
    if (!nfc.hceSupported()) {
      this.setData({ nfcHint: '请让安卓手机出示票根，在 iPhone 上点击读取对方' });
      return;
    }
    this.stopReading();
    this.simulatedTrade = false;
    const savedOffer = this.publishedOffer;
    this.tradeId = savedOffer && this.sameCards(savedOffer.cards, this.selected) ? savedOffer.trade
      : 't' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    this.offeredCards = this.selected.slice();
    const payload = { v: 1, type: 'offer', trade: this.tradeId, cards: this.offeredCards, reviews: this.myReviews(), writeback: true };
    this.publishedOffer = payload;
    if (this.save() === false) {
      this.publishedOffer = savedOffer;
      this.setData({ nfcHint: '本机无法保存报价，请腾出存储空间后重试' });
      return;
    }
    const session = this.tradeSession;
    this.setData({ nfcActive: true, simulatedTrade: false, canDeal: false, peerOffer: [] });
    nfc.startPublish(payload, {
      onMessage: (deal) => this.receiveWrittenDeal(deal),
      onError: (error) => {
        if (session === this.tradeSession) this.setData({ nfcHint: error.message });
      },
    }).then(() => {
      if (session !== this.tradeSession) return;
      this.setData({ broadcastOn: true, nfcActive: false, readingOn: false, nfcText: '票根已出示，等待对方读取并确认', nfcHint: '短评随票根分享，成交回执发出前请保持此页面打开' });
      this.startBroadcastTimer();
    }).catch((error) => {
      if (session === this.tradeSession) this.setData({ nfcActive: false, nfcHint: error.message });
    });
  },

  receiveWrittenDeal(deal) {
    if (!deal || deal.v !== 1 || deal.type !== 'deal' || typeof deal.nonce !== 'string'
      || deal.nonce.length > 120 || deal.trade !== this.tradeId || !this.sameCards(deal.theirs, this.offeredCards)
      || !this.validCards(deal.mine)) return null;
    const receipt = { v: 1, type: 'ack', trade: deal.trade, nonce: deal.nonce, mine: deal.mine, theirs: deal.theirs };
    if (!this.applyTrade(deal.mine, deal.theirs, deal.trade, deal.mineReviews, { keepPublish: true, receipt })) return null;
    this.setData({ nfcText: '本机已完成交换，正在出示成交回执', nfcHint: '请保持贴合，等对方也显示交换完成。断开后可从菜单重发成交回执' });
    this.startBroadcastTimer();
    return receipt;
  },

  startBroadcastTimer() {
    clearTimeout(this.broadcastTimer);
    this.broadcastTimer = setTimeout(() => {
      this.stopBroadcast();
      this.setData({ nfcText: 'NFC 出示已停止', nfcHint: '已成交的记录保存在本机，可从菜单重发成交回执' });
    }, 60000);
  },

  stopBroadcast() {
    clearTimeout(this.broadcastTimer);
    nfc.stopPublish();
    if (this.data.broadcastOn) this.setData({ broadcastOn: false });
  },

  startReading() {
    if (this.pendingNfcDeal || this.data.nfcActive || this.data.readingOn) return;
    this.stopBroadcast();
    this.simulatedTrade = false;
    this.setData({ nfcActive: true, canDeal: false, simulatedTrade: false });
    const session = this.tradeSession;
    this.reader = nfc.startReader({
      onStart: () => {
        if (session === this.tradeSession) this.setData({ broadcastOn: false, readingOn: true, nfcText: '请保持两台手机的 NFC 区域贴合', nfcHint: '先读取报价，确认后再碰一次完成交换' });
      },
      onError: (error) => {
        if (session === this.tradeSession) this.setData({ readingOn: false, nfcActive: false, nfcHint: error.message });
      },
      onMessage: (payload) => {
        if (session === this.tradeSession) this.handleNfcPayload(payload);
      },
    });
  },

  stopReading() {
    if (this.reader) nfc.stopReader(this.reader);
    this.reader = null;
    this.clearUncommittedDeal();
    this.setData({ readingOn: false, nfcActive: false });
  },

  clearUncommittedDeal() {
    if (!this.pendingNfcDeal || this.pendingNfcDeal.commitAttempted) return;
    const pending = this.pendingNfcDeal;
    this.pendingNfcDeal = null;
    if (this.save() === false) this.pendingNfcDeal = pending;
    this.setData({ pendingExchange: !!this.pendingNfcDeal });
  },

  handleNfcPayload(payload) {
    this.setData({ readingOn: false, nfcActive: false });
    if (!payload || payload.v !== 1 || typeof payload.trade !== 'string' || !payload.trade || payload.trade.length > 120) return;
    if (payload.type === 'offer' && this.validCards(payload.cards)) {
      this.tradeId = payload.trade;
      this.peerReviews = payload.reviews || {};
      this.peerWritable = payload.writeback === true;
      this.peerOffer = payload.cards.map((id) => this.decorate(this.byId.get(id)));
      const offered = this.peerOffer.map((card) => Object.assign({}, card, { review: shortReview(this.peerReviews[card.id] || '') }));
      this.setData({ peerOffer: offered, nfcText: '收到对方 ' + offered.length + ' 张票根', canDeal: true,
        nfcHint: this.peerWritable ? '确认双方票根后，点击确认交换，再把两台手机贴合' : '对方版本较旧，iPhone 交换需要安卓端也更新到当前预览版' });
      wx.vibrateShort({ type: 'medium', fail() {} });
    } else if (payload.type === 'deal' && payload.trade === this.tradeId && this.sameCards(payload.theirs, this.selected)) {
      // 兼容旧版安卓以广播成交回复报价的方向。
      this.applyTrade(payload.mine, payload.theirs, payload.trade, payload.mineReviews);
    } else {
      this.setData({ canDeal: false, nfcHint: '收到的票根与本次交换不匹配，请重新读取' });
    }
  },

  acceptTrade() {
    if (!this.data.canDeal || this.data.nfcActive) return;
    if (this.simulatedTrade) return this.acceptSimulated();
    if (!this.peerWritable) return this.broadcastDeal();
    let payload = this.pendingNfcDeal;
    if (!payload) {
      payload = { v: 1, type: 'deal', trade: this.tradeId, nonce: Date.now() + '-' + Math.random().toString(36).slice(2),
        mine: this.selected.slice(), theirs: this.peerOffer.map((card) => card.id),
        mineReviews: this.myReviews(), theirReviews: this.peerReviews || {} };
      if (!this.validCards(payload.mine) || !this.validCards(payload.theirs) || !payload.mine.every((id) => this.ownedCount(id) > 0)) return;
      this.pendingNfcDeal = payload;
      if (this.save() === false) {
        this.pendingNfcDeal = null;
        this.setData({ nfcHint: '本机存储写入失败，请腾出空间后重试' });
        return;
      }
    }
    this.setData({ nfcActive: true, pendingExchange: true, nfcText: '请再次贴合，正在确认成交', nfcHint: '等待双方保存并返回成交回执，中断后可继续确认' });
    const session = this.tradeSession;
    this.reader = nfc.startExchange(payload, {
      onStart: () => {
        if (session === this.tradeSession) this.setData({ readingOn: true, broadcastOn: false });
      },
      onError: (error) => {
        if (session !== this.tradeSession) return;
        this.clearUncommittedDeal();
        this.setData({ readingOn: false, nfcActive: false, nfcHint: error.message + (this.pendingNfcDeal ? '。原交换已保存，可点击继续确认' : '。可重试或重新读取对方') });
      },
      onCommit: () => {
        if (session !== this.tradeSession) return false;
        payload.commitAttempted = true;
        if (this.save() !== false) return true;
        payload.commitAttempted = false;
        return false;
      },
      onMessage: () => {
        if (session !== this.tradeSession) return;
        this.applyTrade(payload.theirs, payload.mine, payload.trade, payload.theirReviews);
      },
    });
  },

  broadcastDeal() {
    if (!this.peerOffer.length || !nfc.hceSupported()) {
      this.setData({ nfcHint: '请让安卓手机更新到当前预览版，再重新出示和读取票根' });
      return;
    }
    const payload = { v: 1, type: 'deal', trade: this.tradeId, mine: this.selected.slice(),
      theirs: this.peerOffer.map((card) => card.id), mineReviews: this.myReviews(), theirReviews: this.peerReviews || {} };
    const session = this.tradeSession;
    this.setData({ nfcActive: true });
    nfc.startPublish(payload).then(() => {
      if (session !== this.tradeSession) return;
      if (!this.applyTrade(payload.theirs, payload.mine, payload.trade, payload.theirReviews, { keepPublish: true, receipt: payload })) {
        this.stopBroadcast();
        return;
      }
      this.setData({ broadcastOn: true, nfcActive: false, nfcText: '成交已出示，请对方再次读取', nfcHint: '若连接中断，可从菜单重发成交回执' });
      this.startBroadcastTimer();
    }).catch((error) => {
      if (session === this.tradeSession) this.setData({ nfcActive: false, nfcHint: error.message });
    });
  },

  acceptSimulated() {
    if (!this.simulatedTrade || !this.data.canDeal) return;
    this.applyTrade(this.peerOffer.map((card) => card.id), this.selected.slice(), 'sim' + Date.now(), {});
  },

  applyTrade(theirs, mine, tradeId, theirReviews, options = {}) {
    if (!tradeId || !this.validCards(theirs) || !this.validCards(mine)) return false;
    const signature = JSON.stringify([theirs.slice().sort(), mine.slice().sort()]);
    const previous = this.appliedTrades[tradeId];
    if (previous) return previous === signature;
    if (!mine.every((id) => this.ownedCount(id) > 0)) {
      this.setData({ nfcHint: '收藏中的票根已变化，无法完成本次交换', nfcActive: false, readingOn: false });
      return false;
    }
    const owned = Object.assign({}, this.owned);
    const reviews = Object.assign({}, this.reviews);
    mine.forEach((id) => {
      if (owned[id] <= 1) delete owned[id];
      else owned[id] -= 1;
    });
    theirs.forEach((id) => {
      owned[id] = (owned[id] || 0) + 1;
      const text = Array.from(String((theirReviews && theirReviews[id]) || '')).slice(0, REVIEW_MAX).join('');
      if (text) {
        const entry = this.reviewOf(id);
        const guests = entry.guests.slice();
        if (guests.indexOf(text) < 0) guests.push(text);
        reviews[id] = { mine: entry.mine, guests };
      }
    });
    const appliedTrades = Object.assign({}, this.appliedTrades, { [tradeId]: signature });
    const pendingNfcDeal = this.pendingNfcDeal && this.pendingNfcDeal.trade !== tradeId ? this.pendingNfcDeal : null;
    const lastNfcReceipt = options.receipt || this.lastNfcReceipt;
    const publishedOffer = this.publishedOffer && this.publishedOffer.trade !== tradeId ? this.publishedOffer : null;
    const saved = store.save({ owned, daily: this.daily, reviews, appliedTrades, pendingNfcDeal, lastNfcReceipt, publishedOffer });
    if (saved === false) {
      this.setData({ nfcHint: '本机存储写入失败，原票根仍保留，请腾出空间后继续确认', nfcActive: false, readingOn: false });
      return false;
    }
    this.owned = owned;
    this.reviews = reviews;
    this.appliedTrades = appliedTrades;
    this.pendingNfcDeal = pendingNfcDeal;
    this.lastNfcReceipt = lastNfcReceipt;
    this.publishedOffer = publishedOffer;
    this.selected = [];
    this.peerOffer = [];
    this.peerReviews = {};
    this.render();
    if (this.data.detailOpen && this.detailId) {
      this.setData({ detailCard: this.decorate(this.byId.get(this.detailId)), detailSelected: false });
    }
    this.setData({ tradeOpen: !!options.keepPublish, canDeal: false, nfcActive: false, pendingExchange: !!pendingNfcDeal,
      nfcText: '交换完成', nfcSelection: false, readingOn: false, broadcastOn: !!options.keepPublish });
    if (!options.keepPublish) {
      this.stopBroadcast();
      this.stopReading();
    }
    wx.vibrateShort({ type: 'heavy', fail() {} });
    wx.showToast({ title: '交换完成', icon: 'success' });
    return true;
  },

  resendReceipt() {
    if (!this.lastNfcReceipt || !nfc.hceSupported()) return;
    this.tradeSession += 1;
    const session = this.tradeSession;
    this.setData({ tradeOpen: true, myOffer: [], peerOffer: [], canDeal: false, simulatedTrade: false,
      broadcastSupported: true, nfcActive: true, nfcText: '正在出示上次成交回执' });
    nfc.startPublish(this.lastNfcReceipt).then(() => {
      if (session !== this.tradeSession) return;
      this.setData({ broadcastOn: true, nfcActive: false, nfcHint: '请对方点击继续确认并贴合手机，收到回执后会完成原交换' });
      this.startBroadcastTimer();
    }).catch((error) => {
      if (session === this.tradeSession) this.setData({ nfcActive: false, nfcHint: error.message });
    });
  },

  /* ------------------------------------------------------------ 手动添加 */

  enterNfcSelection() {
    if (this.pendingNfcDeal) return this.openTrade();
    if (!this.data.ownedTotal) {
      wx.showToast({ title: '还没有可交换的电影', icon: 'none' });
      return;
    }
    this.closeDetail();
    this.setData({ nfcSelection: true, activeTab: 'collection', query: '' });
    this.render();
    this.previewFirstCard();
  },

  exitNfcSelection() {
    if (!this.pendingNfcDeal) this.selected = [];
    this.setData({ nfcSelection: false, detailSelected: false });
    this.render();
    if (this.detailId) this.setData({ detailCard: this.decorate(this.byId.get(this.detailId)) });
  },

  openMenu() {
    const itemList = ['碰一碰交换', '清空收藏与观后感'];
    if (this.pendingNfcDeal) itemList.unshift('继续确认上次交换');
    if (this.lastNfcReceipt && nfc.hceSupported()) itemList.unshift('重发上次成交回执');
    wx.showActionSheet({
      itemList,
      success: (result) => {
        const action = itemList[result.tapIndex];
        if (action === '碰一碰交换') return this.enterNfcSelection();
        if (action === '继续确认上次交换') return this.openTrade();
        if (action === '重发上次成交回执') return this.resendReceipt();
        if (action !== '清空收藏与观后感') return;
        if (this.pendingNfcDeal) {
          wx.showToast({ title: '请先继续确认上次交换', icon: 'none' });
          return;
        }
        wx.showModal({
          title: '清空收藏与观后感？',
          content: '当前收藏和保存的观后感将被删除。',
          confirmText: '清空',
          confirmColor: '#b54848',
          success: (result) => { if (result.confirm) this.resetAll(); },
        });
      },
    });
  },

  openImport() {
    this.setData({ importOpen: true, importValue: '', importStatus: '' });
  },

  closeImport() {
    this.setData({ importOpen: false });
  },

  onImportInput(event) {
    this.setData({ importValue: event.detail.value });
  },

  extractId(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    const match = text.match(/subject\/(\d{4,9})/);
    if (match) return match[1];
    if (/^\d{5,9}$/.test(text)) return text;
    return null;
  },

  doImport() {
    const id = this.extractId(this.data.importValue);
    if (!id) {
      this.setData({ importStatus: '没认出豆瓣链接，示例：https://movie.douban.com/subject/1292052/' });
      return;
    }
    if (!this.byId.has(id)) {
      this.setData({ importStatus: '片库未收录这部（共 ' + LIBRARY.length + ' 部），可以换一部试试' });
      return;
    }
    this.addOwned(id, 1);
    this.save();
    this.render();
    this.setData({ importStatus: '已加入收藏：' + this.byId.get(id).title });
    setTimeout(() => this.setData({ importOpen: false }), 600);
    wx.vibrateShort({ type: 'medium', fail() {} });
  },

  resetAll() {
    this.owned = {};
    this.selected = [];
    this.reviews = {};
    this.daily = { date: todayKey(), picks: [], taken: '', draws: 0 };
    this.closeDetail();
    this.setData({ activeTab: 'daily', query: '' });
    this.ensureDaily();
    this.save();
    this.render();
    wx.showToast({ title: '已清空', icon: 'none' });
    this.previewFirstCard();
  },

  onPosterError(event) {
    const id = event.currentTarget.dataset.id;
    if (!id || this.failedPosters.has(id)) return;
    const card = this.byId.get(id);
    if (!card) return;
    const failedUrl = event.currentTarget.dataset.src;
    if (failedUrl && failedUrl !== this.decorate(card).posterSrc) return;
    if (!this.posterFallbacks.has(id) && fullSizePoster(card.poster) !== card.poster) {
      this.posterFallbacks.add(id);
    } else {
      this.failedPosters.add(id);
    }
    const posterSrc = this.decorate(card).posterSrc;
    const patch = {};
    ['cards', 'dailyList', 'myOffer', 'peerOffer'].forEach((key) => {
      this.data[key].forEach((card, index) => {
        if (card.id === id) patch[key + '[' + index + '].posterSrc'] = posterSrc;
      });
    });
    ['detailCard', 'drawCard'].forEach((key) => {
      if (this.data[key] && this.data[key].id === id) patch[key + '.posterSrc'] = posterSrc;
    });
    this.setData(patch);
  },

  noop() {},
});
