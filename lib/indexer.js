'use strict';

var fs = require('fs');
var fsp = fs.promises;
var nodePath = require('path');

var extractRefs = require('./extract').extractRefs;
var decompressUuid = require('./uuid').decompressUuid;

var CACHE_VERSION = 4;
var MAX_FILE_SIZE = 4 * 1024 * 1024;
var READ_CONCURRENCY = 32;
var META_CONCURRENCY = 8;
var FULL_REBUILD_THRESHOLD = 3000;
var MAX_PENDING_ATTEMPTS = 3;
var SAVE_DEBOUNCE_MS = 3000;
var PROGRESS_STEP = 200;

var FNT_RE = /\.fnt$/i;
var TEXTURE_EXT_RE = /\.(png|jpg|jpeg|webp|bmp|tga|pvr|pkm|ktx|astc)$/i;

function noop () {}

function createIndexer (options) {
  options = options || {};

  var projectPath = options.projectPath || '';
  var editorVersion = options.editorVersion || '';
  var log = options.log || noop;
  var onProgress = options.onProgress || noop;
  var uuidToUrl = options.uuidToUrl || function () { return null; };
  var uuidToFspath = options.uuidToFspath || function () { return null; };
  var subAssetUuids = options.subAssetUuids || function () { return []; };

  var libraryDir = nodePath.join(projectPath, 'library');
  var importsDir = nodePath.join(libraryDir, 'imports');
  var mtimePath = nodePath.join(libraryDir, 'uuid-to-mtime.json');
  var cacheDir = nodePath.join(projectPath, 'local', 'res-cite-tool');
  var cachePath = nodePath.join(cacheDir, 'index-cache.json');

  var state = 'idle';
  var assets = new Map();   // uuid -> [assetMtime, metaMtime, relativePath]
  var outEdges = new Map(); // referrerUuid -> Map<targetUuid, count>
  var reverse = new Map();  // targetUuid -> Map<referrerUuid, count>
  var boneGroups = [];      // 骨骼动画资源组：[{ id, engine, members: [uuid] }]
  var pacScopes = [];       // 自动图集保护范围：[{ uuid, dir, hasTexture }]

  var libraryStamp = null;
  var buildMs = 0;
  var cacheHit = false;
  var lastError = null;
  var buildPromise = null;
  var saveTimer = null;
  var disposed = false;
  var pendingAttempts = new Map();
  var mtimeFailures = 0;
  var lastFullBuildAt = 0;

  // ---------------------------------------------------------------------------
  // 基础工具
  // ---------------------------------------------------------------------------

  function importFileOf (uuid) {
    return nodePath.join(importsDir, uuid.slice(0, 2), uuid + '.json');
  }

  function reportProgress (payload) {
    try { onProgress(payload); } catch (e) { /* ignore */ }
  }

  function stampNow () {
    try {
      var st = fs.statSync(mtimePath);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch (e) {
      return null;
    }
  }

  function edgeCount () {
    var total = 0;
    outEdges.forEach(function (targets) { total += targets.size; });
    return total;
  }

  function rebuildReverse () {
    reverse = new Map();
    outEdges.forEach(function (targets, referrer) {
      targets.forEach(function (count, target) {
        var map = reverse.get(target);
        if (!map) {
          map = new Map();
          reverse.set(target, map);
        }
        map.set(referrer, (map.get(referrer) || 0) + count);
      });
    });
  }

  function countsToMap (counts) {
    var map = new Map();
    Object.keys(counts).forEach(function (key) {
      map.set(key, counts[key]);
    });
    return map;
  }

  function mergeCounts (counts, extra) {
    if (!extra) {
      return;
    }
    Object.keys(extra).forEach(function (key) {
      counts[key] = (counts[key] || 0) + extra[key];
    });
  }

  async function readTextIfExists (filePath) {
    try {
      var text = await fsp.readFile(filePath, 'utf8');
      return { exists: true, ok: true, text: text };
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        return { exists: false, ok: false };
      }
      return { exists: true, ok: false };
    }
  }

  function isBigFile (text) {
    return text && text.length > MAX_FILE_SIZE;
  }

  // ---------------------------------------------------------------------------
  // 缓存
  // ---------------------------------------------------------------------------

  function loadCache () {
    try {
      if (!fs.existsSync(cachePath)) {
        return false;
      }
      var cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (!cache || cache.cacheVersion !== CACHE_VERSION || cache.editorVersion !== editorVersion) {
        return false;
      }
      assets = new Map();
      var cachedAssets = cache.assets || {};
      Object.keys(cachedAssets).forEach(function (uuid) {
        var item = cachedAssets[uuid];
        if (Array.isArray(item)) {
          assets.set(uuid, item);
        } else if (item) {
          assets.set(uuid, [item.asset, item.meta, item.relativePath]);
        }
      });

      outEdges = new Map();
      var cachedEdges = cache.outEdges || {};
      Object.keys(cachedEdges).forEach(function (referrer) {
        var inner = new Map();
        var targets = cachedEdges[referrer] || {};
        Object.keys(targets).forEach(function (target) {
          inner.set(target, targets[target]);
        });
        outEdges.set(referrer, inner);
      });

      boneGroups = [];
      if (Array.isArray(cache.boneGroups)) {
        cache.boneGroups.forEach(function (group) {
          if (!group || typeof group.id !== 'string' || !Array.isArray(group.members)) {
            return;
          }
          boneGroups.push({
            id: group.id.toLowerCase(),
            engine: group.engine || 'bone',
            members: group.members.map(function (uuid) {
              return String(uuid).toLowerCase();
            }),
          });
        });
      }

      pacScopes = [];
      if (Array.isArray(cache.pacScopes)) {
        cache.pacScopes.forEach(function (scope) {
          if (!scope || typeof scope.uuid !== 'string') {
            return;
          }
          pacScopes.push({
            uuid: scope.uuid.toLowerCase(),
            dir: String(scope.dir || '').toLowerCase(),
            hasTexture: scope.hasTexture === true,
          });
        });
      }

      libraryStamp = cache.libraryStamp || null;
      rebuildReverse();
      cacheHit = true;
      state = 'ready';
      buildMs = 0;
      log('cache loaded assets=' + assets.size + ' edges=' + edgeCount());
      return true;
    } catch (e) {
      log('cache load failed: ' + (e && e.message));
      return false;
    }
  }

  function serializeCache () {
    var assetObj = Object.create(null);
    assets.forEach(function (triple, uuid) {
      assetObj[uuid] = triple;
    });

    var edgeObj = Object.create(null);
    outEdges.forEach(function (targets, referrer) {
      var inner = Object.create(null);
      targets.forEach(function (count, target) {
        inner[target] = count;
      });
      edgeObj[referrer] = inner;
    });

    return {
      cacheVersion: CACHE_VERSION,
      editorVersion: editorVersion,
      libraryStamp: libraryStamp,
      assets: assetObj,
      outEdges: edgeObj,
      boneGroups: boneGroups,
      pacScopes: pacScopes,
    };
  }

  async function saveNow () {
    if (!projectPath) {
      return;
    }
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      var tmp = cachePath + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(serializeCache()), 'utf8');
      await fsp.rename(tmp, cachePath);
    } catch (e) {
      log('cache save failed: ' + (e && e.message));
    }
  }

  function scheduleSave () {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(function () {
      saveTimer = null;
      saveNow();
    }, SAVE_DEBOUNCE_MS);
    if (saveTimer && typeof saveTimer.unref === 'function') {
      saveTimer.unref();
    }
  }

  // ---------------------------------------------------------------------------
  // 并发控制
  // ---------------------------------------------------------------------------

  async function mapLimit (items, limit, worker) {
    var index = 0;
    var size = Math.min(limit, items.length);
    var runners = [];
    for (var i = 0; i < size; i++) {
      runners.push((async function () {
        var local = 0;
        while (!disposed) {
          var current = index++;
          if (current >= items.length) {
            return;
          }
          await worker(items[current], current);
          local++;
          if (local % PROGRESS_STEP === 0) {
            await new Promise(function (resolve) { setImmediate(resolve); });
          }
        }
      })());
    }
    await Promise.all(runners);
  }

  // ---------------------------------------------------------------------------
  // 全量构建
  // ---------------------------------------------------------------------------

  async function listImportFiles () {
    var list = [];
    var dirs;
    try {
      dirs = await fsp.readdir(importsDir);
    } catch (e) {
      throw new Error('找不到 library/imports 目录：' + importsDir);
    }
    for (var i = 0; i < dirs.length; i++) {
      var dirName = dirs[i];
      var dirPath = nodePath.join(importsDir, dirName);
      var st;
      try {
        st = await fsp.stat(dirPath);
      } catch (e) {
        continue;
      }
      if (!st.isDirectory()) {
        continue;
      }
      var names;
      try {
        names = await fsp.readdir(dirPath);
      } catch (e) {
        continue;
      }
      for (var k = 0; k < names.length; k++) {
        var name = names[k];
        if (!name.endsWith('.json')) {
          continue;
        }
        list.push({
          uuid: name.slice(0, -5).toLowerCase(),
          path: nodePath.join(dirPath, name),
        });
      }
    }
    return list;
  }

  function readMtimeSnapshot () {
    try {
      var json = JSON.parse(fs.readFileSync(mtimePath, 'utf8'));
      var map = new Map();
      Object.keys(json).forEach(function (uuid) {
        var item = json[uuid] || {};
        map.set(uuid.toLowerCase(), [item.asset, item.meta, String(item.relativePath || '')]);
      });
      return map;
    } catch (e) {
      return null;
    }
  }

  async function readFntTexture (uuid) {
    try {
      var fspath = uuidToFspath(uuid);
      if (!fspath) {
        return { ok: false };
      }
      var text = await fsp.readFile(fspath + '.meta', 'utf8');
      var json = JSON.parse(text.replace(/^\uFEFF/, ''));
      var textureUuid = json && json.textureUuid;
      return {
        ok: true,
        textureUuid: typeof textureUuid === 'string' ? textureUuid.toLowerCase() : null,
      };
    } catch (e) {
      return { ok: false };
    }
  }

  async function buildFull () {
    var t0 = Date.now();
    var startStamp = stampNow();
    state = 'building';
    lastError = null;
    reportProgress({ phase: 'scan', done: 0, total: 0 });

    var files = await listImportFiles();
    var snapshot = readMtimeSnapshot();
    var nextAssets = snapshot || new Map();

    var nextEdges = new Map();
    var done = 0;

    await mapLimit(files, READ_CONCURRENCY, async function (file) {
      var result = await readTextIfExists(file.path);
      var counts = Object.create(null);
      if (result.exists && result.ok && !isBigFile(result.text)) {
        counts = extractRefs(result.text, file.uuid);
      }
      nextEdges.set(file.uuid, countsToMap(counts));
      done++;
      if (done % PROGRESS_STEP === 0 || done === files.length) {
        reportProgress({ phase: 'build', done: done, total: files.length });
      }
    });

    // .fnt.meta 中的 textureUuid 不在 library JSON 里，单独补边
    var fntUuids = [];
    nextAssets.forEach(function (triple, uuid) {
      if (FNT_RE.test(triple[2] || '')) {
        fntUuids.push(uuid);
      }
    });

    await mapLimit(fntUuids, META_CONCURRENCY, async function (uuid) {
      var meta = await readFntTexture(uuid);
      if (!meta.ok || !meta.textureUuid) {
        return;
      }
      var targets = nextEdges.get(uuid);
      if (!targets) {
        targets = new Map();
        nextEdges.set(uuid, targets);
      }
      var target = meta.textureUuid;
      targets.set(target, (targets.get(target) || 0) + 1);
    });

    outEdges = nextEdges;
    assets = nextAssets;
    pendingAttempts.clear();
    rebuildReverse();
    await rebuildBoneGroups();
    await rebuildPacScopes();
    // 用构建开始时的指纹：构建期间发生的改动会被下一次 ensureFresh 捕获
    libraryStamp = snapshot ? startStamp : null;
    buildMs = Date.now() - t0;
    lastFullBuildAt = Date.now();
    mtimeFailures = 0;
    state = 'ready';

    reportProgress({ phase: 'done', done: files.length, total: files.length });
    log('index ready assets=' + assets.size + ' edges=' + edgeCount() + ' build=' + buildMs + 'ms');
    await saveNow();
    return true;
  }

  function startBuild () {
    if (buildPromise) {
      return buildPromise;
    }
    buildPromise = buildFull()
      .catch(function (e) {
        state = 'error';
        lastError = String((e && e.message) || e);
        log('index build failed: ' + lastError);
        return false;
      })
      .then(function (result) {
        buildPromise = null;
        return result;
      });
    return buildPromise;
  }

  function ensureReady () {
    if (disposed) {
      return Promise.reject(new Error('indexer disposed'));
    }
    if (state === 'ready') {
      return Promise.resolve(true);
    }
    return startBuild();
  }

  // ---------------------------------------------------------------------------
  // 增量更新
  // ---------------------------------------------------------------------------

  async function processAsset (uuid, relativePath) {
    var counts = Object.create(null);
    var ok = true;
    var processed = outEdges.has(uuid);

    var mainResult = await readTextIfExists(importFileOf(uuid));
    if (mainResult.exists) {
      if (mainResult.ok && !isBigFile(mainResult.text)) {
        mergeCounts(counts, extractRefs(mainResult.text, uuid));
      } else if (!mainResult.ok) {
        ok = false;
      }
    } else if (processed) {
      // 之前有 import JSON，现在缺失，可能是编辑器写入中，交给重试上限处理
      ok = false;
    }

    var subs = [];
    try {
      subs = subAssetUuids(uuid) || [];
    } catch (e) {
      subs = [];
    }
    for (var i = 0; i < subs.length; i++) {
      var item = subs[i];
      var subUuid = typeof item === 'string' ? item : (item && item.uuid);
      if (!subUuid) {
        continue;
      }
      subUuid = subUuid.toLowerCase();
      var subResult = await readTextIfExists(importFileOf(subUuid));
      if (subResult.exists && subResult.ok && !isBigFile(subResult.text)) {
        mergeCounts(counts, extractRefs(subResult.text, subUuid));
      }
    }

    if (FNT_RE.test(relativePath || '')) {
      var meta = await readFntTexture(uuid);
      if (meta.ok) {
        if (meta.textureUuid) {
          counts[meta.textureUuid] = (counts[meta.textureUuid] || 0) + 1;
        }
      } else {
        ok = false;
      }
    }

    return { ok: ok, counts: counts };
  }

  async function applyDelta (added, changed, removed, nextAssets) {
    var pending = [];

    removed.forEach(function (uuid) {
      outEdges.delete(uuid);
      assets.delete(uuid);
      pendingAttempts.delete(uuid);
    });

    var todo = added.concat(changed);
    if (todo.length === 0) {
      return pending;
    }

    await mapLimit(todo, READ_CONCURRENCY, async function (uuid) {
      var triple = nextAssets.get(uuid) || ['', '', ''];
      var result = await processAsset(uuid, triple[2]);
      if (!result.ok) {
        var attempts = (pendingAttempts.get(uuid) || 0) + 1;
        if (attempts >= MAX_PENDING_ATTEMPTS) {
          pendingAttempts.delete(uuid);
          outEdges.set(uuid, new Map());
          log('asset read failed ' + attempts + ' times, accepted empty: ' + uuid);
        } else {
          pendingAttempts.set(uuid, attempts);
          pending.push(uuid);
        }
      } else {
        pendingAttempts.delete(uuid);
        outEdges.set(uuid, countsToMap(result.counts));
      }
    });

    // 未处理完成的资源保留旧快照，下次查询继续重试
    var next = new Map(nextAssets);
    pending.forEach(function (uuid) {
      var old = assets.get(uuid);
      if (old) {
        next.set(uuid, old);
      } else {
        next.delete(uuid);
      }
    });
    assets = next;

    return pending;
  }

  // ---------------------------------------------------------------------------
  // 骨骼动画资源组
  // ---------------------------------------------------------------------------

  function safeFspath (uuid) {
    try {
      var value = uuidToFspath(uuid);
      return typeof value === 'string' && value ? value : null;
    } catch (e) {
      return null;
    }
  }

  async function readImporterMeta (uuid) {
    var fspath = safeFspath(uuid);
    if (!fspath) {
      return null;
    }
    try {
      var text = await fsp.readFile(fspath + '.meta', 'utf8');
      var meta = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (!meta || typeof meta.importer !== 'string') {
        return null;
      }
      return meta;
    } catch (e) {
      return null;
    }
  }

  async function readAtlasTextureUuid (uuid) {
    var result = await readTextIfExists(importFileOf(uuid));
    if (!result.exists || !result.ok) {
      return null;
    }
    var data;
    try {
      data = JSON.parse(result.text.replace(/^\uFEFF/, ''));
    } catch (e) {
      return null;
    }
    var candidates = [data && data._texture, data && data.texture];
    for (var i = 0; i < candidates.length; i++) {
      var value = candidates[i];
      if (typeof value === 'string' && value) {
        return value.toLowerCase();
      }
      if (value && typeof value.__uuid__ === 'string' && value.__uuid__) {
        return value.__uuid__.toLowerCase();
      }
    }
    return null;
  }

  function escapeRegExp (value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function atlasNameMatches (atlasName, mainName) {
    var base = mainName.replace(/_ske$/, '');
    var targets = [base + '_texture', base + '_tex'];
    for (var i = 0; i < targets.length; i++) {
      if (atlasName === targets[i]) {
        return true;
      }
      if (new RegExp('^' + escapeRegExp(targets[i]) + '_\\d+$').test(atlasName)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 建立骨骼动画资源组：
   * - Spine：importer=spine 的主资源 + meta.textures 中的贴图 + 同目录同名 .atlas
   * - DragonBones：importer=dragonbones 的主资源 + dragonbones-atlas 图集 + 图集贴图
   * 组关系独立于引用查找页的反向引用图，仅用于未引用清理。
   */
  async function rebuildBoneGroups () {
    var t0 = Date.now();
    var groups = [];
    var pathByUuid = new Map();
    var uuidByPath = new Map();

    assets.forEach(function (triple, uuid) {
      var rel = String((triple && triple[2]) || '').replace(/\\/g, '/').toLowerCase();
      if (!rel) {
        return;
      }
      pathByUuid.set(uuid, rel);
      if (!uuidByPath.has(rel)) {
        uuidByPath.set(rel, uuid);
      }
    });

    var candidates = [];
    pathByUuid.forEach(function (rel, uuid) {
      if (/\.(json|skel|dbbin)$/.test(rel)) {
        candidates.push(uuid);
      }
    });

    var metaByUuid = new Map();
    await mapLimit(candidates, META_CONCURRENCY, async function (uuid) {
      var meta = await readImporterMeta(uuid);
      if (meta) {
        metaByUuid.set(uuid, meta);
      }
    });

    function addGroup (mainUuid, engine, list) {
      var seen = new Set();
      var members = [];
      list.forEach(function (item) {
        var uuid = typeof item === 'string' ? item.toLowerCase() : '';
        if (!uuid || seen.has(uuid)) {
          return;
        }
        seen.add(uuid);
        members.push(uuid);
      });
      if (members.length < 2 || !pathByUuid.has(mainUuid)) {
        return;
      }
      groups.push({ id: mainUuid, engine: engine, members: members });
    }

    // Spine
    metaByUuid.forEach(function (meta, uuid) {
      if (meta.importer !== 'spine') {
        return;
      }
      var rel = pathByUuid.get(uuid) || '';
      var base = rel.replace(/\.(json|skel)$/, '');
      var members = [uuid];
      if (Array.isArray(meta.textures)) {
        meta.textures.forEach(function (item) {
          if (typeof item === 'string' && item) {
            members.push(item);
          }
        });
      }
      var atlasUuid = uuidByPath.get(base + '.atlas');
      if (atlasUuid) {
        members.push(atlasUuid);
      }
      addGroup(uuid, 'spine', members);
    });

    // DragonBones
    var atlasUuids = [];
    var mainUuids = [];
    metaByUuid.forEach(function (meta, uuid) {
      if (meta.importer === 'dragonbones-atlas') {
        atlasUuids.push(uuid);
      } else if (meta.importer === 'dragonbones') {
        mainUuids.push(uuid);
      }
    });

    for (var m = 0; m < mainUuids.length; m++) {
      var mainUuid = mainUuids[m];
      var mainRel = pathByUuid.get(mainUuid) || '';
      var mainBase = mainRel.replace(/\.(json|dbbin)$/, '');
      var slash = mainBase.lastIndexOf('/');
      var dir = slash >= 0 ? mainBase.slice(0, slash + 1) : '';
      var mainName = mainBase.slice(dir.length);
      var members = [mainUuid];

      for (var a = 0; a < atlasUuids.length; a++) {
        var atlasUuid = atlasUuids[a];
        var atlasRel = pathByUuid.get(atlasUuid) || '';
        var atlasBase = atlasRel.replace(/\.(json|dbbin)$/, '');
        if (atlasBase.slice(0, dir.length) !== dir) {
          continue;
        }
        if (!atlasNameMatches(atlasBase.slice(dir.length), mainName)) {
          continue;
        }
        members.push(atlasUuid);

        var textureUuid = await readAtlasTextureUuid(atlasUuid);
        if (textureUuid) {
          members.push(textureUuid);
        }
        var pngUuid = uuidByPath.get(atlasBase + '.png');
        if (pngUuid) {
          members.push(pngUuid);
        }
      }
      addGroup(mainUuid, 'dragonbones', members);
    }

    boneGroups = groups;
    log('bone groups=' + groups.length + ' build=' + (Date.now() - t0) + 'ms');
  }

  /**
   * 自动图集保护范围：目录及子目录中存在 importer=texture 的资源时，
   * 视为该 .pac 有可打包内容并保护，避免误清理仍在使用的自动图集配置。
   */
  async function rebuildPacScopes () {
    var t0 = Date.now();
    var scopes = [];
    var pathByUuid = new Map();
    var pacs = [];

    assets.forEach(function (triple, uuid) {
      var rel = String((triple && triple[2]) || '').replace(/\\/g, '/').toLowerCase();
      if (!rel) {
        return;
      }
      pathByUuid.set(uuid, rel);
      if (/\.pac$/.test(rel)) {
        pacs.push({ uuid: uuid, rel: rel });
      }
    });

    if (pacs.length === 0) {
      pacScopes = [];
      return;
    }

    var textureCache = new Map();
    async function isTextureAsset (uuid) {
      if (textureCache.has(uuid)) {
        return textureCache.get(uuid);
      }
      // 读取失败时按“存在纹理”处理，优先保护自动图集配置
      var result = true;
      var fspath = safeFspath(uuid);
      if (fspath) {
        try {
          var text = await fsp.readFile(fspath + '.meta', 'utf8');
          var meta = JSON.parse(text.replace(/^\uFEFF/, ''));
          result = !!meta && meta.importer === 'texture';
        } catch (e) {
          result = true;
        }
      }
      textureCache.set(uuid, result);
      return result;
    }

    for (var i = 0; i < pacs.length; i++) {
      var pac = pacs[i];
      var slash = pac.rel.lastIndexOf('/');
      var dir = slash >= 0 ? pac.rel.slice(0, slash + 1) : '';
      var candidates = [];

      pathByUuid.forEach(function (rel, uuid) {
        if (uuid === pac.uuid || rel === pac.rel) {
          return;
        }
        if (dir) {
          if (rel.indexOf(dir) !== 0) {
            return;
          }
        }
        if (TEXTURE_EXT_RE.test(rel)) {
          candidates.push(uuid);
        }
      });

      var hasTexture = false;
      for (var k = 0; k < candidates.length; k++) {
        if (await isTextureAsset(candidates[k])) {
          hasTexture = true;
          break;
        }
      }
      scopes.push({ uuid: pac.uuid, dir: dir, hasTexture: hasTexture });
    }

    pacScopes = scopes;
    var protectedCount = 0;
    scopes.forEach(function (scope) {
      if (scope.hasTexture) {
        protectedCount++;
      }
    });
    log('auto atlas scopes=' + scopes.length + ' protected=' + protectedCount + ' build=' + (Date.now() - t0) + 'ms');
  }

  async function ensureFresh () {
    var t0 = Date.now();
    if (disposed) {
      return { ok: false, changed: 0, removed: 0, tookMs: 0 };
    }
    await ensureReady();
    if (state !== 'ready') {
      return { ok: false, changed: 0, removed: 0, tookMs: Date.now() - t0 };
    }

    var stamp = stampNow();
    if (!stamp) {
      return { ok: false, changed: 0, removed: 0, tookMs: Date.now() - t0 };
    }
    if (libraryStamp &&
        stamp.mtimeMs === libraryStamp.mtimeMs &&
        stamp.size === libraryStamp.size) {
      return { ok: true, changed: 0, removed: 0, tookMs: Date.now() - t0 };
    }

    var snapshot;
    try {
      snapshot = JSON.parse(await fsp.readFile(mtimePath, 'utf8'));
      mtimeFailures = 0;
    } catch (e) {
      mtimeFailures++;
      log('uuid-to-mtime parse failed (' + mtimeFailures + '): ' + (e && e.message));
      if (mtimeFailures >= 3 && Date.now() - lastFullBuildAt > 30000) {
        await buildFull();
      }
      return { ok: false, changed: 0, removed: 0, tookMs: Date.now() - t0 };
    }

    var nextAssets = new Map();
    Object.keys(snapshot).forEach(function (uuid) {
      var item = snapshot[uuid] || {};
      nextAssets.set(uuid.toLowerCase(), [item.asset, item.meta, String(item.relativePath || '')]);
    });

    var added = [];
    var changed = [];
    var removed = [];

    nextAssets.forEach(function (triple, uuid) {
      var prev = assets.get(uuid);
      if (!prev) {
        added.push(uuid);
      } else if (prev[0] !== triple[0] || prev[1] !== triple[1] || prev[2] !== triple[2]) {
        changed.push(uuid);
      }
    });
    assets.forEach(function (triple, uuid) {
      if (!nextAssets.has(uuid)) {
        removed.push(uuid);
      }
    });

    var deltaCount = added.length + changed.length + removed.length;
    if (deltaCount > FULL_REBUILD_THRESHOLD) {
      log('delta too large (' + deltaCount + '), rebuild instead');
      await buildFull();
      return { ok: true, changed: deltaCount, removed: 0, tookMs: Date.now() - t0, full: true };
    }

    await applyDelta(added, changed, removed, nextAssets);
    rebuildReverse();
    if (deltaCount > 0) {
      await rebuildBoneGroups();
      await rebuildPacScopes();
    }
    libraryStamp = { mtimeMs: stamp.mtimeMs, size: stamp.size };
    if (deltaCount > 0) {
      scheduleSave();
    }

    return {
      ok: true,
      changed: changed.length + added.length,
      removed: removed.length,
      tookMs: Date.now() - t0,
    };
  }

  // ---------------------------------------------------------------------------
  // 查询
  // ---------------------------------------------------------------------------

  function safeUrl (uuid) {
    try {
      var url = uuidToUrl(uuid);
      return typeof url === 'string' && url ? url : null;
    } catch (e) {
      return null;
    }
  }

  function baseName (url) {
    if (!url) {
      return '';
    }
    var parts = url.split('/');
    return parts[parts.length - 1] || url;
  }

  function typeOf (url) {
    if (!url) {
      return '';
    }
    var parts = url.split('/');
    for (var i = parts.length - 1; i >= 0; i--) {
      var dot = parts[i].lastIndexOf('.');
      if (dot > 0 && dot < parts[i].length - 1) {
        return parts[i].slice(dot + 1).toLowerCase();
      }
    }
    return 'folder';
  }

  function describe (uuid) {
    var url = safeUrl(uuid);
    return {
      uuid: uuid,
      url: url,
      name: url ? baseName(url) : uuid,
      type: url ? typeOf(url) : '',
    };
  }

  // ---------------------------------------------------------------------------
  // 未引用资源
  // ---------------------------------------------------------------------------

  function normalizeExt (value) {
    var ext = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    if (!ext || ext === '.meta') {
      return '';
    }
    if (ext.charAt(0) !== '.') {
      ext = '.' + ext;
    }
    return ext;
  }

  function normalizeDir (value) {
    var dir = String(value === undefined || value === null ? '' : value).trim().replace(/\\/g, '/');
    if (!dir) {
      return '';
    }
    dir = dir.replace(/^\.\/+/, '');
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
  }

  function withinDir (relPosix, dir) {
    var target = String(dir || '').toLowerCase();
    if (!target) {
      return true;
    }
    var path = relPosix.toLowerCase();
    return path === target || path.indexOf(target + '/') === 0;
  }

  function isReferenced (uuid) {
    var targetUrl = safeUrl(uuid);
    var family = getFamily(uuid);
    var familySet = new Set(family);
    var referenced = false;
    for (var i = 0; i < family.length && !referenced; i++) {
      var map = reverse.get(family[i]);
      if (!map) {
        continue;
      }
      map.forEach(function (count, referrer) {
        if (referenced) {
          return;
        }
        var referrerUrl = safeUrl(referrer);
        if (!isExcludedReferrer(targetUrl, referrer, referrerUrl, familySet)) {
          referenced = true;
        }
      });
    }
    return referenced;
  }

  /**
   * 骨骼动画组级引用判定：组内任一成员被组外资源引用即整组已引用。
   * @param {string[]} memberUuids
   * @returns {boolean}
   */
  function isGroupReferenced (memberUuids) {
    var groupSet = new Set(memberUuids);
    for (var m = 0; m < memberUuids.length; m++) {
      var uuid = memberUuids[m];
      var targetUrl = safeUrl(uuid);
      var family = getFamily(uuid);
      var familySet = new Set(family);
      groupSet.forEach(function (item) {
        if (!familySet.has(item)) {
          familySet.add(item);
        }
      });

      for (var i = 0; i < family.length; i++) {
        var map = reverse.get(family[i]);
        if (!map) {
          continue;
        }
        var hit = false;
        map.forEach(function (count, referrer) {
          if (hit || groupSet.has(referrer)) {
            return;
          }
          var referrerUrl = safeUrl(referrer);
          if (!isExcludedReferrer(targetUrl, referrer, referrerUrl, familySet)) {
            hit = true;
          }
        });
        if (hit) {
          return true;
        }
      }
    }
    return false;
  }

  function buildBoneGroupResult (group) {
    var members = [];
    group.members.forEach(function (uuid) {
      var triple = assets.get(uuid);
      var url = safeUrl(uuid);
      if (!triple && !url) {
        return;
      }
      var rel = triple ? String(triple[2] || '').replace(/\\/g, '/') : '';
      var ext = rel ? nodePath.extname(rel).toLowerCase() : (url ? nodePath.extname(url).toLowerCase() : '');
      members.push({
        uuid: uuid,
        url: url || '',
        relativePath: rel,
        name: url ? baseName(url) : uuid,
        ext: ext,
        type: url ? typeOf(url) : '',
      });
    });
    members.sort(function (a, b) {
      return a.relativePath.localeCompare(b.relativePath);
    });

    var main = describe(group.id);
    main.relativePath = '';
    for (var i = 0; i < members.length; i++) {
      if (members[i].uuid === group.id) {
        main.relativePath = members[i].relativePath;
        break;
      }
    }

    return {
      id: group.id,
      engine: group.engine,
      main: main,
      total: members.length,
      members: members,
    };
  }

  async function findResourceRefs (options) {
    var t0 = Date.now();
    await ensureReady();
    try {
      await ensureFresh();
    } catch (e) {
      log('ensureFresh failed: ' + (e && e.message));
    }

    var opts = options || {};
    var extSet = new Set();
    if (Array.isArray(opts.types)) {
      opts.types.forEach(function (item) {
        var ext = normalizeExt(item);
        if (ext) {
          extSet.add(ext);
        }
      });
    }
    if (extSet.size === 0) {
      return { ok: false, error: 'NO_TYPES' };
    }

    var groups = [];
    var skipped = { internal: 0, scope: 0, type: 0, unreferenced: 0 };
    var scanned = 0;

    assets.forEach(function (triple, uuid) {
      var rel = String(triple[2] || '');
      if (!rel) {
        return;
      }
      var relPosix = rel.replace(/\\/g, '/');
      var ext = nodePath.extname(relPosix).toLowerCase();
      if (!ext || ext === '.meta') {
        return;
      }
      scanned++;

      var url = safeUrl(uuid);
      if (!url || url.indexOf('db://assets/') !== 0) {
        skipped.internal++;
        return;
      }
      if (!withinDir(relPosix, 'resources')) {
        skipped.scope++;
        return;
      }
      if (!extSet.has(ext)) {
        skipped.type++;
        return;
      }

      var referrers = referrersOf(uuid);
      if (referrers.length === 0) {
        skipped.unreferenced++;
        return;
      }

      groups.push({
        target: describe(uuid),
        total: referrers.length,
        referrers: referrers,
      });
    });

    groups.sort(function (a, b) {
      return String(a.target.url || '').localeCompare(String(b.target.url || ''));
    });

    return {
      ok: true,
      tookMs: Date.now() - t0,
      index: getStats(),
      scanned: scanned,
      groups: groups,
      skipped: skipped,
    };
  }

  /**
   * 未引用扫描专用：判断 png 是否存在同目录同名的图集 / 骨骼容器文件。
   * 与“资源引用查找”“resources 引用资源查询”的排除规则相互独立，
   * 仅用于避免把图集、Spine、DragonBones 内部的贴图列为可清理资源。
   * @param {string} relPosix 相对 assets 的路径
   * @param {Set<string>} pathSet 全部资源相对路径（小写）
   * @returns {boolean}
   */
  function pngHasContainer (relPosix, pathSet) {
    if (!/\.png$/i.test(relPosix)) {
      return false;
    }
    var lower = relPosix.toLowerCase();
    var base = lower.slice(0, -4);

    // 同目录同名 .plist 图集
    if (pathSet.has(base + '.plist')) {
      return true;
    }
    // Spine：.skel / .atlas；DragonBones：.json / .dbbin
    if (pathSet.has(base + '.skel') || pathSet.has(base + '.atlas')) {
      return true;
    }
    if (pathSet.has(base + '.json') || pathSet.has(base + '.dbbin')) {
      return true;
    }

    // DragonBones 常见导出命名：xxx_tex.png ↔ xxx_ske.json / xxx_ske.dbbin
    var slash = base.lastIndexOf('/');
    var dir = slash >= 0 ? base.slice(0, slash + 1) : '';
    var fileName = base.slice(dir.length);
    if (fileName.length > 4 && fileName.slice(-4) === '_tex') {
      var prefix = dir + fileName.slice(0, -4);
      if (pathSet.has(prefix + '_ske.json') || pathSet.has(prefix + '_ske.dbbin')) {
        return true;
      }
    }
    return false;
  }

  async function findUnused (options) {
    var t0 = Date.now();
    await ensureReady();
    try {
      await ensureFresh();
    } catch (e) {
      log('ensureFresh failed: ' + (e && e.message));
    }

    var opts = options || {};
    var mode = opts.mode === 'specify' ? 'specify' : 'ignore';
    var ignoreDirs = [];
    var specifyDir = '';

    if (mode === 'ignore') {
      var rawDirs = Array.isArray(opts.ignoreDirs) ? opts.ignoreDirs : [];
      rawDirs.forEach(function (item) {
        var dir = normalizeDir(item);
        if (dir) {
          ignoreDirs.push(dir);
        }
      });
    } else {
      specifyDir = normalizeDir(opts.specifyDir || '');
    }

    var extSet = new Set();
    var hasTypeFilter = Array.isArray(opts.types);
    if (hasTypeFilter) {
      opts.types.forEach(function (item) {
        var ext = normalizeExt(item);
        if (ext) {
          extSet.add(ext);
        }
      });
      if (extSet.size === 0) {
        return { ok: false, error: 'NO_TYPES' };
      }
    }

    var items = [];
    var skipped = { internal: 0, scope: 0, type: 0, referenced: 0 };
    var scanned = 0;

    // 预先收集全部资源相对路径，用于判断 png 是否属于同目录同名的图集/骨骼容器
    var assetPaths = new Set();
    assets.forEach(function (triple) {
      var rel = String((triple && triple[2]) || '').replace(/\\/g, '/').toLowerCase();
      if (rel && !/\.meta$/.test(rel)) {
        assetPaths.add(rel);
      }
    });

    // 骨骼动画按组判定：组内任一成员被外部引用则整组受保护
    var groupStates = [];
    var memberGroupMap = new Map();
    boneGroups.forEach(function (group) {
      var groupState = {
        group: group,
        referenced: isGroupReferenced(group.members),
        triggered: false,
      };
      groupStates.push(groupState);
      group.members.forEach(function (memberUuid) {
        var list = memberGroupMap.get(memberUuid);
        if (!list) {
          list = [];
          memberGroupMap.set(memberUuid, list);
        }
        list.push(groupState);
      });
    });
    var boneResults = [];

    // 自动图集：目录及子目录存在 importer=texture 的资源时视为已引用
    var pacProtectMap = new Map();
    pacScopes.forEach(function (scope) {
      pacProtectMap.set(scope.uuid, scope.hasTexture);
    });
    var pacDirCache = new Map();
    function pacDirHasTexture (relPosix) {
      var slash = relPosix.lastIndexOf('/');
      var dir = slash >= 0 ? relPosix.slice(0, slash + 1).toLowerCase() : '';
      if (pacDirCache.has(dir)) {
        return pacDirCache.get(dir);
      }
      var found = false;
      assetPaths.forEach(function (rel) {
        if (found || !TEXTURE_EXT_RE.test(rel)) {
          return;
        }
        if (dir) {
          if (rel.indexOf(dir) === 0) {
            found = true;
          }
        } else {
          found = true;
        }
      });
      pacDirCache.set(dir, found);
      return found;
    }

    assets.forEach(function (triple, uuid) {
      var rel = String(triple[2] || '');
      if (!rel) {
        return;
      }
      var relPosix = rel.replace(/\\/g, '/');
      var ext = nodePath.extname(relPosix).toLowerCase();
      if (!ext || ext === '.meta') {
        return;
      }
      scanned++;

      // uuid-to-mtime 同时包含 db://internal 内置资源，禁止纳入清理候选
      var url = safeUrl(uuid);
      if (!url || url.indexOf('db://assets/') !== 0) {
        skipped.internal++;
        return;
      }

      if (mode === 'ignore') {
        var ignored = false;
        for (var i = 0; i < ignoreDirs.length; i++) {
          if (withinDir(relPosix, ignoreDirs[i])) {
            ignored = true;
            break;
          }
        }
        if (ignored) {
          skipped.scope++;
          return;
        }
      } else if (specifyDir && !withinDir(relPosix, specifyDir)) {
        skipped.scope++;
        return;
      }

      if (extSet.size && !extSet.has(ext)) {
        skipped.type++;
        return;
      }

      // 自动图集 .pac：目录（含子目录）有 importer=texture 的资源时整项保护
      if (ext === '.pac') {
        var pacProtected = pacProtectMap.has(uuid)
          ? pacProtectMap.get(uuid)
          : pacDirHasTexture(relPosix);
        if (pacProtected) {
          skipped.referenced++;
          return;
        }
      }

      // 骨骼动画组：任一成员被组外资源引用 -> 整组不列入；否则整组作为一个条目输出
      var states = memberGroupMap.get(uuid);
      if (states) {
        var protectedGroup = false;
        for (var g = 0; g < states.length; g++) {
          if (states[g].referenced) {
            protectedGroup = true;
            break;
          }
        }
        if (protectedGroup) {
          skipped.referenced++;
          return;
        }
        for (var k = 0; k < states.length; k++) {
          if (!states[k].triggered) {
            states[k].triggered = true;
            var groupResult = buildBoneGroupResult(states[k].group);
            if (groupResult.total > 0) {
              boneResults.push(groupResult);
            }
          }
        }
        return;
      }

      // 被同目录同名 .plist 图集、Spine、DragonBones 容器包含的 png 贴图，
      // 不单独列为未引用资源（与引用查找页的排除规则相互独立）
      if (pngHasContainer(relPosix, assetPaths)) {
        skipped.referenced++;
        return;
      }

      if (isReferenced(uuid)) {
        skipped.referenced++;
        return;
      }

      items.push({
        uuid: uuid,
        url: url,
        relativePath: relPosix,
        name: baseName(url),
        ext: ext,
      });
    });

    items.sort(function (a, b) {
      return a.relativePath.localeCompare(b.relativePath);
    });

    boneResults.sort(function (a, b) {
      return String(a.main.relativePath || a.main.url || '')
        .localeCompare(String(b.main.relativePath || b.main.url || ''));
    });

    return {
      ok: true,
      tookMs: Date.now() - t0,
      index: getStats(),
      scanned: scanned,
      items: items,
      groups: boneResults,
      skipped: skipped,
      scope: {
        mode: mode,
        dirs: mode === 'ignore' ? ignoreDirs : [specifyDir],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // 节点级引用（点击"引用节点"时按需解析，不参与索引）
  // ---------------------------------------------------------------------------

  function getFamily (uuid) {
    var family = [uuid];
    var subs = [];
    try {
      subs = subAssetUuids(uuid) || [];
    } catch (e) {
      subs = [];
    }
    for (var i = 0; i < subs.length; i++) {
      var item = subs[i];
      var subUuid = typeof item === 'string' ? item : (item && item.uuid);
      if (subUuid) {
        subUuid = subUuid.toLowerCase();
        if (subUuid !== uuid && family.indexOf(subUuid) === -1) {
          family.push(subUuid);
        }
      }
    }
    return family;
  }

  function nodePathOf (index, data) {
    var names = [];
    var current = index;
    var guard = 0;
    while (current !== null && current !== undefined && guard++ < 64) {
      var node = data[current];
      if (!node || typeof node !== 'object') {
        break;
      }
      names.push(node._name || '(未命名节点)');
      var parent = node._parent;
      current = (parent && typeof parent.__id__ === 'number') ? parent.__id__ : null;
    }
    return names.reverse().join('/');
  }

  function nodeIndexPathOf (index, data) {
    var path = [];
    var current = index;
    var guard = 0;
    while (guard++ < 64) {
      var node = data[current];
      if (!node || typeof node !== 'object') {
        break;
      }
      var parent = node._parent;
      if (!parent || typeof parent.__id__ !== 'number') {
        break;
      }
      var parentNode = data[parent.__id__];
      var childIndex = -1;
      if (parentNode && Array.isArray(parentNode._children)) {
        for (var i = 0; i < parentNode._children.length; i++) {
          var child = parentNode._children[i];
          if (child && child.__id__ === current) {
            childIndex = i;
            break;
          }
        }
      }
      if (childIndex < 0) {
        break;
      }
      path.unshift(childIndex);
      current = parent.__id__;
    }
    return path;
  }

  function collectValueRefs (value, targetSet, path, out, depth) {
    if (depth > 8 || value === null || value === undefined) {
      return;
    }
    if (typeof value === 'string') {
      if (targetSet.has(value.toLowerCase())) {
        out.push(path);
      }
      return;
    }
    if (typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        collectValueRefs(value[i], targetSet, path + '[' + i + ']', out, depth + 1);
      }
      return;
    }
    if (typeof value.__uuid__ === 'string') {
      if (targetSet.has(value.__uuid__.toLowerCase())) {
        out.push(path);
      }
      return;
    }
    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        continue;
      }
      if (key === '__id__' || key === '__type__') {
        continue;
      }
      var next = path ? (path + '.' + key) : key;
      collectValueRefs(value[key], targetSet, next, out, depth + 1);
    }
  }

  function componentLabel (type, isNode) {
    if (isNode) {
      return 'Node';
    }
    if (!type || typeof type !== 'string') {
      return 'Object';
    }
    if (type.length === 22 || type.length === 23) {
      return '自定义组件';
    }
    if (type.indexOf('cc.') === 0) {
      return type.slice(3);
    }
    return type;
  }

  function collectNodeRefs (data, targetSet) {
    var componentNode = new Map();
    var i;
    for (i = 0; i < data.length; i++) {
      var entry = data[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      if (entry.__type__ !== 'cc.PrefabInfo' &&
          entry.node && typeof entry.node === 'object' &&
          typeof entry.node.__id__ === 'number') {
        componentNode.set(i, entry.node.__id__);
      }
    }

    var results = new Map();
    for (i = 0; i < data.length; i++) {
      var obj = data[i];
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        continue;
      }

      var paths = [];

      // 组件本身引用了目标脚本（__type__ 就是脚本的压缩 UUID）
      var typeId = obj.__type__;
      if (typeof typeId === 'string' && (typeId.length === 22 || typeId.length === 23)) {
        var decodedType = decompressUuid(typeId);
        if (decodedType && targetSet.has(decodedType)) {
          paths.push('');
        }
      }

      for (var key in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) {
          continue;
        }
        if (key === '__id__' || key === '__type__' || key === 'node' || key === '_prefab' ||
            key === '_name' || key === '_parent' || key === '_components' || key === '_children') {
          continue;
        }
        collectValueRefs(obj[key], targetSet, key, paths, 0);
      }
      if (paths.length === 0) {
        continue;
      }

      var isNode = obj.__type__ === 'cc.Node';
      var nodeIndex = componentNode.has(i) ? componentNode.get(i) : (isNode ? i : -1);
      var nodePath = nodeIndex >= 0 ? nodePathOf(nodeIndex, data) : '';
      var nodeId = '';
      var nodeIndexPath = [];
      if (nodeIndex >= 0 && data[nodeIndex]) {
        nodeId = typeof data[nodeIndex]._id === 'string' ? data[nodeIndex]._id : '';
        nodeIndexPath = nodeIndexPathOf(nodeIndex, data);
      }
      var component = componentLabel(obj.__type__, isNode);
      var seen = new Set(paths);

      seen.forEach(function (property) {
        var dedupeKey = nodePath + '|' + component + '|' + property;
        var existing = results.get(dedupeKey);
        if (existing) {
          existing.count++;
        } else {
          results.set(dedupeKey, {
            nodePath: nodePath,
            nodeId: nodeId,
            nodeIndexPath: nodeIndexPath,
            component: component,
            property: property,
            count: 1,
          });
        }
      });
    }

    return Array.from(results.values()).sort(function (a, b) {
      if (a.nodePath !== b.nodePath) {
        return a.nodePath.localeCompare(b.nodePath);
      }
      if (a.component !== b.component) {
        return a.component.localeCompare(b.component);
      }
      return a.property.localeCompare(b.property);
    });
  }

  async function queryNodeRefs (referrerUuid, targetUuid) {
    var t0 = Date.now();
    if (!referrerUuid || !targetUuid) {
      return { ok: false, error: 'INVALID_PARAMS' };
    }
    await ensureReady();

    var targetSet = new Set(getFamily(String(targetUuid).toLowerCase()));
    var result = await readTextIfExists(importFileOf(String(referrerUuid).toLowerCase()));
    if (!result.exists) {
      return { ok: false, error: 'FILE_NOT_FOUND' };
    }
    if (!result.ok) {
      return { ok: false, error: 'READ_FAILED' };
    }

    var data;
    try {
      data = JSON.parse(result.text.replace(/^\uFEFF/, ''));
    } catch (e) {
      return { ok: false, error: 'PARSE_FAILED' };
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      data = [data];
    }

    var nodes = Array.isArray(data) ? collectNodeRefs(data, targetSet) : [];
    return {
      ok: true,
      tookMs: Date.now() - t0,
      total: nodes.length,
      nodes: nodes,
    };
  }

  function isPlistAtlasRef (targetUrl, referrerUrl) {
    if (!targetUrl || !referrerUrl || !/\.png$/i.test(targetUrl)) {
      return false;
    }
    var targetBase = targetUrl.slice(0, -4).toLowerCase();
    var ref = referrerUrl.toLowerCase();
    return ref === targetBase + '.plist' || ref.indexOf(targetBase + '.plist/') === 0;
  }

  function isSkeletonRef (targetUrl, referrerUrl) {
    if (!targetUrl || !referrerUrl || !/\.png$/i.test(targetUrl)) {
      return false;
    }
    var targetBase = targetUrl.slice(0, -4).toLowerCase();
    var ref = referrerUrl.toLowerCase();

    // Spine：同目录同名 .skel 骨骼动画
    if (ref === targetBase + '.skel' || ref.indexOf(targetBase + '.skel/') === 0) {
      return true;
    }

    // DragonBones：同目录同名 .json / .dbbin 骨骼或图集数据
    if (ref === targetBase + '.json' || ref.indexOf(targetBase + '.json/') === 0) {
      return true;
    }
    if (ref === targetBase + '.dbbin' || ref.indexOf(targetBase + '.dbbin/') === 0) {
      return true;
    }

    // DragonBones 常见导出命名：xxx_tex.png 对应 xxx_ske.json
    var slash = targetBase.lastIndexOf('/');
    var dir = slash >= 0 ? targetBase.slice(0, slash + 1) : '';
    var fileName = targetBase.slice(dir.length);
    if (fileName.length > 4 && fileName.slice(-4) === '_tex') {
      var prefix = dir + fileName.slice(0, -4);
      if (ref === prefix + '_ske.json' || ref.indexOf(prefix + '_ske.json/') === 0) {
        return true;
      }
    }
    return false;
  }

  function isExcludedReferrer (targetUrl, referrer, referrerUrl, familySet) {
    if (familySet.has(referrer)) {
      return true;
    }
    if (!referrerUrl) {
      return true;
    }
    // 目标为引用资源的子资源（如图集 .plist 内的 png/spriteFrame）
    if (targetUrl && targetUrl.indexOf(referrerUrl + '/') === 0) {
      return true;
    }
    // 同目录同名 .plist 图集内的帧资源，不计为 png 的引用
    if (isPlistAtlasRef(targetUrl, referrerUrl)) {
      return true;
    }
    // 同目录同名骨骼动画（.skel / DragonBones）不计为 png 的引用
    return isSkeletonRef(targetUrl, referrerUrl);
  }

  function referrersOf (uuid) {
    var targetUrl = safeUrl(uuid);
    var family = getFamily(uuid);
    var familySet = new Set(family);
    var refCounts = new Map();
    for (var f = 0; f < family.length; f++) {
      var map = reverse.get(family[f]);
      if (!map) {
        continue;
      }
      map.forEach(function (count, referrer) {
        var referrerUrl = safeUrl(referrer);
        if (isExcludedReferrer(targetUrl, referrer, referrerUrl, familySet)) {
          return;
        }
        refCounts.set(referrer, (refCounts.get(referrer) || 0) + count);
      });
    }

    var referrers = [];
    refCounts.forEach(function (count, referrer) {
      var url = safeUrl(referrer);
      if (!url) {
        return;
      }
      referrers.push({
        uuid: referrer,
        url: url,
        name: baseName(url),
        type: typeOf(url),
        count: count,
      });
    });
    referrers.sort(function (a, b) {
      return a.url.localeCompare(b.url);
    });
    return referrers;
  }

  async function query (uuids) {
    var t0 = Date.now();
    if (!Array.isArray(uuids)) {
      uuids = [];
    }

    await ensureReady();
    try {
      await ensureFresh();
    } catch (e) {
      log('ensureFresh failed: ' + (e && e.message));
    }

    var groups = [];
    for (var i = 0; i < uuids.length; i++) {
      var raw = uuids[i];
      if (typeof raw !== 'string' || !raw) {
        continue;
      }
      var uuid = raw.toLowerCase();
      var referrers = referrersOf(uuid);

      groups.push({
        target: describe(uuid),
        total: referrers.length,
        referrers: referrers,
      });
    }

    return {
      ok: true,
      tookMs: Date.now() - t0,
      index: getStats(),
      groups: groups,
    };
  }

  function getStats () {
    return {
      state: state,
      assets: assets.size,
      edges: edgeCount(),
      buildMs: buildMs,
      cacheHit: cacheHit,
      error: lastError,
    };
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  async function init () {
    if (!projectPath) {
      state = 'error';
      lastError = 'project path is empty';
      return getStats();
    }
    if (!loadCache()) {
      state = 'idle';
      startBuild();
    }
    return getStats();
  }

  async function forceRebuild () {
    await ensureReady();
    buildMs = 0;
    cacheHit = false;
    await buildFull();
    return getStats();
  }

  function dispose () {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    disposed = true;
    if (state === 'ready') {
      saveNow();
    }
  }

  return {
    init: init,
    ensureReady: ensureReady,
    ensureFresh: ensureFresh,
    query: query,
    queryNodeRefs: queryNodeRefs,
    findUnused: findUnused,
    findResourceRefs: findResourceRefs,
    forceRebuild: forceRebuild,
    getStats: getStats,
    saveNow: saveNow,
    dispose: dispose,
    getState: function () { return state; },
  };
}

module.exports = {
  createIndexer: createIndexer,
};
