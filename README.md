# 豆瓣音乐高级搜索（油猴脚本）

在 **music.douban.com** 与新版搜索页 **search.douban.com/music/subject_search** 的搜索框旁
增加「高级搜索」入口，支持对音乐条目按 **作品名 / 表演者 / 年份 / 流派** 进行字段级精确过滤——
这是豆瓣官方搜索不具备的能力。

---

## 一、前期调研结论（动手前的联网调查）

按需求先做了联网调研，结论：**没有人做过「豆瓣音乐搜索框 + 作品名/表演者/年份字段级精确搜索」**。找到的相关前人工作分三类，均与本需求不同：

| 类别 | 代表项目 | 做了什么 | 与本需求差异 |
|---|---|---|---|
| 资源下载聚合 | 豆瓣资源下载大师（greasyfork 461306）、Douban Download Search（ywzhaiqi） | 在条目页右侧栏聚合 BT/网盘/在线站点的**站外**搜索链接 | 只做跳转外站，不涉及豆瓣站内字段搜索 |
| 界面美化增强 | BeautifyCompleteDouban（whyfishing） | 美化搜索栏、个人主页网格化、无限滚动 | 排序/类型筛选仅针对电影，无音乐字段过滤 |
| 站外 API 封装 | wanglin2/douban_api、xsbailong/douban-api 等 | PhantomJS 抓取豆瓣页面输出 JSON | 服务端工具，依赖的旧官方 API（api.douban.com/v2/music）**已于 2020 年前后停用** |

另外核实了豆瓣现状：官方音乐搜索已迁移到 `search.douban.com/music/subject_search`，**没有官方高级搜索界面**。该页虽由 React 渲染，但服务端会把结果 JSON 直接注入 `window.__DATA__`，每条自带 `abstract`（`表演者 / 日期 / 版本 / 介质 / 流派`）；旧版 `www.douban.com/search?cat=1003` 则仍是服务端渲染 HTML，每条自带 `subject-cast`（`表演者 / 流派 / 年份`）。这两处元数据正是本脚本的技术基础。

## 二、技术方案

```
┌─ music.douban.com / search.douban.com ─────┐
│  搜索框 ──[高级]──▶ 高级搜索面板            │
│  填写：作品名 / 表演者 / 年份 / 流派        │
│  （各自可选「包含」或「精确」匹配）          │
└──────────────┬───────────────────────────┘
               │ 跳转 search.douban.com/music/subject_search
               │ ?search_text=<作品名+表演者>
               │ &adv_title=…&adv_performer=…&adv_year=…
┌─ 新版搜索页（主流程）──────────────────────┐
│  ① 读取 window.__DATA__（服务端注入 JSON）  │
│  ② 同源翻页 ?start=15/30/…（未登录也能翻）  │
│     （最多 12 页 ≈ 180 条）                │
│  ③ 组合词命中 0 且填了作品名+表演者         │
│     → 分别检索两词并合并去重                │
│  ④ 按字段过滤 → 自绘结果卡片                │
│  ⑤ 顶部状态条：条件、命中数、修改/清除       │
└────────────────────────────────────────────┘
┌─ 旧版 www.douban.com/search（兼容）────────┐
│  ① 解析服务端渲染的 .result（含 subject-cast）│
│  ② 已登录 → 调站内 /j/search 自动翻页       │
│  ③ 同样按字段过滤并给出状态条               │
└────────────────────────────────────────────┘
```

关键机制（均经真实请求验证）：

1. **新版页数据源**：`search.douban.com/music/subject_search` 把结果 JSON 注入 `window.__DATA__`（`{count, items[], total, start}`），`items[].abstract` 形如「周杰伦 / 2016-06-24 / 专辑 / CD / 流行」；`tpl_name=search_subject` 才是音乐条目，音乐人等结果会被剔除。
2. **新版页翻页**：改 `start` 参数再取页面即可（15 条/页），**不需要登录态**，脚本最多自动翻 12 页（约 180 条）后过滤。
3. **旧版页数据源**：`www.douban.com/search?cat=1003&q=…` 服务端渲染，未登录可用，每页 20 条；每条结果的 `subject-cast` 形如「周杰伦 / 流行 / 2001」。
4. **旧版页翻页**：站内 AJAX `GET /j/search?q=…&cat=1003&start=N`，需要登录态（`ck` cookie）。
5. **表演者名含斜杠**：字段分隔符是「空格+斜杠+空格」，`AC/DC`、`Guns N' Roses`、以及流派「放克/灵歌/R&B」内部斜杠不含空格，不会被切坏。
6. **字段缺失兼容**：部分条目无日期或省略介质，解析器按「日期段定位 + 末段是否像介质」判断流派，实测 20 条真实样本全部正确。
7. **链接还原**：旧版结果链接经 `www.douban.com/link2/?url=<编码>` 跳转，脚本解码还原 `music.douban.com/subject/…` 直链。

