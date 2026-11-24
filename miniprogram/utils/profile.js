/** 昵称：默认取微信昵称，取不到时让用户自己填。 */
const KEY = 'movie-nick';

function cached() {
  try { return wx.getStorageSync(KEY) || ''; } catch (error) { return ''; }
}

function save(nick) {
  try { wx.setStorageSync(KEY, String(nick || '').trim()); } catch (error) {}
}

function wechatNickname() {
  return new Promise((resolve, reject) => {
    if (typeof wx.getUserProfile !== 'function') {
      reject(new Error('请手动填写昵称'));
      return;
    }
    wx.getUserProfile({
      desc: '用于在放映室里显示昵称',
      success(response) {
        const nick = response && response.userInfo && response.userInfo.nickName;
        if (nick) {
          save(nick);
          resolve(nick);
        } else {
          reject(new Error('请手动填写昵称'));
        }
      },
      fail() {
        reject(new Error('请手动填写昵称'));
      },
    });
  });
}

module.exports = { cached, save, wechatNickname };
