/**
 * Scene Loader for Planner5d Scene files
 */

'use strict';

var ArchCreator = require('geo/ArchCreator');
var AssetGroups = require('assets/AssetGroups');
var SceneState = require('scene/SceneState');
var SceneLoader = require('scene/SceneLoader');
var Object3DUtil = require('geo/Object3DUtil');
var P5DTextureLoader = require('loaders/P5DTextureLoader');
var d3queue = require('d3-queue');
var _ = require('util/util');

function getHasCategoryInFilter(targetCategories) {
  return function(modelInfo) {
    var match = false;
    if (modelInfo && modelInfo.category) {
      var categories = modelInfo.category;
      for (var i = 0; i < categories.length; i++) {
        if (targetCategories.indexOf(categories[i]) >= 0) {
          match = true;
          break;
        }
      }
    }
    return match;
  };
}

SUNCGLoader.ArchCategories = ['door', 'arch', 'garage_door', 'window', 'stairs', 'column', 'partition', 'roof'];
SUNCGLoader.PortalCategories = ['door', 'arch', 'garage_door', 'window'];

// Loader for SUNCG JSON format scenes
function SUNCGLoader(params) {
  SceneLoader.call(this, params);
  this.defaultSource = 'p5d';
  this.includeCeiling = (params.includeCeiling != undefined)? params.includeCeiling : true;
  this.includeWalls = (params.includeWalls != undefined)? params.includeWalls : true;
  this.includeFloor = (params.includeFloor != undefined)? params.includeFloor : true;
  this.attachWallsToRooms = params.attachWallsToRooms;
  this.archOnly = params.archOnly;  // Only load architecture elements (no objects)
  this.useVariants = params.useVariants;
  this.keepInvalid = params.keepInvalid; // Retain invalid objects
  this.keepParse = params.keepParse; // Retain intermediate parse
  this.keepMaterialInfo = params.keepMaterialInfo;
  this.useArchModelId = params.useArchModelId; // Use model id for room and ground instead of json id
  this.ignoreOriginalArchHoles = params.ignoreOriginalArchHoles; // Whether to ignore precomputed architectural holes

  this.skipElements = params.skipElements;  // Set to ['Object'] to only load architecture elements (no Object)
                                            // Set to ['Object', 'Box'] to skip Object and Box
  this.loadModelsFilter = params.loadModelsFilter; // Only load models matching filter (default: null to load all)
  this.replaceModels = params.replaceModels; // Replace models
  this.verbose = params.verbose;  // verbose logging
  if (params.emptyRoom) {
    this.loadModelsFilter = getHasCategoryInFilter(SUNCGLoader.PortalCategories);
    this.skipElements = ['Box'];
  } else if (params.archOnly) {
    this.loadModelsFilter = getHasCategoryInFilter(SUNCGLoader.ArchCategories);
  } else if (params.loadModelsFilter && params.loadModelsFilter.categories) {
    this.loadModelsFilter = getHasCategoryInFilter(params.categories);
  }

  this.__scenesAssetGroup =  AssetGroups.getAssetGroup('p5dScene');
  this.__modelsAssetGroup =  AssetGroups.getAssetGroup('p5d');

  if (params.createArch) {
    // Create architecture
    this.archCreator = new ArchCreator({
      up: new THREE.Vector3(0,1,0),
      front: new THREE.Vector3(0,0,1),
      unit: 1,
      defaults: {
        'Wall': {
          depth: 0.1,
          height: 2.7,
          extraHeight: 0.035,
          materials: [
            {
              "name": "inside",                          // Name of material ("inside" for inside wall)
              "texture": "wallp_1_1",                    // Texture
              "diffuse": "#ffffff"                       // Diffuse color in hex
            },
            {
              "name": "outside",                         // Name of material ("outside" for outside wall)
//              "texture": "bricks_1",                     // Texture
              "texture": "wallp_1_1",                    // Texture
              "diffuse": "#ffffff"                       // Diffuse color in hex
            }
          ]
        },
        'Ceiling': {
          depth: 0.05,
          offset: 0.04,    // Bit offset above wall extraHeight
          materials: [
            {
              "name": "surface",
              "texture": 'laminate_1_2',
              "diffuse": '#ffffff'

            }
          ]
        },
        'Floor': {
          depth: 0.05,
          materials: [
            {
              "name": "surface",
              "texture": 'linen_1_4',
              "diffuse": '#ffffff'

            }
          ]
        },
        'Ground': {
          depth: 0.08,
          materials: [
            {
              "name": "surface",
              "texture": 'ground_1',
              "diffuse": '#ffffff'

            }
          ]
        }
      }
    });
  }
}

