/**
 * 房间服务的纯逻辑：邀请码、输入清洗、影片校验。
 * 不依赖 wx-server-sdk，便于在 Node 里直接跑单测。
 */

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const NICK_MAX = 20;
const REVIEW_MAX = 80;
const TITLE_MAX = 30;
const MAX_MEMBERS = 8;
const MAX_FILMS = 60;

function makeCode(random = Math.random) {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return code;
}

/** 只保留字母数字并转大写；不是 6 位就返回空串。 */
function normalizeCode(value) {
  const text = String(value == null ? '' : value)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
  return text.length === CODE_LENGTH ? text : '';
}

/** 支持邀请码、mg-room:XXXXXX、以及带 code= 参数的链接或小程序码 scene。 */
function parseInvite(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  const query = text.match(/[?&]code=([0-9A-Za-z]{6})(?:[&#]|$)/);
  if (query) return query[1].toUpperCase();
  const scheme = text.match(/^mg-room:([0-9A-Za-z]{6})$/i);
  if (scheme) return scheme[1].toUpperCase();
  return normalizeCode(text);
}

function cleanText(value, max) {
  return Array.from(String(value == null ? '' : value).trim()).slice(0, max).join('');
}

function cleanNick(value) {
  return cleanText(value, NICK_MAX).replace(/\s+/g, ' ');
}

function cleanReview(value) {
  return cleanText(value, REVIEW_MAX).replace(/\s+/g, ' ');
}

function cleanTitle(value) {
  return cleanText(value, TITLE_MAX).replace(/\s+/g, ' ');
}

/** 只接受片库里需要的字段，长度和格式都做白名单校验。 */
function normalizeFilm(input) {
  const film = input || {};
  const id = String(film.id == null ? (film.subjectId == null ? '' : film.subjectId) : film.id).trim();
  if (!/^\d{4,9}$/.test(id)) throw new Error('电影编号无效');
  const title = cleanText(film.title, 80);
  if (!title) throw new Error('电影名称无效');
  const genres = Array.isArray(film.genres)
    ? film.genres.slice(0, 3).map((item) => cleanText(item, 12)).filter(Boolean)
    : [];
  const directors = Array.isArray(film.directors)
    ? film.directors.slice(0, 2).map((item) => cleanText(item, 40)).filter(Boolean)
    : [];
  const rating = /^\d{1,2}(\.\d)?$/.test(String(film.rating || '')) ? String(film.rating) : '';
  const year = /^\d{4}$/.test(String(film.year || '')) ? String(film.year) : '';
  const poster = /^https:\/\/\S+$/.test(String(film.poster || '')) ? String(film.poster) : '';
  return { id, title, genres, directors, rating, year, poster };
}

function filmKey(roomCode, filmId) {
  return roomCode + ':' + filmId;
}

module.exports = {
  CODE_ALPHABET,
  CODE_LENGTH,
  NICK_MAX,
  REVIEW_MAX,
  TITLE_MAX,
  MAX_MEMBERS,
  MAX_FILMS,
  makeCode,
  normalizeCode,
  parseInvite,
  cleanText,
  cleanNick,
  cleanReview,
  cleanTitle,
  normalizeFilm,
  filmKey,
};
