/** NDEF Type 4 读写。安卓提供 HCE 标签，iPhone 通过 ISO-DEP 读取并写回成交。 */
const { utf8Encode, utf8Decode, toBuffer } = require('./format');

const AID = 'D2760000850101';
const AID_BYTES = [0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01];
const MAX_FILE_SIZE = 4095;
const TRANSFER_SIZE = 127;
const SW_OK = new Uint8Array([0x90, 0x00]);
const SW_NOT_FOUND = new Uint8Array([0x6a, 0x82]);
const SW_WRONG_LENGTH = new Uint8Array([0x67, 0x00]);
const SW_REJECTED = new Uint8Array([0x69, 0x85]);

let ndefMessage = new Uint8Array(0);
let selectedFile = 0;
let incoming = null;
let hceActive = false;
let hceGeneration = 0;
let hceListener = null;
let hceQueue = Promise.resolve();
let activeReader = null;

function errorMessage(error) {
  const message = String((error && (error.errMsg || error.message)) || error || 'NFC 通讯失败');
  if (/function cannot run on service/i.test(message)) {
    return '当前调试环境无法启动 NFC。请退出真机调试，在微信中打开普通预览版后重试';
  }
  if (error && error.errCode === 13000) return '设备不支持 NFC';
  if (error && error.errCode === 13001) return '请先在系统设置中打开 NFC';
  return message;
}

function hceSupported() {
  return typeof wx.startHCE === 'function' && typeof wx.canIUse === 'function' && wx.canIUse('startHCE');
}

/* ------------------------------------------------------------ NDEF 编码 */

function buildNdef(payload) {
  const body = utf8Encode(JSON.stringify(payload));
  const payloadLength = body.length + 3;
  const short = payloadLength <= 255;
  const headerLength = short ? 4 : 7;
  const message = new Uint8Array(headerLength + payloadLength);
  if (message.length + 2 > MAX_FILE_SIZE) throw new Error('票根与短评超过 NFC 容量，请减少交换数量');
  message[0] = short ? 0xd1 : 0xc1;
  message[1] = 1;
  if (short) {
    message[2] = payloadLength;
  } else {
    message[2] = (payloadLength >>> 24) & 255;
    message[3] = (payloadLength >>> 16) & 255;
    message[4] = (payloadLength >>> 8) & 255;
    message[5] = payloadLength & 255;
  }
  message[headerLength - 1] = 0x54;
  message.set([2, 0x65, 0x6e], headerLength);
  message.set(body, headerLength + 3);
  return message;
}

function textPayload(payload) {
  if (!payload.length || (payload[0] & 0x80)) return null;
  const offset = 1 + (payload[0] & 0x3f);
  return offset <= payload.length ? utf8Decode(payload.slice(offset)) : null;
}

function parseTextNdef(bytes) {
  let offset = 0;
  while (offset + 3 <= bytes.length) {
    const header = bytes[offset++];
    if (header & 0x20) return null; // 分块记录不属于本协议
    const typeLength = bytes[offset++];
    const lengthSize = header & 0x10 ? 1 : 4;
    if (offset + lengthSize > bytes.length) return null;
    let payloadLength = 0;
    for (let i = 0; i < lengthSize; i += 1) payloadLength = payloadLength * 256 + bytes[offset++];
    let idLength = 0;
    if (header & 0x08) {
      if (offset >= bytes.length) return null;
      idLength = bytes[offset++];
    }
    const end = offset + typeLength + idLength + payloadLength;
    if (end > bytes.length) return null;
    const isText = (header & 7) === 1 && typeLength === 1 && bytes[offset] === 0x54;
    offset += typeLength + idLength;
    if (isText) return textPayload(bytes.slice(offset, end));
    offset = end;
    if (header & 0x40) break;
  }
  return null;
}

function textFromMessages(messages) {
  for (const message of messages || []) {
    const records = Array.isArray(message) ? message : (message.records || [message]);
    for (const record of records) {
      if (record && utf8Decode(new Uint8Array(record.type || [])) === 'T') {
        const text = textPayload(new Uint8Array(record.payload || []));
        if (text) return text;
      }
    }
  }
  return null;
}

function decodeMessage(text) {
  try {
    const payload = JSON.parse(text);
    if (payload && payload.v === 1 && typeof payload.trade === 'string' && payload.trade.length <= 120) return payload;
  } catch (error) {
    // 统一报告格式错误
  }
  throw new Error('对方票根数据不完整，请重新出示');
}

