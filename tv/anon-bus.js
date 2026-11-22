'use strict';

// opens the anonymous private palmbus handle used for the SDX service call.
// The host pushes it next to whichever driver loads it; both are run with
// NODE_PATH set so require('palmbus') resolves.
// pmloglib (a webOS logging module) does not exist on the TV's node; stub it
// with no-ops so a require() of it cannot throw.
var Module = require('module');
var originalLoad = Module._load;
var noop = function () {};
var logger = function () {
  return { log: noop, info: noop, warn: noop, warning: noop, error: noop };
};

Module._load = function (request) {
  if (request === 'pmloglib') {
    return {
      log: noop,
      info: noop,
      warning: noop,
      error: noop,
      Console: logger,
      Context: logger
    };
  }
  return originalLoad.apply(this, arguments);
};

var palmbus = require('palmbus');

// Anonymous private-bus access pattern from:
// https://github.com/lennylxx/lg-geolock-bypass
//
// The two forms cover the two measured generation behaviors: on webOS 26
// (Node 20+) the single-argument form works and the two-argument form with a
// boolean second argument throws "basic_string::_S_construct null not valid";
// on webOS 25 (Node 16) the single-argument form throws and the two-argument
// form works.
function openPrivateHandle() {
  try {
    return new palmbus.Handle('');
  } catch (error) {
    try {
      return new palmbus.Handle('', false);
    } catch (error) {
      throw new Error('anonymous private palmbus handle unavailable: ' + error.message);
    }
  }
}

module.exports = { openPrivateHandle: openPrivateHandle };
