#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
豆瓣电影 —— 内部 JSON 接口抓取器

背景：豆瓣官方 API（api.douban.com/v2）已于 2019 年关停，现在返回
403 invalid_apikey；App 端 frodo API 需要 apikey + 签名。移动端公开接口
m.douban.com/rexxar/api/v2/movie/<id> 可读取剧情简介（2026-11-14 实测）。

仍然可用的是 movie.douban.com 的 `j/` 一族的内部接口（免登录、免签名）：
    /j/chart/top_list          榜单列表（按类型 + 评分区间，分页）
    /j/chart/top_list_count    榜单数量统计
    /j/subject_abstract        单片概要（导演/时长/短评等）
    /j/new_search_subjects     搜索/筛选（标签、评分区间、排序）
    /j/subject_suggest         搜索联想

注意：/j/top250 这个老接口已 404，Top250 只能解析 HTML 页面；
详情页 HTML（/subject/<id>/）会 302 跳到 sec.douban.com 风控墙，
因此单片详情请走 /j/subject_abstract。

仅供个人学习/非商业用途，请保持低速率、遵守站点条款。

用法：
    python3 tools/fetch_douban.py probe          # 体检所有接口
    python3 tools/fetch_douban.py top250         # 抓 Top250
    python3 tools/fetch_douban.py charts --types 11,24,5 --intervals 100:90
    python3 tools/fetch_douban.py search --tags 科幻 --min-rating 8.5
    python3 tools/fetch_douban.py enrich --limit 50   # 补导演/时长/短评
    python3 tools/fetch_douban.py intros --limit 50   # 补剧情简介
    python3 tools/fetch_douban.py export         # 导出 CSV
    python3 tools/fetch_douban.py stats
