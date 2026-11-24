# 豆瓣电影接口现状与抓取方案

> 简介接口更新：2026-11-14。其余接口实测时间：2026-11-10。豆瓣风控和接口变动频繁，**结论会过期**，改动后先跑
> `python3 tools/fetch_douban.py probe` 重新体检。

## 一句话结论

官方 API 和 App 端接口全部需要授权或已下线，**但 `movie.douban.com/j/*` 一族内部
JSON 接口仍然免登录、免签名可用**，靠它们就能把电影数据完整抓下来。

## 接口体检结果

| 接口 | 状态 | 说明 |
|---|---|---|
| `api.douban.com/v2/movie/subject/<id>` | ❌ 403 | `invalid_apikey`，2019 年关停，需联系 bd-team 授权 |
| `frodo.douban.com/api/v2/movie/subject/<id>` | ❌ 400 | `apikey is required`；带 apikey 后还要 `_sig` 签名，`code 997` |
| `m.douban.com/rexxar/api/v2/movie/<id>` | ✅ 200 | 2026-11-14 实测含 `intro`，小程序 `wx.request` 可读取；部分条目返回 400 |
| `movie.douban.com/rexxar/api/v2/...` | ❌ 404 | 不存在（返回 HTML） |
| `movie.douban.com/j/top250` | ❌ 404 | 这个老接口死了，Top250 只能解析 HTML |
| **`movie.douban.com/j/chart/top_list`** | ✅ 200 | 榜单列表，支持 `start`/`limit`（`limit` 可到 200） |
| **`movie.douban.com/j/chart/top_list_count`** | ✅ 200 | 榜单数量统计 |
| **`movie.douban.com/j/subject_abstract`** | ✅ 200 | 单片概要，详情页的替代品 |
| **`movie.douban.com/j/new_search_subjects`** | ✅ 200 | 搜索/筛选，20 条一页 |
| **`movie.douban.com/j/subject_suggest`** | ✅ 200 | 搜索联想，适合片名换 id |
| `movie.douban.com/top250`（HTML） | ✅ 200 | 页面可直接解析 |
| `movie.douban.com/subject/<id>/`（HTML） | 🚧 302 | 跳到 `sec.douban.com` 风控墙，**不要走 HTML** |

## 可用接口详情

### `/j/chart/top_list` —— 主力接口

```
GET https://movie.douban.com/j/chart/top_list
    ?type=11&interval_id=100:90&action=&start=0&limit=100
```

返回 `[{...}]`，字段：

| 字段 | 示例 | 说明 |
|---|---|---|
| `id` | `"1292052"` | 豆瓣 subject id |
| `title` | `肖申克的救赎` | 中文名 |
| `score` / `rating[0]` | `9.7` | 评分 |
| `vote_count` | `3363533` | 评价人数 |
| `types` | `["犯罪","剧情"]` | 类型 |
| `regions` | `["美国"]` | 地区 |
| `release_date` | `2026-08-28` | 上映日期（注意有些是重映日期） |
| `actors` | `["蒂姆·罗宾斯",...]` | 主演（10 个） |
| `cover_url` | `https://img3.doubanio.com/...` | 海报 |
| `rank` | `1` | 该类型榜单内排名，全局连续递增 |
| `is_playable` | `true` | 是否可在线播放 |

翻页直到返回空数组即为该类型完整榜单。实测「剧情」共 1110 部，rank 连续无缺。

### `/j/subject_abstract` —— 补全详情

```
GET https://movie.douban.com/j/subject_abstract?subject_id=1292052
```

返回 `subject` 对象，含 `directors`、`actors`（全部）、`duration`（`"142分钟"`）、
`region`、`types`、`rate`、`release_year`、`short_comment{content,author}`、`is_tv`。

此接口可补导演、时长和热门短评。剧情简介使用下方的移动端接口。

### `/rexxar/api/v2/movie/<id>` —— 剧情简介

```text
GET https://m.douban.com/rexxar/api/v2/movie/1292052
```

2026-11-14 实测返回 `id`、`intro`、`color_scheme` 等字段。此前测试的
`/movie/subject/<id>` 路径有误。部分电影返回 400，界面会使用片库的基本介绍。

小程序按需读取并缓存简介，保留前一两句，最多 100 字。批量补充可运行
`python3 tools/fetch_douban.py intros --limit 50`，逐部保存，重跑会跳过已有简介。
之后用 `python3 tools/build_data.py --target miniprogram` 更新小程序离线片库。

### `/j/new_search_subjects` —— 按标签/评分筛选

```
GET https://movie.douban.com/j/new_search_subjects
    ?sort=U&range=0,10&tags=&start=0
```

