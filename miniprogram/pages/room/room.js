const qrcode = require('../../utils/qrcode');
const roomApi = require('../../utils/room');
const profile = require('../../utils/profile');
const store = require('../../utils/store');
const LIBRARY = require('../../data/library.js');

const DRAWS_PER_DAY = 3;
const MAX_SELECTED = 3;

function todayKey() {
  const now = new Date();
  return now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
}

Page({
  data: {
    mode: 'lobby',
    nick: '',
    codeInput: '',
    busy: false,
    error: '',
    room: null,
    me: '',
    isOwner: false,
    members: [],
    films: [],
    hasFilms: false,
    hasMembers: false,
    qrOpen: false,
    qrError: '',
    addOpen: false,
    ownedList: [],
    hasOwned: false,
    picked: null,
    addReview: '',
    addStatus: '',
    addBusy: false,
    drawing: false,
  },

  onLoad(query) {
    const nick = profile.cached();
    this.setData({ nick });
    wx.showShareMenu({ withShareTicket: false });
    if (query && query.code) {
      this.setData({ codeInput: String(query.code).toUpperCase().slice(0, 6) });
      // 有昵称才自动加入；没有昵称时留在输入页，避免在非点击场景里请求微信昵称
      if (nick) this.joinRoom();
    }
  },

  onShow() {
    if (this.data.mode === 'room' && this.data.room) this.startWatch();
  },

  onHide() {
    this.stopWatch();
  },

  onUnload() {
    this.stopWatch();
  },

  onShareAppMessage() {
    const code = this.data.room ? this.data.room.code : '';
    return {
      title: code ? '来我的放映室一起抽卡' : '一起看电影',
      path: '/pages/room/room' + (code ? '?code=' + code : ''),
    };
  },

  /* ------------------------------------------------------------ 昵称与邀请码 */

  onNickInput(event) {
    this.setData({ nick: event.detail.value });
  },

  useWechatNick() {
    profile.wechatNickname()
      .then((nick) => this.setData({ nick, error: '' }))
      .catch((error) => this.setData({ error: error.message }));
  },

  onCodeInput(event) {
    this.setData({ codeInput: String(event.detail.value || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6) });
  },

  async ensureNick() {
    let nick = String(this.data.nick || '').trim();
    if (!nick) {
      try {
        nick = await profile.wechatNickname();
        this.setData({ nick });
      } catch (error) {
        this.setData({ error: '先填一个昵称，或点「用微信昵称」' });
        return '';
      }
    }
    profile.save(nick);
    return nick;
  },

  /* ------------------------------------------------------------ 创建 / 加入 */

  async createRoom() {
    const nick = await this.ensureNick();
    if (!nick) return;
    this.setData({ busy: true, error: '' });
    try {
      const result = await roomApi.call('create', { nick });
      this.enterRoom(result);
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ busy: false });
    }
  },

  async joinRoom() {
    const nick = await this.ensureNick();
    if (!nick) return;
    const code = roomApi.parseInvite(this.data.codeInput);
    if (!code) {
      this.setData({ error: '邀请码是 6 位字母或数字' });
      return;
    }
    this.setData({ busy: true, error: '' });
    try {
      const result = await roomApi.call('join', { code, nick });
      this.enterRoom(result);
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ busy: false });
    }
  },

  scanCode() {
    wx.scanCode({
      success: (res) => {
        const code = roomApi.parseInvite(res.result);
        if (!code) {
          this.setData({ error: '这个二维码里没有邀请码' });
          return;
        }
        this.setData({ codeInput: code, error: '' });
        this.joinRoom();
      },
      fail: () => {},
    });
  },

  enterRoom(result) {
    const members = this.decorateMembers(result.members || []);
    const films = this.decorateFilms(result.films || []);
    this.setData({
      mode: 'room',
      room: result.room,
      me: result.me,
      isOwner: result.room.owner === result.me,
      members,
      films,
      hasMembers: members.length > 0,
      hasFilms: films.length > 0,
      codeInput: result.room.code,
      error: '',
    });
    this.startWatch();
  },

  /* ------------------------------------------------------------ 房间数据 */

  fromDoc(doc) {
    return {
      key: doc._id,
      id: doc.filmId,
      title: doc.title,
      genres: doc.genres || [],
      directors: doc.directors || [],
      rating: doc.rating || '',
      year: doc.year || '',
      poster: doc.poster || '',
      source: doc.source === 'draw' ? 'draw' : 'library',
      review: doc.review || '',
      addedBy: doc.addedBy,
      addedByName: doc.addedByName || '影迷',
      createdAt: doc.createdAt || 0,
    };
  },

  decorateFilm(film) {
    return Object.assign({}, film, {
      initial: (film.title || '?').trim().charAt(0) || '?',
      metaLine: [film.year, (film.genres || []).slice(0, 2).join(' / ')].filter(Boolean).join(' · '),
      sourceLabel: film.source === 'draw' ? '房间抽到' : '收藏加入',
    });
  },

  decorateFilms(films) {
    return films
      .map((film) => this.decorateFilm(film))
      .sort((left, right) => left.createdAt - right.createdAt);
  },

  decorateMembers(members) {
    return members
      .map((member) => ({ openid: member.openid, nick: member.nick || '影迷', joinedAt: member.joinedAt || 0 }))
      .sort((left, right) => left.joinedAt - right.joinedAt);
  },

  applyFilms(films) {
    const list = this.decorateFilms(films);
    this.setData({ films: list, hasFilms: list.length > 0 });
  },

  applyMembers(members) {
    const list = this.decorateMembers(members);
    this.setData({ members: list, hasMembers: list.length > 0 });
  },

  // 集合默认权限下客户端 watch 读不到云函数写入的文档，统一用云函数轮询。
  startWatch() {
    this.stopWatch();
    if (!this.data.room) return;
    this.refresh();
    this.poller = setInterval(() => this.refresh(), 2500);
  },

  stopWatch() {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  },

  async refresh() {
    const room = this.data.room;
    if (!room) return;
    try {
      const result = await roomApi.call('snapshot', { code: room.code });
      const members = this.decorateMembers(result.members || []);
      const films = this.decorateFilms(result.films || []);
      this.setData({
        room: result.room,
        isOwner: result.room.owner === result.me,
        members,
        films,
        hasMembers: members.length > 0,
        hasFilms: films.length > 0,
      });
    } catch (error) {
      this.setData({ error: error.message });
    }
  },

  /* ------------------------------------------------------------ 房间抽卡 */

  async drawInRoom() {
    if (this.data.drawing || !this.data.room) return;
    const state = store.load();
    const today = todayKey();
    const daily = Object.assign({ date: '', draws: 0, taken: '', picks: [] }, state.daily || {});
    if (daily.date !== today) {
      daily.date = today;
      daily.draws = 0;
      daily.taken = '';
      daily.picks = [];
    }
    if ((daily.draws || 0) >= DRAWS_PER_DAY) {
      wx.showToast({ title: '今天的 3 次抽完了', icon: 'none' });
      return;
    }
    const inRoom = new Set(this.data.films.map((film) => film.id));
    const pool = LIBRARY.filter((card) => !inRoom.has(card.id));
    const card = pool[Math.floor(Math.random() * pool.length)];
    if (!card) {
      wx.showToast({ title: '房间已没有可抽的电影', icon: 'none' });
      return;
    }

    this.setData({ drawing: true });
    try {
      const result = await roomApi.call('addFilm', {
        code: this.data.room.code,
        film: card,
        source: 'draw',
        review: '',
      });
      if (result.duplicate) {
        wx.showToast({ title: '这部已经在房间里了，再抽一次', icon: 'none' });
        return;
      }
      daily.draws = (daily.draws || 0) + 1;
      state.daily = daily;
      state.owned = state.owned || {};
      state.owned[card.id] = (state.owned[card.id] || 0) + 1;
      store.save(state);
      wx.vibrateShort({ type: 'light', fail() {} });
      wx.showToast({ title: '抽到《' + card.title + '》，已放进房间', icon: 'none' });
      this.refresh();
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    } finally {
      this.setData({ drawing: false });
    }
  },

  /* ------------------------------------------------------------ 从收藏加片 */

  openAddPicker() {
    const state = store.load();
    const owned = state.owned || {};
    const inRoom = new Set(this.data.films.map((film) => film.id));
    const list = LIBRARY
      .filter((card) => (owned[card.id] || 0) > 0)
      .map((card) => Object.assign({}, card, {
        initial: (card.title || '?').trim().charAt(0) || '?',
        metaLine: [card.year, (card.genres || []).slice(0, 2).join(' / ')].filter(Boolean).join(' · '),
        inRoom: inRoom.has(card.id),
      }));
    this.setData({ addOpen: true, ownedList: list, hasOwned: list.length > 0, picked: null, addReview: '', addStatus: '', addBusy: false });
  },

  closeAddPicker() {
    this.setData({ addOpen: false });
  },

  pickFilm(event) {
    const id = event.currentTarget.dataset.id;
    const film = this.data.ownedList.find((item) => item.id === id);
    if (!film) return;
    if (film.inRoom) {
      this.setData({ addStatus: '这部已经在房间里了' });
      return;
    }
    this.setData({ picked: film, addStatus: '' });
  },

  onAddReview(event) {
    this.setData({ addReview: event.detail.value });
  },

  async submitAdd() {
    const film = this.data.picked;
    if (!film || this.data.addBusy) return;
    this.setData({ addBusy: true, addStatus: '' });
    try {
      const result = await roomApi.call('addFilm', {
        code: this.data.room.code,
        film,
        source: 'library',
        review: this.data.addReview,
      });
      if (result.duplicate) {
        this.setData({ addStatus: '这部已经在房间里了' });
        return;
      }
      this.setData({ addOpen: false, picked: null, addReview: '' });
      wx.showToast({ title: '已放进房间', icon: 'none' });
      this.refresh();
    } catch (error) {
      this.setData({ addStatus: error.message });
    } finally {
      this.setData({ addBusy: false });
    }
  },

  /* ------------------------------------------------------------ 邀请 */

  copyCode() {
    if (!this.data.room) return;
    wx.setClipboardData({ data: this.data.room.code });
  },

  showQr() {
    if (!this.data.room) return;
    this.setData({ qrOpen: true, qrError: '' }, () => this.drawQr(this.data.room.code));
  },

  /** 个人主体没有 wxacode 权限，二维码在本地生成（内容为 mg-room:邀请码）。 */
  drawQr(code) {
    let qr = null;
    try {
      qr = qrcode(0, 'M');
      qr.addData('mg-room:' + code);
      qr.make();
    } catch (error) {
      this.setData({ qrError: '二维码生成失败' });
      return;
    }
    const count = qr.getModuleCount();
    wx.nextTick(() => {
      wx.createSelectorQuery().in(this).select('#qrCanvas').fields({ node: true, size: true }).exec((result) => {
        const info = result && result[0];
        if (!info || !info.node) {
          this.setData({ qrError: '二维码画布不可用' });
          return;
        }
        const canvas = info.node;
        const dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2;
        const box = info.width || 210;
        canvas.width = Math.round(box * dpr);
        canvas.height = Math.round(box * dpr);
        const context = canvas.getContext('2d');
        context.scale(dpr, dpr);
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, box, box);
        const cell = Math.floor(canvas.width / (count + 8)) / dpr;
        const offset = Math.floor((canvas.width - count * cell * dpr) / 2) / dpr;
        context.fillStyle = '#161616';
        for (let row = 0; row < count; row += 1) {
          for (let col = 0; col < count; col += 1) {
            if (qr.isDark(row, col)) {
              context.fillRect(offset + col * cell, offset + row * cell, cell, cell);
            }
          }
        }
      });
    });
  },

  closeQr() {
    this.setData({ qrOpen: false });
  },

  /* ------------------------------------------------------------ 离开 */

  async leaveRoom() {
    const room = this.data.room;
    this.stopWatch();
    if (room) {
      try { await roomApi.call('leave', { code: room.code }); } catch (error) {}
    }
    this.setData({ mode: 'lobby', room: null, members: [], films: [], hasMembers: false, hasFilms: false, qrOpen: false, addOpen: false });
    wx.setNavigationBarTitle({ title: '放映室' });
  },

  noop() {},
});