## 三、安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox / Safari 均可）；
2. 新建脚本，将 `douban-music-advanced-search.user.js` 全文粘贴进去保存；
   （或将该文件拖入浏览器，由 Tampermonkey 识别安装）
3. 打开 [music.douban.com](https://music.douban.com/) 或 [search.douban.com/music/subject_search](https://search.douban.com/music/subject_search)，搜索框右侧会出现绿色的「高级」入口。

脚本无任何第三方依赖、不请求外部服务、不需要 API Key，`@grant none`（无特殊权限）。

## 四、使用说明

- **作品名 / 表演者**：支持「包含」（默认，模糊命中，兼容「周杰伦 Jay Chou」这类双语字段）与「精确」（去空白、全半角归一后整体相等）；
- **年份**：支持 `2004`、`2001,2004`（多值）、`2000-2005`（区间，也认 `~` `～` `—` `至`，倒序自动修正）；
- **流派**：可选，包含匹配（如 摇滚、流行）；
- 至少填写「作品名」或「表演者」其中一项（豆瓣搜索本身需要关键词）；
- 结果页顶部状态条可**修改条件**（原地展开表单）或**清除过滤**（回到普通搜索结果）。

典型场景验证（真实数据）：`作品名=范特西(精确) + 表演者=周杰伦 + 年份=2001` → 唯一命中《范特西》(9.5 分)；`表演者=朴树 + 年份=1999` → 命中《我去2000年》。

## 五、已知限制

- 新版搜索页最多自动翻 12 页（约 180 条）后过滤，结果特别多时状态条会提示可缩小关键词范围；
- 旧版 `www.douban.com/search` 未登录时仅能过滤第一页 20 条（站方翻页接口要求登录态）；
- 「精确」匹配是对搜索结果元数据行的精确比对，个别条目元数据不全（无年份/流派）时会被过滤掉；
- 新版页由脚本自绘结果卡片（隐藏原生 React 列表），原生的「听过 / 收藏」按钮在过滤结果中不可用，点击条目进入原页面即可操作；
- 豆瓣若改版页面结构（`window.__DATA__` 字段或 DOM 选择器），脚本需要同步更新。

## 六、测试

- `test/test_userscript.mjs`：jsdom 驱动的 11 组 60+ 断言。运行：`node test/test_userscript.mjs`（依赖 jsdom）。
  - [1]–[5] 核心逻辑：`extractItem` 条目提取、`parseCast` 边界（AC/DC 斜杠、完整日期）、匹配模式（双语/大小写/全半角/空白）、年份解析（多值/区间/倒序）、组合过滤；
  - [6]–[9] 页面注入：面板挂载与字段、URL 构造、空条件校验、面板防裁剪回归（豆瓣 `.nav` 为 `overflow:hidden`）；
  - [10] 新版页解析：`parseSpaAbstract` / `parseSpaItem` / `extractSpaData` / `buildSpaSearchUrl`，覆盖六段式、无日期、缺表演者、介质结尾、流派含斜杠、中文日期等真实样本；
  - [11] 新版页集成：模拟 `window.__DATA__` + 打桩翻页，验证自动翻页、字段过滤、自绘卡片、原生列表隐藏、状态条统计。
- `demo/index.html`：**交互演示页**，内嵌 2026-09 真实抓取的 80 条音乐数据，界面与过滤逻辑和脚本完全一致，安装前即可体验全部交互。

## 七、文件结构

```
豆瓣高级搜索/
├── douban-music-advanced-search.user.js   # 油猴脚本（主交付物）
├── README.md
├── test/
│   └── test_userscript.mjs                # 自动化测试
└── demo/
    ├── index.html                         # 交互演示（自包含，双击打开）
    └── demo_data.json                     # 演示数据源（真实抓取）
```
