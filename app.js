'use strict';
/* 特斯拉 CAN 信号浏览器 */
let DATA = [], SOURCES = [];
let filtered = [];
let page = 1;
const PAGE_SIZE = 100;
let sortAsc = true;
const favMap = new Map(); // rid -> {rid, addedAt}

/* ---------- IndexedDB ---------- */
const idb = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('tesla-can-favorites', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('favorites', { keyPath: 'rid' });
      req.onsuccess = () => { idb.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  all() {
    return new Promise((resolve, reject) => {
      const tx = idb.db.transaction('favorites', 'readonly');
      const req = tx.objectStore('favorites').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },
  put(rec) {
    return new Promise((resolve, reject) => {
      const tx = idb.db.transaction('favorites', 'readwrite');
      tx.objectStore('favorites').put(rec);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  },
  del(rid) {
    return new Promise((resolve, reject) => {
      const tx = idb.db.transaction('favorites', 'readwrite');
      tx.objectStore('favorites').delete(rid);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  },
  clear() {
    return new Promise((resolve, reject) => {
      const tx = idb.db.transaction('favorites', 'readwrite');
      tx.objectStore('favorites').clear();
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  }
};

/* ---------- 工具 ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function idNum(r) { const n = parseInt(r.id10, 10); return isNaN(n) ? -1 : n; }
function juniperTag(j) {
  if (!j) return '<span class="tag na">–</span>';
  if (j.includes('已确认')) return '<span class="tag ok">已确认</span>';
  if (j.includes('差异')) return '<span class="tag warn">有差异</span>';
  return '<span class="tag na">未确认</span>';
}

/* ---------- 加载 ---------- */
async function init() {
  const [d, s] = await Promise.all([
    fetch('data.json').then(r => r.json()),
    fetch('sources.json').then(r => r.json())
  ]);
  DATA = d; SOURCES = s;
  $('sigCount').textContent = DATA.length.toLocaleString();
  $('srcCount').textContent = SOURCES.length;
  try {
    await idb.open();
    const all = await idb.all();
    all.forEach(rec => favMap.set(rec.rid, rec));
  } catch (e) { console.warn('IndexedDB 不可用', e); }
  updateFavBadge();
  applyFilters();
  renderSources();
  bindEvents();
}

function bindEvents() {
  $('btnSearch').onclick = () => { page = 1; applyFilters(); };
  $('btnClear').onclick = () => {
    ['fKeyword','fCanId'].forEach(i => $(i).value = '');
    ['fEndian','fJuniper','fDiff','fFix'].forEach(i => $(i).value = '');
    $('fFavOnly').checked = false; page = 1; applyFilters();
  };
  [$('fKeyword'), $('fCanId')].forEach(el =>
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { page = 1; applyFilters(); } }));
  $('pgPrev').onclick = () => { if (page > 1) { page--; renderTable(); } };
  $('pgNext').onclick = () => { const t = totalPages(); if (page < t) { page++; renderTable(); } };
  $('pgGo').onclick = () => {
    const n = parseInt($('pgJump').value, 10), t = totalPages();
    if (n >= 1 && n <= t) { page = n; renderTable(); }
  };
  $('sortId').onclick = () => { sortAsc = !sortAsc; $('sortId').textContent = '按 CAN ID ' + (sortAsc ? '↑' : '↓'); page = 1; applyFilters(); };
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $('tab-signals').hidden = t.dataset.tab !== 'signals';
    $('tab-sources').hidden = t.dataset.tab !== 'sources';
  });
  $('favFloat').onclick = openDrawer;
  $('btnCloseDrawer').onclick = closeDrawer;
  $('drawerMask').onclick = closeDrawer;
  $('btnExportCsv').onclick = () => exportFav('csv');
  $('btnExportJson').onclick = () => exportFav('json');
  $('btnClearFav').onclick = async () => {
    if (!favMap.size || !confirm('确定清空全部收藏吗？')) return;
    await idb.clear(); favMap.clear();
    updateFavBadge(); renderTable(); renderDrawer();
    if ($('fFavOnly').checked) applyFilters();
  };
}

/* ---------- 筛选 ---------- */
function parseCanIdInput(text) {
  text = text.trim().toLowerCase();
  if (!text) return null;
  if (text.startsWith('0x')) { const n = parseInt(text, 16); return isNaN(n) ? null : n; }
  const n = parseInt(text, 10);
  if (!isNaN(n)) return n;
  return null; // 非数字则按文本匹配
}

function applyFilters() {
  const kw = $('fKeyword').value.trim().toLowerCase();
  const canRaw = $('fCanId').value.trim();
  const canNum = parseCanIdInput(canRaw);
  const endian = $('fEndian').value;
  const jun = $('fJuniper').value;
  const diff = $('fDiff').value;
  const fix = $('fFix').value;
  const favOnly = $('fFavOnly').checked;

  filtered = DATA.map((r, i) => ({ r, i })).filter(({ r, i }) => {
    if (favOnly && !favMap.has(i)) return false;
    if (kw) {
      const hay = (r.sig + ' ' + r.msg + ' ' + r.desc + ' ' + r.unit + ' ' + r.src).toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    if (canRaw) {
      if (canNum !== null) { if (idNum(r) !== canNum) return false; }
      else if (!(r.id16.toLowerCase().includes(canRaw.toLowerCase()))) return false;
    }
    if (endian && r.bo !== endian) return false;
    if (jun === '已确认' && !r.jun.includes('已确认')) return false;
    if (jun === '有差异' && !r.jun.includes('差异')) return false;
    if (jun === '未确认' && (r.jun.includes('已确认') || r.jun.includes('差异'))) return false;
    if (diff === 'yes' && !r.diff) return false;
    if (diff === 'no' && r.diff) return false;
    if (fix === 'yes' && !r.fix) return false;
    if (fix === 'no' && r.fix) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const d = idNum(a.r) - idNum(b.r);
    if (d !== 0) return sortAsc ? d : -d;
    return a.r.sig.localeCompare(b.r.sig);
  });
  renderTable();
}

/* ---------- 表格渲染 ---------- */
const totalPages = () => Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

function renderTable() {
  const body = $('sigBody');
  const t = totalPages();
  if (page > t) page = t;
  const start = (page - 1) * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);
  let html = '';
  for (const { r, i } of slice) {
    const fav = favMap.has(i);
    html += '<tr data-rid="' + i + '">'
      + '<td><button class="fav-btn' + (fav ? ' on' : '') + '" data-fav="' + i + '" title="' + (fav ? '取消收藏' : '收藏') + '">★</button></td>'
      + '<td class="canid">' + esc(r.id16) + '</td>'
      + '<td class="canid">' + esc(r.id10) + '</td>'
      + '<td class="msg-name">' + esc(r.msg) + '</td>'
      + '<td class="sig-name">' + esc(r.sig) + '</td>'
      + '<td>' + esc(r.bit) + '</td>'
      + '<td>' + esc(r.len) + '</td>'
      + '<td>' + esc(r.bo) + '</td>'
      + '<td>' + esc(r.f) + '</td>'
      + '<td>' + esc(r.o) + '</td>'
      + '<td>' + esc(r.unit) + '</td>'
      + '<td>' + juniperTag(r.jun) + '</td>'
      + '<td><button class="detail-btn" data-detail="' + i + '">展开</button></td>'
      + '</tr>';
  }
  body.innerHTML = html || '<tr><td colspan="13" class="empty">没有匹配的信号</td></tr>';
  $('resultInfo').textContent = '共 ' + filtered.length.toLocaleString() + ' 条信号（收藏 ' + favMap.size + ' 条）';
  $('pgInfo').textContent = '第 ' + page + ' / ' + t + ' 页';
  $('pgPrev').disabled = page <= 1;
  $('pgNext').disabled = page >= t;

  body.querySelectorAll('[data-fav]').forEach(b => b.onclick = e => { e.stopPropagation(); toggleFav(parseInt(b.dataset.fav, 10)); });
  body.querySelectorAll('[data-detail]').forEach(b => b.onclick = () => toggleDetail(b));
}

function toggleDetail(btn) {
  const tr = btn.closest('tr');
  const rid = parseInt(btn.dataset.detail, 10);
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail-row')) { next.remove(); btn.textContent = '展开'; return; }
  const r = DATA[rid];
  const item = (label, val, pre) =>
    '<div class="d-item"><b>' + label + '</b><div class="' + (pre ? 'pre' : '') + '">' + (esc(val) || '–') + '</div></div>';
  const dr = document.createElement('tr');
  dr.className = 'detail-row';
  dr.innerHTML = '<td colspan="13"><div class="detail-box">'
    + item('取值范围', r.rng)
    + item('信号描述', r.desc)
    + item('各出处定义', r.src, true)
    + item('差异标注', r.diff, true)
    + item('修正建议', r.fix, true)
    + item('Juniper 适用性', r.jun)
    + '</div></td>';
  tr.after(dr);
  btn.textContent = '收起';
}

/* ---------- 收藏 ---------- */
async function toggleFav(rid) {
  if (favMap.has(rid)) {
    favMap.delete(rid);
    try { await idb.del(rid); } catch (e) {}
  } else {
    const r = DATA[rid];
    const rec = { rid, addedAt: new Date().toISOString(), ...r };
    favMap.set(rid, rec);
    try { await idb.put(rec); } catch (e) {}
  }
  updateFavBadge();
  renderTable();
  if ($('fFavOnly').checked) applyFilters();
}

function updateFavBadge() {
  $('favCount').textContent = favMap.size;
}

function openDrawer() {
  $('favDrawer').hidden = false;
  $('drawerMask').hidden = false;
  renderDrawer();
}
function closeDrawer() {
  $('favDrawer').hidden = true;
  $('drawerMask').hidden = true;
}

function renderDrawer() {
  const box = $('favGroups');
  $('drawerCount').textContent = '（' + favMap.size + ' 条）';
  if (!favMap.size) { box.innerHTML = '<div class="empty">还没有收藏，点击信号列表中的 ★ 即可收藏</div>'; return; }
  // 按 CAN ID 分组
  const groups = new Map();
  for (const rec of favMap.values()) {
    const key = idNum(rec);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  let html = '';
  for (const k of keys) {
    const list = groups.get(k).sort((a, b) => a.sig.localeCompare(b.sig));
    html += '<div class="fav-group"><div class="fav-group-head"><span>' + esc(list[0].id16) + ' (' + k + ')</span><span class="cnt">' + list.length + ' 条信号</span></div>';
    for (const rec of list) {
      html += '<div class="fav-item"><div class="meta">'
        + '<div class="n">' + esc(rec.sig) + '</div>'
        + '<div class="s">' + esc(rec.msg) + ' · 起始位 ' + esc(rec.bit) + ' · 长度 ' + esc(rec.len) + ' · 因子 ' + esc(rec.f) + ' · 单位 ' + esc(rec.unit) + '</div>'
        + '</div><button class="unfav" data-unfav="' + rec.rid + '">移除</button></div>';
    }
    html += '</div>';
  }
  box.innerHTML = html;
  box.querySelectorAll('[data-unfav]').forEach(b => b.onclick = () => toggleFav(parseInt(b.dataset.unfav, 10)).then(renderDrawer));
}

/* ---------- 导出 ---------- */
function favList() {
  const groups = new Map();
  for (const rec of favMap.values()) {
    const key = idNum(rec);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  const out = [];
  [...groups.keys()].sort((a, b) => a - b).forEach(k =>
    groups.get(k).sort((a, b) => a.sig.localeCompare(b.sig)).forEach(r => out.push(r)));
  return out;
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function exportFav(fmt) {
  const list = favList();
  if (!list.length) { alert('收藏列表为空'); return; }
  const stamp = new Date().toISOString().slice(0, 10);
  if (fmt === 'json') {
    download('tesla-can-收藏_' + stamp + '.json', JSON.stringify(list, null, 2), 'application/json');
  } else {
    const cols = ['id16','id10','msg','sig','bit','len','bo','f','o','unit','rng','desc','src','diff','fix','jun','addedAt'];
    const head = ['CAN ID(16进制)','CAN ID(10进制)','报文名','信号名','起始位','长度','字节序','因子','偏移','单位','取值范围','信号描述','各出处定义','差异标注','修正建议','Juniper适用性','收藏时间'];
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = ['\ufeff' + head.map(q).join(',')];
    list.forEach(r => lines.push(cols.map(c => q(r[c])).join(',')));
    download('tesla-can-收藏_' + stamp + '.csv', lines.join('\r\n'), 'text/csv;charset=utf-8');
  }
}

/* ---------- 出处清单 ---------- */
function renderSources() {
  let html = '';
  for (const s of SOURCES) {
    html += '<tr><td>' + esc(s.id) + '</td>'
      + '<td>' + esc(s.name) + '</td>'
      + '<td>' + esc(s.type) + '</td>'
      + '<td>' + (s.url ? '<a class="src-link" href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.url) + '</a>' : '–') + '</td>'
      + '<td>' + esc(s.lic) + '</td>'
      + '<td>' + esc(s.note) + '</td></tr>';
  }
  $('srcBody').innerHTML = html;
}

document.addEventListener('DOMContentLoaded', init);
