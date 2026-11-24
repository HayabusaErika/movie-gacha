/** 放映室客户端：封装云函数调用与邀请码解析。 */
const config = require('../config');
let inited = false;

function init() {
  if (inited) return;
  if (!wx.cloud) throw new Error('当前微信版本不支持云开发，请更新微信');
  let app = null;
  try { app = getApp(); } catch (error) {}
  if (!app || !app.globalData || !app.globalData.cloudInited) {
    const options = { traceUser: true };
    if (config && config.cloudEnvId) options.env = config.cloudEnvId;
    wx.cloud.init(options);
    if (app && app.globalData) app.globalData.cloudInited = true;
  }
  inited = true;
}

function friendlyError(error) {
  const text = String((error && (error.message || error.errMsg)) || error || '放映室服务暂时不可用');
  if (/-601034|没有权限，请先开通云开发/.test(text)) return '放映室需要先在云开发控制台开通环境';
  if (/FunctionName|cloud function not found|-501000/i.test(text)) return '云函数 room 还没有部署';
  if (/collection.*not exist/i.test(text)) return '房间的数据集合还没有创建';
  return text;
}

function call(action, data) {
  init();
  return wx.cloud.callFunction({
    name: 'room',
    data: Object.assign({ action }, data || {}),
  }).then((response) => {
    const payload = response && response.result ? response.result : {};
    if (!payload.ok) throw new Error(payload.error || '放映室服务暂时不可用');
    return payload;
  }, (error) => { throw new Error(friendlyError(error)); });
}

/** 与云函数 logic.parseInvite 保持一致：支持邀请码、mg-room:XXXXXX、带 code 参数的链接。 */
function parseInvite(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  const query = text.match(/[?&]code=([0-9A-Za-z]{6})(?:[&#]|$)/);
  if (query) return query[1].toUpperCase();
  const scheme = text.match(/^mg-room:([0-9A-Za-z]{6})$/i);
  if (scheme) return scheme[1].toUpperCase();
  const compact = text.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return compact.length === 6 ? compact : '';
}

module.exports = { init, call, parseInvite };
