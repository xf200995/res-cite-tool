'use strict';

// 复制用路径：仅去掉开头的 db://，其余内容（含 assets/、internal/、分隔符）原样保留
function stripDbPrefix (url) {
  if (typeof url !== 'string') {
    return '';
  }
  return url.indexOf('db://') === 0 ? url.slice(5) : url;
}

// 兜底方案：document.execCommand('copy')，在 Electron 面板内可用
function execCommandCopy (text) {
  var area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  area.style.opacity = '0';
  document.body.appendChild(area);

  var previous = document.activeElement;
  var ok = false;
  try {
    area.focus();
    area.select();
    ok = document.execCommand('copy');
  } catch (e) {
    ok = false;
  }
  document.body.removeChild(area);
  try {
    if (previous && typeof previous.focus === 'function') {
      previous.focus();
    }
  } catch (e) {
    // ignore
  }
  return ok;
}

// 剪贴板写入：依次尝试编辑器/Electron 原生剪贴板、浏览器剪贴板、execCommand
function writeText (text, done) {
  var settled = false;
  function finish (ok) {
    if (settled) {
      return;
    }
    settled = true;
    done(ok);
  }

  try {
    var editorClipboard = typeof Editor !== 'undefined' && (Editor.Clipboard || Editor.clipboard);
    if (editorClipboard && typeof editorClipboard.writeText === 'function') {
      editorClipboard.writeText(text);
      finish(true);
      return;
    }
  } catch (e) {
    // ignore
  }

  try {
    var electron = require('electron');
    if (electron && electron.clipboard && typeof electron.clipboard.writeText === 'function') {
      electron.clipboard.writeText(text);
      finish(true);
      return;
    }
  } catch (e) {
    // ignore
  }

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(function () {
        finish(true);
      }, function () {
        finish(execCommandCopy(text));
      });
      return;
    }
  } catch (e) {
    // ignore
  }

  finish(execCommandCopy(text));
}

module.exports = {
  stripDbPrefix: stripDbPrefix,
  writeText: writeText,
};
