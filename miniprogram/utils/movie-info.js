const CACHE_KEY = 'gw-movie-info-v1';
const pending = new Map();
let cache = {};
try {
  cache = wx.getStorageSync(CACHE_KEY) || {};
} catch (error) {}

function shortIntro(value) {
  const text = String(value || '')
    .replace(/（[^（）]*饰[^（）]*）|\([^()]*饰[^()]*\)/g, '')
    .replace(/\s+/g, ' ').split('©')[0].trim();
  const sentences = text.match(/[^。！？]+[。！？]?/g) || [];
  const excerpt = sentences.slice(0, 2).join('').trim();
  const characters = Array.from(excerpt);
  return characters.length > 100 ? characters.slice(0, 99).join('').replace(/[，、；\s]+$/, '') + '…' : excerpt;
}

function cachedIntro(card) {
  return shortIntro(card.intro || (cache[card.id] && cache[card.id].intro));
}

function introduction(card) {
  const intro = cachedIntro(card);
  if (intro) return intro;
  const genres = (card.genres || []).slice(0, 2).join('、');
  const director = (card.directors || [])[0];
  return '《' + card.title + '》' + (card.year ? '于 ' + card.year + ' 年上映' : '是一部电影')
    + (genres ? '，类型为' + genres : '') + '。' + (director ? '由' + director + '执导。' : '');
}

function load(card) {
  if (cachedIntro(card)) return Promise.resolve(cachedIntro(card));
  if (pending.has(card.id)) return pending.get(card.id);
  const request = new Promise((resolve, reject) => {
    wx.request({
      url: 'https://m.douban.com/rexxar/api/v2/movie/' + encodeURIComponent(card.id),
      timeout: 8000,
      success(response) {
        const data = response.data || {};
        const intro = typeof data.intro === 'string' ? shortIntro(data.intro) : '';
        if (response.statusCode !== 200 || String(data.id) !== card.id || !intro) {
          reject(new Error('暂无剧情简介'));
          return;
        }
        cache[card.id] = { intro };
        try { wx.setStorageSync(CACHE_KEY, cache); } catch (error) {}
        resolve(intro);
      },
      fail: reject,
    });
  }).finally(() => pending.delete(card.id));
  pending.set(card.id, request);
  return request;
}

module.exports = { shortIntro, cachedIntro, introduction, load };