SUNCGLoader.prototype = Object.create(SceneLoader.prototype);
SUNCGLoader.prototype.constructor = SUNCGLoader;

SUNCGLoader.textureRepeat = new THREE.Vector2(1, 1);

SUNCGLoader.prototype.__createArch = function(archData, json, context) {
  var scope = this;
  var archIds;
  //console.log('useArchModelId', scope.useArchModelId);
  if (scope.useArchModelId) {
    var archMappings = {};
    var archRegex = /[a-zA-Z]+_(\d+)[a-zA-Z]+_(\d+)/;
    var rooms = _.flatten(_.map(json.levels, function (level) {
        return _.filter(level.nodes, function (x) {
          return x.type === 'Room' || x.type === 'Ground';
        });
      }
    ));
    _.each(rooms, function (arch) {
      var archId = arch.id;
      if (arch.modelId) {
        // Get archId from modelId
        var match = arch.modelId.match(archRegex);
        if (match) {
          archId = match[1] + '_' + match[2];
        }
      }
      archMappings[arch.id] = archId;
    });
    context.archMappings = archMappings;
    //console.log('create archMappings', rooms, archMappings);
    archIds = _.values(archMappings);
  }

  context.arch = this.archCreator.createArch(archData, {
    filterElements: function (element) {
      var include = true;
      if (!scope.includeCeiling) {
        include = include && (element.type !== 'Ceiling');
      }
      if (!scope.includeFloor) {
        include = include && (element.type !== 'Floor');
      }
      if (!scope.includeWalls) {
        include = include && (element.type !== 'Wall');
      }
      if (!include) {
        return false;
      }
      if (scope.room != undefined && scope.level != undefined) {
        return element.roomId === (scope.level + '_' + scope.room);
      } else if (scope.level != undefined) {
        return element.roomId && element.roomId.startsWith(scope.level + '_');
      } else if (archIds) {
        return archIds.indexOf(element.roomId) >= 0 || archIds.indexOf(element.id) >= 0;
      } else {
        return true;
      }
    },
    getMaterials: function (w) {
      return scope.__getMaterials(w);
    },
    groupWalls: false
  });
};

// Extra functions for making new holes
SUNCGLoader.prototype.__associateArchWithNewHoles = function(arch, objects) {
  // console.log('objects', objects);
  function isHoleFilter(x) {
    return x.object3D && (x.json.type === 'Object' && (x.modelInstance.model.isDoor() || x.modelInstance.model.isWindow()));
  }

  // helper to get hole BBox and flip y-z
  var left = this.archCreator.left;
  function getBBox(hole) {
    var bbox = Object3DUtil.computeBoundingBox(hole.object3D).clone();
    // Shrink bbox along length, expand along perpendicular
    var widthDir = left.clone().applyQuaternion(hole.object3D.getWorldQuaternion());
    var x = Math.abs(widthDir.x);
    var z = Math.abs(widthDir.z);
    var bboxDelta = new THREE.Vector3(-0.05*x + 0.05*z, -0.02, -0.05*z + 0.05*x);
    //console.log('bbox hole: ' + bbox.toString(), hole);
    //console.log('adjusting bbox hole', widthDir, bboxDelta);
    bbox = bbox.expandBy(bboxDelta);  // TODO(MS): Hack! - slightly contract hole bboxen to avoid over-merging and over-cutting
    var miny = bbox.min.y;
    var maxy = bbox.max.y;
    bbox.min.y = bbox.min.z;
    bbox.max.y = bbox.max.z;
    bbox.min.z = miny;
    bbox.max.z = maxy;
    return bbox;
  }

  // TODO: Check this logic!!!
  var holes = objects.filter(isHoleFilter);
  var walls = arch.elements.filter(function(element) { return element.type === 'Wall'; });
  _.each(walls, function(wall) { wall.holes = []; });
  this.archCreator.associateWallsWithHoles(walls, holes, getBBox, function(wall) {
    return [ new THREE.Vector2(wall.points[0][0], wall.points[0][2]), new THREE.Vector2(wall.points[1][0], wall.points[1][2]) ];
  }, 0.25);
  //console.log('walls',walls);
};

// Extra functions for making new holes
SUNCGLoader.prototype.__attachRoomArchWithNewHoles = function (archData, objects, json, context) {
  this.__associateArchWithNewHoles(archData, objects);
  this.__createArch(archData, json, context);
  var holeToWalls = context.arch.holeToWalls;
  for (var i = 0; i < objects.length; i++) {
    var r = objects[i];
    if (r.json.type === 'Room') {
      var room = this.__parseRoomCached(r.json, context);
      while (room.object3D.children.length) {
        r.object3D.add(room.object3D.children[0]);
      }
    } else if (r.json.type === 'Object' && r.object3D && holeToWalls[r.id]) {
      r.object3D.userData.wallIds = holeToWalls[r.id];
    }
  }
};

