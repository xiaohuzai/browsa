/* browsa 官网 · 行为层（Material for MkDocs 风格）
   - 主题切换：default/slate 双 scheme，localStorage 持久化（首帧由各页
     <head> 里的内联脚本先行设置，这里只负责切换与持久化）
   - 顶栏滚动阴影（Material md-header--shadow）
   - 指南页：左栏搜索（懒抓取侧栏里链接到的页面做全文匹配）+
     右栏页内目录（从 h2/h3 自动生成，滚动高亮）
   全部原生 JS，无依赖。 */
(function(){
  'use strict';
  var doc = document.documentElement;
  var lang = (doc.getAttribute('lang') || 'zh-CN').indexOf('zh') === 0 ? 'zh' : 'en';
  var T = {
    zh: {
      searchPh: '搜索指南…', searching: '搜索中…', noMatch: '没有匹配的结果',
      toc: '本页目录'
    },
    en: {
      searchPh: 'Search the guide…', searching: 'Searching…', noMatch: 'No matches',
      toc: 'On this page'
    }
  }[lang];

  /* ─── 顶栏滚动阴影 ─── */
  var header = document.querySelector('.md-header');
  var onScroll = function(){
    if (!header) return;
    header.classList.toggle('md-header--shadow', window.scrollY > 8);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ─── 主题切换 ─── */
  var toggle = document.querySelector('.md-scheme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function(){
      var next = doc.dataset.mdColorScheme === 'slate' ? 'default' : 'slate';
      doc.dataset.mdColorScheme = next;
      doc.style.colorScheme = next === 'slate' ? 'dark' : 'light';
      try { localStorage.setItem('browsa-scheme', next); } catch (e) {}
    });
  }

  /* ─── 指南页：右栏页内目录 ─── */
  var body = document.querySelector('.docs-body');
  var shell = document.querySelector('.docs-shell');
  if (body && shell) {
    var headings = body.querySelectorAll('h2, h3');
    if (headings.length >= 2) {
      var slug = function (s, used) {
        var base = s.trim().toLowerCase()
          .replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'sec';
        var name = base, i = 2;
        while (used[name]) name = base + '-' + (i++);
        used[name] = true;
        return name;
      };
      var used = {};
      var items = [];
      headings.forEach(function (h) {
        if (!h.id) h.id = slug(h.textContent, used);
        items.push({ tag: h.tagName, id: h.id, text: h.textContent });
      });
      var aside = document.createElement('aside');
      aside.className = 'md-sidebar--secondary';
      var label = document.createElement('p');
      label.className = 'toc-label';
      label.textContent = T.toc;
      var list = document.createElement('ul');
      list.className = 'toc-list';
      items.forEach(function (it) {
        var li = document.createElement('li');
        if (it.tag === 'H3') li.className = 'lvl2';
        var a = document.createElement('a');
        a.href = '#' + it.id;
        a.textContent = it.text;
        li.appendChild(a);
        list.appendChild(li);
      });
      aside.appendChild(label);
      aside.appendChild(list);
      shell.appendChild(aside);

      /* 滚动高亮：谁最后越过视口上四分位，谁高亮 */
      var links = list.querySelectorAll('a');
      var byId = {};
      links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
      var cur = null;
      var spy = function () {
        var line = window.innerHeight * 0.25;
        var best = null;
        for (var i = 0; i < items.length; i++) {
          var el = document.getElementById(items[i].id);
          if (!el) continue;
          if (el.getBoundingClientRect().top <= line) best = items[i].id;
        }
        var next = best || (items.length ? items[0].id : null);
        if (next === cur) return;
        cur = next;
        links.forEach(function (a) { a.classList.remove('cur'); });
        if (cur && byId[cur]) byId[cur].classList.add('cur');
      };
      window.addEventListener('scroll', spy, { passive: true });
      window.addEventListener('resize', spy);
      spy();
    }
  }

  /* ─── 指南页：左栏搜索（懒抓侧栏链接页做全文匹配） ─── */
  var side = document.querySelector('.docs-side');
  if (side && 'fetch' in window) {
    var box = document.createElement('div');
    box.className = 'doc-search';
    box.innerHTML =
      '<svg class="doc-search-icon" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>' +
      '<input type="search" placeholder="' + T.searchPh + '" aria-label="' + T.searchPh + '">' +
      '<div class="doc-search-results" role="listbox"></div>';
    var navEl = side.querySelector('nav');
    side.insertBefore(box, navEl);
    var input = box.querySelector('input');
    var results = box.querySelector('.doc-search-results');

    var cache = null;            /* [{href,title,text}] */
    var loading = false;
    var loadIndex = function () {
      if (cache || loading) return Promise.resolve(cache);
      loading = true;
      var seen = {};
      var hrefs = [location.href.split('#')[0]];
      seen[hrefs[0]] = true;
      side.querySelectorAll('nav a').forEach(function (a) {
        var h = a.href.split('#')[0];
        if (h && !seen[h]) { seen[h] = true; hrefs.push(h); }
      });
      return Promise.all(hrefs.map(function (h) {
        return fetch(h).then(function (r) { return r.text(); }).then(function (html) {
          var d = new DOMParser().parseFromString(html, 'text/html');
          var art = d.querySelector('.docs-body') || d.body;
          return {
            href: h,
            title: (d.querySelector('h1') || {}).textContent || h,
            text: art.textContent.replace(/\s+/g, ' ')
          };
        }).catch(function () { return null; });
      })).then(function (pages) {
        cache = pages.filter(Boolean);
        loading = false;
        return cache;
      });
    };

    var closeResults = function () { results.classList.remove('open'); results.innerHTML = ''; };
    var runSearch = function () {
      var q = input.value.trim().toLowerCase();
      if (q.length < 2) { closeResults(); return; }
      results.innerHTML = '<div class="none">' + T.searching + '</div>';
      results.classList.add('open');
      loadIndex().then(function (pages) {
        if (!pages) return;
        var hits = [];
        pages.forEach(function (p) {
          var idx = p.text.toLowerCase().indexOf(q);
          var inTitle = p.title.toLowerCase().indexOf(q) !== -1;
          if (idx === -1 && !inTitle) return;
          var snippet = '';
          if (idx !== -1) {
            var start = Math.max(0, idx - 30);
            snippet = (start > 0 ? '…' : '') + p.text.slice(start, idx + 80) + '…';
          }
          hits.push({ p: p, snippet: snippet, title: inTitle });
        });
        hits.sort(function (a, b) { return (b.title ? 1 : 0) - (a.title ? 1 : 0); });
        results.innerHTML = '';
        if (!hits.length) {
          results.innerHTML = '<div class="none">' + T.noMatch + '</div>';
        } else {
          hits.slice(0, 8).forEach(function (h) {
            var a = document.createElement('a');
            a.href = h.p.href;
            var t = document.createElement('span'); t.className = 't'; t.textContent = h.p.title;
            a.appendChild(t);
            if (h.snippet) {
              var s = document.createElement('span'); s.className = 's'; s.textContent = h.snippet;
              a.appendChild(s);
            }
            results.appendChild(a);
          });
        }
        results.classList.add('open');
      });
    };
    var debounce = null;
    input.addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(runSearch, 200);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeResults(); input.blur(); }
    });
    document.addEventListener('click', function (e) {
      if (!box.contains(e.target)) closeResults();
    });
  }
})();