"""
import argparse
import csv
import html as htmlmod
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTDIR = os.path.join(ROOT, "data")
JSONL = os.path.join(OUTDIR, "movies.jsonl")
CSVPATH = os.path.join(OUTDIR, "movies.csv")

BASE = "https://movie.douban.com"

# 实测得到的类型 ID 映射（豆瓣改过编号，旧文档不可信）
TYPE_MAP = {
    1: "纪录片", 2: "传记", 3: "犯罪", 4: "历史", 5: "动作", 6: "情色",
    7: "歌舞", 8: "儿童", 10: "悬疑", 11: "剧情", 12: "灾难", 13: "爱情",
    14: "音乐", 15: "冒险", 16: "奇幻", 17: "科幻", 18: "运动", 19: "惊悚",
    20: "恐怖", 22: "战争", 23: "短片", 24: "喜剧", 25: "动画", 26: "同性",
    27: "西部", 28: "家庭", 29: "武侠", 30: "古装", 31: "黑色电影",
}

INTERVALS = ["100:90", "90:80", "80:70", "70:60", "60:50",
             "50:40", "40:30", "30:20", "20:10", "10:0"]

ENDPOINTS = {
    "movie_intro": "https://m.douban.com/rexxar/api/v2/movie",
    "chart/top_list": BASE + "/j/chart/top_list",
    "chart/top_list_count": BASE + "/j/chart/top_list_count",
    "subject_abstract": BASE + "/j/subject_abstract",
    "new_search_subjects": BASE + "/j/new_search_subjects",
    "subject_suggest": BASE + "/j/subject_suggest",
}


class Fetcher:
    """带重试 + 礼貌节流的 HTTP 客户端。"""

    def __init__(self, delay=1.2, retries=3, timeout=20, cookie=None, verbose=True):
        self.delay = delay
        self.retries = retries
        self.timeout = timeout
        self.verbose = verbose
        self.cookie = cookie or os.environ.get("DOUBAN_COOKIE", "")
        self._last = 0.0
        self.stats = {"requests": 0, "retries": 0, "bytes": 0}

    def headers(self, referer=BASE + "/"):
        h = {
            "User-Agent": UA,
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": referer,
        }
        if self.cookie:
            h["Cookie"] = self.cookie
        return h

    def _throttle(self):
        wait = self.delay - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)

    def get(self, url, referer=BASE + "/"):
        last_err = None
        for attempt in range(1, self.retries + 1):
            self._throttle()
            self._last = time.time()
            try:
                req = urllib.request.Request(url, headers=self.headers(referer))
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    body = r.read()
                self.stats["requests"] += 1
                self.stats["bytes"] += len(body)
                return body.decode("utf-8", "replace")
            except urllib.error.HTTPError as e:
                last_err = e
                self.stats["retries"] += 1
                if self.verbose:
                    print(f"    ! HTTP {e.code} (第{attempt}次) {url}", file=sys.stderr)
                # 4xx 不重试（除了 429）
                if e.code not in (429, 500, 502, 503) :
                    break
            except Exception as e:  # 网络错误
                last_err = e
                self.stats["retries"] += 1
                if self.verbose:
                    print(f"    ! {type(e).__name__} (第{attempt}次) {url}", file=sys.stderr)
            time.sleep(1.5 * attempt)
        raise last_err

    def get_json(self, url, referer=BASE + "/"):
        return json.loads(self.get(url, referer))


# ---------------------------------------------------------------- 解析

def _clean(s):
    if not s:
        return ""
    s = htmlmod.unescape(s)
    s = s.replace("\u00a0", " ")
    s = re.sub(r"\s+", " ", s).strip()
    return s.strip(" /")


def _split_titles(raw_titles):
    """Top250 的 title 段：第一个是中文名，第二个形如 ' / English Title'。"""
    zh, en = "", ""
    for i, t in enumerate(raw_titles):
        name = _clean(t)
        name = name.lstrip("/ ").strip()
        if not name:
            continue
        if i == 0:
            zh = name
        elif not en:
            en = name
    return zh, en


def parse_top250(html, start_rank=1):
    """解析 movie.douban.com/top250 页面 -> [record]。"""
    records = []
    # 按 <div class="item"> 切块
    blocks = re.split(r'<div class="item">', html)[1:]
    for rank_off, blk in enumerate(blocks):
        blk = blk.split('<div class="item">')[0]

        m = re.search(r'href="https://movie\.douban\.com/subject/(\d+)/"', blk)
        if not m:
            continue
        sid = m.group(1)

        titles = re.findall(r'<span class="title">(.*?)</span>', blk, re.S)
        zh, en = _split_titles(titles)

        other = ""
        mo = re.search(r'<span class="other">(.*?)</span>', blk, re.S)
        if mo:
            other = _clean(re.sub(r"<[^>]+>", "", mo.group(1)))

        # 海报
        poster = ""
        mp = re.search(r'<img[^>]+(?:data-src|src)="([^"]+)"', blk)
        if mp:
            poster = mp.group(1)

        # 排名
        rank = start_rank + rank_off
        mr = re.search(r"<em>(\d+)</em>", blk)
        if mr:
            rank = int(mr.group(1))

        # 评分 / 评价人数
        rating = ""
        mrt = re.search(r'property="v:average">([\d.]+)<', blk)
        if mrt:
            rating = mrt.group(1)
        votes = 0
        mv = re.search(r"(\d+)人评价", blk)
        if mv:
            votes = int(mv.group(1))

        # 一句话短评（豆瓣 2024+ 去掉了 class="inq"，只剩裸 span）
        quote = ""
        mq = (re.search(r'<p class="quote">\s*<span[^>]*>(.*?)</span>', blk, re.S)
              or re.search(r'<span class="inq">(.*?)</span>', blk, re.S))
        if mq:
            quote = _clean(mq.group(1))

        # <p> 段：导演/主演 + 年份/地区/类型
        year, regions, genres = "", [], []
        directors, actors = [], []
        mp2 = re.search(r"<p[^>]*>(.*?)</p>", blk, re.S)
        if mp2:
            raw = re.sub(r"<br\s*/?>", "|", mp2.group(1))
            raw = re.sub(r"<[^>]+>", "", raw)
            parts = [_clean(p) for p in raw.split("|")]
            if parts:
                head = parts[0]
                md = re.search(r"导演:\s*(.*?)(?:\s*主演:|$)", head)
                if md:
                    directors = [d.strip() for d in re.split(r"[/、]", md.group(1)) if d.strip()]
                ma = re.search(r"主演:\s*(.*)$", head)
                if ma:
                    actors = [a.strip() for a in re.split(r"[/、]", ma.group(1)) if a.strip()]
            if len(parts) > 1:
                tail = [p.strip() for p in parts[1].split("/") if p.strip()]
                if tail:
                    year = tail[0]
                if len(tail) > 1:
                    regions = [r.strip() for r in tail[1].split() if r.strip()]
                if len(tail) > 2:
                    genres = [g.strip() for g in tail[2].split() if g.strip()]

        records.append({
            "id": sid,
            "title": zh,
            "original_title": en,
            "other_titles": other,
            "year": year,
            "rating": rating,
            "votes": votes,
            "genres": genres,
            "regions": regions,
            "directors": directors,
            "actors": actors,
            "duration": "",
            "poster": poster,
            "url": f"{BASE}/subject/{sid}/",
            "rank": rank,
            "year_source": "top250",
            "short_comment": quote,
        })
    return records


def parse_chart_items(items):
    """解析 /j/chart/top_list 的 JSON -> [record]。"""
    out = []
    for it in items:
        rating = it.get("score") or (it.get("rating") or [""])[0]
        out.append({
            "id": str(it.get("id", "")),
            "title": it.get("title", ""),
            "original_title": "",
            "other_titles": "",
            "year": (it.get("release_date") or "")[:4],
            "release_date": it.get("release_date", ""),
            "rating": rating or "",
            "votes": it.get("vote_count", 0),
            "genres": it.get("types", []) or [],
            "regions": it.get("regions", []) or [],
            "directors": [],
            "actors": it.get("actors", []) or [],
            "duration": "",
            "poster": it.get("cover_url", ""),
            "url": it.get("url") or f"{BASE}/subject/{it.get('id')}/",
            "rank": it.get("rank", 0),
            "year_source": "release_date",
            "short_comment": "",
        })
    return out


def parse_search_items(items):
    """解析 /j/new_search_subjects -> [record]。"""
    out = []
    for it in items:
        url = it.get("url", "")
        m = re.search(r"/subject/(\d+)/", url)
        out.append({
            "id": m.group(1) if m else "",
            "title": it.get("title", ""),
            "original_title": "",
            "other_titles": "",
            "year": "",
            "release_date": "",
            "rating": it.get("rate", "") or "",
            "votes": 0,
            "genres": [],
            "regions": [],
            "directors": it.get("directors", []) or [],
            "actors": it.get("casts", []) or [],
            "duration": "",
            "poster": it.get("cover", ""),
            "url": url,
            "rank": 0,
            "short_comment": "",
        })
    return out


def parse_subject_abstract(subj):
    """/j/subject_abstract -> 补全字段（不含 id 时由调用方填）。"""
    title = (subj.get("title", "") or "").replace("\u200e", "").replace("\u200f", "")
    # title 形如 "肖申克的救赎 The Shawshank Redemption (1994)" 或 "霸王别姬 (1993)"
    title = re.sub(r"\s*\((\d{4})\)\s*$", "", title).strip()
    # 先剥掉结尾年份，再拆中/英名
    year = subj.get("release_year", "")
    if not year:
        m = re.search(r"\((\d{4})\)\s*$", title)
        if m:
            year = m.group(1)
    zh = title
    m = re.match(r"^(.*?)\s+([A-Za-z].*?)(?:\s*\((\d{4})\))?\s*$", title)
    if m:
        zh = m.group(1).strip()
    sc = subj.get("short_comment") or {}
    return {
        "id": str(subj.get("id", "")),
        "title": zh,
        "year": year,
        "rating": subj.get("rate", "") or "",
        "genres": subj.get("types", []) or [],
        "regions": [subj.get("region", "")] if subj.get("region") else [],
        "directors": subj.get("directors", []) or [],
        "actors": subj.get("actors", []) or [],
        "duration": subj.get("duration", "") or "",
        "poster": subj.get("img") or "",
        "url": subj.get("url") or "",
        "short_comment": sc.get("content", "") or "",
        "year_source": "abstract" if year else "",
        "is_tv": subj.get("is_tv", False),
    }


# ---------------------------------------------------------------- 存储

def load_store():
    store = {}
    if os.path.exists(JSONL):
        with open(JSONL, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("id"):
                    store[rec["id"]] = rec
    return store


def save_store(store):
    os.makedirs(OUTDIR, exist_ok=True)
    tmp = JSONL + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for rec in store.values():
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    os.replace(tmp, JSONL)


YEAR_PRIORITY = {"abstract": 3, "top250": 2, "release_date": 1, "": 0}


def upsert(store, records, source):
    """按 id 合并：空字段不覆盖已有值；year 按来源权威度取，rank 只认 Top250。"""
    added = updated = 0
    for rec in records:
        rid = rec.get("id")
        if not rid:
            continue
        if rid in store:
            old = store[rid]
            for k, v in rec.items():
                if k == "year":
                    old_pri = YEAR_PRIORITY.get(old.get("year_source", ""), 0)
                    new_pri = YEAR_PRIORITY.get(rec.get("year_source", ""), 0)
                    if v and (not old.get("year") or new_pri > old_pri):
                        old["year"] = v
                        old["year_source"] = rec.get("year_source", "")
                    continue
                if k == "rank":
                    if source == "top250" and v:
                        old["rank"] = v
                    continue
                if k in ("genres", "regions", "directors", "actors"):
                    # 列表字段做并集，避免不同来源互相覆盖（如地区少一个合拍国）
                    merged = list(old.get(k) or [])
                    for x in v or []:
                        if x and x not in merged:
                            merged.append(x)
                    if merged:
                        old[k] = merged
                    continue
                if v in ("", [], 0, None) and old.get(k) not in ("", [], 0, None):
                    continue
                if v not in ("", [], 0, None):
                    old[k] = v
            srcs = set(old.get("source", [])) | {source}
            old["source"] = sorted(srcs)
            updated += 1
        else:
            rec["source"] = [source]
            store[rid] = rec
            added += 1
    return added, updated


def export_csv(store):
    os.makedirs(OUTDIR, exist_ok=True)
    cols = ["id", "title", "original_title", "year", "rating", "votes",
            "genres", "regions", "directors", "actors", "duration",
            "rank", "url", "poster", "short_comment"]
    rows = sorted(store.values(), key=lambda r: (-(float(r["rating"]) if r.get("rating") else 0),
                                                 -(r.get("votes") or 0)))
    with open(CSVPATH, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            row = dict(r)
            for k in ("genres", "regions", "directors", "actors"):
                row[k] = "/".join(row.get(k) or [])
            w.writerow(row)
    return len(rows)


# ---------------------------------------------------------------- 抓取流程

def crawl_top250(fx, store, max_pages=10):
    print("▶ Top250（HTML 页面，/j/top250 已失效）")
    total_added = total_upd = 0
    for page in range(max_pages):
        start = page * 25
        url = f"{BASE}/top250?start={start}&filter="
        html = fx.get(url)
        recs = parse_top250(html, start_rank=start + 1)
        if not recs:
            print(f"  第{page+1}页无数据，停止")
            break
        a, u = upsert(store, recs, "top250")
        total_added += a
        total_upd += u
        print(f"  第{page+1}页 {len(recs):>2} 条  (新增{a} 更新{u})")
    return total_added, total_upd


def crawl_charts(fx, store, types, intervals, per_page=100, max_pages=50):
    total_added = total_upd = 0
    for t in types:
        tname = TYPE_MAP.get(t, str(t))
        for iv in intervals:
            start = 0
            grabbed = 0
            while start < per_page * max_pages:
                url = (f"{BASE}/j/chart/top_list?type={t}&interval_id={iv}"
                       f"&action=&start={start}&limit={per_page}")
                items = fx.get_json(url)
                if not items:
                    break
                recs = parse_chart_items(items)
                a, u = upsert(store, recs, f"chart:{tname}:{iv}")
                total_added += a
                total_upd += u
                grabbed += len(items)
                if len(items) < per_page:
                    break
                start += per_page
            print(f"  type={t:<2}({tname}) {iv:<6} → {grabbed} 条")
    return total_added, total_upd


def crawl_search(fx, store, tags="", min_rating="", sort="U", max_items=200):
    total_added = total_upd = 0
    start = 0
    page = 20
    while start < max_items:
        params = {"sort": sort, "range": f"{min_rating or 0},10",
                  "tags": tags, "start": start}
        url = ENDPOINTS["new_search_subjects"] + "?" + urllib.parse.urlencode(params)
        data = fx.get_json(url)
        items = data.get("data", []) if isinstance(data, dict) else []
        if not items:
            break
        recs = parse_search_items(items)
        a, u = upsert(store, recs, f"search:{tags or 'all'}")
        total_added += a
        total_upd += u
        print(f"  start={start:<4} → {len(items)} 条 (新增{a} 更新{u})")
        if len(items) < page:
            break
        start += page
    return total_added, total_upd


def enrich(fx, store, limit=0, only_missing=True):
    """用 /j/subject_abstract 补全导演/时长/短评等。"""
    todo = []
    for rec in store.values():
        if only_missing and rec.get("duration") and rec.get("directors"):
            continue
        todo.append(rec)
    todo.sort(key=lambda r: -(r.get("votes") or 0))
    if limit:
        todo = todo[:limit]
    print(f"▶ 补全详情：{len(todo)} 部")
    done = 0
    for i, rec in enumerate(todo, 1):
        try:
            data = fx.get_json(f"{ENDPOINTS['subject_abstract']}?subject_id={rec['id']}")
        except Exception as e:
            print(f"  ✗ {rec['id']} {e}", file=sys.stderr)
            continue
        subj = data.get("subject") or {}
        if not subj:
            continue
        d = parse_subject_abstract(subj)
        if not d.get("year"):
            d.pop("year_source", None)
        for k, v in d.items():
            if k == "is_tv":
                rec[k] = bool(v)
            elif k in ("genres", "regions", "actors", "directors"):
                # 列表字段做并集，避免单值覆盖（如详情的 region 只有一个国家）
                merged = list(rec.get(k) or [])
                for x in v or []:
                    if x and x not in merged:
                        merged.append(x)
                if merged:
                    rec[k] = merged
            elif k == "year":
                cur_pri = YEAR_PRIORITY.get(rec.get("year_source", ""), 0)
                if v and (not rec.get("year") or YEAR_PRIORITY["abstract"] >= cur_pri):
                    rec["year"] = v
                    rec["year_source"] = "abstract"
            elif v not in ("", [], 0, None):
                rec[k] = v
        rec.setdefault("source", [])
        if "abstract" not in rec["source"]:
            rec["source"].append("abstract")
        done += 1
        if i % 10 == 0 or i == len(todo):
            print(f"  {i}/{len(todo)} …")
    print(f"  完成 {done} 部")
    return done


def crawl_intros(fx, store, limit=0, ids=None):
    """补充剧情简介，保留原文并逐条保存，重复运行跳过已有简介。"""
    from build_data import usable

    todo = [row for row in store.values() if usable(row) and not row.get('intro')]
    if ids:
        todo = [row for row in todo if row['id'] in ids]
    todo.sort(key=lambda row: -(row.get('votes') or 0))
    if limit:
        todo = todo[:limit]
    print(f'▶ 补充剧情简介：{len(todo)} 部', flush=True)
    for index, row in enumerate(todo, 1):
        sid = row['id']
        try:
            data = fx.get_json(f"{ENDPOINTS['movie_intro']}/{sid}",
                               referer=f'https://m.douban.com/movie/subject/{sid}/')
            intro = data.get('intro') if str(data.get('id')) == sid else ''
            if intro:
                row['intro'] = intro
                row['intro_source'] = f'{BASE}/subject/{sid}/'
                save_store(store)
            print(f"  {index}/{len(todo)} {row['title']} {'✓' if intro else '暂无简介'}", flush=True)
        except urllib.error.HTTPError as error:
            print(f'  {sid} HTTP {error.code}', file=sys.stderr)
            if error.code in (401, 403, 429):
                break
        except (json.JSONDecodeError, ValueError) as error:
            print(f'  简介接口返回异常，已保留已抓取数据：{error}', file=sys.stderr)
            break


def cmd_probe(fx):
    print("豆瓣接口体检")
    print("-" * 68)
    checks = [
        ("官方旧 API api.douban.com/v2", "https://api.douban.com/v2/movie/subject/1292052", "json"),
        ("App API frodo.douban.com/v2", "https://frodo.douban.com/api/v2/movie/subject/1292052", "json"),
        ("移动端剧情简介", ENDPOINTS['movie_intro'] + '/1292052', 'json'),
        ("/j/chart/top_list", ENDPOINTS["chart/top_list"] + "?type=11&interval_id=100:90&action=&start=0&limit=1", "json"),
        ("/j/chart/top_list_count", ENDPOINTS["chart/top_list_count"] + "?type=11&interval_id=100:90", "json"),
        ("/j/subject_abstract", ENDPOINTS["subject_abstract"] + "?subject_id=1292052", "json"),
        ("/j/new_search_subjects", ENDPOINTS["new_search_subjects"] + "?sort=U&range=0,10&tags=&start=0", "json"),
        ("/j/subject_suggest", ENDPOINTS["subject_suggest"] + "?q=" + urllib.parse.quote("肖申克"), "json"),
        ("Top250 页面", BASE + "/top250", "html"),
        ("详情页 /subject/<id>/", BASE + "/subject/1292052/", "html"),
    ]
    for name, url, kind in checks:
        t0 = time.time()
        try:
            body = fx.get(url)
            ms = int((time.time() - t0) * 1000)
            if kind == "json":
                try:
                    json.loads(body)
                    ok = "✅ JSON"
                except json.JSONDecodeError:
                    ok = "⚠️ 非 JSON（多为风控 HTML）"
            else:
                if "<html" not in body[:500].lower():
                    ok = "⚠️ 非 HTML"
                elif "v:itemreviewed" in body or 'class="article"' in body:
                    ok = "✅ HTML"
                else:
                    ok = "🚧 风控墙（跳转 sec.douban.com）"
            print(f"{ok:<28} {ms:>5}ms  {name}")
        except urllib.error.HTTPError as e:
            ms = int((time.time() - t0) * 1000)
            print(f"{'❌ HTTP ' + str(e.code):<28} {ms:>5}ms  {name}")
        except Exception as e:
            print(f"{'❌ ' + type(e).__name__:<28} {'':>5}    {name}")
        time.sleep(0.6)
    print("-" * 68)
    print("说明：以本次逐项结果为准，剧情简介与 /j/subject_abstract 使用不同接口。")


def cmd_stats(store):
    print(f"电影总数: {len(store)}")
    if not store:
        return
    rated = [r for r in store.values() if r.get("rating")]
    if rated:
        vals = sorted(float(r["rating"]) for r in rated)
        print(f"有评分: {len(rated)}  中位数 {vals[len(vals)//2]:.1f}  区间 {vals[0]}–{vals[-1]}")
    by_year = {}
    for r in store.values():
        y = (r.get("year") or "")[:4]
        if y.isdigit():
            by_year[y] = by_year.get(y, 0) + 1
    top = sorted(by_year.items(), key=lambda kv: -kv[1])[:5]
    print("年份 Top5: " + ", ".join(f"{y}:{n}" for y, n in top))
    enr = sum(1 for r in store.values() if r.get("duration"))
    print(f"已补全详情: {enr}")


def main():
    ap = argparse.ArgumentParser(description="豆瓣电影内部接口抓取器")
    ap.add_argument("--delay", type=float, default=1.2, help="请求间隔秒（默认1.2）")
    ap.add_argument("--cookie", default=None, help="可选 Cookie（dbcl2=...），提高限额")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("probe", help="体检所有接口可用性")

    p = sub.add_parser("top250", help="抓取豆瓣 Top250")
    p.add_argument("--pages", type=int, default=10)

    p = sub.add_parser("charts", help="按类型/评分区间抓榜单")
    p.add_argument("--types", default="11", help="类型ID，逗号分隔，或 all")
    p.add_argument("--intervals", default="100:90",
                   help="榜单分段（默认100:90即完整榜单；注意 interval 已不按评分过滤，多填会重复抓取）")
    p.add_argument("--per-page", type=int, default=100)
    p.add_argument("--max-pages", type=int, default=20)

    p = sub.add_parser("search", help="按标签/评分筛选")
    p.add_argument("--tags", default="")
    p.add_argument("--min-rating", default="")
    p.add_argument("--sort", default="U", choices=["U", "S", "T"])
    p.add_argument("--max-items", type=int, default=200)

    p = sub.add_parser("enrich", help="补全导演/时长/短评")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--force", action="store_true", help="连已有详情的也重新抓")

    p = sub.add_parser('intros', help='补充豆瓣剧情简介，可断点续跑')
    p.add_argument('--limit', type=int, default=0)
    p.add_argument('--ids', default='', help='只补充指定豆瓣 ID，以逗号分隔')

    sub.add_parser("export", help="导出 CSV")
    sub.add_parser("stats", help="统计")

    args = ap.parse_args()
    fx = Fetcher(delay=args.delay, cookie=args.cookie)

    if args.cmd == "probe":
        cmd_probe(fx)
        return
    if args.cmd == "stats":
        cmd_stats(load_store())
        return

    store = load_store()
    t0 = time.time()

    if args.cmd == "top250":
        crawl_top250(fx, store, args.pages)
    elif args.cmd == "charts":
        types = list(TYPE_MAP) if args.types == "all" else [int(x) for x in args.types.split(",")]
        intervals = args.intervals.split(",")
        crawl_charts(fx, store, types, intervals, args.per_page, args.max_pages)
    elif args.cmd == "search":
        crawl_search(fx, store, args.tags, args.min_rating, args.sort, args.max_items)
    elif args.cmd == "enrich":
        enrich(fx, store, args.limit, only_missing=not args.force)
    elif args.cmd == 'intros':
        crawl_intros(fx, store, args.limit, set(args.ids.split(',')) if args.ids else None)

    save_store(store)
    n = export_csv(store)
    el = time.time() - t0
    print(f"\n✔ 已保存 {len(store)} 部 → {os.path.relpath(JSONL, ROOT)}")
    print(f"✔ CSV {n} 行 → {os.path.relpath(CSVPATH, ROOT)}")
    print(f"  请求 {fx.stats['requests']} 次 / 重试 {fx.stats['retries']} 次 / "
          f"下载 {fx.stats['bytes']/1024:.0f}KB / 耗时 {el:.1f}s")


if __name__ == "__main__":
    main()
