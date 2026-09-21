# Skill: codeindex-mcp

## Overview

`codeindex-mcp` is an **LM Studio plugin** that exposes the upstream **Code Index MCP**
(a Python package) as a set of MCP tools. The upstream Python repo is cloned at install
time (`scripts/setup.cjs`) and left untouched, so it stays `git pull`-able. A thin
TypeScript wrapper (`src/`) calls each upstream tool over MCP/stdio.

Use this skill whenever you need to **index, search, or analyze a codebase / source tree**.

## Mental Model (how it works)

- The heavy lifting (indexing, parsing, searching) happens in the **Python** backend
  (`CodeIndex/`), which you never edit.
- You talk to it through **MCP tools** exposed by this plugin. Each tool returns a
  human-readable string (or JSON). Results are truncated to a character limit; set the
  per-chat **Result Limit** to `0` if you want no truncation.
- The backend keeps an **in-memory index**. Shallow index = fast file discovery; deep
  index = symbol-level data for summaries and symbol bodies.

## Recommended Workflow (always start here)

1. **`set_project_path`** — point the backend at the repo you want to work on. DO THIS FIRST.
2. **`build_deep_index`** — run once if you plan to use `get_file_summary` / `get_symbol_body`.
   (Skip it for pure text search; the shallow index is enough.)
3. **`find_files`** / **`search_code_advanced`** — locate files and code.
4. **`get_file_content`** / **`get_file_summary`** / **`get_symbol_body`** — read the code.
5. If the codebase changes, call **`refresh_index`** (shallow, fast) or **`build_deep_index`**
   (deep, slower).

---

## Tool Reference

All tool names match the upstream Code Index MCP exactly. Args are listed in order.

### Project / Lifecycle

| Tool | Arguments | Purpose |
|------|-----------|---------|
| `set_project_path` | `path` (string, required) | Set the base project path for indexing. Call this FIRST. |
| `refresh_index` | — | Rebuild the shallow file index after changes / git operations. |
| `build_deep_index` | `max_workers` (int, optional), `timeout` (int, optional) | Build the full symbol index for deep analysis. Tune `max_workers` for large codebases. |
| `get_settings_info` | — | Show current project config & indexed state (temp/settings dirs, writable, file count). |

### Search & Discovery

| Tool | Arguments | Purpose |
|------|-----------|---------|
| `find_files` | `pattern (string, required)` | Find files by glob pattern (`**/*.py`, `src/**/*`, `README.md`). Default 10 results. |
| `search_code_advanced` | `pattern` (req), `case_sensitive` (bool, default true), `context_lines` (int, default 0), `file_pattern` (glob opt), `fuzzy` (bool, default false), `regex` (bool, optional), `start_index` (int, default 0), `max_results` (int, optional) | Smart code search. Literal by default; set `regex=true` for regex and `fuzzy=true` for fuzzy matching. Paginated.
| `get_file_summary` | `file_path` (string, required) | File structure: line count, functions/classes, imports, complexity. **Needs the deep index.** |

### Code Intelligence / Reading

| Tool | Arguments | Purpose |
|------|-----------|---------|
| `get_file_content` | `file_path` (string, required) | Raw text content of a file (the `files://{file_path}` resource). |
| `get_symbol_body` | `file_path` (required), `symbol_name` (required, e.g. `process_data` or `MyClass.my_method`) | Source body of one symbol (function/method/class) without loading the whole file. **Needs the deep index.** |

### Monitoring / Auto-refresh

| Tool | Arguments | Purpose |
|------|-----------|---------|
| `get_file_watcher_status` | — | Check file-watcher status & statistics (active/inactive, debounce). |
| `configure_file_watcher` | `enabled` (bool/null/opt), `debounce_seconds` (float, opt), `additional_exclude_patterns` (list, opt), `observer_type` ("auto"/"kqueue"/"fsevents"/"polling", opt) | Enable/disable auto-refresh and configure the watcher. |

### System / Maintenance

| Tool | Arguments | Purpose |
|------|-----------|---------|
| `create_temp_directory` | — | Create the storage directory for index data. |
| `check_temp_directory` | — | Verify the index storage location & permissions. |
| `clear_settings` | — | Reset all cached settings, index, and cache. (Then re-run `set_project_path` + `build_deep_index`.) |
| `refresh_search_tools` | — | Re-detect available search tools (ugrep/ripgrep/ag/grep). Call if search returns zero results unexpectedly. |

---

## Usage Rules & Conventions

- **Always call `set_project_path` first.** Every tool assumes the backend already knows the
  project path. If you are unsure, check `get_settings_info` (it reports `base_path`).
- **Deep vs. shallow:** Use `search_code_advanced` / `find_files` with the shallow index for
  speed. Call `build_deep_index` once before `get_file_summary`, `get_symbol_body`, or any
  symbol-level work. If a summary says it "needs deep index", run `build_deep_index` first.
