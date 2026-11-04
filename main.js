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
var settingsPath = null;
var attached = new Map();
var onWindowCreated = null;
var globalFallbackAccelerator = null;
var disposed = false;
var pendingTrigger = null;
var pendingTriggerTimer = null;

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
        shortcut = loadProjectSettings(projectPath).shortcut;
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
    if (url.indexOf('http://') === 0 || url.indexOf('https://') === 0) {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

function attachWindow (win) {
  if (!win || win.isDestroyed()) {
    return;
  }
  var webContents = win.webContents;
  if (!webContents || attached.has(webContents.id)) {
    return;
  }

  var handler = function (event, input) {
    if (!isEditorWindow(win)) {
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
  log('input hook attached id=' + webContents.id);

  webContents.once('destroyed', function () {
    try {
      webContents.removeListener('before-input-event', handler);
    } catch (e) {
      // ignore
    }
    attached.delete(webContents.id);
  });
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

  var accelerator = settingsLib.toAccelerator(shortcut);
  if (!accelerator) {
    return;
  }

  try {
    var ok = electron.globalShortcut.register(accelerator, function () {
      var focused = electron.BrowserWindow.getFocusedWindow();
      if (!focused) {
        return;
      }
      triggerFind('hotkey');
    });
    if (ok) {
      globalFallbackAccelerator = accelerator;
      log('global shortcut fallback registered: ' + accelerator);
    } else {
      log('global shortcut register failed: ' + accelerator);
    }
  } catch (e) {
    log('global shortcut error: ' + (e && e.message));
  }
}

function refreshGlobalFallback () {
  if (!globalFallbackAccelerator) {
    return;
  }
  try {
    require('electron').globalShortcut.unregister(globalFallbackAccelerator);
  } catch (e) {
    // ignore
  }
  globalFallbackAccelerator = null;
  setupGlobalFallback();
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

// -----------------------------------------------------------------------------
// 插件入口
// -----------------------------------------------------------------------------

module.exports = {
  load: function () {
    disposed = false;
    log('package loaded');

    var projectPath = getProjectPath();
    if (projectPath) {
      shortcut = loadProjectSettings(projectPath).shortcut;
    }

    attachAllWindows();
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

    if (globalFallbackAccelerator) {
      try {
        require('electron').globalShortcut.unregister(globalFallbackAccelerator);
      } catch (e) {
        // ignore
      }
      globalFallbackAccelerator = null;
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
      reply(event, { shortcut: shortcut });
    },

    'set-shortcut': function (event, payload) {
      var combo = settingsLib.normalize(payload);
      if (!combo) {
        reply(event, { ok: false, error: 'INVALID_SHORTCUT' });
        return;
      }

      if (settingsPath) {
        try {
          settingsLib.save(settingsPath, { shortcut: combo });
        } catch (e) {
          reply(event, { ok: false, error: 'SAVE_FAILED' });
          return;
        }
      }

      shortcut = combo;
      refreshGlobalFallback();
      log('shortcut changed to ' + combo.label);
      reply(event, { ok: true, shortcut: combo });
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
