/**
 * 房间服务：创建/加入房间、共享影片墙、房间内抽卡、邀请二维码。
 *
 * 集合：
 *   rooms          { code, owner, title, createdAt, updatedAt }
 *   room_members   { roomCode, openid, nick, avatar, joinedAt }
 *   room_films     { roomCode, filmId, title, genres, directors, rating, year, poster,
 *                    source: 'draw'|'library', review, addedBy, addedByName, createdAt }
 */
const cloud = require('wx-server-sdk');
const logic = require('./logic');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const ROOMS = 'rooms';
const MEMBERS = 'room_members';
const FILMS = 'room_films';

async function ensureCollections() {
  for (const name of [ROOMS, MEMBERS, FILMS]) {
    try {
      await db.createCollection(name);
    } catch (error) {
      // 已存在
    }
  }
}

async function findRoom(code) {
  const result = await db.collection(ROOMS).where({ code }).limit(1).get();
  return result.data[0] || null;
}

async function findMember(code, openid) {
  const result = await db.collection(MEMBERS).where({ roomCode: code, openid }).limit(1).get();
  return result.data[0] || null;
}

async function listMembers(code) {
  const result = await db.collection(MEMBERS).where({ roomCode: code }).limit(50).get();
  return result.data
    .map((member) => ({
      openid: member.openid,
      nick: member.nick || '影迷',
      avatar: member.avatar || '',
      joinedAt: member.joinedAt || 0,
    }))
    .sort((left, right) => left.joinedAt - right.joinedAt);
}

async function listFilms(code) {
  const result = await db.collection(FILMS).where({ roomCode: code }).limit(200).get();
  return result.data
    .map((film) => ({
      key: film._id,
      id: film.filmId,
      title: film.title,
      genres: film.genres || [],
      directors: film.directors || [],
      rating: film.rating || '',
      year: film.year || '',
      poster: film.poster || '',
      source: film.source === 'draw' ? 'draw' : 'library',
      review: film.review || '',
      addedBy: film.addedBy,
      addedByName: film.addedByName || '影迷',
      createdAt: film.createdAt || 0,
    }))
    .sort((left, right) => left.createdAt - right.createdAt);
}

async function snapshot(code, openid) {
  const room = await findRoom(code);
  if (!room) throw new Error('房间不存在或已关闭');
  return {
    ok: true,
    me: openid,
    room: { code: room.code, owner: room.owner, title: room.title || '放映室' },
    members: await listMembers(code),
    films: await listFilms(code),
  };
}

async function upsertMember(code, openid, nick, avatar) {
  const member = await findMember(code, openid);
  const data = { roomCode: code, openid, nick: logic.cleanNick(nick) || '影迷', avatar: String(avatar || '').slice(0, 300) };
  if (member) {
    await db.collection(MEMBERS).doc(member._id).update({ data });
    return Object.assign({}, member, data);
  }
  const created = Object.assign({}, data, { joinedAt: Date.now() });
  const added = await db.collection(MEMBERS).add({ data: created });
  return Object.assign({ _id: added._id }, created);
}

async function generateCode() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = logic.makeCode();
    if (!(await findRoom(code))) return code;
  }
  throw new Error('邀请码生成失败，请重试');
}

async function createRoom(openid, event) {
  const code = await generateCode();
  const now = Date.now();
  await db.collection(ROOMS).add({
    data: {
      code,
      owner: openid,
      title: logic.cleanTitle(event.title) || '放映室',
      createdAt: now,
      updatedAt: now,
    },
  });
  await upsertMember(code, openid, event.nick, event.avatar);
  return snapshot(code, openid);
}

async function joinRoom(openid, event) {
  const code = logic.normalizeCode(event.code);
  if (!code) throw new Error('邀请码格式不对');
  const room = await findRoom(code);
  if (!room) throw new Error('房间不存在或已关闭');
  const members = await listMembers(code);
  const joined = members.some((member) => member.openid === openid);
  if (!joined && members.length >= logic.MAX_MEMBERS) throw new Error('房间已满');
  await upsertMember(code, openid, event.nick, event.avatar);
  await db.collection(ROOMS).doc(room._id).update({ data: { updatedAt: Date.now() } });
  return snapshot(code, openid);
}

async function addFilm(openid, event) {
  const code = logic.normalizeCode(event.code);
  if (!code) throw new Error('邀请码格式不对');
  const room = await findRoom(code);
  if (!room) throw new Error('房间不存在或已关闭');
  const film = logic.normalizeFilm(event.film);
  const member = await findMember(code, openid);
  if (!member) throw new Error('请先加入房间');

  const existing = await db.collection(FILMS).where({ roomCode: code, filmId: film.id }).limit(1).get();
  if (existing.data.length) return { ok: true, duplicate: true, film: existing.data[0] };

  const count = await db.collection(FILMS).where({ roomCode: code }).count();
  if (count.total >= logic.MAX_FILMS) throw new Error('房间里的票根已经放满');

  await db.collection(FILMS).add({
    data: Object.assign({}, film, {
      roomCode: code,
      filmId: film.id,
      source: event.source === 'draw' ? 'draw' : 'library',
      review: logic.cleanReview(event.review),
      addedBy: openid,
      addedByName: member.nick || '影迷',
      createdAt: Date.now(),
    }),
  });
  await db.collection(ROOMS).doc(room._id).update({ data: { updatedAt: Date.now() } });
  return { ok: true, duplicate: false };
}

async function leaveRoom(openid, event) {
  const code = logic.normalizeCode(event.code);
  const member = code ? await findMember(code, openid) : null;
  if (member) await db.collection(MEMBERS).doc(member._id).remove();
  return { ok: true };
}

async function makeQrCode(openid, event) {
  const code = logic.normalizeCode(event.code);
  const room = code ? await findRoom(code) : null;
  if (!room) throw new Error('房间不存在或已关闭');
  try {
    const result = await cloud.openapi.wxacode.getUnlimited({
      scene: code,
      page: 'pages/room/room',
      checkPath: false,
      width: 280,
    });
    const upload = await cloud.uploadFile({
      cloudPath: 'room-qr/' + code + '.png',
      fileContent: result.buffer,
    });
    return { ok: true, fileID: upload.fileID || '' };
  } catch (error) {
    // 没有小程序码权限时退回邀请码与分享卡片
    return { ok: true, fileID: '', error: String(error.message || error) };
  }
}

exports.main = async (event) => {
  const context = cloud.getWXContext();
  const openid = context.OPENID || '';
  try {
    if (!openid) throw new Error('无法识别用户身份');
    await ensureCollections();
    const action = String((event && event.action) || '');
    if (action === 'create') return await createRoom(openid, event);
    if (action === 'join') return await joinRoom(openid, event);
    if (action === 'snapshot') {
      const code = logic.normalizeCode(event.code);
      if (!code) throw new Error('邀请码格式不对');
      return await snapshot(code, openid);
    }
    if (action === 'addFilm') return await addFilm(openid, event);
    if (action === 'leave') return await leaveRoom(openid, event);
    if (action === 'qrcode') return await makeQrCode(openid, event);
    return { ok: false, error: '未知操作' };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
};
