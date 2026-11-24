#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把抓取到的豆瓣数据（data/movies.jsonl）编译成客户端用的片库。

    python3 tools/build_data.py

卡片没有稀有度、没有战斗数值 —— 只有电影本身的信息。

输出：
    web/data/library.json         浏览器 Demo 的片库（抽卡 / 每日推荐 / 交换）
    miniprogram/data/library.js   小程序片库
    android/assets/library.json   安卓 App 片库（id 为 int，方便原生端处理）
"""
import argparse
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data', 'movies.jsonl')

CORE_GENRES = {
    '剧情', '喜剧', '动作', '科幻', '动画', '爱情', '犯罪', '悬疑', '惊悚', '战争',
    '冒险', '奇幻', '恐怖', '西部', '武侠', '灾难', '家庭', '传记', '历史', '运动',
    '古装', '黑色电影',
}
DROP_GENRES = {'纪录片', '音乐', '歌舞', '短片', '情色'}
BAD_TITLE = re.compile(r'第[一二三四五六七八九十\d]{1,2}季|最终季|完结篇|特别篇|演唱会|LIVE|音乐会|开幕式|直播|幕后|制作特辑|花絮|综艺|Skam|Season')


def load_rows():
    if not os.path.exists(SRC):
        raise SystemExit('缺少 %s，请先运行 python3 tools/fetch_douban.py charts --types all' % SRC)
    with open(SRC, encoding='utf-8') as handle:
        return [json.loads(line) for line in handle if line.strip()]


def usable(row):
    if not row.get('title') or not row.get('rating') or not row.get('poster'):
        return False
    if (row.get('votes') or 0) < 20000:
        return False
    if BAD_TITLE.search(row['title']):
        return False
    genres = set(row.get('genres') or [])
    if not genres & CORE_GENRES or genres & DROP_GENRES:
        return False
    return True


def entry(row):
    directors = row.get('directors') or []
    comment = (row.get('short_comment') or '').strip()
    item = {
        'id': str(row['id']),
        'title': row['title'],
        'year': row.get('year') or '',
        'rating': row['rating'],
        'genres': (row.get('genres') or [])[:3],
        'directors': directors[:1],
        'poster': row['poster'],
    }
    if comment:
        item['comment'] = comment
    if row.get('intro'):
        item['intro'] = short_intro(row['intro'])
    return item


def short_intro(text):
    text = re.sub(r'（[^（）]*饰[^（）]*）|\([^()]*饰[^()]*\)', '', text)
    text = re.sub(r'\s+', ' ', text).split('©')[0].strip()
    sentences = re.findall(r'[^。！？]+[。！？]?', text)
    excerpt = ''.join(sentences[:2]).strip()
    return excerpt if len(excerpt) <= 100 else excerpt[:99].rstrip('，、； ') + '…'


def write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(',', ':'))


def write_js(path, comment, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    body = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write('// %s\nmodule.exports = %s;\n' % (comment, body))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=['all', 'miniprogram', 'web', 'android'], default='all')
    args = parser.parse_args()
    rows = [row for row in load_rows() if usable(row)]
    rows.sort(key=lambda row: (-float(row['rating']), -(row.get('votes') or 0)))
    library = [entry(row) for row in rows]

    if args.target in ('all', 'web'):
        write_json(os.path.join(ROOT, 'web', 'data', 'library.json'), library)
    if args.target in ('all', 'miniprogram'):
        write_js(os.path.join(ROOT, 'miniprogram', 'data', 'library.js'),
                 '电影片库 %d 部（由 tools/build_data.py 生成）' % len(library), library)
    if args.target in ('all', 'android'):
        android = [dict(item, id=int(item['id'])) for item in library]
        write_json(os.path.join(ROOT, 'android', 'assets', 'library.json'), android)
    print('片库 %d 部，已写入 %s' % (len(library), args.target))


if __name__ == '__main__':
    main()
