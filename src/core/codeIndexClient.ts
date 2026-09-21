/**
 * Shared core: a thin client for the upstream Code Index MCP server.
 *
 * The Code Index MCP is a Python package (left untouched, so it stays
 * `git pull`-able). We run it as an external MCP server over stdio and call
 * each of its tools by name. This module owns the single, long-lived
 * connection; the LM Studio tools (`toolsProvider.ts`) delegate to it.
 */
import { type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';

// Resolve the upstream Code Index MCP (Python) repo location.
//
// `__dirname` is NOT reliable across runtimes: in the tsc build it is
// `.../codeindex-mcp/dist/core`; in LM Studio's dev loader (`.lmstudio/dev.js`,
// which imports `../src/index.ts`) it can resolve to the plugin root itself.
// To be robust, walk UP from `__dirname` until we find the directory that
// contains BOTH `package.json` and a `CodeIndex/` sibling — that is the plugin
// root, and `CodeIndex/` holds the untouched upstream repo. Fall back to the
// original `../..` traversal if no such directory is found.
const _currentDir = __dirname;

function findPluginRoot(startDir: string): string | null {
  let d = path.resolve(startDir);
  for (;;) {
    const hasPkg = fs.existsSync(path.join(d, 'package.json'));
    const hasCodeIndex = fs.existsSync(path.join(d, 'CodeIndex'));
    if (hasPkg && hasCodeIndex) return d;
    const parent = path.dirname(d);
    if (parent === d) return null; // reached filesystem root
    d = parent;
  }
}

const _foundRoot = findPluginRoot(_currentDir);
const PLUG_ROOT = _foundRoot ?? path.resolve(_currentDir, '..', '..');
const CODE_INDEX_DIR = path.join(PLUG_ROOT, 'CodeIndex');
// Independent C/C++ strategy patch (lives outside CodeIndex/, survives git pull).
const PATCH_DIR = path.join(PLUG_ROOT, '_cpp_patch');
const IS_WIN = process.platform === 'win32';
const VENV_BIN = path.join(CODE_INDEX_DIR, '.venv', IS_WIN ? 'Scripts' : 'bin');
const PY = path.join(VENV_BIN, IS_WIN ? 'python.exe' : 'python');

const SERVER_NAME = 'CodeIndexer';
const SERVER_VERSION = '2.17.1';
const DEFAULT_LIMIT = 8000; // max chars returned per tool call

export interface InvokeOptions {
  /** Hard cap on returned characters (0 = no truncation). */
  limit?: number;
  /** Optional signal to detect a request that was already cancelled. */
  signal?: AbortSignal;
}

function log(...args: unknown[]): void {
  // All debug output goes to stderr so stdout stays clean for any protocol.
  // eslint-disable-next-line no-console
  console.error('[codeindex-wrapper]', ...args);
}

/** Serialize an MCP CallToolResult into a single, readable string. */
function serializeResult(
  res: {
    content?: Array<{ type?: string; text?: string } | null>;
    structuredContent?: unknown;
    isError?: boolean;
  },
  limit: number,
): string {
  const cap = (s: string) =>
    limit > 0 && s.length > limit ? `${s.slice(0, limit)}…[truncated ${s.length - limit} chars]` : s;

  if (res.structuredContent && typeof res.structuredContent === 'object' && res.structuredContent !== null) {
    return cap(JSON.stringify(res.structuredContent, null, 2));
  }
  if (Array.isArray(res.content)) {
    const parts = res.content
      .filter((b): b is { type: string; text?: string } => !!b && b.type === 'text')
      .map((b) => b.text ?? '');
    const txt = parts.join('\n\n');
    if (txt.trim()) return cap(txt);
  }
  // Last resort: stringify the raw result.
  return cap(JSON.stringify(res ?? 'empty result', null, 2));
}

/** Drop `undefined` values so Python receives its own defaults; keep `null`. */
function cleanArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args) {
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

export class CodeIndexClient {
  private _client: Client | null = null;
  private _transport: StdioClientTransport | null = null;
  private _child: ChildProcess | null = null;
  private _connected = false;
  // Remember the last project path so `set_project_path` is not re-run per call.
  private _lastProjectPath: string | null = null;

  private buildParams(): StdioServerParameters {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    // Put the venv first so any bundled executables resolve on PATH.
    env.PATH = env.PATH ? `${VENV_BIN}${path.delimiter}${env.PATH}` : VENV_BIN;
    // Make the `code_index_mcp` package importable from the cloned src/.
    const pyPath = path.join(CODE_INDEX_DIR, 'src');
    const patchDir = path.join(PLUG_ROOT, '_cpp_patch');
    // _cpp_patch (see _cpp_patch/sitecustomize.py). _cpp_patch dir is FIRST on PYTHONPATH so its
    // sitecustomize.py is found at startup; then upstream src/ so
    // `code_index_mcp` stays importable.
    const allPaths = [patchDir, pyPath];
    if (process.env.PYTHONPATH) allPaths.push(process.env.PYTHONPATH);
    env.PYTHONPATH = allPaths.join(path.delimiter);
    return {
      command: PY,
      args: ['-m', 'code_index_mcp', '--transport', 'stdio'],
      env,
      cwd: CODE_INDEX_DIR,
    };
  }

  private reset(): void {
    try {
      this._child?.kill();
    } catch {
      /* ignore */
    }
    this._child = null;
    this._transport = null;
    this._client = null;
    this._connected = false;
  }

  private async ensureConnected(): Promise<void> {
    if (this._client && this._connected) return;
    this.reset();

    const transport = new StdioClientTransport(this.buildParams());
    // The server must keep stdout as pure JSON-RPC; we only report out-of-band errors.
    transport.onerror = (e) => log('transport error:', e.message);
    // If the backend exits for any reason, allow respawn on the next call.
    transport.onclose = () => {
      this._connected = false;
    };

    const client = new Client(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('Failed to connect to Code Index MCP server:', msg);
      throw new Error(
        'Could not start the Code Index MCP backend. Install the plugin / run ' +
          `scripts/setup.cjs and make sure Python is available. (${msg})`,
      );
    }

    this._transport = transport;
    this._client = client;
    this._connected = true;
  }

  /**
   * Call one upstream Code Index MCP tool by name and return its result as a
   * string. Errors are caught and returned as readable strings (no stack traces).
   */
  async invoke(
    name: string,
    args: Record<string, unknown> | undefined = {},
    opts: InvokeOptions = {},
  ): Promise<string> {
    if (opts.signal?.aborted) {
      return 'Error: This request was cancelled before it started.';
    }
    await this.ensureConnected();
    if (!this._client) throw new Error('Code Index MCP client is not connected.');

    const limit = opts.limit ?? DEFAULT_LIMIT;
    const clean = cleanArgs(args);

    let didRetry = false;
    try {
      return serializeResult(
        (await this._client.callTool({ name, arguments: clean }) as unknown) as never,
        limit,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // If the backend died, try a single respawn + retry.
      if (!didRetry && /closed|transport|disconnect|econnrefused|spawn/i.test(msg)) {
        this.reset();
        await this.ensureConnected();
        didRetry = true;
        return this.invoke(name, args, { limit, signal: opts.signal });
      }
      log('callTool failed:', msg);
      return `Error: Code Index MCP tool "${name}" failed: ${msg}`;
    }
  }

  /**
   * Point the backend at a project path. Cached so `initialize_project`
   * (which scans/indexes files) only runs when the path actually changes.
   */
  async ensureProjectPath(pathValue: string | undefined): Promise<void> {
    if (!pathValue) return;
    if (pathValue === this._lastProjectPath) return;
    await this.invoke('set_project_path', { path: pathValue });
    this._lastProjectPath = pathValue;
  }

  /** Stop the backend process. Called on plugin shutdown if available. */
  async close(): Promise<void> {
    if (this._transport) {
      try {
        await this._transport.close();
      } catch {
        /* ignore */
      }
    }
    this.reset();
  }
}

/** A single shared client for the whole plugin instance. */
export const codeIndexClient = new CodeIndexClient();
