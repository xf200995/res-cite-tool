'use strict';

var fs = require('fs');
var nodePath = require('path');

/**
 * 扫描 assets 目录，返回所有子目录（相对 assets，使用 / 分隔）与文件后缀名。
 * .meta 后缀固定排除。
 * @param {string} projectPath
 * @returns {{dirs: string[], types: string[]}}
 */
function collect (projectPath) {
  var assetsDir = nodePath.join(projectPath, 'assets');
  var dirs = [''];
  var typeSet = Object.create(null);

  function walk (dir, rel) {
    var entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    entries.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
    entries.forEach(function (entry) {
      var name = entry.name;
      if (!name || name.charAt(0) === '.') {
        return;
      }
      var fullPath = nodePath.join(dir, name);
      var childRel = rel ? rel + '/' + name : name;
      var isDir = false;
      try {
        isDir = entry.isDirectory();
      } catch (e) {
        isDir = false;
      }
      if (isDir) {
        dirs.push(childRel);
        walk(fullPath, childRel);
        return;
      }
      var ext = nodePath.extname(name).toLowerCase();
      if (ext && ext !== '.meta') {
        typeSet[ext] = true;
      }
    });
  }

  walk(assetsDir, '');

  return {
    dirs: dirs,
    types: Object.keys(typeSet).sort(),
  };
}

module.exports = {
  collect: collect,
};
