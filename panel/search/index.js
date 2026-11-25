'use strict';

var ipcRenderer = require('electron').ipcRenderer;

var inputEl = document.getElementById('input');
var searchBtn = document.getElementById('searchBtn');
var noticeEl = document.getElementById('notice');
var resultEl = document.getElementById('result');
var listEl = document.getElementById('list');

var items = [];
var curIndex = -1;
var renderToken = 0;
var searchTimer = null;

function badgeOf (item) {
  if (item.isDir) {
    return 'DIR';
  }
  if (item.uuid) {
    return 'UUID';
  }
  var ext = String(item.extname || '').replace('.', '').toUpperCase();
  return ext ? ext.slice(0, 6) : 'FILE';
}

function createRow (item, index) {
  var li = document.createElement('li');
  li.className = 'item';
  li.setAttribute('data-index', String(index));
  li.setAttribute('selected', 'false');

  var info = document.createElement('div');
  info.className = 'info';

  var badge = document.createElement('span');
  badge.className = 'badge' +
    (item.isDir ? ' badge-dir' : (item.uuid ? ' badge-uuid' : ''));
  badge.textContent = badgeOf(item);

  var name = document.createElement('span');
  name.className = 'name';
  name.textContent = item.name;

  info.appendChild(badge);
  info.appendChild(name);

  var detail = document.createElement('div');
  detail.className = 'detail';
  var path = document.createElement('span');
  path.className = 'path';
  path.textContent = item.rel || item.path || '';
  detail.appendChild(path);

  li.appendChild(info);
  li.appendChild(detail);
  li.addEventListener('click', function () {
    setSelected(index);
    onOpen();
  });
  return li;
}

function renderChunk (token, start) {
  if (token !== renderToken) {
    return;
  }
  var end = Math.min(start + 150, items.length);
  for (var i = start; i < end; i++) {
    listEl.appendChild(createRow(items[i], i));
  }
  if (end < items.length) {
    setTimeout(function () {
      renderChunk(token, end);
    }, 0);
  }
}

function setSelected (index) {
  if (index < 0 || index >= items.length) {
    return;
  }
  var rows = listEl.querySelectorAll('.item');
  for (var i = 0; i < rows.length; i++) {
    rows[i].setAttribute('selected', 'false');
  }
  curIndex = index;
  var row = listEl.querySelector('.item[data-index="' + index + '"]');
  if (row) {
    row.setAttribute('selected', 'true');
    if (row.scrollIntoView) {
      row.scrollIntoView({ block: 'nearest' });
    }
  }
  var item = items[index];
  if (!item.uuid) {
    inputEl.value = item.name;
  }
}

function renderResults (payload) {
  var token = ++renderToken;
  items = (payload && payload.items) || [];
  curIndex = -1;

  noticeEl.hidden = !(payload && payload.notice);
  noticeEl.textContent = (payload && payload.notice) || '';

  listEl.innerHTML = '';
  resultEl.hidden = items.length === 0;
  if (items.length === 0) {
    return;
  }

  // 只有一个结果时直接选中，回车即可打开
  if (items.length === 1) {
    renderChunk(token, 0);
    setSelected(0);
    return;
  }
  renderChunk(token, 0);
}

function sendMatch (keyword) {
  ipcRenderer.send('res-cite-tool:search-match', keyword);
}

function moveSelection (delta) {
  if (items.length === 0) {
    return;
  }
  var next = curIndex + delta;
  if (next < 0) {
    next = items.length - 1;
  }
  if (next >= items.length) {
    next = 0;
  }
  setSelected(next);
}

function shakeInput () {
  inputEl.classList.add('input-error');
  setTimeout(function () {
    inputEl.classList.remove('input-error');
  }, 500);
}

function onOpen () {
  if (curIndex < 0) {
    if (inputEl.value !== '') {
      shakeInput();
    }
    return;
  }
  ipcRenderer.send('res-cite-tool:search-open', items[curIndex]);
}

function onFocusItem () {
  if (curIndex < 0) {
    return;
  }
  ipcRenderer.send('res-cite-tool:search-focus', items[curIndex]);
}

inputEl.addEventListener('input', function () {
  if (searchTimer) {
    clearTimeout(searchTimer);
  }
  var value = inputEl.value;
  searchTimer = setTimeout(function () {
    searchTimer = null;
    sendMatch(value);
  }, 60);
});

inputEl.addEventListener('keydown', function (event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveSelection(1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveSelection(-1);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    onOpen();
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    onFocusItem();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    ipcRenderer.send('res-cite-tool:search-close');
  }
});

searchBtn.addEventListener('click', function () {
  onOpen();
  inputEl.focus();
});

// 焦点不在输入框时（如点在按钮上）也能用 Esc 关闭
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && event.target !== inputEl) {
    ipcRenderer.send('res-cite-tool:search-close');
  }
});

ipcRenderer.on('res-cite-tool:search-results', function (event, payload) {
  renderResults(payload);
});

window.addEventListener('focus', function () {
  inputEl.focus();
});

window.addEventListener('load', function () {
  inputEl.focus();
  setTimeout(function () {
    inputEl.focus();
  }, 50);
});
