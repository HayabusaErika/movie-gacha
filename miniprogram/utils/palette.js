const CACHE_KEY = 'gw-movie-colors-v1';
const pending = new Map();
let cache = {};
try {
  cache = wx.getStorageSync(CACHE_KEY) || {};
} catch (error) {}

function blend(color, target, weight) {
  return color.map((channel, index) => Math.round(channel * (1 - weight) + target[index] * weight));
}

function rgb(color) {
  return 'rgb(' + color.join(',') + ')';
}

function theme(color) {
  const hex = /^#[\da-f]{6}$/i.test(color) ? color : '#35475c';
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  const paper = blend(channels, [255, 253, 248], 0.9);
  const ink = blend(channels, [22, 24, 28], 0.8);
  const accent = blend(channels, [25, 27, 31], 0.65);
  return '--ticket-paper:' + rgb(paper) + ';--ticket-ink:' + rgb(ink)
    + ';--ticket-accent:' + rgb(accent) + ';--ticket-color:' + hex;
}

function dominantColor(pixels) {
  const buckets = new Map();
  const total = [0, 0, 0];
  let opaqueCount = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] < 200) continue;
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    total[0] += red;
    total[1] += green;
    total[2] += blue;
    opaqueCount += 1;
    const lightness = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    if (lightness < 22 || lightness > 235) continue;
    const saturation = (Math.max(red, green, blue) - Math.min(red, green, blue)) / 255;
    const key = [red >> 5, green >> 5, blue >> 5].join(',');
    const bucket = buckets.get(key) || { score: 0, count: 0, sum: [0, 0, 0] };
    bucket.score += 1 + saturation * 2;
    bucket.count += 1;
    bucket.sum[0] += red;
    bucket.sum[1] += green;
    bucket.sum[2] += blue;
    buckets.set(key, bucket);
  }
  const best = Array.from(buckets.values()).sort((left, right) => right.score - left.score)[0];
  if (!opaqueCount) return '#35475c';
  const channels = best ? best.sum.map((channel) => channel / best.count) : total.map((channel) => channel / opaqueCount);
  return '#' + channels.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('');
}

function cachedColor(url) {
  return cache[url] || '';
}

function fromPoster(url) {
  if (cache[url]) return Promise.resolve(cache[url]);
  if (pending.has(url)) return pending.get(url);
  if (!url || !wx.createOffscreenCanvas) return Promise.reject(new Error('海报暂不可取色'));
  const request = new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: url,
      fail: reject,
      success(info) {
        let canvas;
        let image;
        try {
          canvas = wx.createOffscreenCanvas({ type: '2d', width: 32, height: 48 });
          image = canvas.createImage();
        } catch (error) {
          reject(error);
          return;
        }
        const timeout = setTimeout(() => reject(new Error('海报取色超时')), 8000);
        image.onerror = (error) => { clearTimeout(timeout); reject(error); };
        image.onload = () => {
          clearTimeout(timeout);
          try {
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0, 32, 48);
            const color = dominantColor(context.getImageData(0, 0, 32, 48).data);
            cache[url] = color;
            try { wx.setStorageSync(CACHE_KEY, cache); } catch (error) {}
            resolve(color);
          } catch (error) { reject(error); }
        };
        try {
          image.src = info.path;
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      },
    });
  }).finally(() => pending.delete(url));
  pending.set(url, request);
  return request;
}

module.exports = { theme, dominantColor, cachedColor, fromPoster };
