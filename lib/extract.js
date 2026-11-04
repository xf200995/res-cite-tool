'use strict';

var decompressUuid = require('./uuid').decompressUuid;

/**
 * 从序列化资源文本（library/imports/*.json）中提取引用。
 *
 * 覆盖三类写法：
 * 1. 完整 UUID（含 __uuid__、spriteFrame 的 "texture" 字段、材质贴图字段等）
 * 2. __uuid__ 中的压缩 UUID（22 或 23 字符）
 * 3. __type__ 中的压缩 UUID（脚本组件类 ID = 脚本资源 UUID，22 或 23 字符）
 */

var FULL_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
var SHORT_UUID_RE = /"__uuid__"\s*:\s*"([A-Za-z0-9+/]{22,23})"/g;
var SHORT_TYPE_RE = /"__type__"\s*:\s*"([A-Za-z0-9+/]{22,23})"/g;

function addCount (counts, uuid) {
  if (!uuid) {
    return;
  }
  counts[uuid] = (counts[uuid] || 0) + 1;
}

/**
 * @param {string} text 序列化文本
 * @param {string} [selfUuid] 引用方自身 UUID，用于过滤自引用
 * @returns {Object.<string, number>} targetUuid -> 出现次数
 */
function extractRefs (text, selfUuid) {
  var counts = Object.create(null);
  if (!text) {
    return counts;
  }

  var m;

  FULL_UUID_RE.lastIndex = 0;
  while ((m = FULL_UUID_RE.exec(text)) !== null) {
    addCount(counts, m[0].toLowerCase());
  }

  SHORT_UUID_RE.lastIndex = 0;
  while ((m = SHORT_UUID_RE.exec(text)) !== null) {
    addCount(counts, decompressUuid(m[1]));
  }

  SHORT_TYPE_RE.lastIndex = 0;
  while ((m = SHORT_TYPE_RE.exec(text)) !== null) {
    addCount(counts, decompressUuid(m[1]));
  }

  if (selfUuid && counts[selfUuid]) {
    delete counts[selfUuid];
  }

  return counts;
}

module.exports = {
  extractRefs: extractRefs,
};
