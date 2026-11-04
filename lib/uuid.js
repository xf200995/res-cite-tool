'use strict';

/**
 * 压缩 UUID 解码，兼容两种格式：
 * - 22 字符：前 2 位原样 + 20 位 base64（对应剩余 30 个 hex）
 * - 23 字符：前 5 位原样 + 18 位 base64（对应剩余 27 个 hex，脚本组件常用）
 * 算法来自 Cocos Creator 2.4 引擎源码：
 * resources/engine/cocos2d/core/utils/decode-uuid.js
 */

var BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
var BASE64_VALUES = new Array(123);
for (var i = 0; i < 123; ++i) {
  BASE64_VALUES[i] = 64;
}
for (var j = 0; j < 64; ++j) {
  BASE64_VALUES[BASE64_KEYS.charCodeAt(j)] = j;
}

var HEX_CHARS = '0123456789abcdef'.split('');

function formatUuid (hex) {
  return hex.slice(0, 8) + '-' +
    hex.slice(8, 12) + '-' +
    hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' +
    hex.slice(20);
}

function decompressUuid (compressed) {
  if (typeof compressed !== 'string') {
    return null;
  }

  var prefixLength;
  var base64Length;
  if (compressed.length === 22) {
    prefixLength = 2;
    base64Length = 20;
  } else if (compressed.length === 23) {
    prefixLength = 5;
    base64Length = 18;
  } else {
    return null;
  }

  var hex = compressed.slice(0, prefixLength);
  for (var i = prefixLength, k = 0; k < base64Length; k += 2, i += 2) {
    var lhs = BASE64_VALUES[compressed.charCodeAt(i)];
    var rhs = BASE64_VALUES[compressed.charCodeAt(i + 1)];
    if (lhs === 64 || rhs === 64) {
      return null;
    }
    hex += HEX_CHARS[lhs >> 2] +
      HEX_CHARS[((lhs & 3) << 2) | rhs >> 4] +
      HEX_CHARS[rhs & 0xF];
  }

  if (hex.length !== 32) {
    return null;
  }
  return formatUuid(hex);
}

module.exports = {
  decompressUuid: decompressUuid,
};
