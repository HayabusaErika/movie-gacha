/** 文案与数据的本地存档：收藏、导入的卡片、海报 fileID 缓存。 */
const KEY = 'gw-movie-v1';
const POSTER_KEY = 'gw-movie-posters-v1';

function load() {
  try {
    return wx.getStorageSync(KEY) || {};
  } catch (error) {
    return {};
  }
}

function save(state) {
  try {
    wx.setStorageSync(KEY, state);
    return true;
  } catch (error) {
    return false;
  }
}

function loadPosters() {
  try {
    return wx.getStorageSync(POSTER_KEY) || {};
  } catch (error) {
    return {};
  }
}

function savePosters(map) {
  try {
    wx.setStorageSync(POSTER_KEY, map);
  } catch (error) {
    // 忽略
  }
}

module.exports = { load, save, loadPosters, savePosters };