// Parses json of P5D scene
SUNCGLoader.prototype.parse = function (json, callback, url, loadOpts) {
  //console.log(json);
  var scene = new THREE.Scene();
  for (var i = 0; i < json.levels.length; i++) {
    json.levels[i].type = 'Level';
  }
  var sceneResult = new SceneState(scene, { up: json.up, front: json.front, unit: json.scaleToMeters, textureRepeat: SUNCGLoader.textureRepeat });
  //console.log('got loadOpts', loadOpts);
  var context = {
    scene: sceneResult,
    sceneHash: json.id
  };
  if (json.camera) {
    this.__parseCamera(json.camera, sceneResult);
  }

  if (this.archCreator) {
    if (loadOpts.arch && loadOpts.arch.data) {
      context.hasArch = true;
      if (this.ignoreOriginalArchHoles) {
        // Skip room for now so that we can create rooms with custom cut out holes
        this.__createDummyRoom = true;
        this.keepParse = true;
      } else {
        this.__createArch(loadOpts.arch.data, json, context);
      }
    } else {
      this.keepParse = true;
      console.warn('No architecture data found for ' + json.id);
    }
  }

  var scope = this;
  this.__parseItemDeferred(json, json.levels, context, ['Level'], function(err, parsed, results) {
    // Load or create room
    if (context.hasArch && scope.ignoreOriginalArchHoles) {
      // Hack to have delayed creation of new architecture, now that we loaded the windows/doors
      scope.__createDummyRoom = false;
      // TODO: handle ground
      var archData = _.cloneDeep(loadOpts.arch.data);
      var objects = _.flatMap(results, function(x) { return x.children; });
      scope.__attachRoomArchWithNewHoles(archData, objects, json, context);
    } else if (scope.__hasEmbeddedArchElements) {
      scope.__hasEmbeddedArchElements = false;
      var roomJsons = _.flatMap(results, function(x) { return x.json.nodes.filter(function(y) { return y.type === 'Room'; } ); });
      var allElements = _.flatMap(roomJsons, function(x) { return x.elements || []; });
      var archData = { elements: allElements };
      var objects = _.flatMap(results, function(x) { return x.children; });
      scope.__attachRoomArchWithNewHoles(archData, objects, json, context);
    }

    __addChildren(scene, results);

    _.each(results, function(level, levelIndex) {
      if (level.object3D) {
        level.object3D.traverse(function (child) {
          if (child.userData.id != undefined) {
            child.userData.level = levelIndex;
          }
        });
      }
    });

    // Finalize our scene
    if (scope.keepParse) {
      parsed.loader = 'SUNCGLoader';
      sceneResult.parsedData = parsed;
    }
    scope.__onSceneCompleted(null, sceneResult);
    // our callback expect the sceneResult and then error
    callback(sceneResult, err);
  });
};

SUNCGLoader.prototype.__parseCamera = function(cameraJson, sceneResult) {
  var cameras;
  if (_.isArray(cameraJson)) {
    cameras = _.keyBy(cameraJson, 'name');
  } else {
    cameras = cameraJson;
  }
  _.each(cameras, function(v, k) {
    v.name = k;
    if (!v.type) {
      v.type = k;
    }
    if (v.type === 'orthographic') {
      if (!v.position) {
        // Convert from world into local
        v.position = new THREE.Vector3((v.left + v.right)/2, v.near, (v.top + v.bottom)/2);
        v.target = new THREE.Vector3((v.left + v.right)/2, v.far, (v.top + v.bottom)/2);
        var w = (v.right - v.left)/2;
        var h = (v.top - v.bottom)/2;
        v.left = -w; v.right = w;
        v.top = h; v.bottom = -h;
        delete v['near'];
        delete v['far'];
      }
    }
    if (v.position) {
      v.position = Object3DUtil.toVector3(v.position);
    }
    if (v.target) {
      v.target = Object3DUtil.toVector3(v.target);
    }
    if (v.direction) {
      v.direction = Object3DUtil.toVector3(v.direction);
    }
  });
  sceneResult.cameras = cameras;
};

