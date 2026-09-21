'use strict';

/*
 * postinstall entry point for the `codeindex-mcp` LM Studio plugin.
 *
 * Runs automatically whenever the plugin is installed (including from the
 * LM Studio Hub). It makes the upstream Code Index MCP (a Python package)
 * available so the TypeScript wrapper can call its tools over MCP/stdio.
 *
 *   [a] clone the upstream repo into ./CodeIndex  (only if it is missing,
 *       so a later `git pull` inside CodeIndex keeps working)
 *   [b} create a Python venv at ./CodeIndex/.venv
 *   [c] install Code Index's Python dependencies from ./requirements.txt
 *       via PyPI, right after the venv is created. Nothing is bundled here,
 *       so the plugin stays small enough for LM Studio Hub upload.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- paths -----------------------------------------------------------------
const PLUG_ROOT = path.resolve(__dirname, '..');
const CODE_INDEX_DIR = path.join(PLUG_ROOT, 'CodeIndex');
const REQ_PATH = path.join(PLUG_ROOT, 'requirements.txt');
const VENV_REL = path.join('CodeIndex', '.venv'); // relative to PLUG_ROOT
const IS_WIN = process.platform === 'win32';
const VENV_BIN = path.join(CODE_INDEX_DIR, '.venv', IS_WIN ? 'Scripts' : 'bin');
const PY = path.join(VENV_BIN, IS_WIN ? 'python.exe' : 'python');

// --- helpers ---------------------------------------------------------------
function log(msg) {
  // postinstall output goes to stdout; that is fine (this is not the MCP server).
  // eslint-disable-next-line no-console
  console.log(`[codeindex setup] ${msg}`);
}
function errLog(msg) {
  // eslint-disable-next-line no-console
  console.error(`[codeindex setup] ERROR: ${msg}`);
}
function run(cmd, opts) {
  // eslint-disable-next-line no-console
  console.log(`[codeindex setup] $ ${cmd}`);
  return execSync(cmd, { encoding: 'utf8', stdio: 'inherit', ...opts });
}
// Find a python interpreter on PATH (to bootstrap the venv).
function findPython() {
  const names = IS_WIN ? ['python.exe', 'python'] : ['python3', 'python'];
  for (const name of names) {
    try {
      const p = execSync(`command -v ${name}`, { encoding: 'utf8' }).trim();
      if (p) return p;
    } catch (_) {
      // try next
    }
  }
  return null;
}

// --- [a] clone upstream repo ----------------------------------------------
try {
  if (!fs.existsSync(path.join(CODE_INDEX_DIR, '.git')) && !fs.existsSync(CODE_INDEX_DIR)) {
    log('Cloning upstream Code Index MCP repo into CodeIndex/ ...');
    const rel = path.relative(PLUG_ROOT, CODE_INDEX_DIR) || 'CodeIndex';
    run(`git clone https://github.com/johnhuang316/code-index-mcp "${rel}"`, { cwd: PLUG_ROOT });
  } else {
    log('CodeIndex/ already present; skipping clone (leaves it free for `git pull`).');
  }
} catch (e) {
  errLog(`git clone failed: ${(e && e.message) || e}`);
  process.exit(1);
}

// --- [b] create the Python venv -------------------------------------------
const SYS_PY = findPython();
if (!SYS_PY) {
  errLog('No Python interpreter found on PATH (need python3/python to create a venv).');
  process.exit(1);
}
if (!fs.existsSync(PY)) {
  log(`Creating venv at ${VENV_REL} using ${SYS_PY} ...`);
  run(`"${SYS_PY}" -m venv "${VENV_REL}"`, { cwd: PLUG_ROOT });
} else {
  log('venv already exists; reusing it.');
}

// --- [c] install Python dependencies from requirements.txt ----------------
try {
  if (!fs.existsSync(REQ_PATH)) {
    errLog(`Missing ${REQ_PATH}. The plugin cannot install its Python backend.`);
    process.exit(1);
  }
  run(`${PY} -m pip install --upgrade pip setuptools wheel`, {});
  log(`Installing dependencies from ${REQ_PATH} via PyPI ...`);
  run(`${PY} -m pip install --retries 2 -r "${REQ_PATH}"`, { cwd: PLUG_ROOT });
  log('Python dependencies installed successfully.');
} catch (e) {
  errLog(`dependency install failed: ${(e && e.message) || e}`);
  errLog('Install needs network at plugin-install time. If a top-level package ' +
         '(e.g. libclang, protobuf, tree-sitter*) has no prebuilt wheel for this ' +
         'platform/Python version, make sure the host has a C compiler, or add the ' +
         'missing prebuilt wheel back into ./wheels and restore the offline path.');
  process.exit(1);
}

// --- [d] inject independent C/C++ strategy (survives git pull) -------------
try {
  const purelib = execSync(
    `${PY} -c "import sysconfig; print(sysconfig.get_paths()['purelib'])"`,
    { encoding: 'utf8' },
  ).trim();
  if (!fs.existsSync(purelib)) fs.mkdirSync(purelib, { recursive: true });
  const pth = path.join(purelib, "codeindex_cxx.pth");
  // .pth adds _cpp_patch to sys.path at Python startup so its sitecustomize.py
  // (which registers the C/C++ parser) is available even for direct use.
  fs.writeFileSync(pth, PLUG_ROOT + "/_cpp_patch\n");
  log(`Injected C/C++ strategy via .pth -> ${pth}`);
} catch (e) {
  errLog(`.pth injection skipped: ${(e && e.message) || e}`);
}

log('Setup complete: CodeIndex MCP is ready to be called over MCP/stdio.');
