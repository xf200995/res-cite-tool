'use strict';

var ipcRenderer = require('electron').ipcRenderer;
var settingsLib = require('../../lib/settings');

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

var $shortcut = document.getElementById('shortcut');
var $hint = document.getElementById('hint');
var $btnSave = document.getElementById('btnSave');
var $btnReset = document.getElementById('btnReset');

var pendingCombo = null;

function setHint (text, kind) {
  $hint.textContent = text;
  $hint.className = 'hint' +
    (kind === 'error' ? ' hint-error' : (kind === 'ok' ? ' hint-ok' : ''));
}

function sendRecording (flag) {
  ipcRenderer.send('res-cite-tool:shortcut-recording', !!flag);
}

function save () {
  if (!pendingCombo) {
    setHint('请按下要绑定的组合键后再保存', 'error');
    return;
  }
  ipcRenderer.send('res-cite-tool:search-settings-set', pendingCombo);
}

function closeWindow () {
  ipcRenderer.send('res-cite-tool:search-settings-close');
}

$shortcut.addEventListener('focus', function () {
  sendRecording(true);
});
$shortcut.addEventListener('blur', function () {
  sendRecording(false);
});
$shortcut.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeWindow();
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    save();
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  var code = event.code || '';
  if (MODIFIER_CODES[code]) {
    pendingCombo = null;
    var modifiers = [];
    if (event.ctrlKey) { modifiers.push('Ctrl'); }
    if (event.altKey) { modifiers.push('Alt'); }
    if (event.shiftKey) { modifiers.push('Shift'); }
    if (event.metaKey) { modifiers.push('Meta'); }
    $shortcut.value = modifiers.length ? modifiers.join('+') + '+…' : '…';
    return;
  }

  pendingCombo = {
    code: code,
    key: event.key,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
  $shortcut.value = settingsLib.formatLabel(pendingCombo);
  setHint('点击“保存”应用快速查找快捷键', '');
});

$btnSave.addEventListener('click', function () {
  save();
});
$btnReset.addEventListener('click', function () {
  ipcRenderer.send('res-cite-tool:search-settings-reset');
});
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') {
    closeWindow();
  }
});
window.addEventListener('blur', function () {
  sendRecording(false);
});
window.addEventListener('beforeunload', function () {
  sendRecording(false);
});

ipcRenderer.on('res-cite-tool:search-settings-state', function (event, res) {
  if (!res || !res.shortcut) {
    return;
  }
  $shortcut.value = res.shortcut.label || '';
});

ipcRenderer.on('res-cite-tool:search-settings-result', function (event, res) {
  if (!res || res.ok !== true) {
    var code = res && res.error;
    if (code === 'INVALID_SHORTCUT') {
      setHint('无效组合：需包含 Ctrl/Alt/Meta，或使用 F1–F24；不能是纯字母/数字', 'error');
    } else if (code === 'SAVE_FAILED') {
      setHint('保存失败：无法写入项目 local 目录', 'error');
    } else {
      setHint('保存失败：' + (code || '未知错误'), 'error');
    }
    return;
  }
  pendingCombo = null;
  $shortcut.value = res.shortcut.label;
  setHint('已生效：' + res.shortcut.label, 'ok');
  // 释放录制状态，保存后可立即按新快捷键验证
  $shortcut.blur();
});

ipcRenderer.send('res-cite-tool:search-settings-get');
$shortcut.focus();