SUNCGLoader.prototype.__parseItemDeferred = function (json, items, context, allowed, callback) {
  // List of asynchronous jobs we want to do
  var deferred = d3queue.queue();
  var parsed = { json: json, parent: context.parent, sceneHash: context.sceneHash,
    floor: context.floor, id: context.id, index: context.index };
  for (var i = 0; i < items.length; i++) {
    var child = items[i];
    var processChild = !context.keepItems || context.keepItems.indexOf(i) >= 0;  // Check if we want to process this
    if (!this.keepInvalid) {
      processChild = processChild && (child.valid == null || child.valid);
    }
    if (this.skipElements && this.skipElements.indexOf(child.type) >= 0) {
      processChild = false;
    }
    if (!processChild) {
      deferred.defer(this.__parseItemSimple.bind(this, child, { parent: parsed }));
    } else if (allowed && allowed.indexOf(child.type) < 0) {
      console.warn('Disallowed type ' + child.type + ' when processing ' + parsed.id, child);
      deferred.defer(this.__parseItemSimple.bind(this, child, { parent: parsed }));
    } else {
      var func = this.__lookupParseFn(child.type);
      var childCtx = _.defaults({}, context);
      childCtx.parent = parsed;
      childCtx.index = i;
      childCtx.id = (parsed.id != undefined)? parsed.id + '_' + i : i;
      delete childCtx.keepItems;

      if (func) {
        deferred.defer(func.bind(this, child, childCtx));
      } else {
        console.warn('Unknown type ' + child.type + ' when processing ' + parsed.id, child);
        deferred.defer(this.__parseItemSimple.bind(this, child, { parent: parsed }));
      }
    }
  }

  // the first argument is the error and the next argument the results
  // our callback expect the sceneResult and then error
  var scope = this;
  deferred.awaitAll(function (err, results) {
    if (err) {
      console.error('Error processing', context);
      console.error(err);
    }
    if (results && results.length) {
      //console.log(results);
      for (var i = 0; i < results.length; i++) {
        var result = results[i];
        if (result && result.object3D) {
//          result.object3D.userData.id = result.id;
          result.object3D.userData.id = result.json.id;
          if (scope.keepMaterialInfo) {
            if (result.json.materials) {
              result.object3D.userData.materials = result.json.materials;
            }
          }
        }
      }
    }
    if (scope.keepParse) {
      parsed.children = results;
    }
    // console.log('Processed ' + item.type);
    callback(err, parsed, results);
  });
};

 SUNCGLoader.prototype.__parseItemSimple = function (item, context, callback) {
   //console.log(item.type);
   //console.log(item);
   var parsed = { json: item, parent: context.parent, floor: context.floor, id: context.id, index: context.index };
   if (callback) {
     callback(null, parsed);
   } else {
     return parsed;
   }
 };

SUNCGLoader.prototype.__parseLevel = function (json, context, callback) {
  context.floor = context.index;
  var scope = this;
  var loadFloor = this.floor == undefined || (this.floor === context.floor);
  // Only load specified floor if only one floor requested
  if (loadFloor) {
    if (this.room != undefined) {
      var room = json && json.nodes? json.nodes[this.room] : null;
      var isRoom = room && room.type === 'Room';
      var itemIndices = room.nodeIndices;
      if (itemIndices != null) {
        context['keepItems'] = [this.room].concat(itemIndices);
      }
      var itemStr = 'Scene ' + context.sceneHash + ', floor ' + context.floor + ', item ' + this.room;
      if (!isRoom) {
        var msg2 = (context['keepItems'])? ' but has other items ' + itemIndices.join(',') : ' loading single object';
        console.warn(itemStr + ' is not a room,' + msg2);
      }
      if (!context['keepItems']) {
        if (isRoom) {
          console.warn(itemStr + ' is a room without any objects.');
        }
        context['keepItems'] = [this.room];
      }
    }
    this.__parseItemDeferred(json, json.nodes, context, ['Room', 'Object', 'Ground', 'Box'], function (err, parsed, results) {
      // add children into group and callback
      var group = new THREE.Group();
      group.name = 'Level#' + context.floor;
      group.userData.type = 'Level';
      __addChildren(group, results);
      parsed.object3D = group;

      // Process roomObjectMapping (map of room index to object indices)
      var rooms = _.filter(results, function(x) { return x.json.type === 'Room'; });
      for (var i = 0; i < rooms.length; i++) {
        var room = rooms[i];
        if (room && room.object3D && room.json.nodeIndices) {
          var m = room.json.nodeIndices;
          room.objectIndices = m;
          room.partitions = m.map(function(idx) {
            if (results[idx]) {
              var mInst = results[idx].modelInstance;
              if (mInst && mInst.model.isPartition()) {
                return results[idx];
              }
            } else {
              console.warn('Invalid node index for room', idx, room.json.id);
            }
          }).filter(function(x) { return x; });
          for (var j = 0; j < m.length; j++) {
            var ci = m[j];
            var item = results[ci];
            if (item && item.object3D) {
              if (item.json.type === 'Room') {
                console.warn('Skipping attaching Room ' + item.object3D.userData.id + ' to Room ' + room.object3D.userData.id);
              } else {
                if (!item.object3D.userData.roomIds) {
                  item.object3D.userData.roomIds = [];
                }
                item.object3D.userData.roomIds.push(room.object3D.userData.id);
                Object3DUtil.attachToParent(item.object3D, room.object3D, group);
              }
            }
          }
        }
      }
      if (context.arch) {
        var holeToWalls = context.arch.holeToWalls;
        for (var i = 0; i < results.length; i++) {
          var r = results[i];
          if (r.object3D && holeToWalls[r.id]) {
            r.object3D.userData.wallIds = holeToWalls[r.id];
          }
        }
      }
      callback(err, parsed);
    });
  } else {
    console.log('Skipping floor ' + context.floor + ', only loading floor ' + this.floor);
    this.__parseItemSimple(json, context, callback);
  }
};