function sameCards(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && JSON.stringify(left.slice().sort()) === JSON.stringify(right.slice().sort());
}

function isReceipt(payload, deal) {
  return payload.type === 'ack' && payload.trade === deal.trade && payload.nonce === deal.nonce
    && sameCards(payload.mine, deal.mine) && sameCards(payload.theirs, deal.theirs);
}

/* ------------------------------------------------------------ HCE 标签 */

function capabilitiesFile(writable) {
  return new Uint8Array([
    0, 15, 0x20, 0, TRANSFER_SIZE, 0, TRANSFER_SIZE, 4, 6,
    0xe1, 4, MAX_FILE_SIZE >> 8, MAX_FILE_SIZE & 255, 0, writable ? 0 : 255,
  ]);
}

function ndefFile() {
  const file = new Uint8Array(2 + ndefMessage.length);
  file[0] = ndefMessage.length >> 8;
  file[1] = ndefMessage.length & 255;
  file.set(ndefMessage, 2);
  return file;
}

function matches(bytes, offset, expected) {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

function handleWrite(apdu, callbacks) {
  if (selectedFile !== 2 || !callbacks.onMessage) return SW_REJECTED;
  const offset = apdu[2] * 256 + apdu[3];
  const length = apdu[4];
  if (!length || apdu.length !== length + 5 || length > TRANSFER_SIZE) return SW_WRONG_LENGTH;
  const data = apdu.slice(5);
  if (offset === 0) {
    if (length !== 2) return SW_WRONG_LENGTH;
    const nlen = data[0] * 256 + data[1];
    if (nlen === 0) {
      incoming = { bytes: new Uint8Array(MAX_FILE_SIZE - 2), length: 0 };
      return SW_OK;
    }
    if (!incoming || nlen !== incoming.length) return SW_WRONG_LENGTH;
    const message = incoming.bytes.slice(0, nlen);
    incoming = null;
    try {
      const receipt = callbacks.onMessage(decodeMessage(parseTextNdef(message)));
      if (!receipt) return SW_REJECTED;
      ndefMessage = buildNdef(receipt);
      return SW_OK;
    } catch (error) {
      callbacks.onError && callbacks.onError(error);
      return SW_REJECTED;
    }
  }
  const bodyOffset = offset - 2;
  if (!incoming || bodyOffset < 0 || bodyOffset > incoming.length || bodyOffset + length > incoming.bytes.length) return SW_WRONG_LENGTH;
  incoming.bytes.set(data, bodyOffset);
  incoming.length = Math.max(incoming.length, bodyOffset + length);
  return SW_OK;
}

function handleApdu(apdu, callbacks) {
  if (apdu.length < 4 || apdu[0] !== 0) return SW_NOT_FOUND;
  if (apdu[1] === 0xa4) {
    if (apdu[2] === 4) {
      selectedFile = 0;
      incoming = null;
      return apdu[4] === AID_BYTES.length && matches(apdu, 5, AID_BYTES) ? SW_OK : SW_NOT_FOUND;
    }
    selectedFile = 0;
    if (apdu[2] !== 0 || apdu[3] !== 0x0c || apdu[4] !== 2 || apdu.length < 7) return SW_NOT_FOUND;
    const file = apdu[5] * 256 + apdu[6];
    if (file === 0xe103) selectedFile = 1;
    if (file === 0xe104) selectedFile = 2;
    return selectedFile ? SW_OK : SW_NOT_FOUND;
  }
  if (apdu[1] === 0xd6) return handleWrite(apdu, callbacks);
  if (apdu[1] !== 0xb0 || apdu.length !== 5) return SW_NOT_FOUND;
  const source = selectedFile === 1 ? capabilitiesFile(!!callbacks.onMessage) : selectedFile === 2 ? ndefFile() : null;
  if (!source) return SW_NOT_FOUND;
  const offset = apdu[2] * 256 + apdu[3];
  const length = apdu[4] || 256;
  if (offset >= source.length || length > TRANSFER_SIZE) return SW_WRONG_LENGTH;
  const data = source.slice(offset, offset + length);
  const response = new Uint8Array(data.length + 2);
  response.set(data);
  response.set(SW_OK, data.length);
  return response;
}

function queueHce(operation) {
  const task = hceQueue.then(operation);
  hceQueue = task.catch(() => {});
  return task;
}

function stopHceHardware() {
  if (hceListener) wx.offHCEMessage(hceListener);
  hceListener = null;
  if (!hceActive) return Promise.resolve();
  hceActive = false;
  return new Promise((resolve) => wx.stopHCE({ complete: resolve }));
}

function startPublish(payload, callbacks = {}) {
  let message;
  try {
    if (!hceSupported()) throw new Error('这台设备不支持出示 NFC 标签，请用安卓手机出示票根');
    message = buildNdef(payload);
  } catch (error) {
    return Promise.reject(error);
  }
  const generation = ++hceGeneration;
  stopReader(activeReader);
  return queueHce(async () => {
    await stopHceHardware();
    if (generation !== hceGeneration) throw new Error('NFC 已停止');
    ndefMessage = message;
    selectedFile = 0;
    incoming = null;
    hceListener = (event) => {
      if (generation !== hceGeneration) return;
      if (event.messageType === 1) {
        const response = handleApdu(new Uint8Array(event.data), callbacks);
        wx.sendHCEMessage({ data: toBuffer(response), fail: (error) => callbacks.onError && callbacks.onError(new Error(errorMessage(error))) });
      } else {
        selectedFile = 0;
        incoming = null;
        callbacks.onDeactivated && callbacks.onDeactivated();
      }
    };
    wx.onHCEMessage(hceListener);
    try {
      await new Promise((resolve, reject) => wx.startHCE({ aid_list: [AID], success: resolve, fail: reject }));
      hceActive = true;
      if (generation !== hceGeneration) {
        await stopHceHardware();
        throw new Error('NFC 已停止');
      }
    } catch (error) {
      await stopHceHardware();
      throw new Error(errorMessage(error));
    }
  });
}

function stopPublish() {
  hceGeneration += 1;
  return queueHce(stopHceHardware);
}

/* ------------------------------------------------------------ ISO-DEP 读写 */

function callNfc(target, method, options = {}) {
  return new Promise((resolve, reject) => {
    target[method](Object.assign({}, options, { success: resolve, fail: (error) => reject(new Error(errorMessage(error))) }));
  });
}

function checkSession(session) {
  if (session.cancelled) throw new Error('读卡已停止');
}

async function command(session, bytes, expectedLength) {
  checkSession(session);
  const result = await callNfc(session.isoDep, 'transceive', { data: toBuffer(new Uint8Array(bytes)) });
  checkSession(session);
  const response = new Uint8Array(result.data);
  const size = response.length;
  if (size < 2 || response[size - 2] !== 0x90 || response[size - 1] !== 0) {
    const status = size >= 2 ? response[size - 2].toString(16) + response[size - 1].toString(16).padStart(2, '0') : '空响应';
    throw new Error('对方未接受 NFC 指令（' + status + '），请重新出示票根');
  }
  if (expectedLength !== undefined && size !== expectedLength + 2) throw new Error('NFC 数据传输中断，请保持两台手机贴合后重试');
  return response.slice(0, -2);
}

function readBinary(session, offset, length) {
  return command(session, [0, 0xb0, offset >> 8, offset & 255, length], length);
}

async function selectNdef(session) {
  await callNfc(session.isoDep, 'connect');
  checkSession(session);
  await command(session, [0, 0xa4, 4, 0, 7].concat(AID_BYTES, [0]));
  await command(session, [0, 0xa4, 0, 0x0c, 2, 0xe1, 3]);
  const cc = await readBinary(session, 0, 15);
  if (cc[0] * 256 + cc[1] < 15 || cc[7] !== 4 || cc[8] !== 6 || cc[13] !== 0) throw new Error('对方没有可读取的 NDEF 票根');
  const mle = cc[3] * 256 + cc[4];
  const mlc = cc[5] * 256 + cc[6];
  const maxSize = cc[11] * 256 + cc[12];
  if (mle < 15 || mlc < 2 || maxSize < 2) throw new Error('对方 NFC 容量信息无效');
  session.readSize = Math.min(TRANSFER_SIZE, mle);
  session.writeSize = Math.min(TRANSFER_SIZE, mlc);
  session.maxSize = Math.min(MAX_FILE_SIZE, maxSize);
  session.writable = cc[14] === 0;
  await command(session, [0, 0xa4, 0, 0x0c, 2, cc[9], cc[10]]);
}

async function readMessage(session) {
  const lengthBytes = await readBinary(session, 0, 2);
  const length = lengthBytes[0] * 256 + lengthBytes[1];
  if (!length || length + 2 > session.maxSize) throw new Error('对方还没有出示完整票根，请重试');
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += session.readSize) {
    const chunk = await readBinary(session, offset + 2, Math.min(session.readSize, length - offset));
    bytes.set(chunk, offset);
  }
  return decodeMessage(parseTextNdef(bytes));
}