- `sort`：`U` 综合 / `S` 评分 / `T` 时间
- `range`：评分区间，如 `8.5,10`
- `tags`：标签，如 `科幻`
- 每页 20 条，字段含 `directors`、`casts`、`rate`、`cover`

### `/j/chart/top_list_count`

```
GET https://movie.douban.com/j/chart/top_list_count?type=11&interval_id=100:90
→ {"playable_count":852,"total":1110,"filtered_total":1110,"unwatched_count":1110}
```

用来预估总页数，避免空跑。

## 实测的类型 ID 映射

豆瓣改过编号，**网上流传的旧文档是错的**。以下为 2026-11 实测：

| id | 类型 | id | 类型 | id | 类型 |
|---|---|---|---|---|---|
| 1 | 纪录片 | 12 | 灾难 | 22 | 战争 |
| 2 | 传记 | 13 | 爱情 | 23 | 短片 |
| 3 | 犯罪 | 14 | 音乐 | 24 | 喜剧 |
| 4 | 历史 | 15 | 冒险 | 25 | 动画 |
| 5 | 动作 | 16 | 奇幻 | 26 | 同性 |
| 6 | 情色 | 17 | 科幻 | 27 | 西部 |
| 7 | 歌舞 | 18 | 运动 | 28 | 家庭 |
| 8 | 儿童 | 19 | 惊悚 | 29 | 武侠 |
| 10 | 悬疑 | 20 | 恐怖 | 30 | 古装 |
| 11 | 剧情 | | | 31 | 黑色电影 |

（`9`、`21` 返回空，无对应类型。）

## 两个坑

1. **`interval_id` 已退化为分段提示，不再按评分过滤。**
   `90:80` 返回的片子里混着 7.9 分，`60:50` 里混着 8.2 分。所以不要
   「区间 × 类型」组合枚举，会重复抓同一批数据。正确做法：固定
   `interval_id=100:90`，然后 `start` 一直翻到空数组，得到该类型完整榜单。

2. **短评标记变了。** 老页面是 `<span class="inq">`，新页面是
   `<p class="quote"><span>`，只匹配 `inq` 会全部抓空。

## 用法

```bash
python3 tools/fetch_douban.py probe            # 接口体检
python3 tools/fetch_douban.py top250           # Top250 → 250 部
python3 tools/fetch_douban.py charts --types all   # 全类型榜单，约 6~7k 部
python3 tools/fetch_douban.py search --tags 科幻 --min-rating 8.5
python3 tools/fetch_douban.py enrich --limit 200   # 补导演/时长/短评
python3 tools/fetch_douban.py export           # 导出 CSV
python3 tools/fetch_douban.py stats            # 统计
```

- 输出：`data/movies.jsonl`（按 id 去重合并）+ `data/movies.csv`
- 结果可增量：重复跑不会产生重复记录，空字段不会覆盖已有值
- 节流：默认 1.2s/请求，`--delay` 可调；有 Cookie 可传 `--cookie` 或环境变量
  `DOUBAN_COOKIE`（`dbcl2=...`）提高限额

## 数据质量注意事项

抓下来的 `movies.jsonl` 是**多来源合并**的，字段权威度不同：

| 字段 | 来源与坑 |
|---|---|
| `year` | `chart/top_list` 的 `release_date` 是**中国上映/重映日期**，老片会偏后（肖申克写成 2026、控方证人写成 2025）。合并时按 `abstract > top250 > release_date` 优先级取，并用 `year_source` 记录来源。未补详情的 3808 部仍用首映日期，可跑 `enrich` 修正。 |
| `rank` | 类型榜单的 `rank` 是**单类型内排名**，无全局意义；合并时只有 Top250 的全局排名会写入 `rank`（1–250）。 |
| `regions` / `genres` / `directors` / `actors` | 多来源取**并集**，避免详情接口只给单个国家时覆盖掉合拍国。 |
| `short_comment` | Top250 的「一句话短评」和详情接口的「热门短评」是两种东西，合并后统一放 `short_comment`。 |
| `duration` | 只有跑过 `enrich` 的记录才有。 |

`enrich` 每部要 1 个请求（约 1.2s），全量 4096 部约 1.5 小时。建议按票数优先、
分批跑，它会自动跳过已有详情的记录（`--force` 可强制重抓）。

## 合规

`robots.txt` 未禁止 `/j/`、`/top250`、`/subject/` 路径（禁止的是 `/search`、
`/people/*/collect` 等）。但豆瓣用户协议限制自动化抓取，**仅限个人学习/数据分析
用途，不要商业使用、不要高频请求、不要公开分发抓下来的数据**。海报图片版权归
影片方所有。