SUNCGLoader.prototype.__parseGround = function (json, context, callback) {
  // console.log('parse ground');
  var scope = this;
  var parts = ['f'].map(function(suffix) {
    return {
      id: json.id,
      type: 'Arch',
      modelId: json.modelId + suffix,
      archType: 'Ground'
    };
  });
  // Load modelId with ground
  this.__parseItemDeferred(json, parts, context, null, function (err, parsed, results) {
    var group = new THREE.Group();
    group.name = 'Ground' + json.id;
    group.userData.type = 'Ground';
    __addChildren(group, results);
    scope.__applyTransform(group, json);
    parsed.object3D = group;
    callback(err, parsed);
  });
};

function __getWallHeight(elements, defaults) {
  var walls = _.filter(elements, function(x) { return x.type === 'Wall'; });
  var defaultWallHeight = _.get(defaults, "Wall.height");
  return _.max(_.map(walls, function(w) {
    return w.height || defaultWallHeight;
  }));
}

SUNCGLoader.prototype.__parseRoom = function (json, context, callback) {
  if (this.__createDummyRoom || (!context.arch && json.elements)) {
    if (!context.arch && json.elements) {
      var scope = this;
      this.__hasEmbeddedArchElements = true;
      _.each(json.elements, function(x) {
        x.roomId = json.id;
      });
      var addFloor = this.includeFloor && !_.some(json.elements, function(e) { return e.type === 'Floor'; });
      var addCeiling = this.includeCeiling && !_.some(json.elements, function(e) { return e.type === 'Ceiling'; });
      if (addFloor || addCeiling) {
        var s = scope.archCreator.getWallPoints(json.elements, true);
        var wallPoints = s.wallPoints;
        json.elements = _.flatten(s.groupedWalls); // reordered walls
        if (addFloor) {
          // Let's create a floor
          json.elements.push({
            'id': json.id + "f",
            "type": "Floor",
            "roomId": json.id,
            "points": wallPoints
          });
        }
        if (addCeiling) {
          // Let's create a ceiling
          var up = Object3DUtil.toVector3(scope.archCreator.up).clone();
          var wallHeight = __getWallHeight(json.elements, scope.archCreator.defaults);
          var ceilingOffset = _.get(scope.archCreator.defaults, "Ceiling.offset") || 0;
          // Let's create a floor
          json.elements.push({
            'id': json.id + "c",
            "type": "Ceiling",
            "roomId": json.id,
            "offset": up.multiplyScalar(wallHeight + ceilingOffset).toArray(),
            "points": wallPoints
          });
        }
      }
    }
    // console.log('dummy room creation');
    this.__parseItemSimple(json, context, function (err, parsed) {
      var group = new THREE.Group();
      group.name = 'Room#' + json.id;
      group.userData.id = json.id;
      group.userData.type = 'Room';

      if (json.roomTypes) {
        group.userData.roomType = json.roomTypes;  // Room types as array
      }
      parsed.object3D = group;
      callback(err, parsed);
    });
  } else if (context.arch) {
    // console.log('parse room cached');
    this.__parseRoomCached(json, context, callback);
  } else {
    // console.log('parse room load');
    this.__parseRoomLoad(json, context, callback);
  }
};