async function writeDeal(session, deal) {
  const current = await readMessage(session);
  if (isReceipt(current, deal)) return current;
  if (current.type !== 'offer' || current.trade !== deal.trade || !sameCards(current.cards, deal.theirs)) throw new Error('对方的票根已变化，请重新读取并确认');
  if (!current.writeback || !session.writable) throw new Error('请让安卓手机更新到当前预览版后重新出示票根');
  const bytes = buildNdef(deal);
  if (bytes.length + 2 > session.maxSize) throw new Error('对方的 NFC 容量不足');
  await command(session, [0, 0xd6, 0, 0, 2, 0, 0]);
  for (let offset = 0; offset < bytes.length; offset += session.writeSize) {
    const chunk = Array.from(bytes.slice(offset, offset + session.writeSize));
    const fileOffset = offset + 2;
    await command(session, [0, 0xd6, fileOffset >> 8, fileOffset & 255, chunk.length].concat(chunk));
  }
  checkSession(session);
  if (session.callbacks.onCommit && session.callbacks.onCommit() === false) throw new Error('本机未能保存成交进度，请腾出存储空间后重试');
  await command(session, [0, 0xd6, 0, 0, 2, bytes.length >> 8, bytes.length & 255]);
  const receipt = await readMessage(session);
  if (!isReceipt(receipt, deal)) throw new Error('尚未收到成交回执，请保持原选择并重试');
  return receipt;
}

