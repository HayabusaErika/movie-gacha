/* Run with node tools/test_nfc.cjs. Hardware APIs are isolated per phone. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../miniprogram');
const library = require(path.join(root, 'data/library.js'));
const format = require(path.join(root, 'utils/format.js'));
const ids = library.slice(0, 6).map(card => card.id);
const settle = () => new Promise(resolve => setImmediate(resolve));
let checks = 0;

function phone(platform, saved = {}) {
  const state = { saved: structuredClone(saved), hce: new Set(), discoveries: new Set(), commands: [], timers: new Map(), notices: [] };
  let timer = 0;
  let definition;
  const later = callback => { state.timers.set(++timer, callback); return timer; };
  const wx = {
    canIUse: name => name !== 'startHCE' || platform === 'android',
    getDeviceInfo: () => ({ platform }),
    getAppBaseInfo: () => ({ SDKVersion: '3.18.0' }),
    getWindowInfo: () => ({ windowWidth: 420, windowHeight: 814 }),
    nextTick: callback => callback(),
    createSelectorQuery() {
      const query = { in: () => query, select: () => query, boundingClientRect: callback => { callback({ height: 560 }); return query; }, exec() {} };
      return query;
    },
    hideKeyboard() {}, vibrateShort() {},
    showToast: value => state.notices.push(value.title),
    getStorageSync: () => structuredClone(state.saved),
    setStorageSync(key, value) {
      if (state.failStorage || (state.rejectStorage && state.rejectStorage(value))) throw new Error('storage full');
      state.saved = structuredClone(value);
    },
    startHCE: options => options.success(),
    stopHCE: options => options.complete && options.complete(),
    onHCEMessage: listener => state.hce.add(listener),
    offHCEMessage: listener => state.hce.delete(listener),
    sendHCEMessage(options) { state.reply(options.data); },
  };
  const isoDep = {
    connect: options => options.success({}),
    close: options => options.success && options.success({}),
    transceive(options) {
      const bytes = Array.from(new Uint8Array(options.data));
      state.commands.push(bytes);
      if (state.breakCommand && state.breakCommand(bytes)) return options.fail({ errMsg: 'tag lost' });
      if (state.rejectCommand && state.rejectCommand(bytes)) return options.success({ data: new Uint8Array([0x6a, 0x82]).buffer });
      state.peer.reply = data => options.success({ data });
      assert.equal(state.peer.hce.size, 1, 'Exactly one HCE listener serves each APDU');
      for (const listener of state.peer.hce) listener({ messageType: 1, data: options.data });
    },
  };
  const adapter = {
    onDiscovered: listener => state.discoveries.add(listener),
    offDiscovered: listener => state.discoveries.delete(listener),
    startDiscovery(options) {
      state.discoveryStarts = (state.discoveryStarts || 0) + 1;
      if (state.discoveryError) options.fail({ errMsg: state.discoveryError });
      else options.success({});
    },
    stopDiscovery() {},
    getIsoDep: () => isoDep,
  };
  wx.getNFCAdapter = () => adapter;
  function loadModule(file) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
      module, wx, Uint8Array, ArrayBuffer, setTimeout: later, clearTimeout: id => state.timers.delete(id),
      require: name => {
        if (name === './format') return format;
        throw new Error(name);
      },
    }, { filename: file });
    return module.exports;
  }
  state.nfc = loadModule('utils/nfc.js');
  const store = loadModule('utils/store.js');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/index/index.js'), 'utf8'), {
    Page: value => { definition = value; }, wx, console,
    setTimeout: later, clearTimeout: id => state.timers.delete(id),
    require(name) {
      if (name.includes('/store')) return store;
      if (name.includes('/nfc')) return state.nfc;
      if (name.includes('/library')) return library;
      if (name.includes('/movie-info')) return { introduction: card => card.title, cachedIntro: () => '' };
      if (name.includes('/palette')) return { cachedColor: () => '', theme: () => '' };
      throw new Error(name);
    },
  });
  state.page = Object.assign({}, definition, { data: structuredClone(definition.data) });
  state.page.setData = patch => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
      const last = parts.pop();
      let target = state.page.data;
      for (const part of parts) target = target[part];
      target[last] = value;
    }
  };
  state.page.onLoad();
  state.discover = async (event = {}) => {
    for (const listener of [...state.discoveries]) await listener(event);
    await settle();
  };
  return state;
}

function select(state, cards) {
  state.page.selected = cards;
  state.page.openTrade();
}

async function pair() {
  const review = '电影的余味留在生活里。🎬'.repeat(7).slice(0, 80);
  const android = phone('android', { owned: Object.fromEntries(ids.slice(0, 3).map(id => [id, 1])), reviews: Object.fromEntries(ids.slice(0, 3).map(id => [id, { mine: review, guests: [] }])) });
  const ios = phone('ios', { owned: Object.fromEntries(ids.slice(3).map(id => [id, 1])), reviews: Object.fromEntries(ids.slice(3).map(id => [id, { mine: review, guests: [] }])) });
  ios.peer = android;
  select(android, ids.slice(0, 3));
  select(ios, ids.slice(3));
  android.page.startBroadcast();
  await settle();
  ios.page.startReading();
  await settle();
  await ios.discover();
  assert.equal(ios.page.data.canDeal, true, ios.page.data.nfcHint);
  assert.equal(ios.discoveries.size, 0);
  assert.ok(ios.commands.some(command => command[1] === 0xb0 && command[2] === 0 && command[3] === 2), 'NDEF body starts after NLEN');
  assert.ok(ios.commands.filter(command => command[1] === 0xb0).every(command => command[4] <= 127), 'Reads respect CC MLe');
  return { android, ios, review };
}

async function test(name, run) {
  await run();
  checks += 1;
  process.stdout.write('PASS ' + name + '\n');
}

(async () => {
  await test('iPhone + Android public page flow exchanges 3 tickets and long Chinese reviews', async () => {
    const { android, ios, review } = await pair();
    assert.equal(ios.page.data.broadcastSupported, false);
    const before = structuredClone(ios.saved.owned);
    ios.page.acceptTrade();
    await settle();
    assert.deepEqual(ios.saved.owned, before, 'No deduction before receipt');
    assert.ok(ios.saved.pendingNfcDeal);
    await ios.discover();
    assert.deepEqual(Object.keys(android.saved.owned).sort(), ids.slice(3).sort());
    assert.deepEqual(Object.keys(ios.saved.owned).sort(), ids.slice(0, 3).sort());
    assert.equal(ios.saved.pendingNfcDeal, null);
    assert.equal(android.saved.reviews[ids[3]].guests[0], review);
    assert.equal(ios.saved.reviews[ids[0]].guests[0], review);
    assert.equal(ios.page.data.tradeOpen, false);
    assert.equal(android.hce.size, 1, 'Android keeps serving the receipt');
    assert.ok(ios.commands.some(command => command[1] === 0xd6));
  });
  await test('Interrupted receipt survives restart and completes without duplicate deductions', async () => {
    const { android, ios } = await pair();
    ios.page.acceptTrade();
    await settle();
    let committed = false;
    ios.breakCommand = command => {
      if (command[1] === 0xb0 && committed) return true;
      if (command[1] === 0xd6 && command[3] === 0 && (command[5] || command[6])) committed = true;
      return false;
    };
    await ios.discover();
    assert.ok(android.saved.lastNfcReceipt);
    assert.ok(ios.saved.pendingNfcDeal);
    assert.deepEqual(Object.keys(ios.saved.owned).sort(), ids.slice(3).sort());
    const restartedAndroid = phone('android', android.saved);
    const restartedIos = phone('ios', ios.saved);
    restartedIos.peer = restartedAndroid;
    restartedAndroid.page.resendReceipt();
    await settle();
    restartedIos.page.openTrade();
    restartedIos.page.acceptTrade();
    await settle();
    await restartedIos.discover();
    assert.equal(restartedIos.saved.pendingNfcDeal, null);
    assert.deepEqual(Object.keys(restartedIos.saved.owned).sort(), ids.slice(0, 3).sort());
    const snapshot = JSON.stringify(restartedIos.saved);
    assert.equal(restartedIos.page.applyTrade(ids.slice(0, 3), ids.slice(3), android.saved.lastNfcReceipt.trade, {}), true);
    assert.equal(JSON.stringify(restartedIos.saved), snapshot);
  });
  await test('Storage failure rejects writeback and keeps both inventories intact', async () => {
    const { android, ios } = await pair();
    const beforeA = JSON.stringify(android.saved.owned);
    const beforeB = JSON.stringify(ios.saved.owned);
    android.failStorage = true;
    ios.page.acceptTrade();
    await settle();
    await ios.discover();
    assert.equal(JSON.stringify(android.saved.owned), beforeA);
    assert.equal(JSON.stringify(ios.saved.owned), beforeB);
    assert.ok(ios.saved.pendingNfcDeal);
    assert.match(ios.page.data.nfcHint, /6985/);
  });
  await test('Partial NDEF write can be retried without applying the incomplete payload', async () => {
    const { android, ios } = await pair();
    ios.breakCommand = command => command[1] === 0xd6 && command[3] > 2;
    ios.page.acceptTrade();
    await settle();
    await ios.discover();
    assert.equal(android.saved.lastNfcReceipt, null);
    ios.breakCommand = null;
    ios.page.acceptTrade();
    await settle();
    await ios.discover();
    assert.equal(ios.saved.pendingNfcDeal, null);
    assert.deepEqual(Object.keys(android.saved.owned).sort(), ids.slice(3).sort());
  });
  await test('APDU status failures cannot be interpreted as a successful offer', async () => {
    const android = phone('android');
    const ios = phone('ios');
    ios.peer = android;
    await android.nfc.startPublish({ v: 1, type: 'offer', trade: 'bad', cards: [ids[0]] });
    ios.rejectCommand = command => command[1] === 0xa4;
    let message;
    let error;
    ios.nfc.startReader({ onMessage: value => { message = value; }, onError: value => { error = value; } });
    await settle();
    await ios.discover();
    assert.equal(message, undefined);
    assert.match(error.message, /6a82/);
    assert.equal(ios.discoveries.size, 0);
  });
  await test('Commit-journal failure stops before the Android inventory changes', async () => {
    const { android, ios } = await pair();
    const beforeA = JSON.stringify(android.saved.owned);
    const beforeB = JSON.stringify(ios.saved.owned);
    ios.rejectStorage = value => value.pendingNfcDeal && value.pendingNfcDeal.commitAttempted;
    ios.page.acceptTrade();
    await settle();
    await ios.discover();
    assert.equal(JSON.stringify(android.saved.owned), beforeA);
    assert.equal(JSON.stringify(ios.saved.owned), beforeB);
    assert.equal(ios.saved.pendingNfcDeal, null);
    assert.equal(ios.page.data.pendingExchange, false);
  });
  await test('Android restart resumes the same advertised transaction', async () => {
    const { android, ios } = await pair();
    const trade = android.saved.publishedOffer.trade;
    ios.page.acceptTrade();
    await settle();
    ios.page.closeTrade();
    assert.equal(ios.saved.pendingNfcDeal, null, 'Cancellation before commit remains reversible');
    const restarted = phone('android', android.saved);
    restarted.page.openTrade();
    restarted.page.startBroadcast();
    await settle();
    assert.equal(restarted.page.tradeId, trade);
    ios.peer = restarted;
    ios.page.openTrade();
    ios.page.startReading();
    await settle();
    await ios.discover();
    ios.page.acceptTrade();
    await settle();
    await ios.discover();
    assert.equal(ios.saved.pendingNfcDeal, null);
    assert.deepEqual(Object.keys(restarted.saved.owned).sort(), ids.slice(3).sort());
  });
  await test('Oversized messages and unavailable HCE fail before binding a listener', async () => {
    const android = phone('android');
    const ios = phone('ios');
    await assert.rejects(android.nfc.startPublish({ v: 1, trade: 'large', text: '影'.repeat(2000) }), /容量/);
    await assert.rejects(ios.nfc.startPublish({ v: 1, trade: 'ios' }), /安卓/);
    assert.equal(android.hce.size, 0);
    assert.equal(ios.hce.size, 0);
  });
  await test('Nested NDEF messages and record IDs decode through the reader entry point', async () => {
    const ios = phone('ios');
    const value = { v: 1, type: 'offer', trade: 'nested', cards: [ids[0]] };
    const payload = format.utf8Encode('\u0002en' + JSON.stringify(value));
    let message;
    ios.nfc.startReader({ onMessage: data => { message = data; } });
    await settle();
    await ios.discover({ messages: [{ records: [{ type: new Uint8Array([0x54]).buffer, id: new Uint8Array([1]).buffer, payload: payload.buffer }] }] });
    assert.deepEqual(JSON.parse(JSON.stringify(message)), value);
    assert.equal(ios.discoveries.size, 0);
  });
  await test('Cancelled and repeated readers remove listeners and ignore late discoveries', async () => {
    const ios = phone('ios');
    let calls = 0;
    const first = ios.nfc.startReader({ onMessage: () => { calls += 1; } });
    await settle();
    const late = [...ios.discoveries][0];
    ios.nfc.stopReader(first);
    await late({});
    assert.equal(calls, 0);
    assert.equal(ios.discoveries.size, 0);
    ios.nfc.startReader({});
    await settle();
    ios.nfc.startReader({});
    await settle();
    assert.equal(ios.discoveries.size, 1);
    ios.nfc.stopReader();
    assert.equal(ios.discoveries.size, 0);
  });
  await test('Remote-service failure gives preview guidance and cleans up discovery', async () => {
    const ios = phone('ios');
    ios.discoveryError = 'startDiscovery:fail function cannot run on service';
    select(ios, [ids[0]]);
    ios.page.startReading();
    await settle();
    assert.match(ios.page.data.nfcHint, /普通预览版/);
    assert.equal(ios.page.data.readingOn, false);
    assert.equal(ios.page.data.nfcActive, false);
    assert.equal(ios.discoveries.size, 0);
  });
  await test('Real confirmation cannot use the simulated local-commit handler', async () => {
    const { android, ios } = await pair();
    const snapshot = JSON.stringify(ios.saved);
    ios.page.acceptSimulated();
    assert.equal(JSON.stringify(ios.saved), snapshot);
    const oldOwned = JSON.stringify(android.saved.owned);
    assert.equal(android.page.receiveWrittenDeal({ v: 1, type: 'deal', trade: 'wrong', nonce: 'x', mine: ids.slice(3), theirs: ids.slice(0, 3) }), null);
    assert.equal(JSON.stringify(android.saved.owned), oldOwned);
  });
  await test('Legacy receiving deal gives local offered cards and takes peer cards', async () => {
    const state = phone('android', { owned: { [ids[0]]: 1 } });
    select(state, [ids[0]]);
    state.page.tradeId = 'legacy';
    state.page.handleNfcPayload({ v: 1, type: 'deal', trade: 'legacy', mine: [ids[3]], theirs: [ids[0]], mineReviews: { [ids[3]]: '来自对方' } });
    assert.deepEqual(state.saved.owned, { [ids[3]]: 1 });
    assert.equal(state.saved.reviews[ids[3]].guests[0], '来自对方');
  });
  process.stdout.write(checks + ' NFC regression checks passed\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