SUNCGLoader.prototype.__parseRoomCached = function (json, context, callback) {
  //console.log('parseRoomCached', json, context);
  var parsed = { json: json, parent: context.parent, floor: context.floor, id: context.id, index: context.index };
  var archId = json.id;
  if (context.archMappings) {
    var m = context.archMappings[json.id];
    if (m != null) {
      archId = m;
    }
  }
  parsed.object3D = context.arch.rooms[archId];
  if (parsed.object3D) {
    var ro = parsed.object3D;
    if (json.roomTypes) {
      ro.userData.roomType = json.roomTypes;  // Room types as array
    }
    for (var i = 0; i < ro.children.length; i++) {
      // HACK!!!!
      context.scene.extraObjects.push(ro.children[i]);
    }
  }

  if (callback) {
    callback(null, parsed);
  } else {
    return parsed;
  }
};

SUNCGLoader.prototype.__parseRoomLoad = function (json, context, callback) {
  var parts = ['f','c','w'];
  if (!this.includeFloor || json.hideFloor) {
    _.pull(parts, 'f');
  }
  if (!this.includeCeiling || json.hideCeiling) {
    _.pull(parts, 'c');
  }
  if (!this.includeWalls || json.hideWalls) {
    _.pull(parts, 'w');
  }
  //console.log(parts);
  parts = parts.map(function(suffix) {
    var archType;
    if (suffix === 'f') {
      archType = 'Floor';
    } else if (suffix === 'w') {
      archType = 'Wall';
    } else if (suffix === 'c') {
      archType = 'Ceiling';
    }
    return {
      id: json.id + suffix,
      type: 'Arch',
      modelId: json.modelId + suffix,
      archType: archType
    };
  });
  // Load modelId + parts (do not load c/f/w if hideCeiling/hideFloor/hideWall)
  this.__parseItemDeferred(json, parts, context, null, function (err, parsed, results) {
    var group = new THREE.Group();
    group.name = 'Room#' + json.id;
    group.userData.id = json.id;
    group.userData.type = 'Room';

    parsed.items = results;
    __addChildren(group, results);

    if (json.roomTypes) {
      group.userData.roomType = json.roomTypes;  // Room types as array
    }
    parsed.object3D = group;
    callback(err, parsed);
  });
};

SUNCGLoader.prototype.__parseObject = function (json, context, callback) {
  this.__parseItemLoad(json, context, callback);
};

SUNCGLoader.prototype.__parseArch = function (json, context, callback) {
  if (context.arch) {
    this.__parseArchCached(json, context, callback);
  } else {
    this.__parseArchLoad(json, context, callback);
  }
};

SUNCGLoader.prototype.__parseBox = function (json, context, callback) {
  // Procedurally generated content
  var scope = this;
  var parsed = { json: json, parent: context.parent, floor: context.floor, id: context.id, index: context.index };

  var dims = json.dimensions;
  var box = new THREE.BoxGeometry(dims[0], dims[1], dims[2], 1, 1, 1);
  for (var i = 0; i < box.faceVertexUvs.length; i++) {
    var uvs = box.faceVertexUvs[i];
    for (var j = 0; j < uvs.length; j++) {
      var uv1, uv2;
      if (j >= 0 && j <= 3) {
        // sY, sZ   // left right
        uv1 = dims[2];
        uv2 = dims[1];
        if (j % 2 === 0) {
          uvs[j][0].set(0, uv2);
          uvs[j][2].set(uv1, uv2);
        } else {
          uvs[j][1].set(uv1, 0);
          uvs[j][2].set(uv1, uv2);
        }
      } else if (j >= 4 && j <= 7) {
        // sX, sY   // top bottom
        uv1 = dims[0];
        uv2 = dims[2];
        if (j % 2 === 0) {
          uvs[j][0].set(0, uv2);
          uvs[j][2].set(uv1, uv2);
        } else {
          uvs[j][1].set(uv1, 0);
          uvs[j][2].set(uv1, uv2);
        }
      } else {
        // sX, sZ   // front back
        uv1 = dims[0];
        uv2 = dims[1];
        if (j % 2 === 0) {
          uvs[j][0].set(0, uv2);
          uvs[j][2].set(uv1, uv2);
        } else {
          uvs[j][1].set(uv1, 0);
          uvs[j][2].set(uv1, uv2);
        }
      }
    }
  }
  var materials = [];
  // TODO: Check ordering of materials [2,3,0,1,4,5]?
  var materialIndexMapping = [2,3,0,1,4,5]; // from json.materials to our materials
  for (var i = 0; i < json.materials.length; i++) {
    var mat = json.materials[i];
    var m = scope.__getMaterial(mat.diffuse, mat.texture + '.jpg', { side: THREE.DoubleSide });
    //console.log('material: ' + i + ' ' + mat.texture + '.jpg');
    materials[materialIndexMapping[i]] = m;
  }
  var object3D = new THREE.Mesh(box, new THREE.MultiMaterial(materials));
  scope.__applyTransform(object3D, json);
  //scope.__applyMaterials(object3D, json);

  parsed.object3D = object3D;
  object3D.name = 'Box';
  // HACK!!!!
  context.scene.extraObjects.push(object3D);

  if (callback) {
    callback(null, parsed);
  } else {
    return parsed;
  }
};

