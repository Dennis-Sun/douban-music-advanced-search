// ==UserScript==
// @name         豆瓣音乐高级搜索
// @namespace    https://music.douban.com/advanced-search
// @version      1.1.0
// @description  在豆瓣音乐搜索框旁增加「高级搜索」：支持按作品名 / 表演者 / 年份 / 流派对音乐条目进行精确过滤（包含 / 精确两种匹配模式，支持多年份与年份区间，自动翻页加载全部结果）。同时支持 music.douban.com 与新版搜索页 search.douban.com/music/subject_search
// @author       Dennis
// @match        https://music.douban.com/*
// @match        https://search.douban.com/music/subject_search*
// @match        https://www.douban.com/search*
// @run-at       document-end
// @noframes
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  /* =====================================================================
   * 一、核心纯逻辑（不依赖具体页面，便于单独测试）
   * ===================================================================== */

  /** 包含匹配用的归一化：NFKC 全半角统一 + 小写 + 连续空白折叠 */
  function normContains(s) {
    return (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /** 精确匹配用的归一化：去掉所有空白后整体比较 */
  function normExact(s) {
    return (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  }

  /**
   * 字段匹配
   * @param {string} value 条目里的字段值（如标题、表演者）
   * @param {string} input 用户输入
   * @param {'contains'|'exact'} mode 匹配模式
   */
  function matchText(value, input, mode) {
    if (!input) return true;   // 未填 → 不约束
    if (!value) return false;  // 条目缺该字段 → 不匹配
    if (mode === 'exact') return normExact(value) === normExact(input);
    return normContains(value).includes(normContains(input));
  }

  /**
   * 解析年份输入为年份集合
   * 支持：2004 ／ 2001,2004 ／ 2000-2005 ／ 2000~2005 ／ 2000至2005
   */
  function parseYearSet(str) {
    const set = new Set();
    if (!str) return set;
    const rangeRe = /(\d{4})\s*(?:-|~|～|—|至)\s*(\d{4})/g;
    let m;
    while ((m = rangeRe.exec(str))) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (a > b) { const t = a; a = b; b = t; }
      for (let y = a; y <= b; y++) set.add(String(y));
    }
    (str.match(/\d{4}/g) || []).forEach((y) => set.add(y));
    return set;
  }

  /** 从条目年份字段中提取 4 位年份数字 */
  function itemYear(item) {
    const m = (item.year || '').match(/\d{4}/);
    return m ? m[0] : '';
  }

  /**
   * 解析 subject-cast 行（形如「周杰伦 / 流行 / 2016」）
   * 字段分隔符是「空格 + 斜杠 + 空格」；AC/DC、Guns N' Roses 等
   * 名字内部不含空格的斜杠不会被切开。
   */
  function parseCast(text) {
    const out = { performer: '', genre: '', year: '' };
    if (!text) return out;
    const parts = String(text).split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return out;
    out.performer = parts[0];
    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      if (/^\d{4}/.test(last)) {
        out.year = last;
        out.genre = parts.slice(1, -1).join(' / ');
      } else {
        out.genre = parts.slice(1).join(' / ');
      }
    }
    return out;
  }

  /** 判断单个条目是否满足全部高级搜索条件 */
  function itemMatches(item, c) {
    if (!matchText(item.title, c.title, c.tmode)) return false;
    if (!matchText(item.performer, c.performer, c.pmode)) return false;
    if (c.yearSet && c.yearSet.size) {
      const y = itemYear(item);
      if (!y || !c.yearSet.has(y)) return false;
    }
    if (!matchText(item.genre, c.genre, 'contains')) return false;
    return true;
  }

  /** 从 link2 跳转链接中还原真实条目地址 */
  function decodeLink2(href) {
    if (!href) return '';
    try {
      const u = new URL(href, location.href);
      return u.searchParams.get('url') || href;
    } catch (e) {
      return href;
    }
  }

  /**
   * 从一个 .result DOM 节点提取结构化数据
   * @param {Element} node
   * @returns {null|{node, title, link, cover, rating, votes, performer, genre, year}}
   */
  function extractItem(node) {
    if (!node || !node.querySelector) return null;
    const a = node.querySelector('.content h3 a') || node.querySelector('h3 a');
    if (!a) return null;
    const link = decodeLink2(a.getAttribute('href'));
    const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!link || !title) return null;
    const item = { node, title, link };

    const img = node.querySelector('.pic img');
    if (img) item.cover = img.getAttribute('src') || '';

    const ratingEl = node.querySelector('.rating_nums');
    item.rating = ratingEl ? ratingEl.textContent.trim() : '';

    const infoEl = node.querySelector('.rating-info');
    if (infoEl) {
      const vm = infoEl.textContent.match(/\(([\d万.]+)\s*人评价\)/);
      item.votes = vm ? vm[1] : '';
    } else {
      item.votes = '';
    }

    const castEl = node.querySelector('.subject-cast');
    const cast = parseCast(castEl ? castEl.textContent : '');
    item.performer = cast.performer;
    item.genre = cast.genre;
    item.year = cast.year;
    return item;
  }

  /** 把 /j/search 返回的 html 片段数组解析成 .result 节点数组（脱离文档） */
  function nodesFromHtml(htmlStrings) {
    const out = [];
    const holder = document.createElement('div');
    (htmlStrings || []).forEach((h) => {
      holder.innerHTML = h;
      Array.from(holder.childNodes).forEach((n) => {
        if (n.nodeType === Node.ELEMENT_NODE) {
          holder.removeChild(n);
          out.push(n);
        }
      });
    });
    return out;
  }

  /* ---------------------------------------------------------------------
   * 新版搜索页（search.douban.com/music/subject_search）的数据结构
   * 服务端把结果 JSON 直接注入 window.__DATA__，每条 abstract 形如：
   *   表演者 / 发行日期 / 版本特性 / 介质 / 流派
   * 其中日期、流派内部可能自带斜杠（2003/11/11、放克/灵歌/R&B），
   * 但字段分隔符固定是「空格 + 斜杠 + 空格」，因此不会被切坏。
   * ------------------------------------------------------------------- */

  /** 介质取值（用于判断末段是不是流派） */
  const MEDIA_WORDS = new Set([
    'cd', 'dvd', 'dvd5', 'dvd9', 'vcd', 'ld', 'lp', 'sacd', 'hdcd', 'xrcd',
    '磁带', '卡带', '黑胶', '光盘', '数字', '数字(digital)', 'digital',
    'audio cd', 'audiocd', 'musiccd', '音乐cd', '音乐cd', 'cd+dvd', 'cd+vcd',
    'dvd+cd', '数字媒体', 'digital media', '蓝光', 'blu-ray', 'umd', 'md',
  ]);
  /** 版本特性取值（用于判断首段是不是表演者） */
  const VERSION_WORDS = new Set([
    '专辑', '单曲', '选集', '精选', '合辑', '套装', 'ep', 'box set', 'boxset',
    'import', '进口', '录音室专辑', '现场专辑', 'live', '再版', '重制版', '重制',
    'remaster', 'remastered', '限量版', '豪华版', 'deluxe', 'anniversary',
    'edition', 'version', '影音', '演唱会', '视频', 'mv', 'ost', '原声带',
  ]);
  const DATE_RE = /^\d{4}\s*[年\-\.\/]?/;

  const isMedia = (s) => MEDIA_WORDS.has(String(s || '').trim().toLowerCase());
  const isVersion = (s) => VERSION_WORDS.has(String(s || '').trim().toLowerCase());

  /**
   * 解析新版搜索页的 abstract 字段
   * @param {string} text
   * @returns {{performer:string, date:string, year:string, genre:string}}
   */
  function parseSpaAbstract(text) {
    const out = { performer: '', date: '', year: '', genre: '' };
    if (!text) return out;
    const parts = String(text).split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return out;

    // 1) 定位日期段
    let dateIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (DATE_RE.test(parts[i])) { dateIdx = i; break; }
    }

    // 2) 表演者：日期段之前的全部（无日期时看首段是否像表演者）
    if (dateIdx > 0) {
      out.performer = parts.slice(0, dateIdx).join(' / ');
    } else if (dateIdx === -1) {
      const first = parts[0];
      if (!isVersion(first) && !isMedia(first)) out.performer = first;
    }
    if (dateIdx >= 0) {
      out.date = parts[dateIdx];
      const ym = out.date.match(/\d{4}/);
      if (ym) out.year = ym[0];
    }

    // 3) 尾段是否流派：介质结尾则说明没写流派
    const tail = dateIdx >= 0 ? parts.slice(dateIdx + 1) : (out.performer ? parts.slice(1) : parts);
    if (tail.length) {
      const last = tail[tail.length - 1];
      if (!isMedia(last)) {
        if (tail.length >= 2 || !isVersion(last)) out.genre = last;
      }
    }
    return out;
  }

  /**
   * 把 __DATA__ 里的一条原始数据转成统一结构
   * @returns {null|{title, link, cover, rating, votes, performer, genre, year, date, abstract}}
   */
  function parseSpaItem(raw) {
    if (!raw || !raw.url || !raw.title) return null;
    // 只保留音乐条目，排除音乐人 / 艺术家等非条目结果
    if (raw.tpl_name && raw.tpl_name !== 'search_subject') return null;
    if (!/\/subject\//.test(raw.url)) return null;
    const a = parseSpaAbstract(raw.abstract || '');
    const r = raw.rating || {};
    const value = typeof r.value === 'number' ? r.value : parseFloat(r.value);
    return {
      title: String(raw.title).replace(/\s+/g, ' ').trim(),
      link: raw.url,
      cover: raw.cover_url || '',
      rating: value > 0 ? value.toFixed(1) : '',
      votes: r.count ? String(r.count) : '',
      performer: a.performer,
      genre: a.genre,
      year: a.year,
      date: a.date,
      abstract: raw.abstract || '',
    };
  }

  /** 从新版搜索页 HTML 中抠出 window.__DATA__ */
  function extractSpaData(html) {
    if (!html) return null;
    const m = /window\.__DATA__\s*=\s*(\{[\s\S]*?\})\s*;/.exec(html);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch (e) {
      return null;
    }
  }

  /** 暴露核心逻辑，便于控制台调试与自动化测试 */
  const API = {
    normContains, normExact, matchText, parseYearSet, itemYear,
    parseCast, itemMatches, decodeLink2, extractItem, nodesFromHtml,
    buildSearchUrl, buildSpaSearchUrl,
    parseSpaAbstract, parseSpaItem, extractSpaData,
  };
  if (typeof window !== 'undefined') window.__DBMAS__ = API;

  /* =====================================================================
   * 二、样式
   * ===================================================================== */

  const CSS = `
.dbmas-toggle {
  position: absolute; right: 7px; top: 50%; transform: translateY(-50%);
  font-size: 12px; line-height: 1; color: #007722; cursor: pointer;
  user-select: none; z-index: 30; white-space: nowrap; text-decoration: none;
}
.dbmas-toggle:hover { text-decoration: underline; }
.dbmas-inp-wrap { position: relative; }
.dbmas-inp-wrap input { padding-right: 46px !important; box-sizing: border-box; }

/* 面板挂在 <body> 下并用 fixed 定位（由 JS 计算坐标），
   避免被豆瓣 .nav 容器的 overflow:hidden 裁剪 */
.dbmas-panel {
  position: fixed; top: 0; left: 0; width: 348px;
  max-width: calc(100vw - 16px);
  background: #fff; border: 1px solid #d9d9d9; border-radius: 6px;
  box-shadow: 0 8px 28px rgba(0,0,0,.14); padding: 18px 18px 14px;
  z-index: 2147483000; font-size: 13px; color: #333; text-align: left;
  font-family: Helvetica, Arial, sans-serif;
}
.dbmas-panel h3 {
  margin: 0 0 14px; font-size: 14px; font-weight: bold; color: #007722;
  display: flex; align-items: center; justify-content: space-between;
}
.dbmas-panel h3 .dbmas-close {
  font-weight: normal; font-size: 18px; color: #999; cursor: pointer; line-height: 1;
}
.dbmas-row { display: flex; align-items: center; margin-bottom: 10px; gap: 6px; }
.dbmas-row > label { width: 48px; flex: none; color: #666; }
.dbmas-row input[type=text] {
  flex: 1; min-width: 0; border: 1px solid #ccc; border-radius: 3px;
  padding: 5px 8px; font-size: 13px; height: 26px;
}
.dbmas-row input[type=text]:focus { outline: none; border-color: #42bd56; }
.dbmas-row select {
  flex: none; border: 1px solid #ccc; border-radius: 3px; padding: 4px 2px;
  font-size: 12px; color: #666; height: 26px; background: #fff;
}
.dbmas-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.dbmas-btn {
  border: none; border-radius: 3px; padding: 6px 16px; font-size: 13px;
  cursor: pointer; line-height: 1.4;
}
.dbmas-btn-primary { background: #33a05a; color: #fff; }
.dbmas-btn-primary:hover { background: #2b8a4c; }
.dbmas-btn-plain { background: #f2f2f2; color: #666; }
.dbmas-btn-plain:hover { background: #e6e6e6; }
.dbmas-hint { color: #999; font-size: 12px; margin-top: 10px; line-height: 1.7; }
.dbmas-error { color: #c0392b; font-size: 12px; margin-top: 8px; display: none; }

/* 结果页状态条 */
#dbmas-bar {
  margin: 0 0 20px; background: #f2f8f2; border: 1px solid #cfe6cf;
  border-radius: 5px; padding: 14px 18px; font-size: 13px; color: #333;
}
#dbmas-bar .dbmas-bar-title { font-weight: bold; color: #007722; margin-bottom: 8px; }
#dbmas-bar .dbmas-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
#dbmas-bar .dbmas-chip {
  background: #fff; border: 1px solid #b5d8b5; border-radius: 3px;
  padding: 3px 8px; color: #2c6e2c; font-size: 12px;
}
#dbmas-bar .dbmas-chip b { color: #007722; }
#dbmas-bar .dbmas-bar-meta { color: #666; }
#dbmas-bar .dbmas-bar-meta .dbmas-link { color: #007722; cursor: pointer; margin-right: 12px; }
#dbmas-bar .dbmas-bar-meta .dbmas-link:hover { text-decoration: underline; }
#dbmas-bar .dbmas-note { color: #b8860b; margin-top: 6px; font-size: 12px; }
#dbmas-bar .dbmas-warn { color: #c0392b; margin-top: 6px; }
#dbmas-bar form.dbmas-inline { margin-top: 12px; border-top: 1px dashed #d5e8d5; padding-top: 12px; }

/* 新版搜索页：自绘结果列表 */
#dbmas-spa { margin: 0 0 24px; }
#dbmas-spa .dbmas-spa-list {
  border-top: 1px solid #eee;
}
#dbmas-spa .dbmas-spa-card {
  display: flex; gap: 16px; padding: 16px 0; border-bottom: 1px solid #eee;
}
#dbmas-spa .dbmas-spa-cover {
  flex: none; width: 80px; height: 80px; overflow: hidden;
  background: #f6f6f6; border-radius: 3px; display: block;
}
#dbmas-spa .dbmas-spa-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
#dbmas-spa .dbmas-spa-nocover {
  display: flex; align-items: center; justify-content: center;
  width: 100%; height: 100%; color: #bbb; font-size: 12px;
}
#dbmas-spa .dbmas-spa-body { min-width: 0; }
#dbmas-spa .dbmas-spa-title { font-size: 15px; line-height: 1.4; margin-bottom: 4px; }
#dbmas-spa .dbmas-spa-title a { color: #37a; text-decoration: none; }
#dbmas-spa .dbmas-spa-title a:hover { color: #fff; background: #37a; }
#dbmas-spa .dbmas-spa-meta { font-size: 13px; color: #007722; margin-bottom: 3px; }
#dbmas-spa .dbmas-spa-abs { font-size: 12px; color: #999; line-height: 1.5; }
#dbmas-spa .dbmas-spa-rating { font-size: 12px; color: #666; margin-top: 4px; }
#dbmas-spa .dbmas-spa-rating b { color: #e09015; font-size: 13px; margin-right: 6px; }
#dbmas-spa .dbmas-norating { color: #bbb; }
#dbmas-spa .dbmas-empty { padding: 28px 0; color: #999; font-size: 13px; }

@media (prefers-color-scheme: dark) {
  .dbmas-panel { background: #1f1f1f; border-color: #3a3a3a; color: #ddd; }
  .dbmas-panel h3 { color: #6fbf73; }
  .dbmas-row > label { color: #aaa; }
  .dbmas-row input[type=text], .dbmas-row select { background: #2b2b2b; border-color: #4a4a4a; color: #ddd; }
  .dbmas-btn-plain { background: #333; color: #aaa; }
  #dbmas-bar { background: #1c241c; border-color: #2f4531; color: #ccc; }
  #dbmas-bar .dbmas-bar-title { color: #6fbf73; }
  #dbmas-bar .dbmas-chip { background: #243122; border-color: #3c5a3e; color: #9ecfa0; }
  #dbmas-bar .dbmas-chip b { color: #7ecf87; }
  #dbmas-spa .dbmas-spa-list, #dbmas-spa .dbmas-spa-card { border-color: #333; }
  #dbmas-spa .dbmas-spa-cover { background: #2b2b2b; }
  #dbmas-spa .dbmas-spa-title a { color: #7cb7e0; }
  #dbmas-spa .dbmas-spa-title a:hover { background: #7cb7e0; color: #1f1f1f; }
  #dbmas-spa .dbmas-spa-meta { color: #7ecf87; }
  #dbmas-spa .dbmas-empty { color: #888; }
}
`;

  function injectCSS() {
    const style = document.createElement('style');
    style.id = 'dbmas-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  /* =====================================================================
   * 三、高级搜索面板（两个页面共用）
   * ===================================================================== */

  const SEARCH_URL = 'https://www.douban.com/search';
  const SPA_SEARCH_URL = 'https://search.douban.com/music/subject_search';
  const SPA_SEARCH_PATH = '/music/subject_search';

  /** 由条件生成跳转地址（旧版 www.douban.com/search） */
  function buildSearchUrl(c) {
    const p = new URLSearchParams();
    const qParts = [];
    if (c.title) qParts.push(c.title.trim());
    if (c.performer) qParts.push(c.performer.trim());
    p.set('cat', '1003');
    p.set('q', qParts.join(' ').trim());
    if (c.title) p.set('adv_title', c.title.trim());
    if (c.performer) p.set('adv_performer', c.performer.trim());
    if (c.year) p.set('adv_year', c.year.trim());
    if (c.genre) p.set('adv_genre', c.genre.trim());
    p.set('adv_tmode', c.tmode === 'exact' ? 'exact' : 'contains');
    p.set('adv_pmode', c.pmode === 'exact' ? 'exact' : 'contains');
    return SEARCH_URL + '?' + p.toString();
  }

  /** 由条件生成跳转地址（新版 search.douban.com/music/subject_search） */
  function buildSpaSearchUrl(c) {
    const p = new URLSearchParams();
    const qParts = [];
    if (c.title) qParts.push(c.title.trim());
    if (c.performer) qParts.push(c.performer.trim());
    p.set('search_text', qParts.join(' ').trim());
    p.set('cat', '1003');
    if (c.title) p.set('adv_title', c.title.trim());
    if (c.performer) p.set('adv_performer', c.performer.trim());
    if (c.year) p.set('adv_year', c.year.trim());
    if (c.genre) p.set('adv_genre', c.genre.trim());
    p.set('adv_tmode', c.tmode === 'exact' ? 'exact' : 'contains');
    p.set('adv_pmode', c.pmode === 'exact' ? 'exact' : 'contains');
    return SPA_SEARCH_URL + '?' + p.toString();
  }

  /**
   * 构建高级搜索表单 DOM
   * @param {object} opts {initial, onSubmit, inline}
   */
  function buildPanelForm(opts) {
    const initial = opts.initial || {};
    const form = document.createElement('form');
    form.className = 'dbmas-form';
    form.innerHTML = `
      <div class="dbmas-row">
        <label>作品名</label>
        <input type="text" name="title" placeholder="专辑 / 唱片名" maxlength="60"
               value="${escapeAttr(initial.title || '')}">
        <select name="tmode" title="作品名匹配模式">
          <option value="contains" ${initial.tmode !== 'exact' ? 'selected' : ''}>包含</option>
          <option value="exact" ${initial.tmode === 'exact' ? 'selected' : ''}>精确</option>
        </select>
      </div>
      <div class="dbmas-row">
        <label>表演者</label>
        <input type="text" name="performer" placeholder="歌手 / 乐队 / 音乐人" maxlength="60"
               value="${escapeAttr(initial.performer || '')}">
        <select name="pmode" title="表演者匹配模式">
          <option value="contains" ${initial.pmode !== 'exact' ? 'selected' : ''}>包含</option>
          <option value="exact" ${initial.pmode === 'exact' ? 'selected' : ''}>精确</option>
        </select>
      </div>
      <div class="dbmas-row">
        <label>年份</label>
        <input type="text" name="year" placeholder="2004 或 2001,2004 或 2000-2005" maxlength="40"
               value="${escapeAttr(initial.year || '')}">
      </div>
      <div class="dbmas-row">
        <label>流派</label>
        <input type="text" name="genre" placeholder="可选，如：摇滚、流行" maxlength="30"
               value="${escapeAttr(initial.genre || '')}">
      </div>
      <div class="dbmas-actions">
        <button type="submit" class="dbmas-btn dbmas-btn-primary">高级搜索</button>
        <button type="button" class="dbmas-btn dbmas-btn-plain dbmas-clear">清空</button>
      </div>
      <div class="dbmas-error"></div>
      <div class="dbmas-hint">至少填写「作品名」或「表演者」其中一项；<br>
        年份支持单值、逗号分隔多值和区间（2000-2005）。</div>
    `;

    const errEl = form.querySelector('.dbmas-error');
    form.querySelector('.dbmas-clear').addEventListener('click', () => {
      form.querySelectorAll('input[type=text]').forEach((i) => (i.value = ''));
      form.querySelectorAll('select').forEach((s) => (s.selectedIndex = 0));
      errEl.style.display = 'none';
      form.querySelector('input[name=title]').focus();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const c = readForm(form);
      if (!c.title && !c.performer) {
        errEl.textContent = '请至少填写「作品名」或「表演者」其中一项';
        errEl.style.display = 'block';
        return;
      }
      opts.onSubmit(c);
    });
    return form;
  }

  function readForm(form) {
    const v = (n) => (form.querySelector('[name=' + n + ']')?.value || '').trim();
    return {
      title: v('title'), performer: v('performer'),
      year: v('year'), genre: v('genre'),
      tmode: form.querySelector('[name=tmode]')?.value || 'contains',
      pmode: form.querySelector('[name=pmode]')?.value || 'contains',
    };
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * 在一个搜索输入框旁边挂上「高级」入口和下拉面板
   * @param {Element} inputEl
   * @param {Element} anchorEl
   * @param {object} [opts] { initial: 条件初值, onSubmit: (c)=>void }
   */
  function mountAdvancedToggle(inputEl, anchorEl, opts) {
    opts = opts || {};
    const submit = opts.onSubmit || ((c) => { location.href = buildSpaSearchUrl(c); });
    if (!inputEl || !anchorEl || anchorEl.querySelector('.dbmas-toggle')) return;

    const wrap = inputEl.closest('.inp') || inputEl.parentNode;
    if (!wrap || wrap.querySelector('.dbmas-toggle')) return;
    wrap.classList.add('dbmas-inp-wrap');

    const toggle = document.createElement('a');
    toggle.className = 'dbmas-toggle';
    toggle.textContent = '高级';
    toggle.title = '豆瓣音乐高级搜索';
    wrap.appendChild(toggle);

    const PANEL_WIDTH = 348;
    let panel = null;

    /** 面板挂载在 <body> 上（position:fixed），
        用触发按钮的视口坐标定位，避免被任何祖先容器的
        overflow:hidden 裁剪（豆瓣 .nav 即是 overflow:hidden） */
    function positionPanel() {
      if (!panel) return;
      const rect = toggle.getBoundingClientRect();
      let left = rect.right - PANEL_WIDTH;
      const maxLeft = Math.max(8, document.documentElement.clientWidth - PANEL_WIDTH - 8);
      if (left > maxLeft) left = maxLeft;
      if (left < 8) left = 8;
      panel.style.left = left + 'px';
      panel.style.top = (rect.bottom + 8) + 'px';
    }

    function openPanel() {
      if (!panel) {
        panel = document.createElement('div');
        panel.className = 'dbmas-panel';
        const h = document.createElement('h3');
        h.textContent = '豆瓣音乐 · 高级搜索';
        const close = document.createElement('span');
        close.className = 'dbmas-close';
        close.textContent = '×';
        close.addEventListener('click', () => (panel.style.display = 'none'));
        h.appendChild(close);
        panel.appendChild(h);
        panel.appendChild(buildPanelForm({
          initial: opts.initial,
          onSubmit: submit,
        }));
        document.body.appendChild(panel);
        window.addEventListener('resize', () => {
          if (panel && panel.style.display !== 'none') positionPanel();
        });
      }
      positionPanel();
      panel.style.display = 'block';
      panel.querySelector('input[name=title]').focus();
    }

    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (panel && panel.style.display !== 'none') {
        panel.style.display = 'none';
        return;
      }
      openPanel();
    });

    // 点击面板外部时收起
    document.addEventListener('click', (e) => {
      if (panel && panel.style.display !== 'none' &&
          !panel.contains(e.target) && e.target !== toggle) {
        panel.style.display = 'none';
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel) panel.style.display = 'none';
    });
  }

  /* =====================================================================
   * 四、Part A —— music.douban.com：在导航搜索框上挂载入口
   * ===================================================================== */

  function initMusicSite() {
    const input = document.querySelector('#inp-query');
    const anchor = document.querySelector('.nav-search');
    mountAdvancedToggle(input, anchor, {
      onSubmit: (c) => { location.href = buildSpaSearchUrl(c); },
    });
  }

  /* =====================================================================
   * 五、Part B —— www.douban.com/search 结果页：按字段过滤
   * ===================================================================== */

  const MAX_PAGES = 30;        // 自动翻页安全上限（约 600 条）
  const PAGE_DELAY_MS = 250;   // 翻页间隔，避免请求过快

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function readCriteriaFromUrl(sp) {
    return {
      title: sp.get('adv_title') || '',
      performer: sp.get('adv_performer') || '',
      year: sp.get('adv_year') || '',
      genre: sp.get('adv_genre') || '',
      tmode: sp.get('adv_tmode') === 'exact' ? 'exact' : 'contains',
      pmode: sp.get('adv_pmode') === 'exact' ? 'exact' : 'contains',
      yearSet: parseYearSet(sp.get('adv_year') || ''),
    };
  }

  function hasAdvCriteria(c) {
    return !!(c.title || c.performer || c.year || c.genre);
  }

  function isLoggedIn() {
    return document.cookie.split(';').some((kv) => kv.trim().startsWith('ck='));
  }

  /** 状态条：条件展示 + 命中统计 + 修改条件 / 清除过滤 */
  function buildStatusBar(c) {
    const bar = document.createElement('div');
    bar.id = 'dbmas-bar';
    const chips = [];
    if (c.title) chips.push(`作品名 <b>「${escapeHtml(c.title)}」</b>（${c.tmode === 'exact' ? '精确' : '包含'}）`);
    if (c.performer) chips.push(`表演者 <b>「${escapeHtml(c.performer)}」</b>（${c.pmode === 'exact' ? '精确' : '包含'}）`);
    if (c.year) chips.push(`年份 <b>${escapeHtml(c.year)}</b>`);
    if (c.genre) chips.push(`流派 <b>「${escapeHtml(c.genre)}」</b>`);
    bar.innerHTML = `
      <div class="dbmas-bar-title">🎵 高级搜索</div>
      <div class="dbmas-chips">${chips.map((s) => `<span class="dbmas-chip">${s}</span>`).join('')}</div>
      <div class="dbmas-bar-meta">
        <span class="dbmas-stat">正在解析结果…</span>
        <span class="dbmas-link dbmas-edit">修改条件</span>
        <span class="dbmas-link dbmas-reset">清除过滤</span>
      </div>
      <div class="dbmas-note" style="display:none"></div>
    `;
    return bar;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** 登录状态下通过站内 /j/search 接口顺序翻页，收集全部结果 */
  async function loadAllMore(q, startAt, onProgress) {
    const nodes = [];
    let start = startAt;
    let more = true;
    let pages = 0;
    while (more && pages < MAX_PAGES) {
      let data;
      try {
        const resp = await fetch('/j/search?' + new URLSearchParams({
          q, cat: '1003', start: String(start),
        }), {
          credentials: 'same-origin',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (!resp.ok) break;
        data = await resp.json();
      } catch (e) {
        break;
      }
      if (!data || data.r) break;
      const items = Array.isArray(data.items) ? data.items : [];
      nodes.push(...nodesFromHtml(items));
      more = !!data.more;
      start += items.length || data.limit || 20;
      pages++;
      if (onProgress) onProgress(nodes.length, pages);
      if (more) await sleep(PAGE_DELAY_MS);
    }
    return nodes;
  }

  /** 兜底：直接抓搜索页 HTML 并解析（未登录也可用） */
  async function fetchSearchPageResults(q) {
    try {
      const resp = await fetch('/search?' + new URLSearchParams({ cat: '1003', q }), {
        credentials: 'same-origin',
      });
      if (!resp.ok) return [];
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return Array.from(doc.querySelectorAll('.result-list .result'));
    } catch (e) {
      return [];
    }
  }

  async function initResultsPage() {
    const sp = new URLSearchParams(location.search);
    const isMusicSearch = sp.get('cat') === '1003';

    // 无论是否高级搜索，都在结果页搜索框上也挂一个入口（方便随时升级为高级搜索）
    const c0 = readCriteriaFromUrl(sp);
    const modInput = document.querySelector('.mod-search input[name=q]');
    const modAnchor = document.querySelector('.mod-search');
    mountAdvancedToggle(modInput, modAnchor, { initial: c0 });

    const c = readCriteriaFromUrl(sp);
    if (!isMusicSearch || !hasAdvCriteria(c)) return;

    const searchResult = document.querySelector('.search-result');
    const resultList = document.querySelector('.result-list');
    if (!searchResult || !resultList) return;

    // ---- 状态条 ----
    const bar = buildStatusBar(c);
    searchResult.insertBefore(bar, searchResult.firstChild);
    const statEl = bar.querySelector('.dbmas-stat');
    const noteEl = bar.querySelector('.dbmas-note');

    bar.querySelector('.dbmas-reset').addEventListener('click', () => {
      const p = new URLSearchParams(location.search);
      ['adv_title', 'adv_performer', 'adv_year', 'adv_genre', 'adv_tmode', 'adv_pmode']
        .forEach((k) => p.delete(k));
      location.href = SEARCH_URL + '?' + p.toString();
    });

    bar.querySelector('.dbmas-edit').addEventListener('click', () => {
      let form = bar.querySelector('form.dbmas-inline');
      if (form) {
        form.remove();
        return;
      }
      form = buildPanelForm({
        initial: c,
        onSubmit: (nc) => { location.href = buildSearchUrl(nc); },
      });
      form.classList.add('dbmas-inline');
      bar.appendChild(form);
    });

    // ---- 收集初始结果（服务端渲染部分） ----
    statEl.textContent = '正在解析当前页结果…';
    const moreBtn = resultList.querySelector('.j.a_search_more');
    const initialNodes = Array.from(resultList.querySelectorAll('.result'));
    const byLink = new Map();
    const items = [];
    const pushNode = (node) => {
      const it = extractItem(node);
      if (!it) return;
      if (byLink.has(it.link)) return; // 去重
      byLink.set(it.link, it);
      items.push(it);
    };
    initialNodes.forEach(pushNode);
    const initialCount = items.length;

    // ---- 登录状态：自动翻页加载全部 ----
    let loadedPages = 0;
    let extended = false;
    if (isLoggedIn() && moreBtn) {
      statEl.textContent = `已解析 ${items.length} 条，正在自动加载后续页…`;
      const moreNodes = await loadAllMore(
        sp.get('q') || '', parseInt(moreBtn.dataset.start || '20', 10),
        (count, pages) => {
          loadedPages = pages;
          statEl.textContent = `已加载 ${count + initialCount} 条（第 ${pages + 1} 页）…`;
        },
      );
      moreNodes.forEach(pushNode);
    }
    moreBtn && (moreBtn.style.display = 'none');
    resultList.querySelector('.result-list-ft') &&
      (resultList.querySelector('.result-list-ft').style.display = 'none');

    // ---- 若一无所获且同时给了作品名与表演者，自动扩展搜索范围 ----
    let matched = items.filter((it) => itemMatches(it, c));
    if (matched.length === 0 && c.title && c.performer && items.length > 0) {
      noteEl.style.display = 'block';
      noteEl.textContent = '组合关键词命中为 0，正在尝试分别按「作品名」「表演者」扩展搜索…';
      const extraNodes = [
        ...await fetchSearchPageResults(c.title),
        ...await fetchSearchPageResults(c.performer),
      ];
      extraNodes.forEach(pushNode);
      extended = extraNodes.length > 0;
      matched = items.filter((it) => itemMatches(it, c));
    }

    // ---- 过滤并重绘列表 ----
    resultList.innerHTML = '';
    matched.forEach((it) => resultList.appendChild(it.node));

    // ---- 更新统计 ----
    const pagesInfo = loadedPages ? `，已自动加载 ${loadedPages + 1} 页` : '';
    statEl.textContent =
      `命中 ${matched.length} / ${items.length} 条${pagesInfo}`;
    if (extended) {
      noteEl.style.display = 'block';
      noteEl.textContent = '已自动扩展搜索范围（按作品名 / 表演者分别检索并合并去重）。';
    } else if (!isLoggedIn() && moreBtn) {
      noteEl.style.display = 'block';
      noteEl.textContent = '💡 登录豆瓣后可自动翻页加载全部结果后再过滤（未登录仅过滤前 20 条）。';
    }
    if (matched.length === 0) {
      const warn = document.createElement('div');
      warn.className = 'dbmas-warn';
      warn.textContent = items.length === 0
        ? '豆瓣搜索本身未返回任何结果，请检查关键词。'
        : '没有满足全部条件的条目。可尝试：将「精确」改为「包含」、放宽年份条件、或只填表演者。';
      bar.appendChild(warn);
    }
  }

  /* =====================================================================
   * 五·B —— 新版搜索页 search.douban.com/music/subject_search
   * 该页由服务端把结果 JSON 注入 window.__DATA__，再由 React 渲染；
   * 翻页只需改 start 参数，且不需要登录态。
   * ===================================================================== */

  const SPA_PAGE_SIZE = 15;
  const MAX_SPA_PAGES = 12;          // 最多自动翻 12 页（约 180 条）
  const SPA_DELAY_MS = 200;          // 翻页间隔，避免请求过快

  /** 等待 React 渲染出结果卡片（最多等 ms 毫秒） */
  async function waitForSpaCards(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (document.querySelector('#root .item-root')) return true;
      await sleep(120);
    }
    return false;
  }

  /** 抓取指定页（start 为偏移量） */
  async function fetchSpaPage(q, start) {
    const p = new URLSearchParams({ search_text: q, cat: '1003', start: String(start) });
    const resp = await fetch(SPA_SEARCH_PATH + '?' + p.toString(), {
      credentials: 'same-origin',
    });
    if (!resp.ok) return null;
    return extractSpaData(await resp.text());
  }

  /** 按关键词汇总结果（自动翻页；登录与否都能翻） */
  async function collectSpaItems(q, onProgress) {
    const items = [];
    const seen = new Set();
    const push = (data) => {
      (data && Array.isArray(data.items) ? data.items : []).forEach((raw) => {
        const it = parseSpaItem(raw);
        if (!it || seen.has(it.link)) return;
        seen.add(it.link);
        items.push(it);
      });
    };

    // 首页：若当前页就是 start=0，直接用已注入的 __DATA__，省一次请求
    const curStart = parseInt(new URLSearchParams(location.search).get('start') || '0', 10);
    let firstData = null;
    if (curStart === 0 && window.__DATA__ && Array.isArray(window.__DATA__.items)) {
      firstData = window.__DATA__;
    } else if (typeof fetch === 'function') {
      firstData = await fetchSpaPage(q, 0);
    }
    if (!firstData) return { items, total: 0, pages: 0, truncated: false };

    const total = firstData.total || 0;
    push(firstData);

    let start = SPA_PAGE_SIZE;
    let pages = 1;
    while (typeof fetch === 'function' && pages < MAX_SPA_PAGES && start < total) {
      const d = await fetchSpaPage(q, start);
      if (!d || !Array.isArray(d.items) || !d.items.length) break;
      push(d);
      start += d.items.length || SPA_PAGE_SIZE;
      pages++;
      if (onProgress) onProgress(items.length, pages);
      if (start < total) await sleep(SPA_DELAY_MS);
    }
    return { items, total, pages, truncated: start < total };
  }

  /** 把一批结果并入已有集合（按链接去重） */
  function mergeSpaItems(target, extra) {
    const seen = new Set(target.map((i) => i.link));
    extra.forEach((it) => { if (!seen.has(it.link)) { seen.add(it.link); target.push(it); } });
  }

  /** 单张结果卡片 */
  function spaCardNode(it) {
    const card = document.createElement('div');
    card.className = 'dbmas-spa-card';
    const bits = [];
    if (it.performer) bits.push(it.performer);
    if (it.date) bits.push(it.date);
    if (it.genre) bits.push(it.genre);
    card.innerHTML = `
      <a class="dbmas-spa-cover" href="${escapeAttr(it.link)}" target="_blank" rel="noreferrer">
        ${it.cover ? `<img src="${escapeAttr(it.cover)}" alt="${escapeAttr(it.title)}" loading="lazy">`
                   : '<span class="dbmas-spa-nocover">无封面</span>'}
      </a>
      <div class="dbmas-spa-body">
        <div class="dbmas-spa-title">
          <a href="${escapeAttr(it.link)}" target="_blank" rel="noreferrer">${escapeHtml(it.title)}</a>
        </div>
        ${bits.length ? `<div class="dbmas-spa-meta">${escapeHtml(bits.join(' · '))}</div>` : ''}
        ${it.abstract ? `<div class="dbmas-spa-abs">${escapeHtml(it.abstract)}</div>` : ''}
        <div class="dbmas-spa-rating">
          ${it.rating
            ? `<b>${escapeHtml(it.rating)}</b>${it.votes ? `<span>${escapeHtml(it.votes)} 人评价</span>` : ''}`
            : '<span class="dbmas-norating">暂无评分</span>'}
        </div>
      </div>`;
    return card;
  }

  async function initSpaResultsPage() {
    const sp = new URLSearchParams(location.search);
    const c = readCriteriaFromUrl(sp);

    // 新版搜索页的搜索框就是顶部导航的 #inp-query
    const navInput = document.querySelector('#inp-query');
    const navAnchor = document.querySelector('.nav-search') || document.querySelector('#db-nav-music');
    mountAdvancedToggle(navInput, navAnchor, {
      initial: c,
      onSubmit: (nc) => { location.href = buildSpaSearchUrl(nc); },
    });

    if (!hasAdvCriteria(c)) return;   // 普通搜索：只挂入口，不干预

    await waitForSpaCards(4000);      // 等 React 渲染完，好定位原生列表

    const root = document.querySelector('#root');
    const wrapper = (root && root.parentElement) || document.querySelector('#wrapper') || document.body;

    // ---- 结果容器 ----
    const box = document.createElement('div');
    box.id = 'dbmas-spa';
    const bar = buildStatusBar(c);
    box.appendChild(bar);
    const listEl = document.createElement('div');
    listEl.className = 'dbmas-spa-list';
    box.appendChild(listEl);
    wrapper.insertBefore(box, root || wrapper.firstChild);

    // ---- 隐藏原生结果列表与分页（保留分类 tab 等其余原生 UI）----
    const cards = document.querySelectorAll('#root .item-root');
    if (cards.length) {
      const listContainer = cards[0].parentElement;
      if (listContainer) listContainer.style.display = 'none';
    } else if (root) {
      root.style.display = 'none';
    }
    document.querySelectorAll('#root [class*="pagin"]').forEach((el) => {
      el.style.display = 'none';
    });

    const statEl = bar.querySelector('.dbmas-stat');
    const noteEl = bar.querySelector('.dbmas-note');

    bar.querySelector('.dbmas-reset').addEventListener('click', () => {
      const p = new URLSearchParams(location.search);
      ['adv_title', 'adv_performer', 'adv_year', 'adv_genre', 'adv_tmode', 'adv_pmode', 'start']
        .forEach((k) => p.delete(k));
      location.href = SPA_SEARCH_PATH + '?' + p.toString();
    });
    bar.querySelector('.dbmas-edit').addEventListener('click', () => {
      let form = bar.querySelector('form.dbmas-inline');
      if (form) { form.remove(); return; }
      form = buildPanelForm({
        initial: c,
        onSubmit: (nc) => { location.href = buildSpaSearchUrl(nc); },
      });
      form.classList.add('dbmas-inline');
      bar.appendChild(form);
    });

    // ---- 汇总并过滤 ----
    const q = sp.get('search_text') || '';
    statEl.textContent = '正在加载结果…';
    const { items, total, pages, truncated } =
      await collectSpaItems(q, (n, p) => { statEl.textContent = `已加载 ${n} 条（第 ${p} 页）…`; });

    let matched = items.filter((it) => itemMatches(it, c));
    let extended = false;
    if (!matched.length && c.title && c.performer) {
      noteEl.style.display = 'block';
      noteEl.textContent = '组合关键词命中为 0，正在按「作品名」「表演者」分别扩展搜索…';
      for (const term of [c.title, c.performer]) {
        const r = await collectSpaItems(term);
        mergeSpaItems(items, r.items);
      }
      matched = items.filter((it) => itemMatches(it, c));
      extended = items.length > 0;
    }

    // ---- 渲染 ----
    if (!matched.length) {
      const empty = document.createElement('div');
      empty.className = 'dbmas-empty';
      empty.textContent = items.length === 0
        ? '豆瓣搜索本身未返回任何结果，请检查关键词。'
        : '没有满足全部条件的条目。可尝试：将「精确」改为「包含」、放宽年份条件、或只填表演者。';
      listEl.appendChild(empty);
    } else {
      matched.forEach((it) => listEl.appendChild(spaCardNode(it)));
    }

    statEl.textContent = `命中 ${matched.length} 条 / 已加载 ${items.length} 条` +
      (total ? `（豆瓣共 ${total} 条${truncated ? '，已达自动翻页上限' : ''}）` : '');
    if (extended) {
      noteEl.style.display = 'block';
      noteEl.textContent = '已自动扩展搜索范围（按作品名 / 表演者分别检索并合并去重）。';
    } else if (truncated) {
      noteEl.style.display = 'block';
      noteEl.textContent = `已自动加载 ${pages} 页。结果较多时建议缩小关键词范围以提高命中率。`;
    }
  }

  /* =====================================================================
   * 六、启动
   * ===================================================================== */

  injectCSS();
  if (location.host === 'music.douban.com') {
    initMusicSite();
  } else if (location.host === 'search.douban.com') {
    initSpaResultsPage();
  } else if (location.host === 'www.douban.com' && location.pathname === '/search') {
    initResultsPage();
  }
})();
