'use strict';

// 节点定位：查找面板与引用管理面板共用，避免两套实现漂移
// 反馈通过 options.notify(text, duration, level) 注入，level 为 info/warn/error/ok

function createState () {
  return { token: 0, timer: null };
}

// 取消上一次尚未完成的定位（包括等待中的轮询）
function cancelPending (state) {
  state.token++;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function isPrefabEditMode (hierarchy, rootName) {
  if (!Array.isArray(hierarchy) || !rootName) {
    return false;
  }
  var sceneRoots = hierarchy.filter(function (node) {
    return node && String(node.name || '').indexOf('Editor Scene ') !== 0;
  });
  return sceneRoots.length === 1 &&
    sceneRoots[0].name === rootName &&
    Number(sceneRoots[0].prefabState) !== 0;
}

function findNodeInHierarchy (roots, item) {
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
}

function openPrefabAndLocate (state, token, ref, item, options) {
  var notify = options.notify;
  var rootName = String(item.nodePath || '').split('/')[0];
  var attempts = 0;
  // 首次打开 prefab 可能较慢（尤其带贴图/嵌套预制体），最多等待约 30 秒
  var maxAttempts = 90;

  function finish (found) {
    if (token !== state.token) {
      return;
    }
    state.timer = null;
    if (found) {
      notify('已定位节点：' + item.nodePath, 2500, 'ok');
    } else {
      notify('已打开 prefab，但未自动定位到节点（文件可能已修改）', 4500, 'warn');
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
    if (token !== state.token) {
      return;
    }
    state.timer = setTimeout(poll, 350);
  }

  function poll () {
    if (token !== state.token) {
      return;
    }
    attempts++;
    if (attempts > maxAttempts) {
      finish(false);
      return;
    }
    if (attempts === 15) {
      notify('prefab 加载较慢，仍在等待…', 4500, 'info');
    }
    Editor.Ipc.sendToPanel('scene', 'scene:query-hierarchy', function (err, sceneId, hierarchy) {
      if (token !== state.token) {
        return;
      }
      if (err || !hierarchy) {
        retryLater();
        return;
      }
      // 必须确认已经切换到该 prefab 的编辑模式，避免在旧场景里误选同名节点
      if (!isPrefabEditMode(hierarchy, rootName)) {
        retryLater();
        return;
      }
      var found = findNodeInHierarchy(hierarchy, item);
      if (!found || !found.id) {
        retryLater();
        return;
      }
      selectNode(found);
      // 进入编辑模式后可能还有一次层级刷新会清空选中状态，稍后确认一次
      state.timer = setTimeout(function () {
        if (token !== state.token) {
          return;
        }
        Editor.Ipc.sendToPanel('scene', 'scene:query-hierarchy', function (err2, sceneId2, hierarchy2) {
          if (token !== state.token) {
            return;
          }
          if (err2 || !hierarchy2 || !isPrefabEditMode(hierarchy2, rootName)) {
            retryLater();
            return;
          }
          var again = findNodeInHierarchy(hierarchy2, item);
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

  try {
    Editor.Ipc.sendToAll('scene:enter-prefab-edit-mode', ref.uuid);
  } catch (e) {
    if (token === state.token) {
      state.timer = null;
      notify('打开 prefab 失败：' + e.message, 4000, 'error');
    }
    return;
  }
  notify('正在打开 prefab：' + (ref.name || ref.url) + '…', 5000, 'info');
  state.timer = setTimeout(poll, 300);
}

/**
 * 定位节点行。
 * @param {Object} state createState() 创建的定位状态（每个面板一个）
 * @param {Object} ref 引用文件记录（uuid/url/name/type）
 * @param {Object} item 节点记录（nodePath/nodeId/nodeIndexPath）
 * @param {Object} options
 *   - row：当前节点行，用于命中高亮（可选）
 *   - hitClass：命中高亮样式类（可选）
 *   - notify(text, duration, level)：反馈回调（必需）
 */
function locate (state, ref, item, options) {
  options = options || {};
  var notify = options.notify || function () {};
  if (!ref || !item || !item.nodePath) {
    return;
  }

  cancelPending(state);
  var token = state.token;

  if (options.row && options.hitClass) {
    var row = options.row;
    row.classList.add(options.hitClass);
    setTimeout(function () {
      row.classList.remove(options.hitClass);
    }, 1500);
  }

  if (item.nodeId) {
    try {
      Editor.Selection.select('node', item.nodeId, true, true);
      notify('已定位节点（若层级中未高亮，请先打开该场景）', 3000, 'info');
    } catch (e) {
      notify('定位节点失败：' + e.message, 3500, 'error');
    }
    return;
  }

  if (ref.type !== 'prefab') {
    notify('该引用文件不是 prefab，请先打开对应场景后再定位节点', 3500, 'warn');
    return;
  }

  openPrefabAndLocate(state, token, ref, item, {
    notify: notify,
  });
}

module.exports = {
  createState: createState,
  locate: locate,
};