SUNCGLoader.prototype.__parseItemLoad = function (json, context, callback) {
  //console.log('processing object!!!');
  //console.log(json);

  var object = { json: json, parent: context.parent, floor: context.floor, id: context.id, index: context.index };
  var modelId = json.modelId;
  object.modelId = modelId;
  // Handle aframe
  if (this.useVariants && json.state > 0) {
    modelId += '_' + (json.state-1);
  }
  if (this.replaceModels) {
    var replacementModelId = _.isFunction(this.replaceModels)? this.replaceModels(modelId) : this.replaceModels[modelId];
    if (replacementModelId) {
      if (this.verbose) {
        console.log('Replace model ' + modelId + ' with ' + replacementModelId);
      }
      modelId = replacementModelId;
    }
  }
  var scope = this;
  function __loadModel() {
    scope.assetManager.getModelInstance(scope.defaultSource, modelId,
      function (modelInstance) {
        // Okay
        object.modelInstance = modelInstance;
        object.object3D = modelInstance.getObject3D();
        if (json.state != null) {
          object.object3D.userData.state = json.state;
        }

        scope.__applyTransform(object.object3D, json);
        // Apply materials after transform (apply transform may change underlying model...)
        scope.__applyMaterials(object.object3D, json);
        // Ensure modelInstance has double sided materials as flips will reveal back faces
        Object3DUtil.setDoubleSided(object.modelInstance.object3D);
        callback(null, object);
      },
      function (error) {
        // Error loading model
        console.warn('Error loading model ' + modelId);
        console.warn(error);
        object.error = error;
        callback(null, object);
      },
      { defaultFormat: scope.defaultModelFormat }
    );
  }

  if (this.loadModelsFilter) {
    // Check category of the model
    var scope = this;
    this.assetManager.lookupModelInfo(scope.defaultSource, modelId, function(modelInfo) {
      if (scope.loadModelsFilter(modelInfo)) {
        __loadModel();
      } else {
        callback(null, object);
      }
    });
  } else {
    __loadModel();
  }
};

SUNCGLoader.prototype.__parseArchLoad = function (json, context, callback) {
  //console.log('processing object!!!');
  //console.log(json);

  var object = { json: json, parent: context.parent, floor: context.floor, id: context.id, index: context.index };
  var modelId = json.modelId;
  object.modelId = modelId;
  var scope = this;
  this.assetManager.getModelInstanceFromModelInfo({
      source: 'suncg-arch',
      fullId: 'suncg-arch.' + context.sceneHash + '_' + modelId,
      id: context.sceneHash + '_' + modelId,
      format: 'obj',
      texturePath: this.__scenesAssetGroup['texturesPath'],
      file: this.__scenesAssetGroup['roomFilesPath'] + context.sceneHash + '/' + modelId + '.obj',
      mtl: this.__scenesAssetGroup['roomFilesPath'] + context.sceneHash + '/' + modelId + '.mtl',
      options: { useBuffers: true, preserveMeshes: false },
      skipCache: true // Don't cache this
    },
    function (modelInstance) {
      // Okay
      object.modelInstance = modelInstance;
      object.object3D = modelInstance.getObject3D();
      object.object3D.userData.archType = json.archType;

      scope.__applyTransform(object.object3D, json);
      //scope.__applyMaterials(object.object3D, json);
      // Ensure modelInstance has double sided materials as flips will reveal back faces
      //Object3DUtil.setDoubleSided(object.modelInstance.object3D);
      callback(null, object);
    },
    function (error) {
      // Error loading model
      console.warn('Error loading model ' + modelId);
      console.warn(error);
      object.error = error;
      callback(null, object);
    }
  );
};

SUNCGLoader.prototype.__parseArchCached = function (json, context, callback) {
  var parsed = { json: json, parent: context.parent, floor: context.floor, id: context.id, index: context.index };
  var element = context.arch.elementsById[json.id];
  if (_.isArray(element)) {
    var group = new THREE.Group();
    group.name = json.archType + '#' + json.id;
    group.userData.id = json.id;
    group.userData.type = json.archType;
    for (var i = 0; i < element.length; i++) {
      var e = element[i];
      group.add((e instanceof THREE.Object3D)? e : e.object3D);
    }
    parsed.object3D = group;
  } else if (element) {
    parsed.object3D = (element instanceof THREE.Object3D)? element : element.object3D;
  } else {
    console.warn('Cannot find arch element', json.id);
  }
  if (parsed.object3D) {
    // HACK!!!!
    context.scene.extraObjects.push(parsed.object3D);
  }
  callback(null, parsed);
};