function stopReader(session = activeReader) {
  if (!session || session.cancelled) return;
  session.cancelled = true;
  clearTimeout(session.timer);
  if (session.adapter) {
    session.adapter.offDiscovered(session.listener);
    session.adapter.stopDiscovery({ fail() {} });
  }
  if (session.isoDep) session.isoDep.close({ fail() {} });
  if (activeReader === session) activeReader = null;
}

function startReader(callbacks, deal) {
  stopReader();
  const session = { cancelled: false, busy: false, adapter: null, isoDep: null, callbacks };
  activeReader = session;
  const fail = (error) => {
    if (session.cancelled) return;
    stopReader(session);
    callbacks.onError && callbacks.onError(new Error(errorMessage(error)));
  };
  const deliver = (payload) => {
    if (session.cancelled) return;
    stopReader(session);
    callbacks.onMessage && callbacks.onMessage(payload);
  };
  session.listener = async (event) => {
    if (session.cancelled || session.busy) return;
    session.busy = true;
    try {
      const text = deal ? null : textFromMessages(event.messages);
      if (text) return deliver(decodeMessage(text));
      session.isoDep = session.adapter.getIsoDep();
      await selectNdef(session);
      deliver(deal ? await writeDeal(session, deal) : await readMessage(session));
    } catch (error) {
      fail(error);
    }
  };
  // 等待 HCE 完全停止，避免 Android 的读卡与模拟卡模式同时启动。
  stopPublish().then(() => {
    if (session.cancelled) return;
    try {
      if (typeof wx.getNFCAdapter !== 'function') throw new Error('请更新微信以使用 NFC 读卡');
      const system = wx.getAppBaseInfo ? wx.getAppBaseInfo() : {};
      const device = wx.getDeviceInfo ? wx.getDeviceInfo() : {};
      const version = (system.SDKVersion || '').split('.').map(Number);
      if (device.platform === 'ios' && (version[0] < 3 || (version[0] === 3 && (version[1] < 17 || (version[1] === 17 && version[2] < 5))))) {
        throw new Error('iPhone NFC 需要微信基础库 3.17.5 或更新版本，请更新微信');
      }
      session.adapter = wx.getNFCAdapter();
      session.adapter.onDiscovered(session.listener);
      session.adapter.startDiscovery({
        success() {
          if (session.cancelled) {
            session.adapter.stopDiscovery({ fail() {} });
            return;
          }
          session.timer = setTimeout(() => fail(new Error('读卡已超时，请重新点击读取')), 60000);
          callbacks.onStart && callbacks.onStart();
        },
        fail,
      });
    } catch (error) {
      fail(error);
    }
  }).catch(fail);
  return session;
}

module.exports = {
  hceSupported,
  startPublish,
  stopPublish,
  publishing: () => hceActive,
  startReader,
  stopReader,
  startExchange: (deal, callbacks) => startReader(callbacks, deal),
};
