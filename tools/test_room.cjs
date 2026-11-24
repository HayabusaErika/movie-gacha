/* Run with node tools/test_room.cjs. 只测云函数的纯逻辑，不碰云环境。 */
const assert = require('node:assert/strict');
const path = require('node:path');
const logic = require(path.join(__dirname, '../miniprogram/cloudfunctions/room/logic.js'));

let checks = 0;
function test(name, run) {
  try {
    run();
    checks += 1;
    console.log('PASS ' + name);
  } catch (error) {
    console.error('FAIL ' + name);
    console.error(error);
    process.exitCode = 1;
  }
}

test('邀请码固定 6 位且不含易混字符', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const code = logic.makeCode();
    assert.equal(code.length, 6);
    assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    seen.add(code);
  }
  assert.ok(seen.size > 400, '随机性太差');
  assert.equal(logic.makeCode(() => 0), '222222');
});

test('邀请码标准化接受小写和空格，拒绝错误长度', () => {
  assert.equal(logic.normalizeCode(' ab12cd '), 'AB12CD');
  assert.equal(logic.normalizeCode('AB-12-CD'), 'AB12CD');
  assert.equal(logic.normalizeCode('ABC12'), '');
  assert.equal(logic.normalizeCode('ABCDEFG'), '');
  assert.equal(logic.normalizeCode(null), '');
});

test('邀请文本解析覆盖邀请码、scheme、链接和 scene', () => {
  assert.equal(logic.parseInvite('AB12CD'), 'AB12CD');
  assert.equal(logic.parseInvite('mg-room:ab12cd'), 'AB12CD');
  assert.equal(logic.parseInvite('https://example.com/join?code=ab12cd&from=share'), 'AB12CD');
  assert.equal(logic.parseInvite('pages/room/room?code=AB12CD'), 'AB12CD');
  assert.equal(logic.parseInvite('随便一段话 AB12CD 结尾'), 'AB12CD');
  assert.equal(logic.parseInvite('not-a-code'), '');
});

test('昵称与推荐语按字符截断', () => {
  const longNick = '影'.repeat(40);
  assert.equal(Array.from(logic.cleanNick(longNick)).length, logic.NICK_MAX);
  const longReview = '好'.repeat(200);
  assert.equal(Array.from(logic.cleanReview(longReview)).length, logic.REVIEW_MAX);
  assert.equal(logic.cleanReview('  写  了   一句  '), '写 了 一句');
  assert.equal(logic.cleanNick(''), '');
});

test('影片字段白名单：只保留需要的字段', () => {
  const film = logic.normalizeFilm({
    id: '1292052',
    title: '肖申克的救赎',
    year: '1994',
    rating: '9.7',
    genres: ['犯罪', '剧情', '剧情2', '剧情3'],
    directors: ['弗兰克·德拉邦特', '第二导演', '第三导演'],
    poster: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2936346968.jpg',
    secret: '不该被写入',
    atk: 999,
  });
  assert.deepEqual(Object.keys(film).sort(), ['directors', 'genres', 'id', 'poster', 'rating', 'title', 'year']);
  assert.equal(film.genres.length, 3);
  assert.equal(film.directors.length, 2);
  assert.equal(film.secret, undefined);
  assert.equal(film.id, '1292052');
});

test('影片校验拒绝无效编号、空标题和非 https 海报', () => {
  assert.throws(() => logic.normalizeFilm({ id: 'abc', title: 'x' }), /电影编号无效/);
  assert.throws(() => logic.normalizeFilm({ id: '1292052', title: '   ' }), /电影名称无效/);
  const film = logic.normalizeFilm({
    id: '1292052', title: 'x', rating: 'nine', year: '199', poster: 'http://evil/x.jpg',
    genres: 'not-an-array', directors: null,
  });
  assert.equal(film.rating, '');
  assert.equal(film.year, '');
  assert.equal(film.poster, '');
  assert.deepEqual(film.genres, []);
  assert.deepEqual(film.directors, []);
});

test('影片键按房间与影片编号唯一', () => {
  assert.equal(logic.filmKey('AB12CD', '1292052'), 'AB12CD:1292052');
  assert.notEqual(logic.filmKey('AB12CD', '1'), logic.filmKey('AB12CE', '1'));
});

test('容量常量与应用层一致', () => {
  assert.equal(logic.MAX_MEMBERS, 8);
  assert.equal(logic.MAX_FILMS, 60);
  assert.equal(logic.REVIEW_MAX, 80);
  assert.equal(logic.CODE_LENGTH, 6);
});

console.log(checks + ' room logic checks passed');