SUNCGLoader.prototype.__getMaterial = function (color, texture, options) {
  if (texture) {
    options = options || { wrap: THREE.RepeatWrapping, repeat: SUNCGLoader.textureRepeat };
    var out = this.assetManager.getTexturedMaterial(this.defaultSource, texture, options);
    out.color = new THREE.Color(color || '#ffffff');
    return out;
  } else {
    return Object3DUtil.getMaterial(color);
  }
};

SUNCGLoader.prototype.__getMaterials = function(w) {
  var scope = this;
  var materials = w.materials? w.materials : _.get(this.archCreator.defaults, w.type + '.materials');
  //console.log("materials", materials);
  return _.map(materials, function (m) {
    return scope.__getMaterial(m.diffuse, m.texture);
  });
};

SUNCGLoader.prototype.__applyMaterials = function (object3D, json) {
  var scope = this;
  if (json.materials && json.materials.length > 0) {
    for (var i = 0; i < json.materials.length; i++) {
      json.materials[i].color = json.materials[i].diffuse;  // Hack to handle diffuse
    }
    // Assume that the object3D is a single mesh with a multimaterial
    // Get the multimaterial and make sure that it matches the number of materials specified and set it
    var meshes = Object3DUtil.getMeshList(object3D);
    for (var i = 0; i < meshes.length; i++) {
      var mesh = meshes[i];
      var name = mesh.material.name; // name not cloned for some reason
      var index = mesh.material.index; // Our own custom index
      mesh.material = mesh.material.clone();
      mesh.material.name = name;
      mesh.material.index = index;
      var p5dLoader = new P5DTextureLoader();
      p5dLoader.loadTexture = function (path, onLoad, onProgress, onError) {
        //console.log('Using texture ' + path + ' on model ' + json.id);
        var texturePath = scope.assetManager.getTexturePath(scope.defaultSource, path);
        //console.log('loadTexture ' + scope.defaultSource + ' ' + path + ' ' + texturePath);
        return Object3DUtil.loadTexture(texturePath, undefined, onLoad, onError);
      };
      p5dLoader.updateMaterials(mesh, json);
    }
  }
};

SUNCGLoader.prototype.__applyTransform = function (object3D, json) {
  if (json.transform) {
    var transform = new THREE.Matrix4();
    transform.fromArray(json.transform);
    if (json.isMirrored == null) {
      var det = transform.determinant();
      json.isMirrored = det < 0;
    }
    Object3DUtil.setMatrix(object3D, transform);
  }

  // AXC: Not needed as of r89 (maybe even a bit before)
  // if (json.isMirrored) {
  //   // console.log('Flip normals!!!', object3D);
  //   var mi = Object3DUtil.getModelInstance(object3D);
  //   if (mi) {
  //     mi.useFlippedModel(this.assetManager);
  //   } else {
  //     Object3DUtil.flipForMirroring(object3D);
  //   }
  // }

  Object3DUtil.clearCache(object3D);
};

// Populate SceneState members for sceneResult (called at end with callback)
SUNCGLoader.prototype.__onSceneCompleted = function (callback, sceneResult) {
  var scene = sceneResult.scene;
  sceneResult.modelInstances = Object3DUtil.findModelInstances(scene);
  for (var i = 0; i < sceneResult.modelInstances.length; i++) {
    var modelInst = sceneResult.modelInstances[i];
    this.setObjectFlags(sceneResult, modelInst);
    modelInst.object3D.name = '' + i;
    if (this.useNormalizedCoordinateFrame) {
      modelInst.ensureNormalizedModelCoordinateFrame().clone();
    }
  }
  this.Publish('sceneLoaded', sceneResult);
  if (callback) {
    callback(sceneResult);
  }
};

SUNCGLoader.prototype.__lookupParseFn = function (type) {
  return this['__parse' + type];
};

// Utility function
function __addChildren(parent, results) {
  if (results) {
    //console.log('Adding children');
    //console.log(results);
    for (var i = 0; i < results.length; i++) {
      var result = results[i];
      if (result.object3D) {
        parent.add(result.object3D);
      } else {
        //console.warn('Skipping child ' + i);
      }
    }
  } else {
    console.warn('No results!!!!');
  }
}

// Exports
module.exports = SUNCGLoader;
