'use strict';

var fs = require('fs');
var nodePath = require('path');

var DEFAULT_SHORTCUT = {
  code: 'F12',
  key: 'F12',
  ctrl: false,
  alt: false,
  shift: true,
  meta: false,
  label: 'Shift+F12',
};

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

function isMac () {
  return process.platform === 'darwin';
}

function displayKey (combo) {
  var code = combo.code || '';
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }
  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }
  var key = String(combo.key || '');
  if (key === ' ') {
    return 'Space';
  }
  if (key.length === 1) {
    return key.toUpperCase();
  }
  return key;
}

function formatLabel (combo) {
  var parts = [];
  if (combo.ctrl) {
    parts.push('Ctrl');
  }
  if (combo.alt) {
    parts.push('Alt');
  }
  if (combo.shift) {
    parts.push('Shift');
  }
  if (combo.meta) {
    parts.push(isMac() ? 'Cmd' : 'Meta');
  }
  parts.push(displayKey(combo));
  return parts.join('+');
}

function isValidCombo (combo) {
  var code = String(combo.code || '');
  var key = String(combo.key || '');

  if (!code && !key) {
    return false;
  }
  if (MODIFIER_CODES[code]) {
    return false;
  }

  var hasCommandModifier = !!(combo.ctrl || combo.alt || combo.meta);
  var isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(code) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key);

  // 纯字母/数字、仅 Shift+字母 不占用（避免劫持正常输入）
  if (!hasCommandModifier && !isFunctionKey) {
    return false;
  }

  // Ctrl+Alt+Delete 系统保留
  if (combo.ctrl && combo.alt && String(key).toUpperCase() === 'DELETE') {
    return false;
  }

  return true;
}

/**
 * 把来自面板/配置文件的快捷键对象规整为内部结构；无效返回 null。
 */
function normalize (raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  var combo = {
    code: typeof raw.code === 'string' ? raw.code : '',
    key: typeof raw.key === 'string' ? raw.key : '',
    ctrl: !!raw.ctrl,
    alt: !!raw.alt,
    shift: !!raw.shift,
    meta: !!raw.meta,
  };
  if (!isValidCombo(combo)) {
    return null;
  }
  combo.label = formatLabel(combo);
  return combo;
}

function load (filePath) {
  var settings = { shortcut: DEFAULT_SHORTCUT };
  if (!filePath) {
    return settings;
  }
  try {
    if (!fs.existsSync(filePath)) {
      return settings;
    }
    var raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    var shortcut = normalize(raw && raw.shortcut);
    if (shortcut) {
      settings.shortcut = shortcut;
    }
  } catch (e) {
    // 配置损坏时回退默认值
  }
  return settings;
}

function save (filePath, settings) {
  if (!filePath) {
    return false;
  }
  var dir = nodePath.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    shortcut: settings && settings.shortcut,
  }, null, 2), 'utf8');
  return true;
}

function matchShortcut (input, shortcut) {
  if (!input || !shortcut) {
    return false;
  }
  if (input.type !== 'keyDown' || input.isAutoRepeat) {
    return false;
  }
  if (!!input.control !== !!shortcut.ctrl) {
    return false;
  }
  if (!!input.alt !== !!shortcut.alt) {
    return false;
  }
  if (!!input.shift !== !!shortcut.shift) {
    return false;
  }
  if (!!input.meta !== !!shortcut.meta) {
    return false;
  }
  var code = input.code || '';
  if (shortcut.code && code) {
    return code === shortcut.code;
  }
  return String(input.key || '').toLowerCase() === String(shortcut.key || '').toLowerCase();
}

/**
 * 仅在 before-input-event 不可用时回退到 globalShortcut，需要 Electron accelerator 字符串。
 */
function toAccelerator (combo) {
  if (!combo) {
    return null;
  }
  var parts = [];
  if (combo.ctrl) {
    parts.push('Control');
  }
  if (combo.alt) {
    parts.push('Alt');
  }
  if (combo.shift) {
    parts.push('Shift');
  }
  if (combo.meta) {
    parts.push(isMac() ? 'Command' : 'Super');
  }

  var code = String(combo.code || '');
  var key = '';
  if (/^Key[A-Z]$/.test(code)) {
    key = code.slice(3);
  } else if (/^Digit[0-9]$/.test(code)) {
    key = code.slice(5);
  } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    key = code;
  } else if (code === 'ArrowUp') {
    key = 'Up';
  } else if (code === 'ArrowDown') {
    key = 'Down';
  } else if (code === 'ArrowLeft') {
    key = 'Left';
  } else if (code === 'ArrowRight') {
    key = 'Right';
  } else if (code === 'Space') {
    key = 'Space';
  } else if (code === 'Escape') {
    key = 'Escape';
  } else if (combo.key && combo.key.length <= 3) {
    key = combo.key.toUpperCase();
  }

  if (!key) {
    return null;
  }
  parts.push(key);
  return parts.join('+');
}

module.exports = {
  DEFAULT_SHORTCUT: DEFAULT_SHORTCUT,
  normalize: normalize,
  formatLabel: formatLabel,
  load: load,
  save: save,
  matchShortcut: matchShortcut,
  toAccelerator: toAccelerator,
};