- **Search modes:**
  - Literal (default) — matches the pattern verbatim.
  - `fuzzy=true` — tolerant matching (e.g. `authUser` matches `authenticateUser`).
  - `regex=true` — regex; needs a native search tool (ugrep/ripgrep). If none is available,
    run `refresh_search_tools` and install one, or fall back to literal/fuzzy.
- **Pagination:** `search_code_advanced` returns up to `max_results` (server default 10). Use
  `start_index` to page forward and `max_results` to fetch more.
- **Reading files:** Prefer `get_file_summary` for a quick overview, `get_symbol_body` for a
  single function/class, and `get_file_content` when you need the entire file verbatim.
- **After edits / git operations:** call `refresh_index`. Or enable `configure_file_watcher`
  with `enabled=true` for automatic refresh while you work.
- **Troubleshooting:**
  - Search returns nothing → run `refresh_search_tools`; if no native tool exists, fall back to
    literal/fuzzy or tell the user a search binary is missing.
  - `set_project_path` fails → check the path is accessible; run `clear_settings` then retry.
  - Watcher inactive → `configure_file_watcher(enabled=true)` + `refresh_index`.
- **Never edit anything in `CodeIndex/`** — it is the upstream repo and must stay
  It is the upstream repo and must stay `git pull`-able. This plugin only wraps it.

---

## Worked Scenarios

### Scenario 1 — Index a brand-new codebase
> User: "Let's work in /home/sensei/works/my-react-app."

1. `set_project_path(path="/home/sensei/works/my-react-app")`
2. (optional) `build_deep_index()` if you expect to summarize files or symbols.
3. `find_files(pattern="**/*.tsx")` to list all React components.
4. `get_settings_info()` to confirm the index loaded and see the file count.

### Scenario 2 — Search for a pattern across the repo
> User: "Find every place that calls `authenticateUser`."

1. `search_code_advanced(pattern="authenticateUser", case_sensitive=true, context_lines=3, max_results=30)`
2. To be tolerant of name variants: `search_code_advanced(pattern="authUser", fuzzy=true, max_results=20)`
3. To match any `*Data` call with a regex in Python files only:
   `search_code_advanced(pattern="get.*Data", regex=true, file_pattern="*.py", context_lines=2)`

### Scenario 3 — Understand / analyze a module
> User: "Explain what src/api/userService.ts does and how it's structured."

1. `get_file_summary(file_path="src/api/userService.ts")` — shows functions, classes, imports, complexity.
   *(If it needs the deep index, run `build_deep_index()` first, then retry.)*
2. For each function of interest: `get_symbol_body(file_path="src/api/userService.ts", symbol_name="getUser")`
3. If you need the full file: `get_file_content(file_path="src/api/userService.ts")`

### Scenario 4 — Refactoring: find all callers / usages
> User: "I'm renaming `process_data`. Where is it used?"

1. `search_code_advanced(pattern="process_data", context_lines=2, max_results=50)` to find every reference.
2. `get_symbol_body(file_path="<the file>", symbol_name="process_data")` to read its signature/docstring/callers.
3. After making the edits, call `refresh_index()` (or rely on the enabled watcher) so the index stays current.

### Scenario 5 — Explore structure before diving in
> User: "Show me the main components of this project."

1. `set_project_path(path="...")` then `find_files(pattern="**/*.{ts,tsx,js,jsx}") to enumerate source files.
2. `search_code_advanced(pattern="export", file_pattern="*.tsx", fuzzy=false, max_results=20)` to spot public entry points.
3. `get_file_summary()` on the top-level components to summarize each.

### Scenario 6 — Keep the index in sync while editing
> User: "I just added new components; refresh the index."

- One-off: `refresh_index()`.
- Ongoing: `configure_file_watcher(enabled=true, debounce_seconds=6)` so future changes auto-refresh.
- To reset everything: `clear_settings()` (then re-run `set_project_path` + `build_deep_index`).

---

## Quick Decision Guide

| You want to… | Use this tool |
|---|---|
| Point at a repo / start | `set_project_path` |
| List files by name or glob | `find_files` |
| Find code/text inside files | `search_code_advanced` |
| Summarize a file's structure | `get_file_summary` (needs deep index) |
| Read one function/class body | `get_symbol_body` (needs deep index) |
| Read a whole file verbatim | `get_file_content` |
| Rebuild the index after changes | `refresh_index` / `build_deep_index` |
| Auto-refresh on file changes | `configure_file_watcher` |
| Check status / troubleshoot | `get_settings_info`, `get_file_watcher_status`, `refresh_search_tools`, `check_temp_directory` |
| Reset everything | `clear_settings` |
