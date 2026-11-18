'use strict';

const path = require('node:path');
const { backgroundProcessOptions } = require('../lib/windows-background-process.js');
const realChildProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { promisify } = require('node:util');

const INSTALL_MARK = Symbol.for('secondbrain.test.quietChildProcesses');
const DEFAULT_PRELOAD = __filename;

function hasRequire(execArgv, preloadPath) {
  return execArgv.some((arg, index) =>
    (arg === '--require' && execArgv[index + 1] === preloadPath) ||
    arg === `--require=${preloadPath}`
  );
}

function withRequire(execArgv = [], preloadPath = DEFAULT_PRELOAD) {
  const copy = [...execArgv];
  return hasRequire(copy, preloadPath) ? copy : [...copy, '--require', preloadPath];
}

function nodeOptionsRequire(preloadPath) {
  return `--require=${JSON.stringify(preloadPath)}`;
}

function withNodeOptions(env, preloadPath = DEFAULT_PRELOAD) {
  const copy = { ...env };
  const addition = nodeOptionsRequire(preloadPath);
  const current = copy.NODE_OPTIONS || '';
  if (!current.includes(addition)) copy.NODE_OPTIONS = current ? `${current} ${addition}` : addition;
  return copy;
}

function isNodeExecutable(command, execPath) {
  if (typeof command !== 'string') return false;
  const normalized = path.normalize(command).toLowerCase();
  if (normalized === path.normalize(execPath).toLowerCase()) return true;
  return /^(node|node\.exe)$/i.test(path.basename(command));
}

function quietOptions(options, { propagateNode = false, env, preloadPath } = {}) {
  // Preserve native validation of invalid option values.
  if (options != null && (typeof options !== 'object' || Array.isArray(options))) return options;
  const copy = options ? { ...options } : {};
  Object.assign(copy, backgroundProcessOptions(copy, 'win32'));
  if (propagateNode) copy.env = withNodeOptions(copy.env || env, preloadPath);
  return copy;
}

function installQuietChildProcesses({
  childProcess = realChildProcess,
  platform = process.platform,
  preloadPath = DEFAULT_PRELOAD,
  env = process.env,
  execPath = process.execPath,
  syncBuiltinESMExportsFn = childProcess === realChildProcess ? syncBuiltinESMExports : () => {},
} = {}) {
  if (platform !== 'win32') return false;
  if (childProcess[INSTALL_MARK]) return false;

  const original = Object.fromEntries(
    ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']
      .map((name) => [name, childProcess[name]])
  );

  childProcess.spawn = function spawn(command, args, options) {
    if (Array.isArray(args) || (args == null && arguments.length >= 3)) {
      return original.spawn.call(this, command, args, quietOptions(options, {
        propagateNode: isNodeExecutable(command, execPath), env, preloadPath,
      }));
    }
    return original.spawn.call(this, command, quietOptions(args, {
      propagateNode: isNodeExecutable(command, execPath), env, preloadPath,
    }));
  };

  childProcess.spawnSync = function spawnSync(command, args, options) {
    if (Array.isArray(args) || (args == null && arguments.length >= 3)) {
      return original.spawnSync.call(this, command, args, quietOptions(options, {
        propagateNode: isNodeExecutable(command, execPath), env, preloadPath,
      }));
    }
    return original.spawnSync.call(this, command, quietOptions(args, {
      propagateNode: isNodeExecutable(command, execPath), env, preloadPath,
    }));
  };

  childProcess.execFile = function execFile(file, args, options, callback) {
    const propagateNode = isNodeExecutable(file, execPath);
    if (Array.isArray(args) || (args == null && arguments.length >= 3)) {
      if (typeof options === 'function') {
        return original.execFile.call(this, file, args, quietOptions(undefined, { propagateNode, env, preloadPath }), options);
      }
      return original.execFile.call(this, file, args, quietOptions(options, { propagateNode, env, preloadPath }), callback);
    }
    if (typeof args === 'function') {
      return original.execFile.call(this, file, quietOptions(undefined, { propagateNode, env, preloadPath }), args);
    }
    return original.execFile.call(this, file, quietOptions(args, { propagateNode, env, preloadPath }), options);
  };

  childProcess.execFileSync = function execFileSync(file, args, options) {
    const propagateNode = isNodeExecutable(file, execPath);
    if (Array.isArray(args) || (args == null && arguments.length >= 3)) {
      return original.execFileSync.call(this, file, args, quietOptions(options, { propagateNode, env, preloadPath }));
    }
    return original.execFileSync.call(this, file, quietOptions(args, { propagateNode, env, preloadPath }));
  };

  childProcess.exec = function exec(command, options, callback) {
    if (typeof options === 'function') {
      return original.exec.call(this, command, quietOptions(), options);
    }
    return original.exec.call(this, command, quietOptions(options), callback);
  };

  childProcess.execSync = function execSync(command, options) {
    return original.execSync.call(this, command, quietOptions(options));
  };

  childProcess.fork = function fork(modulePath, args, options) {
    if (args == null && arguments.length >= 3) {
      args = [];
    } else if (!Array.isArray(args)) {
      options = args;
      args = [];
    }
    const quiet = quietOptions(options);
    if (!quiet || typeof quiet !== 'object' || Array.isArray(quiet) ||
        (quiet.execArgv != null && !Array.isArray(quiet.execArgv))) {
      return original.fork.apply(this, arguments);
    }
    quiet.execArgv = withRequire(quiet.execArgv || process.execArgv, preloadPath);
    return original.fork.call(this, modulePath, args, quiet);
  };

  // Native exec promise adapters return {stdout, stderr} and expose .child.
  // Wrap their own adapter instead of losing it or bypassing hidden options.
  for (const name of ['exec', 'execFile']) {
    const descriptor = Object.getOwnPropertyDescriptor(original[name], promisify.custom);
    if (typeof descriptor?.value !== 'function') continue;
    Object.defineProperty(childProcess[name], promisify.custom, {
      ...descriptor,
      value: function (...args) {
        const index = name === 'exec' ? 1 :
          (Array.isArray(args[1]) || (args[1] == null && args.length >= 3) ? 2 : 1);
        const quietArgs = [...args];
        quietArgs[index] = quietOptions(quietArgs[index], {
          propagateNode: name === 'execFile' && isNodeExecutable(args[0], execPath), env, preloadPath,
        });
        return descriptor.value.apply(this, quietArgs);
      },
    });
  }
  // A shell may itself launch Node. Keep the test preload in the inherited
  // environment as well as the explicit fork flags, only for the real test process.
  if (childProcess === realChildProcess) Object.assign(env, withNodeOptions(env, preloadPath));
  Object.defineProperty(childProcess, INSTALL_MARK, { value: true });
  syncBuiltinESMExportsFn();
  return true;
}

installQuietChildProcesses();

module.exports = {
  installQuietChildProcesses,
  withNodeOptions,
  withRequire,
};
