'use strict';

var fs = require('fs');
var nodePath = require('path');

var createIndexer = require('./lib/indexer').createIndexer;
var settingsLib = require('./lib/settings');
var scanAssets = require('./lib/scan-assets');

var PKG_NAME = 'res-cite-tool';
var PANEL_ID = 'res-cite-tool';
var UNUSED_PANEL_ID = 'res-cite-tool.unused';

var indexer = null;
var indexerPromise = null;
var shortcut = settingsLib.DEFAULT_SHORTCUT;
var searchShortcut = settingsLib.DEFAULT_SEARCH_SHORTCUT;
var settingsPath = null;
var attached = new Map();
var onWindowCreated = null;
var globalFallbackAccelerators = [];
var disposed = false;
var pendingTrigger = null;
var pendingTriggerTimer = null;
var searchWindow = null;
var searchReturnWindow = null;
var searchSettingsWindow = null;
var searchEntries = [];
var searchIpcInstalled = false;
var searchOpening = false;
var shortcutRecording = false;

function log (msg) {
  try {
    Editor.log('[' + PKG_NAME + '] ' + msg);
  } catch (e) {
    console.log('[' + PKG_NAME + '] ' + msg);
  }
}

function safeGet (fn, fallback) {
  try {
    var value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

function getProjectPath () {
  return safeGet(function () { return Editor.Project.path; }, '');
}

function settingsFileOf (projectPath) {
  return nodePath.join(projectPath, 'local', 'res-cite-tool', 'settings.json');
}

function unusedSettingsFileOf (projectPath) {
  return nodePath.join(projectPath, 'local', 'res-cite-tool', 'unused-settings.json');
}

/**
 * 读取“资源引用管理”面板上次的配置（检索范围、目录、文件类型勾选）。
 * @param {string} projectPath
 * @returns {object}
 */
function loadUnusedSettings (projectPath) {
  try {
    var json = JSON.parse(fs.readFileSync(unusedSettingsFileOf(projectPath), 'utf8'));
    return json && typeof json === 'object' ? json : {};
  } catch (e) {
    return {};
  }
}

/**
 * 校验并规范化面板提交的配置，避免写入异常结构。
 * @param {object} payload
 * @returns {object}
 */
function normalizeUnusedSettings (payload) {
  var input = payload && typeof payload === 'object' ? payload : {};
  var settings = {};

  if (input.mode === 'ignore' || input.mode === 'specify' || input.mode === 'resources') {
    settings.mode = input.mode;
  }
  if (typeof input.ignoreDirs === 'string') {
    settings.ignoreDirs = input.ignoreDirs.slice(0, 4096);
  }
  if (typeof input.specifyDir === 'string') {
    settings.specifyDir = input.specifyDir.slice(0, 1024);
  }
  if (input.types && typeof input.types === 'object') {
    var types = {};
    Object.keys(input.types).forEach(function (ext) {
      if (/^[A-Za-z0-9]+$/.test(ext)) {
        types[ext] = input.types[ext] !== false;
      }
    });
    settings.types = types;
  }
  return settings;
}

function saveUnusedSettings (projectPath, settings) {
  var file = unusedSettingsFileOf(projectPath);
  var dir = nodePath.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
}

function readProjectVersion (projectPath) {
  try {
    var json = JSON.parse(fs.readFileSync(nodePath.join(projectPath, 'project.json'), 'utf8'));
    return String(json.version || '');
  } catch (e) {
    return '';
  }
}

function loadProjectSettings (projectPath) {
  var path = settingsFileOf(projectPath);
  settingsPath = path;
  var loaded = settingsLib.load(path);
  if (fs.existsSync(path)) {
    return loaded;
  }

  // 兼容旧包名（res-cite-find）的快捷键配置，首次启动自动迁移
  var legacyPath = nodePath.join(projectPath, 'local', 'res-cite-find', 'settings.json');
  if (!fs.existsSync(legacyPath)) {
    return loaded;
  }
  try {
    var legacy = settingsLib.load(legacyPath);
    if (legacy && legacy.shortcut) {
      settingsLib.save(path, { shortcut: legacy.shortcut });
      log('settings migrated from ' + legacyPath);
      return legacy;
    }
  } catch (e) {
    log('settings migration failed: ' + (e && e.message));
  }
  return loaded;
}

function reply (event, data) {
  if (event && typeof event.reply === 'function') {
    event.reply(null, data);
  }
}

function sendToPanel (name, payload) {
  try {
    Editor.Ipc.sendToPanel(PANEL_ID, PKG_NAME + ':' + name, payload);
  } catch (e) {
    // 面板未打开时忽略
  }
}

// -----------------------------------------------------------------------------
// 索引生命周期
// -----------------------------------------------------------------------------

function ensureIndexer () {
  if (indexer) {
    return Promise.resolve(indexer);
  }
  if (indexerPromise) {
    return indexerPromise;
  }

  indexerPromise = new Promise(function (resolve) {
    var attempts = 0;

    function tick () {
      if (disposed) {
        resolve(null);
        return;
      }

      var projectPath = getProjectPath();
      if (projectPath && !settingsPath) {
        var loaded = loadProjectSettings(projectPath);
        shortcut = loaded.shortcut;
        searchShortcut = loaded.searchShortcut;
      }

      var importsDir = projectPath ? nodePath.join(projectPath, 'library', 'imports') : '';
      if (projectPath && fs.existsSync(importsDir)) {
        indexer = createIndexer({
          projectPath: projectPath,
          editorVersion: readProjectVersion(projectPath),
          log: log,
          uuidToUrl: function (uuid) {
            return safeGet(function () { return Editor.assetdb.uuidToUrl(uuid); }, null);
          },
          uuidToFspath: function (uuid) {
            return safeGet(function () { return Editor.assetdb.uuidToFspath(uuid); }, null);
          },
          subAssetUuids: function (uuid) {
            return safeGet(function () { return Editor.assetdb.subAssetInfosByUuid(uuid); }, []);
          },
          onProgress: function (payload) {
            sendToPanel('progress', payload);
          },
        });

        indexer.init()
          .then(function () {
            log('indexer initialized');
            resolve(indexer);
          })
          .catch(function (e) {
            log('indexer init error: ' + (e && e.message));
            resolve(indexer);
          });
        return;
      }

      attempts++;
      if (attempts > 120) {
        log('library/imports 未就绪，索引暂不可用');
        indexerPromise = null;
        resolve(null);
        return;
      }
      setTimeout(tick, 500);
    }

    tick();
  });

  return indexerPromise;
}

// -----------------------------------------------------------------------------
// 快捷键：窗口内 before-input-event
// -----------------------------------------------------------------------------

function isEditorWindow (win) {
  try {
    if (!win || win.isDestroyed() || !win.webContents) {
      return false;
    }
    var url = win.webContents.getURL() || '';
    if (!url) {
      return true;
    }
    if (url.indexOf('devtools://') === 0) {
      return false;
    }
    if (url.indexOf('/res-cite-tool/panel/search/') !== -1 ||
        url.indexOf('/res-cite-tool/panel/search-settings/') !== -1) {
      return false;
    }
    if (url.indexOf('http://') === 0 || url.indexOf('https://') === 0) {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

function attachWindow (win) {
  if (!win || win.isDestroyed() || win.__rcSearchWindow || win.__rcSearchSettingsWindow) {
    return;
  }
  var webContents = win.webContents;
  if (!webContents || attached.has(webContents.id)) {
    return;
  }

  var handler = function (event, input) {
    if (!isEditorWindow(win) || shortcutRecording) {
      return;
    }
    if (settingsLib.matchShortcut(input, searchShortcut)) {
      try {
        event.preventDefault();
      } catch (e) {
        // ignore
      }
      openSearchWindow();
      return;
    }
    if (!settingsLib.matchShortcut(input, shortcut)) {
      return;
    }
    try {
      event.preventDefault();
    } catch (e) {
      // ignore
    }
    log('hotkey triggered');
    triggerFind('hotkey');
  };

  try {
    webContents.on('before-input-event', handler);
  } catch (e) {
    log('attach before-input-event failed: ' + (e && e.message));
    return;
  }

  attached.set(webContents.id, { webContents: webContents, handler: handler });

  webContents.once('destroyed', function () {
    try {
      webContents.removeListener('before-input-event', handler);
    } catch (e) {
      // ignore
    }
    attached.delete(webContents.id);
  });
}

function detachWindow (win) {
  if (!win || win.isDestroyed() || !win.webContents) {
    return;
  }
  try {
    var webContents = win.webContents;
    var item = attached.get(webContents.id);
    if (item) {
      webContents.removeListener('before-input-event', item.handler);
      attached.delete(webContents.id);
    }
  } catch (e) {
    // ignore
  }
}

function attachAllWindows () {
  var electron;
  try {
    electron = require('electron');
  } catch (e) {
    log('electron module unavailable: ' + (e && e.message));
    return;
  }

  var windows = [];
  try {
    windows = electron.BrowserWindow.getAllWindows() || [];
  } catch (e) {
    windows = [];
  }
  windows.forEach(attachWindow);

  onWindowCreated = function (event, win) {
    attachWindow(win);
  };
  try {
    electron.app.on('browser-window-created', onWindowCreated);
  } catch (e) {
    log('listen browser-window-created failed: ' + (e && e.message));
  }

  if (attached.size === 0) {
    // 极端环境：拿不到窗口时回退系统级快捷键（仅 Creator 聚焦时执行）
    setTimeout(function () {
      if (attached.size === 0) {
        setupGlobalFallback();
      }
    }, 2000);
  }
}

function detachAllWindows () {
  attached.forEach(function (item) {
    try {
      item.webContents.removeListener('before-input-event', item.handler);
    } catch (e) {
      // ignore
    }
  });
  attached.clear();

  try {
    var electron = require('electron');
    if (onWindowCreated) {
      electron.app.removeListener('browser-window-created', onWindowCreated);
    }
  } catch (e) {
    // ignore
  }
  onWindowCreated = null;
}

function setupGlobalFallback () {
  var electron;
  try {
    electron = require('electron');
  } catch (e) {
    return;
  }
  if (!electron.globalShortcut) {
    return;
  }

  registerGlobalFallback(settingsLib.toAccelerator(searchShortcut), function () {
    var focused = electron.BrowserWindow.getFocusedWindow();
    if (!focused) {
      return;
    }
    openSearchWindow();
  });

  registerGlobalFallback(settingsLib.toAccelerator(shortcut), function () {
    var focused = electron.BrowserWindow.getFocusedWindow();
    if (!focused) {
      return;
    }
    triggerFind('hotkey');
  });
}

function registerGlobalFallback (accelerator, handler) {
  if (!accelerator) {
    return;
  }
  try {
    var ok = require('electron').globalShortcut.register(accelerator, handler);
    if (ok) {
      globalFallbackAccelerators.push(accelerator);
      log('global shortcut fallback registered: ' + accelerator);
    } else {
      log('global shortcut register failed: ' + accelerator);
    }
  } catch (e) {
    log('global shortcut error: ' + (e && e.message));
  }
}

function refreshGlobalFallback () {
  if (globalFallbackAccelerators.length === 0) {
    return;
  }
  try {
    var globalShortcut = require('electron').globalShortcut;
    globalFallbackAccelerators.forEach(function (accelerator) {
      globalShortcut.unregister(accelerator);
    });
  } catch (e) {
    // ignore
  }
  globalFallbackAccelerators = [];
  setupGlobalFallback();
}

// -----------------------------------------------------------------------------
// 快速查找（资源 / 文件夹 / UUID）
// -----------------------------------------------------------------------------

var SEARCH_RESULT_LIMIT = 500;
var SEARCH_CLOSE_DELAY = 2000;

function relOfPath (fspath) {
  var projectPath = getProjectPath();
  if (!projectPath || !fspath) {
    return String(fspath || '');
  }
  var rel = fspath;
  try {
    rel = nodePath.relative(projectPath, fspath) || fspath;
  } catch (e) {
    rel = fspath;
  }
  return rel.replace(/\\/g, '/');
}

function normalizeUuidKeyword (keyword) {
  var raw = String(keyword || '').trim().replace(/[{}\-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(raw)) {
    return '';
  }
  return raw.slice(0, 8) + '-' + raw.slice(8, 12) + '-' + raw.slice(12, 16) + '-' +
    raw.slice(16, 20) + '-' + raw.slice(20);
}

function escapeRegExp (text) {
  return String(text).replace(/[*.?+$^()\[\]{}|\\\/]/g, '\\$&');
}

/**
 * 收集项目 assets 下的文件和文件夹（跳过 .meta）。
 * @returns {Promise<Array>}
 */
function collectSearchEntries () {
  var projectPath = getProjectPath();
  var assetsDir = projectPath ? nodePath.join(projectPath, 'assets') : '';
  var entries = [];
  if (!assetsDir || !fs.existsSync(assetsDir)) {
    return Promise.resolve(entries);
  }

  return new Promise(function (resolve) {
    var pending = 0;
    var finished = false;

    function finish () {
      if (!finished && pending === 0) {
        finished = true;
        resolve(entries);
      }
    }

    function walk (dir) {
      pending++;
      fs.readdir(dir, { withFileTypes: true }, function (err, list) {
        if (!err && list) {
          list.forEach(function (item) {
            var full = nodePath.join(dir, item.name);
            if (item.isDirectory()) {
              entries.push({ name: item.name, path: full, isDir: true, extname: '' });
              walk(full);
            } else if (item.isFile()) {
              var extname = nodePath.extname(item.name);
              if (extname === '.meta') {
                return;
              }
              entries.push({ name: item.name, path: full, isDir: false, extname: extname });
            }
          });
        }
        pending--;
        finish();
      });
    }

    walk(assetsDir);
  });
}

function toSearchItem (entry, extra) {
  var item = {
    name: entry.name,
    path: entry.path,
    rel: relOfPath(entry.path),
    isDir: !!entry.isDir,
    extname: entry.extname || '',
  };
  if (extra) {
    Object.keys(extra).forEach(function (key) {
      item[key] = extra[key];
    });
  }
  return item;
}

/**
 * 按名称模糊匹配（与 ccc-quick-finder 一致：字符顺序匹配，忽略大小写）。
 * @param {string} keyword
 * @returns {Array}
 */
function matchSearchEntries (keyword) {
  var results = [];
  if (!keyword) {
    return results;
  }

  var regExp;
  try {
    regExp = new RegExp(String(keyword).split('').map(escapeRegExp).join('.*?'), 'i');
  } catch (e) {
    return results;
  }

  for (var i = 0; i < searchEntries.length; i++) {
    var entry = searchEntries[i];
    var match = entry.name.match(regExp);
    if (!match) {
      continue;
    }
    results.push({ entry: entry, similarity: match[0].length });
    if (results.length >= 4000) {
      break;
    }
  }

  results.sort(function (a, b) {
    if (a.similarity !== b.similarity) {
      return a.similarity - b.similarity;
    }
    if (a.entry.name.length !== b.entry.name.length) {
      return a.entry.name.length - b.entry.name.length;
    }
    return a.entry.name.localeCompare(b.entry.name);
  });

  return results.slice(0, SEARCH_RESULT_LIMIT).map(function (row) {
    return toSearchItem(row.entry);
  });
}

function resolveUuidItem (uuid) {
  var fspath = safeGet(function () { return Editor.assetdb.uuidToFspath(uuid); }, null);
  if (!fspath) {
    return null;
  }
  return {
    name: nodePath.basename(fspath),
    path: fspath,
    rel: relOfPath(fspath),
    isDir: safeGet(function () { return fs.statSync(fspath).isDirectory(); }, false),
    extname: nodePath.extname(fspath),
    uuid: true,
  };
}

function searchUuidOf (fspath) {
  if (!fspath) {
    return null;
  }
  var uuid = safeGet(function () { return Editor.assetdb.fspathToUuid(fspath); }, null);
  if (uuid) {
    return uuid;
  }
  // 文件夹等场景的兜底：先转 db:// 再取 uuid
  var url = safeGet(function () { return Editor.assetdb.fspathToUrl(fspath); }, null);
  if (url) {
    return safeGet(function () { return Editor.assetdb.urlToUuid(url); }, null);
  }
  return null;
}

function handleSearchMatch (event, keyword) {
  var payload = { items: [], notice: '' };
  if (!event || !event.sender || event.sender.isDestroyed()) {
    return;
  }
  var text = String(keyword || '').trim();
  if (!text) {
    event.sender.send('res-cite-tool:search-results', payload);
    return;
  }

  var uuid = normalizeUuidKeyword(text);
  if (uuid) {
    var item = resolveUuidItem(uuid);
    if (item) {
      payload.items.push(item);
    } else {
      payload.notice = '未找到 UUID 对应的资源';
    }
  } else {
    payload.items = matchSearchEntries(text);
  }

  if (!event.sender.isDestroyed()) {
    event.sender.send('res-cite-tool:search-results', payload);
  }
}

function revealSearchItem (item) {
  var uuid = searchUuidOf(item && item.path);
  if (!uuid) {
    return;
  }
  safeGet(function () { Editor.Ipc.sendToAll('assets:hint', uuid); });
  safeGet(function () { Editor.Selection.select('asset', uuid); });
}

function openSearchItem (item) {
  if (!item || !item.path) {
    return;
  }

  var uuid = searchUuidOf(item.path);
  var extname = String(item.extname || '').toLowerCase();

  if (uuid && !item.isDir) {
    if (extname === '.prefab') {
      safeGet(function () { Editor.Ipc.sendToAll('scene:enter-prefab-edit-mode', uuid); });
    } else if (extname === '.fire' || extname === '.scene') {
      safeGet(function () { Editor.Panel.open('scene', { uuid: uuid }); });
    } else if (extname === '.ts' || extname === '.js' || extname === '.json' ||
               extname === '.txt' || extname === '.md') {
      safeGet(function () { Editor.Ipc.sendToMain('assets:open-text-file', uuid); });
    }
  }

  hideSearchWindow(true);

  if (uuid) {
    // 窗口已隐藏但尚未销毁，此时广播不会与窗口销毁产生竞态
    setTimeout(function () {
      revealSearchItem(item);
    }, 50);
  }
}

/**
 * 激活编辑器窗口：优先使用打开搜索窗前聚焦的窗口，否则回退到任意编辑器窗口。
 * @param {object|null} preferred
 * @returns {boolean}
 */
function focusEditorWindow (preferred) {
  var candidates = preferred ? [preferred] : [];
  try {
    var electron = require('electron');
    var windows = (electron.BrowserWindow && electron.BrowserWindow.getAllWindows()) || [];
    windows.forEach(function (win) {
      if (win !== preferred && isEditorWindow(win)) {
        candidates.push(win);
      }
    });
  } catch (e) {
    // ignore
  }

  for (var i = 0; i < candidates.length; i++) {
    var win = candidates[i];
    try {
      if (!win || win.isDestroyed()) {
        continue;
      }
      if (typeof win.isMinimized === 'function' && win.isMinimized()) {
        win.restore();
      }
      win.show();
      win.focus();
      return true;
    } catch (e) {
      // ignore
    }
  }
  return false;
}

function getFocusedEditorWindow () {
  try {
    var electron = require('electron');
    var win = electron.BrowserWindow && electron.BrowserWindow.getFocusedWindow();
    if (win && !win.isDestroyed() && isEditorWindow(win)) {
      return win;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

/**
 * 关闭搜索窗。
 * @param {boolean} restoreFocus 是否把焦点交还给编辑器（Esc / 打开结果时使用）
 */
function hideSearchWindow (restoreFocus) {
  if (!searchWindow || searchWindow.isDestroyed()) {
    searchWindow = null;
    var fallbackTarget = restoreFocus ? searchReturnWindow : null;
    searchReturnWindow = null;
    if (restoreFocus) {
      setTimeout(function () {
        focusEditorWindow(fallbackTarget);
      }, 0);
    }
    return;
  }

  var win = searchWindow;
  var target = restoreFocus ? searchReturnWindow : null;
  searchWindow = null;
  searchReturnWindow = null;
  try {
    win.hide();
  } catch (e) {
    // ignore
  }

  if (restoreFocus) {
    // 先隐藏搜索窗，再激活编辑器，避免隐藏动作把焦点留在桌面上
    setTimeout(function () {
      focusEditorWindow(target);
    }, 0);
  }

  setTimeout(function () {
    try {
      if (!win.isDestroyed()) {
        win.close();
      }
    } catch (e) {
      // ignore
    }
  }, SEARCH_CLOSE_DELAY);
}

function createSearchWindow () {
  var electron;
  try {
    electron = require('electron');
  } catch (e) {
    log('search window unavailable: ' + (e && e.message));
    return;
  }

  var BrowserWindow = electron.BrowserWindow;
  if (!BrowserWindow) {
    return;
  }

  var width = 560;
  var height = 560;
  var area = { x: 0, y: 0, width: 1280, height: 800 };
  try {
    area = electron.screen.getPrimaryDisplay().workArea;
  } catch (e) {
    // ignore
  }

  var win = new BrowserWindow({
    width: width,
    height: height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + Math.max(40, area.height * 0.18)),
    frame: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    opacity: 0.97,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.__rcSearchWindow = true;
  searchWindow = win;
  // 搜索窗不需要编辑器快捷键钩子
  detachWindow(win);

  win.on('ready-to-show', function () {
    try {
      win.show();
      win.focus();
    } catch (e) {
      // ignore
    }
  });
  win.on('blur', function () {
    if (searchWindow === win) {
      hideSearchWindow(false);
    }
  });
  win.on('closed', function () {
    if (searchWindow === win) {
      searchWindow = null;
    }
  });

  var page = nodePath.join(__dirname, 'panel', 'search', 'index.html').replace(/\\/g, '/');
  win.loadURL('file:///' + page);
}

function openSearchWindow () {
  if (searchWindow && !searchWindow.isDestroyed()) {
    hideSearchWindow(false);
    return;
  }
  if (searchOpening) {
    return;
  }
  if (!getProjectPath()) {
    log('project not ready, skip search');
    return;
  }

  // 记住打开搜索窗前的编辑器窗口，关闭时把焦点交还给它
  searchReturnWindow = getFocusedEditorWindow();
  searchOpening = true;
  collectSearchEntries().then(function (entries) {
    searchOpening = false;
    if (disposed) {
      return;
    }
    searchEntries = entries;
    createSearchWindow();
  }).catch(function (e) {
    searchOpening = false;
    if (disposed) {
      return;
    }
    log('collect search entries failed: ' + (e && e.message));
    searchEntries = [];
    createSearchWindow();
  });
}

// -----------------------------------------------------------------------------
// 快速查找资源设置（独立弹窗）
// -----------------------------------------------------------------------------

/**
 * 应用快速查找快捷键：校验 → 持久化 → 刷新系统级回退注册。
 * @param {object} raw
 * @returns {object}
 */
function applySearchShortcut (raw) {
  var combo = settingsLib.normalize(raw);
  if (!combo) {
    return { ok: false, error: 'INVALID_SHORTCUT' };
  }

  var previous = searchShortcut;
  searchShortcut = combo;
  if (!persistSettings()) {
    searchShortcut = previous;
    return { ok: false, error: 'SAVE_FAILED' };
  }

  refreshGlobalFallback();
  log('search shortcut changed to ' + combo.label);
  return { ok: true, shortcut: combo };
}

function sendSearchSettingsResult (sender, payload) {
  try {
    if (sender && !sender.isDestroyed()) {
      sender.send('res-cite-tool:search-settings-result', payload);
    }
  } catch (e) {
    // ignore
  }
}

function createSearchSettingsWindow () {
  var electron;
  try {
    electron = require('electron');
  } catch (e) {
    log('search settings window unavailable: ' + (e && e.message));
    return;
  }

  var BrowserWindow = electron.BrowserWindow;
  if (!BrowserWindow) {
    return;
  }

  var win = new BrowserWindow({
    width: 460,
    height: 250,
    title: '快速查找资源设置',
    frame: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.__rcSearchSettingsWindow = true;
  searchSettingsWindow = win;
  detachWindow(win);

  win.on('ready-to-show', function () {
    try {
      win.center();
    } catch (e) {
      // ignore
    }
    try {
      win.show();
      win.focus();
    } catch (e) {
      // ignore
    }
  });
  win.on('closed', function () {
    if (searchSettingsWindow === win) {
      searchSettingsWindow = null;
    }
    shortcutRecording = false;
  });

  var page = nodePath.join(__dirname, 'panel', 'search-settings', 'index.html').replace(/\\/g, '/');
  win.loadURL('file:///' + page);
}

function openSearchSettingsWindow () {
  if (searchSettingsWindow && !searchSettingsWindow.isDestroyed()) {
    try {
      searchSettingsWindow.show();
      searchSettingsWindow.focus();
    } catch (e) {
      // ignore
    }
    return;
  }
  createSearchSettingsWindow();
}

function closeSearchSettingsWindow () {
  if (!searchSettingsWindow || searchSettingsWindow.isDestroyed()) {
    searchSettingsWindow = null;
    return;
  }
  try {
    searchSettingsWindow.close();
  } catch (e) {
    // ignore
  }
}

function installSearchIpc () {
  var electron;
  try {
    electron = require('electron');
  } catch (e) {
    return;
  }
  if (!electron || !electron.ipcMain || searchIpcInstalled) {
    return;
  }

  searchIpcInstalled = true;
  var ipc = electron.ipcMain;
  ipc.on('res-cite-tool:search-match', function (event, keyword) {
    handleSearchMatch(event, keyword);
  });
  ipc.on('res-cite-tool:search-open', function (event, item) {
    openSearchItem(item);
  });
  ipc.on('res-cite-tool:search-focus', function (event, item) {
    revealSearchItem(item);
  });
  ipc.on('res-cite-tool:search-close', function () {
    hideSearchWindow(true);
  });
  ipc.on('res-cite-tool:search-settings-get', function (event) {
    var sender = event && event.sender;
    if (sender && !sender.isDestroyed()) {
      sender.send('res-cite-tool:search-settings-state', {
        ok: true,
        shortcut: searchShortcut,
      });
    }
  });
  ipc.on('res-cite-tool:search-settings-set', function (event, payload) {
    sendSearchSettingsResult(event && event.sender, applySearchShortcut(payload));
  });
  ipc.on('res-cite-tool:search-settings-reset', function (event) {
    sendSearchSettingsResult(
      event && event.sender,
      applySearchShortcut(settingsLib.DEFAULT_SEARCH_SHORTCUT)
    );
  });
  ipc.on('res-cite-tool:search-settings-close', function () {
    closeSearchSettingsWindow();
  });
  ipc.on('res-cite-tool:shortcut-recording', function (event, flag) {
    shortcutRecording = !!flag;
  });
}

function removeSearchIpc () {
  try {
    var ipc = require('electron').ipcMain;
    ipc.removeAllListeners('res-cite-tool:search-match');
    ipc.removeAllListeners('res-cite-tool:search-open');
    ipc.removeAllListeners('res-cite-tool:search-focus');
    ipc.removeAllListeners('res-cite-tool:search-close');
    ipc.removeAllListeners('res-cite-tool:search-settings-get');
    ipc.removeAllListeners('res-cite-tool:search-settings-set');
    ipc.removeAllListeners('res-cite-tool:search-settings-reset');
    ipc.removeAllListeners('res-cite-tool:search-settings-close');
    ipc.removeAllListeners('res-cite-tool:shortcut-recording');
  } catch (e) {
    // ignore
  }
  searchIpcInstalled = false;
}

// -----------------------------------------------------------------------------
// 面板触发
// -----------------------------------------------------------------------------

function getMainSelectionUuids () {
  var ids = safeGet(function () { return Editor.Selection.curSelection('asset'); }, []);
  if (!Array.isArray(ids)) {
    return [];
  }
  return ids.map(function (id) {
    if (typeof id === 'string' && id.indexOf('db://') === 0) {
      var uuid = safeGet(function () { return Editor.assetdb.urlToUuid(id); }, null);
      return uuid || id;
    }
    return id;
  });
}

function triggerFind (source) {
  try {
    Editor.Panel.open(PANEL_ID);
  } catch (e) {
    log('open panel failed: ' + (e && e.message));
  }

  // 面板首次创建时 trigger 可能丢失：记录一次，等面板就绪后补发
  pendingTrigger = { source: source || 'menu', uuids: getMainSelectionUuids() };
  if (pendingTriggerTimer) {
    clearTimeout(pendingTriggerTimer);
  }
  pendingTriggerTimer = setTimeout(function () {
    pendingTriggerTimer = null;
    pendingTrigger = null;
  }, 3000);

  sendToPanel('trigger', pendingTrigger);
}

function openUnusedPanel () {
  try {
    Editor.Panel.open(UNUSED_PANEL_ID);
  } catch (e) {
    log('open unused panel failed: ' + (e && e.message));
  }
}

// -----------------------------------------------------------------------------
// 未引用资源清理
// -----------------------------------------------------------------------------

function confirmClean (urls) {
  var electron;
  try {
    electron = require('electron');
  } catch (e) {
    return true;
  }
  var dialog = electron && electron.dialog;
  if (!dialog || typeof dialog.showMessageBoxSync !== 'function') {
    return true;
  }

  var detailLines = urls.slice(0, 10).join('\n');
  if (urls.length > 10) {
    detailLines += '\n…共 ' + urls.length + ' 项';
  }

  var options = {
    type: 'warning',
    buttons: ['取消', '清理'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: '资源引用管理',
    message: '确认清理选中的 ' + urls.length + ' 个资源？',
    detail: '资源文件及其 .meta 会被删除，且无法撤销。\n\n' + detailLines,
  };

  try {
    var win = electron.BrowserWindow && electron.BrowserWindow.getFocusedWindow();
    var result = win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options);
    return result === 1;
  } catch (e) {
    log('confirm dialog failed: ' + (e && e.message));
    return true;
  }
}

function handlePickDirectory (event) {
  var projectPath = getProjectPath();
  if (!projectPath) {
    reply(event, { ok: false, error: 'PROJECT_NOT_READY' });
    return;
  }

  var assetsDir = nodePath.join(projectPath, 'assets');
  var electron;
  try {
    electron = require('electron');
  } catch (e) {
    reply(event, { ok: false, error: 'DIALOG_UNAVAILABLE' });
    return;
  }

  var dialog = electron && electron.dialog;
  if (!dialog || typeof dialog.showOpenDialogSync !== 'function') {
    reply(event, { ok: false, error: 'DIALOG_UNAVAILABLE' });
    return;
  }

  var options = {
    title: '选择清理目录',
    defaultPath: assetsDir,
    buttonLabel: '选择',
    properties: ['openDirectory'],
  };

  try {
    var win = electron.BrowserWindow && electron.BrowserWindow.getFocusedWindow();
    var result = win
      ? dialog.showOpenDialogSync(win, options)
      : dialog.showOpenDialogSync(options);

    if (!result || result.length === 0) {
      reply(event, { ok: true, canceled: true });
      return;
    }

    var selected = result[0];
    var realAssets = fs.realpathSync(assetsDir);
    var realSelected = fs.realpathSync(selected);
    var rel = nodePath.relative(realAssets, realSelected);
    var sep = nodePath.sep;
    var outside = rel && (rel === '..' || rel.indexOf('..' + sep) === 0 || nodePath.isAbsolute(rel));
    if (outside) {
      reply(event, { ok: false, error: 'OUTSIDE_ASSETS' });
      return;
    }

    reply(event, {
      ok: true,
      canceled: false,
      dir: rel.replace(/\\/g, '/'),
    });
  } catch (e) {
    reply(event, { ok: false, error: String((e && e.message) || e) });
  }
}

function handleDeleteAssets (event, payload) {
  var urls = payload && payload.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    reply(event, { ok: false, error: 'EMPTY_SELECTION' });
    return;
  }

  var valid = urls.filter(function (url) {
    return typeof url === 'string' && url.indexOf('db://assets/') === 0;
  });
  if (valid.length === 0) {
    reply(event, { ok: false, error: 'INVALID_URLS' });
    return;
  }

  if (!confirmClean(valid)) {
    reply(event, { ok: false, canceled: true });
    return;
  }

  var finished = false;
  var fallbackTimer = null;

  function verify () {
    if (finished) {
      return;
    }
    finished = true;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }

    var deleted = [];
    var failed = [];
    valid.forEach(function (url) {
      var exists = safeGet(function () { return Editor.assetdb.exists(url); }, false);
      if (exists) {
        failed.push(url);
      } else {
        deleted.push(url);
      }
    });

    deleted.forEach(function (url) {
      log('deleted asset ' + url);
    });
    failed.forEach(function (url) {
      log('delete failed, still exists: ' + url);
    });

    reply(event, {
      ok: failed.length === 0,
      canceled: false,
      deleted: deleted,
      failed: failed,
    });
  }

  try {
    Editor.assetdb.delete(valid, function () {
      setTimeout(verify, 400);
    });
  } catch (e) {
    reply(event, { ok: false, error: String((e && e.message) || e) });
    return;
  }

  fallbackTimer = setTimeout(verify, 1500);
}

// -----------------------------------------------------------------------------
// 消息处理
// -----------------------------------------------------------------------------

function handleQuery (event, uuids) {
  if (!Array.isArray(uuids) || uuids.length === 0) {
    reply(event, { ok: false, error: 'EMPTY_SELECTION' });
    return;
  }

  ensureIndexer()
    .then(function (idx) {
      if (!idx) {
        reply(event, { ok: false, error: 'INDEX_UNAVAILABLE' });
        return;
      }
      idx.query(uuids)
        .then(function (result) {
          reply(event, result);
        })
        .catch(function (e) {
          reply(event, { ok: false, error: String((e && e.message) || e) });
        });
    })
    .catch(function (e) {
      reply(event, { ok: false, error: String((e && e.message) || e) });
    });
}

function persistSettings () {
  if (!settingsPath) {
    return false;
  }
  try {
    settingsLib.save(settingsPath, {
      shortcut: shortcut,
      searchShortcut: searchShortcut,
    });
    return true;
  } catch (e) {
    log('save settings failed: ' + (e && e.message));
    return false;
  }
}

// -----------------------------------------------------------------------------
// 插件入口
// -----------------------------------------------------------------------------

module.exports = {
  load: function () {
    disposed = false;
    log('package loaded');

    var projectPath = getProjectPath();
    if (projectPath) {
      var loaded = loadProjectSettings(projectPath);
      shortcut = loaded.shortcut;
      searchShortcut = loaded.searchShortcut;
    }

    attachAllWindows();
    installSearchIpc();
    ensureIndexer();
  },

  unload: function () {
    disposed = true;
    detachAllWindows();

    if (pendingTriggerTimer) {
      clearTimeout(pendingTriggerTimer);
      pendingTriggerTimer = null;
    }
    pendingTrigger = null;

    if (searchWindow && !searchWindow.isDestroyed()) {
      try {
        searchWindow.destroy();
      } catch (e) {
        // ignore
      }
    }
    searchWindow = null;
    searchReturnWindow = null;
    if (searchSettingsWindow && !searchSettingsWindow.isDestroyed()) {
      try {
        searchSettingsWindow.destroy();
      } catch (e) {
        // ignore
      }
    }
    searchSettingsWindow = null;
    searchEntries = [];
    shortcutRecording = false;
    removeSearchIpc();

    if (globalFallbackAccelerators.length > 0) {
      try {
        var globalShortcut = require('electron').globalShortcut;
        globalFallbackAccelerators.forEach(function (accelerator) {
          globalShortcut.unregister(accelerator);
        });
      } catch (e) {
        // ignore
      }
      globalFallbackAccelerators = [];
    }

    if (indexer) {
      indexer.dispose();
      indexer = null;
    }
    indexerPromise = null;
    log('package unloaded');
  },

  messages: {
    'open-panel': function () {
      triggerFind('menu');
    },

    'open-search': function () {
      openSearchWindow();
    },

    'open-search-settings': function () {
      openSearchSettingsWindow();
    },

    'set-shortcut-recording': function (event, flag) {
      shortcutRecording = !!flag;
    },

    'open-unused-panel': function () {
      openUnusedPanel();
    },

    'list-meta': function (event) {
      var projectPath = getProjectPath();
      if (!projectPath) {
        reply(event, { ok: false, error: 'PROJECT_NOT_READY' });
        return;
      }
      try {
        var meta = scanAssets.collect(projectPath);
        reply(event, { ok: true, dirs: meta.dirs, types: meta.types });
      } catch (e) {
        reply(event, { ok: false, error: String((e && e.message) || e) });
      }
    },

    'get-unused-settings': function (event) {
      var projectPath = getProjectPath();
      if (!projectPath) {
        reply(event, { ok: false, error: 'PROJECT_NOT_READY' });
        return;
      }
      reply(event, { ok: true, settings: loadUnusedSettings(projectPath) });
    },

    'set-unused-settings': function (event, payload) {
      var projectPath = getProjectPath();
      if (!projectPath) {
        reply(event, { ok: false, error: 'PROJECT_NOT_READY' });
        return;
      }
      try {
        saveUnusedSettings(projectPath, normalizeUnusedSettings(payload));
        reply(event, { ok: true });
      } catch (e) {
        log('save unused settings failed: ' + (e && e.message));
        reply(event, { ok: false, error: 'SAVE_FAILED' });
      }
    },

    'find-unused': function (event, options) {
      ensureIndexer()
        .then(function (idx) {
          if (!idx) {
            reply(event, { ok: false, error: 'INDEX_UNAVAILABLE' });
            return;
          }
          return idx.findUnused(options).then(function (res) {
            reply(event, res);
          });
        })
        .catch(function (e) {
          reply(event, { ok: false, error: String((e && e.message) || e) });
        });
    },

    'find-resource-refs': function (event, options) {
      ensureIndexer()
        .then(function (idx) {
          if (!idx) {
            reply(event, { ok: false, error: 'INDEX_UNAVAILABLE' });
            return;
          }
          return idx.findResourceRefs(options).then(function (res) {
            reply(event, res);
          });
        })
        .catch(function (e) {
          reply(event, { ok: false, error: String((e && e.message) || e) });
        });
    },

    'delete-assets': function (event, payload) {
      handleDeleteAssets(event, payload);
    },

    'pick-directory': function (event) {
      handlePickDirectory(event);
    },

    'panel-ready': function () {
      if (pendingTrigger) {
        var payload = pendingTrigger;
        pendingTrigger = null;
        if (pendingTriggerTimer) {
          clearTimeout(pendingTriggerTimer);
          pendingTriggerTimer = null;
        }
        sendToPanel('trigger', payload);
      }
    },

    'query': function (event, uuids) {
      handleQuery(event, uuids);
    },

    'query-nodes': function (event, payload) {
      if (!payload || !payload.referrerUuid || !payload.targetUuid) {
        reply(event, { ok: false, error: 'INVALID_PARAMS' });
        return;
      }
      ensureIndexer()
        .then(function (idx) {
          if (!idx) {
            reply(event, { ok: false, error: 'INDEX_UNAVAILABLE' });
            return;
          }
          idx.queryNodeRefs(payload.referrerUuid, payload.targetUuid)
            .then(function (res) {
              reply(event, res);
            })
            .catch(function (e) {
              reply(event, { ok: false, error: String((e && e.message) || e) });
            });
        })
        .catch(function (e) {
          reply(event, { ok: false, error: String((e && e.message) || e) });
        });
    },

    'get-status': function (event) {
      ensureIndexer().then(function (idx) {
        reply(event, idx ? idx.getStats() : { state: 'unavailable' });
      });
    },

    'get-settings': function (event) {
      reply(event, { shortcut: shortcut, searchShortcut: searchShortcut });
    },

    'set-shortcut': function (event, payload) {
      var combo = settingsLib.normalize(payload);
      if (!combo) {
        reply(event, { ok: false, error: 'INVALID_SHORTCUT' });
        return;
      }

      var previous = shortcut;
      shortcut = combo;
      if (!persistSettings()) {
        shortcut = previous;
        reply(event, { ok: false, error: 'SAVE_FAILED' });
        return;
      }

      refreshGlobalFallback();
      log('shortcut changed to ' + combo.label);
      reply(event, { ok: true, shortcut: combo });
    },

    'set-search-shortcut': function (event, payload) {
      reply(event, applySearchShortcut(payload));
    },

    'rebuild-index': function (event) {
      ensureIndexer().then(function (idx) {
        if (!idx) {
          reply(event, { ok: false, error: 'INDEX_UNAVAILABLE' });
          return;
        }
        idx.forceRebuild()
          .then(function (stats) {
            reply(event, { ok: true, stats: stats });
          })
          .catch(function (e) {
            reply(event, { ok: false, error: String((e && e.message) || e) });
          });
      });
    },
  },
};
