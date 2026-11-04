'use strict';

var fs = require('fs');
var clipboard = require('../lib/clipboard');

var PANEL_TEMPLATE = fs.readFileSync(Editor.url('packages://res-cite-tool/panel/template.html'), 'utf8');
var PANEL_STYLE = fs.readFileSync(Editor.url('packages://res-cite-tool/panel/style.css'), 'utf8');

var MODIFIER_CODES = {
  ControlLeft: true,
  ControlRight: true,
  AltLeft: true,
  AltRight: true,
  ShiftLeft: true,
  ShiftRight: true,
  MetaLeft: true,
  MetaRight: true,
  OSLeft: true,
  OSRight: true,
  CapsLock: true,
};

function urlOf (uuid) {
  try {
    var remoteUrl = Editor.remote.assetdb.uuidToUrl(uuid);
    if (remoteUrl) {
      return remoteUrl;
    }
  } catch (e) {
    // ignore
  }
  try {
    var localUrl = Editor.assetdb.uuidToUrl(uuid);
    if (localUrl) {
      return localUrl;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

// 资源管理器选择通常是 uuid；若拿到 url 则转回 uuid
function normalizeSelectionIds (ids) {
  return ids.map(function (id) {
    if (typeof id !== 'string' || id.indexOf('db://') !== 0) {
      return id;
    }
    try {
      var uuid = Editor.remote.assetdb.urlToUuid(id);
      return uuid || id;
    } catch (e) {
      return id;
    }
  });
}

function previewCombo (e) {
  var parts = [];
  if (e.ctrlKey) {
    parts.push('Ctrl');
  }
  if (e.altKey) {
    parts.push('Alt');
  }
  if (e.shiftKey) {
    parts.push('Shift');
  }
  if (e.metaKey) {
    parts.push('Meta');
  }
  var code = e.code || '';
  var key = String(e.key || '');
  if (/^Key[A-Z]$/.test(code)) {
    key = code.slice(3);
  } else if (/^Digit[0-9]$/.test(code)) {
    key = code.slice(5);
  } else if (key === ' ') {
    key = 'Space';
  } else if (key.length === 1) {
    key = key.toUpperCase();
  }
  parts.push(key || '?');
  return parts.join('+');
}

function formatIndex (index) {
  if (!index) {
    return '索引未就绪';
  }
  if (index.state === 'building') {
    return '索引构建中…';
  }
  if (index.state === 'idle') {
    return '索引准备中…';
  }
  if (index.state === 'error') {
    return '索引异常：' + (index.error || '未知错误');
  }
  if (index.state === 'unavailable') {
    return '索引不可用：library 尚未就绪';
  }

  var parts = ['索引：' + index.assets + ' 项', index.edges + ' 条引用'];
  if (index.buildMs) {
    parts.push('构建 ' + index.buildMs + ' ms');
  }
  if (index.cacheHit) {
    parts.push('缓存命中');
  }
  return parts.join(' · ');
}

Editor.Panel.extend({
  style: PANEL_STYLE,
  template: PANEL_TEMPLATE,

  ready: function () {
    var self = this;
    var root = this.shadowRoot || this.$el || this;

    this._pendingCombo = null;
    this._busy = false;
    this._statusTimer = null;
    this._nodeCache = new Map();
    this._locatingNode = false;
    this._toastBase = null;
    this._toastTimer = null;

    this.$selection = root.querySelector('#rcf-selection');
    this.$results = root.querySelector('#rcf-results');
    this.$status = root.querySelector('#rcf-status');
    this.$toggleAll = root.querySelector('#rcf-btn-toggle-all');
    this._groupEntries = [];
    this.$toggleAll.addEventListener('click', function () {
      self.toggleAllGroups();
    });
    this.$settings = root.querySelector('#rcf-settings');
    this.$shortcutInput = root.querySelector('#rcf-shortcut-input');
    this.$shortcutHint = root.querySelector('#rcf-shortcut-hint');
    this.$btnQuery = root.querySelector('#rcf-btn-query');
    this.$btnRebuild = root.querySelector('#rcf-btn-rebuild');
    this.$btnSettings = root.querySelector('#rcf-btn-settings');
    this.$btnSaveShortcut = root.querySelector('#rcf-btn-save-shortcut');
    this.$btnResetShortcut = root.querySelector('#rcf-btn-reset-shortcut');
    this.$btnHelp = root.querySelector('#rcf-btn-help');
    this.$btnHelpClose = root.querySelector('#rcf-btn-help-close');
    this.$help = root.querySelector('#rcf-help');

    // -------------------------------------------------------------------------
    // 视图辅助
    // -------------------------------------------------------------------------

    this.setStatus = function (text) {
      self.$status.textContent = text;
    };

    this.toastStatus = function (text, duration) {
      if (self._toastBase === null) {
        self._toastBase = self.$status.textContent;
      }
      if (self._toastTimer) {
        clearTimeout(self._toastTimer);
      }
      self.setStatus(text);
      self._toastTimer = setTimeout(function () {
        self._toastTimer = null;
        var base = self._toastBase;
        self._toastBase = null;
        if (self.$status.textContent === text) {
          self.setStatus(base || '');
        }
      }, duration || 2500);
    };

    this.notice = function (text) {
      self._groupEntries = [];
      self.updateToggleAll();
      self.$results.innerHTML = '';
      var node = document.createElement('div');
      node.className = 'rcf-notice';
      node.textContent = text;
      self.$results.appendChild(node);
    };

    this.hint = function (text, kind) {
      self.$shortcutHint.textContent = text;
      self.$shortcutHint.className = 'rcf-hint' +
        (kind === 'error' ? ' rcf-hint-error' : (kind === 'ok' ? ' rcf-hint-ok' : ''));
    };

    this.renderSelection = function (uuids) {
      self._currentUuids = uuids || [];

      if (!uuids || uuids.length === 0) {
        self.$selection.textContent = '未选中资源';
        self.$selection.title = '';
        self.$selection.classList.remove('rcf-clickable');
        return;
      }
      var names = uuids.map(function (uuid) {
        return urlOf(uuid) || uuid;
      });
      self.$selection.textContent = names.join('  |  ');
      self.$selection.title = names.join('\n') + '\n\n点击在资源管理器中定位';
      self.$selection.classList.add('rcf-clickable');
    };

    this.locateSelection = function () {
      var uuids = self._currentUuids || [];
      if (uuids.length === 0) {
        return;
      }
      if (uuids.length === 1) {
        self.locateAsset(uuids[0]);
        return;
      }
      try {
        Editor.Selection.select('asset', uuids[0], true, false);
        for (var i = 1; i < uuids.length; i++) {
          Editor.Selection.select('asset', uuids[i], false, false);
        }
        Editor.Selection.confirm();
        Editor.Ipc.sendToAll('assets:hint', uuids[0]);
      } catch (e) {
        // ignore
      }
    };

    this.locateAsset = function (uuid) {
      try {
        Editor.Selection.select('asset', uuid, true, true);
      } catch (e) {
        // ignore
      }
      try {
        Editor.Ipc.sendToAll('assets:hint', uuid);
      } catch (e) {
        // ignore
      }
    };

    this.revealUrl = function (url) {
      try {
        Editor.assetdb.explore(url);
        return;
      } catch (e) {
        // ignore
      }
      try {
        Editor.remote.assetdb.explore(url);
      } catch (e) {
        // ignore
      }
    };

    // 复制引用行的资源路径，并在按钮上做短暂反馈
    this.copyAssetPath = function (ref, button) {
      var url = (ref && (ref.url || urlOf(ref.uuid))) || '';
      var text = clipboard.stripDbPrefix(url);
      if (!text) {
        self.toastStatus('复制失败：未获取到资源路径', 3500);
        return;
      }

      var original = button.textContent;
      if (original === '已复制') {
        original = '复制路径';
      }
      clipboard.writeText(text, function (ok) {
        if (!ok) {
          self.toastStatus('复制失败：系统剪贴板不可用', 3500);
          return;
        }
        if (button._copyTimer) {
          clearTimeout(button._copyTimer);
        }
        button.textContent = '已复制';
        button.classList.add('rcf-active');
        self.toastStatus('已复制：' + text, 2000);
        button._copyTimer = setTimeout(function () {
          button._copyTimer = null;
          button.textContent = original;
          button.classList.remove('rcf-active');
        }, 1200);
      });
    };

    // -------------------------------------------------------------------------
    // 查询与渲染
    // -------------------------------------------------------------------------

    this.curSelection = function () {
      try {
        var ids = Editor.Selection.curSelection('asset');
        if (Array.isArray(ids)) {
          return normalizeSelectionIds(ids.slice());
        }
      } catch (e) {
        // ignore
      }
      return [];
    };

    this.queryCurrent = function (overrideUuids) {
      var uuids = (Array.isArray(overrideUuids) && overrideUuids.length)
        ? normalizeSelectionIds(overrideUuids.slice())
        : self.curSelection();
      self.renderSelection(uuids);

      if (uuids.length === 0) {
        self.setStatus('未选中资源');
        self.notice('请先在资源管理器选中资源，再按快捷键或点击“查询”');
        return;
      }
      if (self._busy) {
        return;
      }

      self._busy = true;
      self.setStatus('查询中…');

      Editor.Ipc.sendToMain('res-cite-tool:query', uuids, function (err, res) {
        self._busy = false;

        if (err) {
          self.notice('查询失败：' + (err.message || err));
          self.setStatus('查询失败');
          return;
        }
        if (!res || res.ok !== true) {
          var code = res && res.error;
          if (code === 'EMPTY_SELECTION') {
            self.notice('请先在资源管理器选中资源');
          } else if (code === 'INDEX_UNAVAILABLE') {
            self.notice('索引不可用：项目 library 尚未就绪，请稍后点击“重建索引”');
          } else {
            self.notice('查询失败：' + (code || '未知错误'));
          }
          self.setStatus('查询失败');
          return;
        }

        self.renderResult(res);
      });
    };

    this.nodeNotice = function (box, text) {
      box.innerHTML = '';
      var node = document.createElement('div');
      node.className = 'rcf-node-notice';
      node.textContent = text;
      box.appendChild(node);
    };

    this.renderNodeList = function (box, nodes, ref) {
      box.innerHTML = '';
      if (!nodes || nodes.length === 0) {
        self.nodeNotice(box, '该文件中未找到节点级引用（可能为资源级引用）');
        return;
      }
      nodes.forEach(function (item) {
        var row = document.createElement('div');
        row.className = 'rcf-node-row';

        if (item.nodePath) {
          row.classList.add('rcf-node-row-clickable');
          row.title = '点击在层级管理器中定位该节点：' + item.nodePath;
          row.addEventListener('click', function () {
            self.locateNodeItem(ref, item, row);
          });
        } else {
          row.title = '资源级引用，无关联节点';
        }

        var pathEl = document.createElement('span');
        pathEl.className = 'rcf-node-path';
        pathEl.textContent = item.nodePath || '资源文件自身';
        pathEl.title = pathEl.textContent;

        var metaEl = document.createElement('span');
        metaEl.className = 'rcf-node-meta';
        metaEl.textContent = item.component + (item.property ? '.' + item.property : '');
        metaEl.title = metaEl.textContent;

        var countEl = document.createElement('span');
        countEl.className = 'rcf-node-count';
        countEl.textContent = item.count > 1 ? '×' + item.count : '';

        row.appendChild(pathEl);
        row.appendChild(metaEl);
        row.appendChild(countEl);
        box.appendChild(row);
      });
    };

    this.isPrefabEditMode = function (hierarchy, rootName) {
      if (!Array.isArray(hierarchy) || !rootName) {
        return false;
      }
      var sceneRoots = hierarchy.filter(function (node) {
        return node && String(node.name || '').indexOf('Editor Scene ') !== 0;
      });
      return sceneRoots.length === 1 &&
        sceneRoots[0].name === rootName &&
        Number(sceneRoots[0].prefabState) !== 0;
    };

    this.findNodeInHierarchy = function (roots, item) {
      if (!Array.isArray(roots) || roots.length === 0) {
        return null;
      }
      var parts = String(item.nodePath || '').split('/');
      var rootName = parts[0] || '';
      var candidates = roots.filter(function (node) {
        return node && node.name === rootName;
      });
      // prefab 编辑模式下优先匹配 prefab 内节点（prefabState 非 0）
      candidates.sort(function (a, b) {
        return (Number(b.prefabState) || 0) - (Number(a.prefabState) || 0);
      });

      var indexPath = item.nodeIndexPath || [];
      var expectedName = parts[parts.length - 1];
      for (var c = 0; c < candidates.length; c++) {
        var current = candidates[c];
        var ok = true;
        for (var i = 0; i < indexPath.length; i++) {
          if (!current.children || !current.children[indexPath[i]]) {
            ok = false;
            break;
          }
          current = current.children[indexPath[i]];
        }
        if (ok && current.name === expectedName) {
          return current;
        }
      }

      // 回退：按名称路径深度优先匹配
      var found = null;
      function dfs (nodes, ancestors) {
        for (var i = 0; i < nodes.length && !found; i++) {
          var node = nodes[i];
          if (!node) {
            continue;
          }
          var path = ancestors.concat(node.name);
          if (path.join('/') === item.nodePath) {
            found = node;
            return;
          }
          if (node.children && node.children.length) {
            dfs(node.children, path);
          }
        }
      }
      dfs(roots, []);
      return found;
    };

    this.locateNodeItem = function (ref, item, row) {
      if (!item || !item.nodePath) {
        return;
      }

      row.classList.add('rcf-node-hit');
      setTimeout(function () {
        row.classList.remove('rcf-node-hit');
      }, 1500);

      if (item.nodeId) {
        try {
          Editor.Selection.select('node', item.nodeId, true, true);
          self.toastStatus('已定位节点（若层级中未高亮，请先打开该场景）', 3000);
        } catch (e) {
          self.toastStatus('定位节点失败：' + e.message, 3500);
        }
        return;
      }

      if (ref.type === 'prefab') {
        self.openPrefabAndLocate(ref, item);
        return;
      }
      self.toastStatus('该引用文件不是 prefab，请先打开对应场景后再定位节点', 3500);
    };

    this.openPrefabAndLocate = function (ref, item) {
      if (self._locatingNode) {
        self.toastStatus('正在定位节点，请稍候…', 2000);
        return;
      }
      self._locatingNode = true;
      self._toastBase = null;
      self.toastStatus('正在打开 prefab：' + (ref.name || ref.url) + '…', 5000);

      try {
        Editor.Ipc.sendToAll('scene:enter-prefab-edit-mode', ref.uuid);
      } catch (e) {
        self._locatingNode = false;
        self.toastStatus('打开 prefab 失败：' + e.message, 4000);
        return;
      }

      var rootName = String(item.nodePath || '').split('/')[0];
      var attempts = 0;
      // 首次打开 prefab 可能较慢（尤其带贴图/嵌套预制体），最多等待约 30 秒
      var maxAttempts = 90;

      function finish (found) {
        self._locatingNode = false;
        if (found) {
          self.toastStatus('已定位节点：' + item.nodePath);
        } else {
          self.toastStatus('已打开 prefab，但未自动定位到节点（文件可能已修改）', 4500);
        }
      }

      function selectNode (found) {
        try {
          Editor.Selection.select('node', found.id, true, true);
        } catch (e) {
          // ignore
        }
      }

      function retryLater () {
        setTimeout(poll, 350);
      }

      function poll () {
        attempts++;
        if (attempts > maxAttempts) {
          finish(false);
          return;
        }
        if (attempts === 15) {
          self.toastStatus('prefab 加载较慢，仍在等待…', 4500);
        }
        Editor.Ipc.sendToPanel('scene', 'scene:query-hierarchy', function (err, sceneId, hierarchy) {
          if (err || !hierarchy) {
            retryLater();
            return;
          }
          // 必须确认已经切换到该 prefab 的编辑模式，避免在旧场景里误选同名节点
          if (!self.isPrefabEditMode(hierarchy, rootName)) {
            retryLater();
            return;
          }
          var found = self.findNodeInHierarchy(hierarchy, item);
          if (!found || !found.id) {
            retryLater();
            return;
          }
          selectNode(found);
          // 进入编辑模式后可能还有一次层级刷新会清空选中状态，稍后确认一次
          setTimeout(function () {
            Editor.Ipc.sendToPanel('scene', 'scene:query-hierarchy', function (err2, sceneId2, hierarchy2) {
              if (err2 || !hierarchy2 || !self.isPrefabEditMode(hierarchy2, rootName)) {
                retryLater();
                return;
              }
              var again = self.findNodeInHierarchy(hierarchy2, item);
              var selected = [];
              try {
                selected = Editor.Selection.curSelection('node') || [];
              } catch (e) {
                selected = [];
              }
              if (again && again.id === found.id && selected.indexOf(found.id) !== -1) {
                finish(true);
              } else {
                retryLater();
              }
            });
          }, 350);
        });
      }

      setTimeout(poll, 300);
    };

    this.toggleNodeRefs = function (box, button, ref, targetUuid) {
      if (!box.hidden) {
        box.hidden = true;
        button.classList.remove('rcf-active');
        button.textContent = '查看引用';
        button.title = '展开该文件中引用此资源的节点';
        return;
      }

      box.hidden = false;
      button.classList.add('rcf-active');
      button.textContent = '折叠引用';
      button.title = '折叠该文件中引用此资源的节点列表';

      var cacheKey = targetUuid + '|' + ref.uuid;
      if (self._nodeCache.has(cacheKey)) {
        self.renderNodeList(box, self._nodeCache.get(cacheKey), ref);
        return;
      }

      self.nodeNotice(box, '解析中…');
      Editor.Ipc.sendToMain('res-cite-tool:query-nodes', {
        referrerUuid: ref.uuid,
        targetUuid: targetUuid,
      }, function (err, res) {
        if (err || !res || res.ok !== true) {
          var code = (res && res.error) || (err && err.message) || '未知错误';
          if (code === 'FILE_NOT_FOUND') {
            self.nodeNotice(box, '找不到该资源的序列化文件（可能尚未导入完成）');
          } else if (code === 'PARSE_FAILED') {
            self.nodeNotice(box, '该资源文件格式不支持节点解析');
          } else {
            self.nodeNotice(box, '解析失败：' + code);
          }
          return;
        }
        var nodes = res.nodes || [];
        self._nodeCache.set(cacheKey, nodes);
        self.renderNodeList(box, nodes, ref);
      });
    };

    this.setGroupExpanded = function (entry, expanded) {
      entry.body.hidden = !expanded;
      if (expanded) {
        entry.button.classList.add('rcf-active');
      } else {
        entry.button.classList.remove('rcf-active');
      }
      entry.button.textContent = expanded ? '折叠引用' : '查看引用';
      entry.button.title = expanded ? '折叠该资源的引用列表' : '展开该资源的引用列表';
    };

    this.updateToggleAll = function () {
      var entries = self._groupEntries || [];
      if (entries.length === 0) {
        self.$toggleAll.hidden = true;
        return;
      }
      self.$toggleAll.hidden = false;
      var expanded = 0;
      entries.forEach(function (entry) {
        if (!entry.body.hidden) {
          expanded++;
        }
      });
      var allExpanded = expanded === entries.length;
      self.$toggleAll.textContent = allExpanded ? '折叠全部引用' : '展开全部引用';
      self.$toggleAll.title = allExpanded
        ? '折叠所有资源的引用资源列表'
        : '展开所有资源的引用资源列表（不展开具体节点列表）';
    };

    this.collapseNodeLists = function (entry) {
      var lists = entry.body.querySelectorAll('.rcf-node-list');
      for (var i = 0; i < lists.length; i++) {
        lists[i].hidden = true;
      }
      var buttons = entry.body.querySelectorAll('.rcf-node-toggle');
      for (var j = 0; j < buttons.length; j++) {
        buttons[j].classList.remove('rcf-active');
        buttons[j].textContent = '查看引用';
        buttons[j].title = '展开该文件中引用此资源的节点';
      }
    };

    this.toggleAllGroups = function () {
      var entries = self._groupEntries || [];
      if (entries.length === 0) {
        return;
      }
      var expanded = 0;
      entries.forEach(function (entry) {
        if (!entry.body.hidden) {
          expanded++;
        }
      });
      var expandAll = expanded < entries.length;
      entries.forEach(function (entry) {
        self.setGroupExpanded(entry, expandAll);
        if (expandAll) {
          // “展开全部引用”只展开引用资源列表，不展开具体节点列表
          self.collapseNodeLists(entry);
        }
      });
      self.updateToggleAll();
    };

    this.renderResult = function (res) {
      var groups = res.groups || [];
      var total = 0;
      groups.forEach(function (group) {
        total += group.total || 0;
      });

      self._nodeCache.clear();
      self._groupEntries = [];
      self.updateToggleAll();
      self.setStatus(formatIndex(res.index) + ' · 查询 ' + res.tookMs + ' ms');
      self.$results.innerHTML = '';

      if (groups.length === 0) {
        self.notice('未选中资源');
        return;
      }
      if (total === 0) {
        self.notice('未找到引用（仅统计序列化资源引用）');
        return;
      }

      groups.forEach(function (group) {
        var wrap = document.createElement('div');
        wrap.className = 'rcf-group';

        var head = document.createElement('div');
        head.className = 'rcf-group-head rcf-group-head-clickable';
        head.title = '点击在资源管理器中定位：' + (group.target.url || group.target.name || group.target.uuid);
        head.addEventListener('click', function () {
          self.locateAsset(group.target.uuid);
        });

        var tag = document.createElement('span');
        tag.className = 'rcf-tag';
        tag.textContent = group.target.type || 'asset';

        var title = document.createElement('span');
        title.className = 'rcf-group-title';
        title.textContent = group.target.url || group.target.name || group.target.uuid;
        title.title = title.textContent;

        var totalEl = document.createElement('span');
        totalEl.className = 'rcf-group-total';
        totalEl.textContent = (group.total || 0) + ' 个引用';

        // 多选资源时默认折叠各资源的引用列表
        var collapsedByDefault = groups.length > 1;
        var groupBody = document.createElement('div');
        groupBody.className = 'rcf-group-body';
        groupBody.hidden = collapsedByDefault && (group.total || 0) > 0;

        var toggleBtn = null;
        var entry = null;
        if ((group.total || 0) > 0) {
          toggleBtn = document.createElement('button');
          toggleBtn.type = 'button';
          toggleBtn.className = 'rcf-btn-sm rcf-group-toggle';
          toggleBtn.addEventListener('click', function (event) {
            event.stopPropagation();
            self.setGroupExpanded(entry, entry.body.hidden);
            self.updateToggleAll();
          });
          entry = { body: groupBody, button: toggleBtn };
          self._groupEntries.push(entry);
          self.setGroupExpanded(entry, !groupBody.hidden);
        }

        var copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'rcf-btn-sm';
        copyBtn.textContent = '复制路径';
        copyBtn.title = '复制该资源路径到剪贴板（自动去掉 db:// 前缀）';
        copyBtn.addEventListener('click', function (event) {
          event.stopPropagation();
          self.copyAssetPath(group.target, copyBtn);
        });

        head.appendChild(tag);
        head.appendChild(title);
        head.appendChild(totalEl);
        if (toggleBtn) {
          head.appendChild(toggleBtn);
        }
        head.appendChild(copyBtn);
        wrap.appendChild(head);
        wrap.appendChild(groupBody);

        (group.referrers || []).forEach(function (ref) {
          var row = document.createElement('div');
          row.className = 'rcf-row';
          row.title = '点击在资源管理器中定位：' + ref.url;

          var rowTag = document.createElement('span');
          rowTag.className = 'rcf-tag';
          rowTag.textContent = ref.type || 'asset';

          var path = document.createElement('span');
          path.className = 'rcf-row-path';
          path.textContent = ref.url;

          var count = document.createElement('span');
          count.className = 'rcf-row-count';
          count.textContent = ref.count > 1 ? '×' + ref.count : '';

          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'rcf-btn-sm';
          button.textContent = '显示';
          button.title = '在系统文件夹中显示';
          button.addEventListener('click', function (event) {
            event.stopPropagation();
            self.revealUrl(ref.url);
          });

          var nodeButton = document.createElement('button');
          nodeButton.type = 'button';
          nodeButton.className = 'rcf-btn-sm rcf-node-toggle';
          nodeButton.textContent = '查看引用';
          nodeButton.title = '展开该文件中引用此资源的节点';
          nodeButton.addEventListener('click', function (event) {
            event.stopPropagation();
            self.toggleNodeRefs(nodeBox, nodeButton, ref, group.target.uuid);
          });

          var copyButton = document.createElement('button');
          copyButton.type = 'button';
          copyButton.className = 'rcf-btn-sm';
          copyButton.textContent = '复制路径';
          copyButton.title = '复制该资源路径到剪贴板（自动去掉 db:// 前缀）';
          copyButton.addEventListener('click', function (event) {
            event.stopPropagation();
            self.copyAssetPath(ref, copyButton);
          });

          var nodeBox = document.createElement('div');
          nodeBox.className = 'rcf-node-list';
          nodeBox.hidden = true;

          row.addEventListener('click', function () {
            self.locateAsset(ref.uuid);
          });

          row.appendChild(rowTag);
          row.appendChild(path);
          row.appendChild(count);
          row.appendChild(nodeButton);
          row.appendChild(button);
          row.appendChild(copyButton);
          groupBody.appendChild(row);
          groupBody.appendChild(nodeBox);
        });

        self.$results.appendChild(wrap);
      });

      self.updateToggleAll();
    };

    this.renderProgress = function (data) {
      if (!data) {
        return;
      }
      if (data.phase === 'done') {
        self.pollStatus();
        return;
      }
      if (data.phase === 'build' && data.total) {
        var percent = Math.floor((data.done || 0) * 100 / data.total);
        self.setStatus('索引构建中… ' + percent + '%（' + (data.done || 0) + '/' + data.total + '）');
        return;
      }
      self.setStatus('索引构建中…');
    };

    // -------------------------------------------------------------------------
    // 状态轮询
    // -------------------------------------------------------------------------

    this.pollStatus = function () {
      if (self._statusTimer) {
        clearTimeout(self._statusTimer);
        self._statusTimer = null;
      }

      Editor.Ipc.sendToMain('res-cite-tool:get-status', function (err, stats) {
        if (err || !stats) {
          return;
        }
        var state = stats.state;
        if (state === 'ready') {
          self.setStatus(formatIndex(stats));
          return;
        }
        if (state === 'error' || state === 'unavailable') {
          self.setStatus(formatIndex(stats));
          return;
        }
        self.setStatus(formatIndex(stats));
        self._statusTimer = setTimeout(function () {
          self._statusTimer = null;
          self.pollStatus();
        }, 1500);
      });
    };

    // -------------------------------------------------------------------------
    // 快捷键设置
    // -------------------------------------------------------------------------

    this.captureShortcut = function (event) {
      event.preventDefault();
      event.stopPropagation();

      var code = event.code || '';
      if (MODIFIER_CODES[code]) {
        self._pendingCombo = null;
        var modifiers = [];
        if (event.ctrlKey) { modifiers.push('Ctrl'); }
        if (event.altKey) { modifiers.push('Alt'); }
        if (event.shiftKey) { modifiers.push('Shift'); }
        if (event.metaKey) { modifiers.push('Meta'); }
        self.$shortcutInput.value = modifiers.length ? modifiers.join('+') + '+…' : '…';
        return;
      }

      var combo = {
        code: code,
        key: event.key,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
      };
      self._pendingCombo = combo;
      self.$shortcutInput.value = previewCombo(event);
      self.hint('点击“保存”应用组合键', '');
    };

    this.saveShortcut = function () {
      var combo = self._pendingCombo;
      if (!combo) {
        self.hint('请先点击输入框，然后按下要绑定的组合键', 'error');
        return;
      }

      Editor.Ipc.sendToMain('res-cite-tool:set-shortcut', combo, function (err, res) {
        if (err || !res || res.ok !== true) {
          var code = res && res.error;
          if (code === 'INVALID_SHORTCUT') {
            self.hint('无效组合：需包含 Ctrl/Alt/Meta，或使用 F1–F24；不能是纯字母/数字', 'error');
          } else if (code === 'SAVE_FAILED') {
            self.hint('保存失败：无法写入项目 local 目录', 'error');
          } else {
            self.hint('保存失败：' + (code || err || '未知错误'), 'error');
          }
          return;
        }
        self._pendingCombo = null;
        self.$shortcutInput.value = res.shortcut.label;
        self.hint('已生效：' + res.shortcut.label, 'ok');
      });
    };

    this.resetShortcut = function () {
      var combo = { code: 'F12', key: 'F12', ctrl: false, alt: false, shift: true, meta: false };
      self._pendingCombo = combo;
      self.$shortcutInput.value = 'Shift+F12';
      self.saveShortcut();
    };

    this.loadSettings = function () {
      Editor.Ipc.sendToMain('res-cite-tool:get-settings', function (err, res) {
        if (err || !res || !res.shortcut) {
          return;
        }
        self.$shortcutInput.value = res.shortcut.label || '';
      });
    };

    this.rebuildIndex = function () {
      self.setStatus('重建索引中…');
      self.$btnRebuild.disabled = true;
      Editor.Ipc.sendToMain('res-cite-tool:rebuild-index', function (err, res) {
        self.$btnRebuild.disabled = false;
        if (err || !res || res.ok !== true) {
          self.setStatus('重建失败：' + ((res && res.error) || err || '未知错误'));
          return;
        }
        self.setStatus(formatIndex(res.stats));
        self.queryCurrent();
      });
    };

    this.toggleSettings = function () {
      self.$settings.hidden = !self.$settings.hidden;
    };

    // -------------------------------------------------------------------------
    // 事件绑定与初始化
    // -------------------------------------------------------------------------

    this.$btnQuery.addEventListener('click', function () {
      self.queryCurrent();
    });
    this.$selection.addEventListener('click', function () {
      self.locateSelection();
    });
    this.$btnRebuild.addEventListener('click', function () {
      self.rebuildIndex();
    });
    this.$btnSettings.addEventListener('click', function () {
      self.toggleSettings();
    });
    this.$btnSaveShortcut.addEventListener('click', function () {
      self.saveShortcut();
    });
    this.$btnResetShortcut.addEventListener('click', function () {
      self.resetShortcut();
    });
    this.$btnHelp.addEventListener('click', function () {
      self.$help.hidden = false;
      var body = self.$help.querySelector('.rcf-help-body');
      if (body) {
        body.scrollTop = 0;
      }
    });
    this.$btnHelpClose.addEventListener('click', function () {
      self.$help.hidden = true;
    });
    this.$shortcutInput.addEventListener('keydown', function (event) {
      self.captureShortcut(event);
    });

    Editor.Ipc.sendToMain('res-cite-tool:panel-ready');
    self.loadSettings();
    self.pollStatus();
    self.queryCurrent();
  },

  messages: {
    'res-cite-tool:trigger': function (event, data) {
      if (typeof this.queryCurrent === 'function') {
        this.queryCurrent(data && data.uuids);
      }
    },
    'res-cite-tool:progress': function (event, data) {
      if (typeof this.renderProgress === 'function') {
        this.renderProgress(data);
      }
    },
  },
});
