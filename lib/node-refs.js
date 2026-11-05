'use strict';

/**
 * 渲染节点级引用列表，供“资源引用查找”和“资源引用管理”两个面板共用。
 * @param {HTMLElement} box 节点列表容器
 * @param {Array} nodes 节点引用记录（nodePath / component / property / count）
 * @param {Object} options
 *   - prefix：样式前缀（rcf / ruc）
 *   - emptyText：无节点记录时的提示文案
 *   - onSelect：(item, row) => void，提供后节点行可点击定位
 */
function renderList (box, nodes, options) {
  options = options || {};
  var prefix = options.prefix || 'rcf';
  box.innerHTML = '';

  if (!nodes || nodes.length === 0) {
    var notice = document.createElement('div');
    notice.className = prefix + '-node-notice';
    notice.textContent = options.emptyText || '该文件中未找到节点级引用（可能为资源级引用）';
    box.appendChild(notice);
    return;
  }

  nodes.forEach(function (item) {
    var row = document.createElement('div');
    row.className = prefix + '-node-row';

    if (item.nodePath && typeof options.onSelect === 'function') {
      row.classList.add(prefix + '-node-row-clickable');
      row.title = '点击在层级管理器中定位该节点：' + item.nodePath;
      row.addEventListener('click', function (event) {
        event.stopPropagation();
        options.onSelect(item, row);
      });
    } else if (item.nodePath) {
      row.title = '引用节点：' + item.nodePath;
    } else {
      row.title = '资源级引用，无关联节点';
    }

    var pathEl = document.createElement('span');
    pathEl.className = prefix + '-node-path';
    pathEl.textContent = item.nodePath || '资源文件自身';
    pathEl.title = pathEl.textContent;

    var metaEl = document.createElement('span');
    metaEl.className = prefix + '-node-meta';
    metaEl.textContent = item.component + (item.property ? '.' + item.property : '');
    metaEl.title = metaEl.textContent;

    var countEl = document.createElement('span');
    countEl.className = prefix + '-node-count';
    countEl.textContent = item.count > 1 ? '×' + item.count : '';

    row.appendChild(pathEl);
    row.appendChild(metaEl);
    row.appendChild(countEl);
    box.appendChild(row);
  });
}

module.exports = {
  renderList: renderList,
};
