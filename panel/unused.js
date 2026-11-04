'use strict';

var fs = require('fs');
var clipboard = require('../lib/clipboard');

var PANEL_TEMPLATE = fs.readFileSync(Editor.url('packages://res-cite-tool/panel/unused.html'), 'utf8');
var PANEL_STYLE = fs.readFileSync(Editor.url('packages://res-cite-tool/panel/unused.css'), 'utf8');

function pad2 (value) {
  return value < 10 ? '0' + value : String(value);
}

function timeNow () {
  var date = new Date();
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

/**
 * 解析输入框中的目录配置，兼容 "/resources"、"assets/resources"、
 * "db://assets/resources" 与反斜杠写法。
 * @param {string} text
 * @returns {string[]}
 */
function parseDirs (text) {
  return String(text || '')
    .split(/[,，;；\n]+/)
    .map(function (item) {
      var dir = item.trim();
      if (!dir) {
        return '';
      }
      dir = dir.replace(/\\/g, '/').replace(/^\.\/+/, '');
      if (dir.indexOf('db://assets/') === 0) {
        dir = dir.slice(12);
      } else if (dir.indexOf('db://assets') === 0) {
        dir = dir.slice(10);
      } else if (dir.indexOf('assets/') === 0) {
        dir = dir.slice(7);
      } else if (dir === 'assets') {
        dir = '';
      }
      return dir.replace(/^\/+/, '').replace(/\/+$/, '');
    })
    .filter(function (dir) {
      return !!dir;
    });
}

Editor.Panel.extend({
  style: PANEL_STYLE,
  template: PANEL_TEMPLATE,

  ready: function () {
    var self = this;
    var root = this.shadowRoot || this.$el || this;

    this.$ignoreMode = root.querySelector('#ruc-mode-ignore');
    this.$specifyMode = root.querySelector('#ruc-mode-specify');
    this.$resourcesMode = root.querySelector('#ruc-mode-resources');
    this.$ignorePanel = root.querySelector('#ruc-panel-ignore');
    this.$specifyPanel = root.querySelector('#ruc-panel-specify');
    this.$resourcesPanel = root.querySelector('#ruc-panel-resources');
    this.$ignoreInput = root.querySelector('#ruc-ignore-input');
    this.$specifyPath = root.querySelector('#ruc-specify-path');
    this.$btnPickDir = root.querySelector('#ruc-btn-pick-dir');
    this.$types = root.querySelector('#ruc-types');
    this.$btnSearch = root.querySelector('#ruc-btn-search');
    this.$btnSelectAll = root.querySelector('#ruc-btn-select-all');
    this.$btnClean = root.querySelector('#ruc-btn-clean');
    this.$summary = root.querySelector('#ruc-summary');
    this.$results = root.querySelector('#ruc-results');
    this.$listTitle = root.querySelector('#ruc-list-title');
    this.$listCount = root.querySelector('#ruc-list-count');
    this.$btnToggleAll = root.querySelector('#ruc-btn-toggle-all');
    this.$log = root.querySelector('#ruc-log');
    this.$btnHelp = root.querySelector('#ruc-btn-help');
    this.$btnHelpClose = root.querySelector('#ruc-btn-help-close');
    this.$help = root.querySelector('#ruc-help');
    this.$helpBody = root.querySelector('.ruc-help-body');
    this.$typeAll = null;

    this._items = [];
    this._groups = [];
    this._groupEntries = [];
    this._busy = false;
    this._specifyDir = '';
    this._configLoaded = false;
    this._typesReady = false;
    this._configApplied = false;
    this._savedConfig = null;

    var modeChanged = function () {
      self.updateMode();
      self.resetResults();
      self.saveConfigSoon();
    };
    this.$ignoreMode.addEventListener('change', modeChanged);
    this.$specifyMode.addEventListener('change', modeChanged);
    this.$resourcesMode.addEventListener('change', modeChanged);
    this.$ignoreInput.addEventListener('input', function () {
      self.saveConfigSoon();
    });

    this.$btnSearch.addEventListener('click', function () {
      self.search();
    });
    this.$btnSelectAll.addEventListener('click', function () {
      self.toggleSelectAll();
    });
    this.$btnClean.addEventListener('click', function () {
      self.clean();
    });
    this.$btnPickDir.addEventListener('click', function () {
      self.pickDirectory();
    });
    this.$btnToggleAll.addEventListener('click', function () {
      self.toggleAllGroups();
    });
    this.$btnHelp.addEventListener('click', function () {
      self.$help.hidden = false;
      if (self.$helpBody) {
        self.$helpBody.scrollTop = 0;
      }
    });
    this.$btnHelpClose.addEventListener('click', function () {
      self.$help.hidden = true;
    });

    // -------------------------------------------------------------------------
    // 日志
    // -------------------------------------------------------------------------

    this.logLine = function (text, kind) {
      var line = document.createElement('div');
      line.className = 'ruc-log-line' + (kind ? ' ruc-log-' + kind : '');
      line.textContent = '[' + timeNow() + '] ' + text;
      self.$log.appendChild(line);
      while (self.$log.children.length > 300) {
        self.$log.removeChild(self.$log.firstChild);
      }
      self.$log.scrollTop = self.$log.scrollHeight;
    };

    // -------------------------------------------------------------------------
    // 配置区
    // -------------------------------------------------------------------------

    this.updateMode = function () {
      var ignoreMode = self.$ignoreMode.checked;
      var specifyMode = self.$specifyMode.checked;
      var resourcesMode = self.$resourcesMode.checked;
      self.$ignorePanel.hidden = !ignoreMode;
      self.$specifyPanel.hidden = !specifyMode;
      self.$resourcesPanel.hidden = !resourcesMode;
      self.$btnSelectAll.hidden = resourcesMode;
      self.$btnClean.hidden = resourcesMode;
      self.$listTitle.textContent = resourcesMode ? '引用资源列表' : '未引用资源列表';
    };

    this.resetResults = function () {
      self._items = [];
      self._groups = [];
      self._groupEntries = [];
      self.$btnToggleAll.hidden = true;
      self.$results.innerHTML = '';
      var empty = document.createElement('div');
      empty.className = 'ruc-empty';
      empty.textContent = self.$resourcesMode.checked
        ? '点击“开始查找”检索 resources 下被引用的资源'
        : '点击“开始查找”检索未引用资源';
      self.$results.appendChild(empty);
      self.$listCount.textContent = '0 项';
      self.$summary.textContent = '未查找';
    };

    this.setBusy = function (busy) {
      self._busy = busy;
      self.$btnSearch.disabled = busy;
      self.$btnSelectAll.disabled = busy;
      self.$btnClean.disabled = busy;
      self.$btnPickDir.disabled = busy;
    };

    this.updateSpecifyDisplay = function () {
      var text = self._specifyDir ? 'assets/' + self._specifyDir : 'assets（根目录）';
      self.$specifyPath.value = text;
      self.$specifyPath.title = text;
    };

    this.pickDirectory = function () {
      if (self._busy) {
        return;
      }
      self.setBusy(true);
      self.logLine('正在打开文件资源选择器…');

      Editor.Ipc.sendToMain('res-cite-tool:pick-directory', function (err, res) {
        self.setBusy(false);

        if (err) {
          self.logLine('选择目录失败：' + (err.message || err), 'error');
          return;
        }
        if (!res || res.ok !== true) {
          var code = (res && res.error) || '未知错误';
          if (code === 'OUTSIDE_ASSETS') {
            self.logLine('只能选择 assets 目录内的子目录', 'error');
          } else {
            self.logLine('选择目录失败：' + code, 'error');
          }
          return;
        }
        if (res.canceled) {
          self.logLine('已取消选择目录');
          return;
        }

        self._specifyDir = res.dir || '';
        self.updateSpecifyDisplay();
        self.saveConfigSoon();
        self.logLine('指定清理目录：' + (self._specifyDir ? 'assets/' + self._specifyDir : 'assets（根目录）'));
      });
    };

    this.loadMeta = function () {
      Editor.Ipc.sendToMain('res-cite-tool:list-meta', function (err, res) {
        if (err || !res || res.ok !== true) {
          var code = (res && res.error) || (err && err.message) || '未知错误';
          self.logLine('加载文件类型失败：' + code, 'error');
          self._typesReady = true;
          self.applySavedConfig();
          return;
        }
        self.fillTypes(res.types || []);
        self.logLine('已加载 ' + ((res.types || []).length) + ' 种文件类型');
        self._typesReady = true;
        self.applySavedConfig();
      });
    };

    this.fillTypes = function (types) {
      self.$types.innerHTML = '';
      self.$typeAll = null;

      var allLabel = document.createElement('label');
      allLabel.className = 'ruc-check ruc-check-all';

      var allBox = document.createElement('input');
      allBox.type = 'checkbox';
      allBox.id = 'ruc-type-all';
      allBox.checked = true;
      allBox.addEventListener('change', function () {
        var boxes = self.$types.querySelectorAll('input[data-ext]');
        for (var i = 0; i < boxes.length; i++) {
          boxes[i].checked = allBox.checked;
        }
        self.saveConfigSoon();
      });

      allLabel.appendChild(allBox);
      allLabel.appendChild(document.createTextNode(' 全部'));
      self.$types.appendChild(allLabel);
      self.$typeAll = allBox;

      types.forEach(function (ext) {
        var label = document.createElement('label');
        label.className = 'ruc-check';

        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = true;
        box.setAttribute('data-ext', ext);
        box.addEventListener('change', function () {
          self.syncTypeAll();
          self.saveConfigSoon();
        });

        label.appendChild(box);
        label.appendChild(document.createTextNode(' ' + ext));
        self.$types.appendChild(label);
      });
    };

    this.syncTypeAll = function () {
      var boxes = self.$types.querySelectorAll('input[data-ext]');
      if (!boxes.length) {
        if (self.$typeAll) {
          self.$typeAll.checked = true;
        }
        return;
      }
      var all = true;
      for (var i = 0; i < boxes.length; i++) {
        if (!boxes[i].checked) {
          all = false;
          break;
        }
      }
      if (self.$typeAll) {
        self.$typeAll.checked = all;
      }
    };

    // -------------------------------------------------------------------------
    // 配置持久化
    // -------------------------------------------------------------------------

    this.loadSavedConfig = function () {
      Editor.Ipc.sendToMain('res-cite-tool:get-unused-settings', function (err, res) {
        if (!err && res && res.ok && res.settings) {
          self._savedConfig = res.settings;
        }
        self._configLoaded = true;
        self.applySavedConfig();
      });
    };

    this.applySavedConfig = function () {
      if (self._configApplied || !self._configLoaded || !self._typesReady) {
        return;
      }
      self._configApplied = true;

      var cfg = self._savedConfig;
      if (!cfg) {
        return;
      }

      if (cfg.mode === 'ignore' || cfg.mode === 'specify' || cfg.mode === 'resources') {
        self.$ignoreMode.checked = cfg.mode === 'ignore';
        self.$specifyMode.checked = cfg.mode === 'specify';
        self.$resourcesMode.checked = cfg.mode === 'resources';
        self.updateMode();
        self.resetResults();
      }
      if (typeof cfg.ignoreDirs === 'string') {
        self.$ignoreInput.value = cfg.ignoreDirs;
      }
      if (typeof cfg.specifyDir === 'string') {
        self._specifyDir = cfg.specifyDir;
        self.updateSpecifyDisplay();
      }
      if (cfg.types && typeof cfg.types === 'object') {
        var boxes = self.$types.querySelectorAll('input[data-ext]');
        for (var i = 0; i < boxes.length; i++) {
          var ext = boxes[i].getAttribute('data-ext');
          if (Object.prototype.hasOwnProperty.call(cfg.types, ext)) {
            boxes[i].checked = cfg.types[ext] !== false;
          }
        }
        self.syncTypeAll();
      }

      self.logLine('已恢复上次配置');
    };

    this.collectTypeState = function () {
      var state = {};
      var boxes = self.$types.querySelectorAll('input[data-ext]');
      for (var i = 0; i < boxes.length; i++) {
        state[boxes[i].getAttribute('data-ext')] = boxes[i].checked;
      }
      return state;
    };

    this.saveConfigSoon = function () {
      if (!self._configApplied) {
        return;
      }
      self.saveConfigNow();
    };

    this.saveConfigNow = function () {
      if (!self._configApplied) {
        return;
      }
      var mode = self.$ignoreMode.checked
        ? 'ignore'
        : (self.$specifyMode.checked ? 'specify' : 'resources');
      Editor.Ipc.sendToMain('res-cite-tool:set-unused-settings', {
        mode: mode,
        ignoreDirs: self.$ignoreInput.value,
        specifyDir: self._specifyDir,
        types: self.collectTypeState(),
      });
    };

    this.collectOptions = function () {
      var mode = self.$ignoreMode.checked
        ? 'ignore'
        : (self.$specifyMode.checked ? 'specify' : 'resources');
      var boxes = self.$types.querySelectorAll('input[data-ext]');
      var types = [];
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].checked) {
          types.push(boxes[i].getAttribute('data-ext'));
        }
      }

      if (types.length === 0) {
        self.logLine('请至少勾选一种文件类型', 'error');
        return null;
      }

      var options = {
        mode: mode,
        types: types,
      };
      if (mode === 'ignore') {
        options.ignoreDirs = parseDirs(self.$ignoreInput.value);
      } else if (mode === 'specify') {
        options.specifyDir = self._specifyDir;
      }
      return options;
    };

    // -------------------------------------------------------------------------
    // 查找
    // -------------------------------------------------------------------------

    this.search = function () {
      if (self._busy) {
        return;
      }
      var options = self.collectOptions();
      if (!options) {
        return;
      }

      var scopeText;
      if (options.mode === 'ignore') {
        scopeText = options.ignoreDirs.length ? '忽略目录：' + options.ignoreDirs.join(', ') : '忽略目录：无';
      } else if (options.mode === 'specify') {
        scopeText = '指定目录：assets/' + options.specifyDir;
      } else {
        scopeText = '检索范围：assets/resources（被引用资源）';
      }
      self.logLine('开始查找（' + scopeText + '；类型：' + options.types.join(', ') + '）');

      if (options.mode === 'resources') {
        self.searchResourceRefs(options);
        return;
      }

      self.setBusy(true);
      self.$summary.textContent = '查找中…';

      Editor.Ipc.sendToMain('res-cite-tool:find-unused', options, function (err, res) {
        self.setBusy(false);

        if (err) {
          self.$summary.textContent = '查找失败';
          self.logLine('查找失败：' + (err.message || err), 'error');
          return;
        }
        if (!res || res.ok !== true) {
          var code = (res && res.error) || '未知错误';
          self.$summary.textContent = '查找失败';
          self.logLine('查找失败：' + code, 'error');
          return;
        }

        var items = res.items || [];
        var groups = res.groups || [];
        self.renderItems(items, groups);

        var groupFileCount = 0;
        groups.forEach(function (group) {
          groupFileCount += group.total || 0;
        });
        self.$summary.textContent = '共 ' + items.length + ' 项'
          + (groups.length ? ' · 骨骼组 ' + groups.length + ' 组' : '')
          + ' · ' + res.tookMs + ' ms';

        var indexPart = res.index && res.index.assets
          ? '，索引 ' + res.index.assets + ' 项资源'
          : '';
        var skipPart = res.skipped
          ? '，已跳过：内置 ' + res.skipped.internal + '，范围 ' + res.skipped.scope + '，类型 ' + res.skipped.type + '，有引用 ' + res.skipped.referenced
          : '';
        var groupPart = groups.length
          ? '，骨骼动画组 ' + groups.length + ' 组（' + groupFileCount + ' 个关联文件）'
          : '';
        self.logLine('查找完成：' + items.length + ' 项未引用资源' + groupPart + '，用时 ' + res.tookMs + ' ms' + indexPart + skipPart, 'ok');

        if (options.mode === 'ignore' && items.some(function (item) {
          return String(item.relativePath || '').toLowerCase().indexOf('resources/') === 0;
        })) {
          self.logLine('提示：resources 目录通常由代码动态加载，建议将 resources 加入忽略目录', 'error');
        }
      });
    };

    this.searchResourceRefs = function (options) {
      self.setBusy(true);
      self.$summary.textContent = '查找中…';

      Editor.Ipc.sendToMain('res-cite-tool:find-resource-refs', { types: options.types }, function (err, res) {
        self.setBusy(false);

        if (err) {
          self.$summary.textContent = '查找失败';
          self.logLine('查找失败：' + (err.message || err), 'error');
          return;
        }
        if (!res || res.ok !== true) {
          var code = (res && res.error) || '未知错误';
          self.$summary.textContent = '查找失败';
          self.logLine('查找失败：' + code, 'error');
          return;
        }

        var groups = res.groups || [];
        self.renderGroups(groups);

        var totalRefs = 0;
        groups.forEach(function (group) {
          totalRefs += group.total || 0;
        });
        self.$summary.textContent = '共 ' + groups.length + ' 个资源 · ' + totalRefs + ' 条引用 · ' + res.tookMs + ' ms';

        var skipPart = res.skipped
          ? '，已跳过：内置 ' + res.skipped.internal + '，范围外 ' + res.skipped.scope + '，类型 ' + res.skipped.type + '，无引用 ' + res.skipped.unreferenced
          : '';
        self.logLine('查找完成：' + groups.length + ' 个被引用资源，共 ' + totalRefs + ' 条引用，用时 ' + res.tookMs + ' ms' + skipPart, 'ok');
      });
    };

    this.setGroupExpanded = function (entry, expanded) {
      entry.body.hidden = !expanded;
      if (expanded) {
        entry.button.classList.add('ruc-active');
      } else {
        entry.button.classList.remove('ruc-active');
      }
      entry.button.textContent = expanded ? '折叠引用' : '查看引用';
      entry.button.title = expanded ? '折叠该资源的引用列表' : '展开该资源的引用列表';
    };

    this.updateGroupToggleAll = function () {
      var entries = self._groupEntries;
      if (entries.length === 0) {
        self.$btnToggleAll.hidden = true;
        return;
      }
      self.$btnToggleAll.hidden = false;
      var expanded = 0;
      entries.forEach(function (entry) {
        if (!entry.body.hidden) {
          expanded++;
        }
      });
      var allExpanded = expanded === entries.length;
      self.$btnToggleAll.textContent = allExpanded ? '折叠全部引用' : '展开全部引用';
      self.$btnToggleAll.title = allExpanded
        ? '折叠所有资源的引用资源列表'
        : '展开所有资源的引用资源列表';
    };

    this.toggleAllGroups = function () {
      var entries = self._groupEntries;
      if (entries.length === 0) {
        return;
      }
      var allExpanded = true;
      entries.forEach(function (entry) {
        if (entry.body.hidden) {
          allExpanded = false;
        }
      });
      var expand = !allExpanded;
      entries.forEach(function (entry) {
        self.setGroupExpanded(entry, expand);
      });
      self.updateGroupToggleAll();
    };

    this.renderGroups = function (groups) {
      self._items = [];
      self._groups = [];
      self._groupEntries = [];
      self.$btnToggleAll.hidden = true;
      self.$results.innerHTML = '';

      if (!groups.length) {
        var empty = document.createElement('div');
        empty.className = 'ruc-empty';
        empty.textContent = '未找到 resources 下被引用的指定类型资源';
        self.$results.appendChild(empty);
        self.$listCount.textContent = '0 个资源';
        self.updateGroupToggleAll();
        return;
      }

      groups.forEach(function (group) {
        var target = group.target || {};
        var wrap = document.createElement('div');
        wrap.className = 'ruc-group';

        var head = document.createElement('div');
        head.className = 'ruc-group-head';
        head.title = '点击在资源管理器中定位：' + (target.url || target.uuid || '');
        head.addEventListener('click', function () {
          self.locateAsset(target.uuid);
        });

        var tag = document.createElement('span');
        tag.className = 'ruc-tag';
        tag.textContent = target.type || 'asset';

        var title = document.createElement('span');
        title.className = 'ruc-group-title';
        title.textContent = target.url || target.uuid || '';
        title.title = title.textContent;

        var totalEl = document.createElement('span');
        totalEl.className = 'ruc-group-total';
        totalEl.textContent = (group.total || 0) + ' 个引用';

        var body = document.createElement('div');
        body.className = 'ruc-group-body';
        body.hidden = true;

        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'ruc-btn-sm ruc-group-toggle';
        toggle.textContent = '查看引用';
        toggle.title = '展开该资源的引用列表';
        var entry = { body: body, button: toggle };
        self._groupEntries.push(entry);
        toggle.addEventListener('click', function (event) {
          event.stopPropagation();
          self.setGroupExpanded(entry, entry.body.hidden);
          self.updateGroupToggleAll();
        });

        head.appendChild(tag);
        head.appendChild(title);
        head.appendChild(totalEl);
        head.appendChild(toggle);
        head.appendChild(self.createCopyButton(target.url));
        wrap.appendChild(head);
        wrap.appendChild(body);

        (group.referrers || []).forEach(function (ref) {
          var row = document.createElement('div');
          row.className = 'ruc-row ruc-ref-row';
          row.title = '点击在资源管理器中定位：' + ref.url;
          row.addEventListener('click', function () {
            self.locateAsset(ref.uuid);
          });

          var refTag = document.createElement('span');
          refTag.className = 'ruc-tag';
          refTag.textContent = ref.type || 'asset';

          var pathEl = document.createElement('span');
          pathEl.className = 'ruc-path';
          pathEl.textContent = ref.url;
          pathEl.title = ref.url;

          var countEl = document.createElement('span');
          countEl.className = 'ruc-ref-count';
          countEl.textContent = ref.count > 1 ? '×' + ref.count : '';

          var showBtn = document.createElement('button');
          showBtn.type = 'button';
          showBtn.className = 'ruc-btn-sm';
          showBtn.textContent = '显示';
          showBtn.title = '在系统文件夹中显示';
          showBtn.addEventListener('click', function (event) {
            event.stopPropagation();
            self.revealUrl(ref.url);
          });

          row.appendChild(refTag);
          row.appendChild(pathEl);
          row.appendChild(countEl);
          row.appendChild(showBtn);
          row.appendChild(self.createCopyButton(ref.url));
          body.appendChild(row);
        });

        self.$results.appendChild(wrap);
      });

      self.$listCount.textContent = groups.length + ' 个资源';
      self.updateGroupToggleAll();
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

    // 复制资源路径，成功后按钮短暂显示“已复制”并写入日志
    this.copyPath = function (url, button) {
      var text = clipboard.stripDbPrefix(url);
      if (!text) {
        self.logLine('复制失败：未获取到资源路径', 'error');
        return;
      }

      var original = button.textContent;
      if (original === '已复制') {
        original = '复制路径';
      }
      clipboard.writeText(text, function (ok) {
        if (!ok) {
          self.logLine('复制失败：系统剪贴板不可用', 'error');
          return;
        }
        if (button._copyTimer) {
          clearTimeout(button._copyTimer);
        }
        button.textContent = '已复制';
        button.classList.add('ruc-active');
        self.logLine('已复制：' + text, 'ok');
        button._copyTimer = setTimeout(function () {
          button._copyTimer = null;
          button.textContent = original;
          button.classList.remove('ruc-active');
        }, 1200);
      });
    };

    this.createCopyButton = function (url) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'ruc-btn-sm';
      button.textContent = '复制路径';
      button.title = '复制该资源路径到剪贴板（自动去掉 db:// 前缀）';
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        self.copyPath(url, button);
      });
      return button;
    };

    this.renderItems = function (items, groups) {
      items = items || [];
      groups = groups || [];

      self.$results.innerHTML = '';
      self._items = [];
      self._groups = [];
      self._groupEntries = [];
      self.$btnToggleAll.hidden = true;

      if (!items.length && !groups.length) {
        var empty = document.createElement('div');
        empty.className = 'ruc-empty';
        empty.textContent = '未找到未引用资源';
        self.$results.appendChild(empty);
        self.updateSummary();
        return;
      }

      var entries = [];
      items.forEach(function (item) {
        entries.push({
          kind: 'item',
          sort: String(item.relativePath || item.url || ''),
          item: item,
        });
      });
      groups.forEach(function (group) {
        entries.push({
          kind: 'group',
          sort: String((group.main && group.main.relativePath) || (group.main && group.main.url) || ''),
          group: group,
        });
      });
      entries.sort(function (a, b) {
        return a.sort.localeCompare(b.sort);
      });

      entries.forEach(function (entry) {
        if (entry.kind === 'group') {
          self.appendBoneGroup(entry.group);
        } else {
          self.appendItemRow(entry.item);
        }
      });

      self.updateSummary();
    };

    this.appendItemRow = function (item) {
      var entry = { item: item, checked: false, checkbox: null };
      self._items.push(entry);

      var row = document.createElement('div');
      row.className = 'ruc-row';
      row.title = '点击在资源管理器中定位：' + item.url;

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = false;
      checkbox.addEventListener('click', function (event) {
        event.stopPropagation();
      });
      checkbox.addEventListener('change', function () {
        entry.checked = checkbox.checked;
        self.updateSummary();
      });
      entry.checkbox = checkbox;

      var extEl = document.createElement('span');
      extEl.className = 'ruc-ext';
      extEl.textContent = item.ext || '';

      var pathEl = document.createElement('span');
      pathEl.className = 'ruc-path';
      pathEl.textContent = item.url;
      pathEl.title = item.url;

      row.appendChild(checkbox);
      row.appendChild(extEl);
      row.appendChild(pathEl);
      row.appendChild(self.createCopyButton(item.url));

      row.addEventListener('click', function () {
        self.locateAsset(item.uuid);
      });

      self.$results.appendChild(row);
    };

    this.appendBoneGroup = function (group) {
      var entry = { group: group, checked: false, checkbox: null, body: null, button: null };
      self._groups.push(entry);

      var wrap = document.createElement('div');
      wrap.className = 'ruc-group ruc-bone-group';

      var head = document.createElement('div');
      head.className = 'ruc-group-head ruc-bone-head';
      head.title = '点击在资源管理器中定位：' + (group.main.url || '');
      head.addEventListener('click', function () {
        self.locateAsset(group.main.uuid);
      });

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = false;
      checkbox.addEventListener('click', function (event) {
        event.stopPropagation();
      });
      checkbox.addEventListener('change', function () {
        entry.checked = checkbox.checked;
        self.updateSummary();
      });
      entry.checkbox = checkbox;

      var tag = document.createElement('span');
      tag.className = 'ruc-tag';
      tag.textContent = group.engine || 'bone';

      var title = document.createElement('span');
      title.className = 'ruc-group-title';
      title.textContent = group.main.url || group.main.uuid || '';
      title.title = title.textContent;

      var countEl = document.createElement('span');
      countEl.className = 'ruc-bone-count';
      countEl.textContent = '骨骼组 · ' + (group.total || (group.members || []).length) + ' 个文件';

      var body = document.createElement('div');
      body.className = 'ruc-group-body';
      body.hidden = true;
      entry.body = body;

      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'ruc-btn-sm';
      toggle.textContent = '查看资源';
      toggle.title = '展开该骨骼动画组的关联资源';
      entry.button = toggle;
      toggle.addEventListener('click', function (event) {
        event.stopPropagation();
        var expand = body.hidden;
        body.hidden = !expand;
        toggle.textContent = expand ? '折叠资源' : '查看资源';
        toggle.title = expand ? '折叠该骨骼动画组的关联资源' : '展开该骨骼动画组的关联资源';
        if (expand) {
          toggle.classList.add('ruc-active');
        } else {
          toggle.classList.remove('ruc-active');
        }
      });

      head.appendChild(checkbox);
      head.appendChild(tag);
      head.appendChild(title);
      head.appendChild(countEl);
      head.appendChild(toggle);
      head.appendChild(self.createCopyButton(group.main.url));
      wrap.appendChild(head);
      wrap.appendChild(body);

      (group.members || []).forEach(function (member) {
        var row = document.createElement('div');
        row.className = 'ruc-row ruc-bone-member';
        row.title = '点击在资源管理器中定位：' + (member.url || '');
        row.addEventListener('click', function () {
          self.locateAsset(member.uuid);
        });

        var typeTag = document.createElement('span');
        typeTag.className = 'ruc-tag';
        typeTag.textContent = member.type || member.ext || 'asset';

        var pathEl = document.createElement('span');
        pathEl.className = 'ruc-path';
        pathEl.textContent = member.url || member.uuid;
        pathEl.title = pathEl.textContent;

        row.appendChild(typeTag);
        row.appendChild(pathEl);
        body.appendChild(row);
      });

      self.$results.appendChild(wrap);
    };

    this.locateAsset = function (uuid) {
      if (!uuid) {
        return;
      }
      try {
        Editor.Selection.select('asset', uuid, true, true);
      } catch (e) {
        self.logLine('定位资源失败：' + (e.message || e), 'error');
      }
      try {
        Editor.Ipc.sendToAll('assets:hint', uuid);
      } catch (e) {
        // ignore
      }
    };

    this.countSelectable = function () {
      var total = self._items.length;
      self._groups.forEach(function (entry) {
        total += (entry.group.members || []).length;
      });
      return total;
    };

    this.toggleSelectAll = function () {
      if (self._items.length === 0 && self._groups.length === 0) {
        self.logLine('请先点击“开始查找”获取未引用资源列表', 'error');
        return;
      }

      var allSelected = true;
      self._items.forEach(function (entry) {
        if (!entry.checked) {
          allSelected = false;
        }
      });
      self._groups.forEach(function (entry) {
        if (!entry.checked) {
          allSelected = false;
        }
      });

      var next = !allSelected;
      self._items.forEach(function (entry) {
        entry.checked = next;
        if (entry.checkbox) {
          entry.checkbox.checked = next;
        }
      });
      self._groups.forEach(function (entry) {
        entry.checked = next;
        if (entry.checkbox) {
          entry.checkbox.checked = next;
        }
      });

      self.updateSummary();
      var total = self.countSelectable();
      self.logLine(next
        ? '已全选 ' + total + ' 项资源'
        : '已取消全选 ' + total + ' 项资源');
    };

    this.updateSummary = function () {
      var total = self._items.length;
      var selected = 0;
      self._items.forEach(function (entry) {
        if (entry.checked) {
          selected++;
        }
      });
      self._groups.forEach(function (entry) {
        var count = (entry.group.members || []).length;
        total += count;
        if (entry.checked) {
          selected += count;
        }
      });
      self.$listCount.textContent = total + ' 项 · 已选 ' + selected + ' 项';
    };

    // -------------------------------------------------------------------------
    // 清理
    // -------------------------------------------------------------------------

    this.clean = function () {
      if (self._busy) {
        return;
      }

      var urls = [];
      var seenUrl = new Set();
      function pushUrl (url) {
        if (url && !seenUrl.has(url)) {
          seenUrl.add(url);
          urls.push(url);
        }
      }
      self._items.forEach(function (entry) {
        if (entry.checked) {
          pushUrl(entry.item.url);
        }
      });
      self._groups.forEach(function (entry) {
        if (!entry.checked) {
          return;
        }
        (entry.group.members || []).forEach(function (member) {
          pushUrl(member.url);
        });
      });

      if (urls.length === 0) {
        self.logLine('请先在未引用资源列表中勾选要清理的资源', 'error');
        return;
      }

      self.setBusy(true);
      self.logLine('开始清理 ' + urls.length + ' 项…');

      Editor.Ipc.sendToMain('res-cite-tool:delete-assets', { urls: urls }, function (err, res) {
        self.setBusy(false);

        if (err) {
          self.logLine('清理失败：' + (err.message || err), 'error');
          return;
        }
        if (res && res.canceled) {
          self.logLine('已取消清理');
          return;
        }
        if (!res) {
          self.logLine('清理失败：未知错误', 'error');
          return;
        }

        var deleted = res.deleted || [];
        var failed = res.failed || [];

        deleted.forEach(function (url) {
          self.logLine('已清理：' + url, 'ok');
        });
        failed.forEach(function (url) {
          self.logLine('清理失败（仍存在）：' + url, 'error');
        });

        if (deleted.length) {
          var deletedSet = new Set(deleted);
          var remaining = self._items.filter(function (entry) {
            return !deletedSet.has(entry.item.url);
          }).map(function (entry) {
            return entry.item;
          });
          var remainingGroups = self._groups.filter(function (entry) {
            return !(entry.group.members || []).some(function (member) {
              return deletedSet.has(member.url);
            });
          }).map(function (entry) {
            return entry.group;
          });
          self.renderItems(remaining, remainingGroups);
        }

        var summary = '清理完成：成功 ' + deleted.length + ' 项' + (failed.length ? '，失败 ' + failed.length + ' 项' : '');
        self.logLine(summary, failed.length ? 'error' : 'ok');
        self.$summary.textContent = '清理完成：成功 ' + deleted.length + ' 项';

        if (!res.ok && failed.length === 0) {
          self.logLine('清理失败：' + (res.error || '未知错误'), 'error');
        }
        if (deleted.length) {
          self.logLine('可重新点击“开始查找”刷新未引用资源列表');
        }
      });
    };

    this.logLine('资源引用管理工具已就绪', 'ok');
    this.logLine('提示：resources 目录资源通常由代码动态加载，建议加入忽略目录。');
    this.logLine('指定清理目录时，可通过“选择目录”按钮打开文件资源选择器。');
    this.logLine('注意：仅统计序列化资源引用，未包含代码 loadRes/require、构建设置（如启动场景）等引用，清理前请确认。');
    this.updateMode();
    this.updateSpecifyDisplay();
    this.loadSavedConfig();
    this.loadMeta();
  },
});
