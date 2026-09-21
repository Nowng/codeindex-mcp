/**
 * LM Studio tools provider.
 *
 * Each tool below is a thin, faithful wrapper around one upstream Code Index
 * MCP tool. All of them delegate to the shared `codeIndexClient`, which runs
 * the untouched Python server over MCP/stdio. Nothing here reimplements the
 * indexing / search logic, so the upstream repo stays `git pull -`-able.
 */
import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { configSchematics } from "./config.js";
import { codeIndexClient } from "./core/codeIndexClient.js";
import * as fs from "node:fs";
import * as path from "node:path";

// Tools with no arguments still need an (empty) parameters schema. The LM Studio
// SDK's `tool()` wraps `parameters` with `zod.z.object(parameters)`, so we must
// pass a plain empty SHAPE here (NOT a pre-built ZodObject — that would be
// double-wrapped and corrupt the resulting schema). A plain `{` yields a valid
// empty object schema for each no-arg tool. Reused for every no-arg tool below.
const NO_ARGS = {} as Record<string, { parse(input: unknown): unknown }>;

export async function toolsProvider(ctl: ToolsProviderController): Promise<Tool[]> {
  // Resolve per-chat config once per tool invocation.
  const cfg = () => ctl.getPluginConfig(configSchematics);
  const limit = () => {
    const v = cfg().get("resultLimit");
    return typeof v === "number" && v >= 0 ? v : 2000;
  };

  // Ensure the backend points at the configured project (cached; runs only
  // when the path actually changes) before each tool call.
  async function withProject<T>(fn: () => Promise<T>): Promise<T> {
    await codeIndexClient.ensureProjectPath(cfg().get("projectPath"));
    return fn();
  }

  const tools: Tool[] = [
    // ---- project / lifecycle -------------------------------------------
    tool({
      name: "set_project_path",
      description:
        "Set the base project path for indexing. Call this first with the directory that contains the codebase you want to index and search.",
      parameters: {
        path: z
          .string()
          .min(1)
          .describe("Absolute or relative path to the project / codebase directory."),
      },
      implementation: async ({ path }: { path: string }, { status, signal }) =>
        withProject(() =>
          codeIndexClient.invoke(
            "set_project_path",
            { path },
            { limit: limit(), signal },
          ),
        ),
    }),

    tool({
      name: "refresh_index",
      description:
        "Manually rebuild the project file index. Use after git operations or when the index seems stale.",
      parameters: NO_ARGS,
      implementation: async (_args: {}, { status, signal }) => {
        status("Rebuilding the file index...");
        return withProject(() =>
          codeIndexClient.invoke("refresh_index", {}, { limit: limit(), signal }),
        );
      },
    }),

    tool({
      name: "build_deep_index",
      description:
        "Build the deep index (full symbol extraction) for the current project. Uses parallel processing by default; tune max_workers for large codebases.",
      parameters: {
        max_workers: z
          .number()
          .int()
          .min(1)
          .nullable()
          .optional()
          .describe("Max parallel workers; omit to let the server choose (default min(4, cpu_count))."),
        timeout: z
          .number()
          .int()
          .min(1)
          .nullable()
          .optional()
          .describe("Parallel build timeout in seconds; omit to use the server's auto-scale."),
      },
      implementation: async (
        { max_workers, timeout }: { max_workers?: number | null; timeout?: number | null },
        { status, signal },
      ) => {
        status("Building the deep index (full symbol extraction)...");
        const args: Record<string, unknown> = {};
        if (max_workers !== undefined && max_workers !== null) args.max_workers = max_workers;
        if (timeout !== undefined && timeout !== null) args.timeout = timeout;
        return withProject(() =>
          codeIndexClient.invoke("build_deep_index", args, { limit: limit(), signal }),
        );
      },
    }),

    // ---- search / discovery --------------------------------------------
    tool({
      name: "search_code_advanced",
      description:
        "Search for a code pattern with pagination. Auto-selects the best search tool (ugrep/ripgrep/ag/grep). Supports glob file_pattern (e.g. \"*.py\") and fuzzy matching.",
      parameters: {
        pattern: z.string().min(1).describe("Text / glob / symbol pattern to search for."),
        case_sensitive: z.boolean().default(true).describe("Match case sensitively."),
        context_lines: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Number of context lines to include around each match."),
        file_pattern: z
          .string()
          .optional()
          .describe("Glob to restrict the search, e.g. \"*.py\"."),
        fuzzy: z.boolean().default(false).describe("Use fuzzy (fuzzy-finding) matching."),
        regex: z
          .boolean()
          .nullable()
          .optional()
          .describe("Force regex mode; omit to use the server default."),
        start_index: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Offset for pagination."),
        max_results: z
          .number()
          .int()
          .min(1)
          .nullable()
          .optional()
          .describe("Maximum number of results to return; omit to use the server default (10)."),
      },
      implementation: async (
        {
          pattern,
          case_sensitive,
          context_lines,
          file_pattern,
          fuzzy,
          regex,
          start_index,
          max_results,
        }: {
          pattern: string;
          case_sensitive: boolean;
          context_lines: number;
          file_pattern?: string;
          fuzzy: boolean;
          regex?: boolean | null;
          start_index: number;
          max_results?: number | null;
        },
        { status, signal },
      ) => {
        status("Searching the index...");
        const args: Record<string, unknown> = {
          pattern,
          case_sensitive,
          context_lines,
          fuzzy,
          start_index,
        };
        if (file_pattern !== undefined) args.file_pattern = file_pattern;
        if (regex !== undefined && regex !== null) args.regex = regex;
        if (max_results !== undefined && max_results !== null) args.max_results = max_results;
        return withProject(() =>
          codeIndexClient.invoke("search_code_advanced", args, { limit: limit(), signal }),
        );
      },
    }),

    tool({
      name: "find_files",
      description:
        "Find files matching a glob pattern using the in-memory index. Supports path patterns (*.py), and filename-only matching (README.md).",
      parameters: {
        pattern: z
          .string()
          .min(1)
          .describe("Glob pattern, e.g. \"*.py\" or a filename like \"README.md\"."),
      },
      implementation: async ({ pattern }: { pattern: string }, { signal }) =>
        withProject(() =>
          codeIndexClient.invoke("find_files", { pattern }, { limit: limit(), signal }),
        ),
    }),

    tool({
      name: "get_file_content",
      description:
        "Get the raw text content of a specific file (the files://{file_path} resource). " +
        "Reads the file directly from the indexed project on disk.",
      parameters: {
        file_path: z
          .string()
          .min(1)
          .describe("Path of the file whose raw content to return."),
      },
      implementation: async ({ file_path }: { file_path: string }) => {
        // The upstream only exposes this as a files:// resource, not a callable
        // tool, so read it directly from the indexed project on disk. Paths are
        // relative to the per-chat Project Path unless already absolute.
        const base = cfg().get("projectPath");
        const target = path.isAbsolute(file_path)
          ? file_path
          : path.join((base as string) || ".", file_path);
        let data: string;
        try {
          data = fs.readFileSync(target, "utf8");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return `Error: Could not read file "${file_path}": ${msg}`;
        }
        const cap = limit();
        if (cap > 0 && data.length > cap) {
          return `${data.slice(0, cap)}\u2026[truncated ${data.length - cap} chars]`;
        }
        return data;
      },
    }),

    // ---- code intelligence ---------------------------------------------
    tool({
      name: "get_file_summary",
      description:
        "Get a summary of a specific file: line count, function/class definitions, import statements, and basic complexity metrics.",
      parameters: {
        file_path: z
          .string()
          .min(1)
          .describe("Path of the file to summarize."),
      },
      implementation: async ({ file_path }: { file_path: string }, { status, signal }) => {
        status("Analyzing file...");
        return withProject(() =>
          codeIndexClient.invoke("get_file_summary", { file_path }, { limit: limit(), signal }),
        );
      },
    }),

    tool({
      name: "get_symbol_body",
      description:
        "Get the source code body of a specific symbol (function, method, or class). Retrieves only the code for the symbol to avoid loading entire files.",
      parameters: {
        file_path: z.string().min(1).describe("Path of the file containing the symbol."),
        symbol_name: z
          .string()
          .min(1)
          .describe('Name of the symbol, e.g. "process_data" or "MyClass.my_method".'),
      },
      implementation: async (
        { file_path, symbol_name }: { file_path: string; symbol_name: string },
        { status, signal },
      ) => {
        status("Resolving symbol body...");
        return withProject(() =>
          codeIndexClient.invoke("get_symbol_body", { file_path, symbol_name }, {
            limit: limit(),
            signal,
          }),
        );
      },
    }),

    // ---- settings / system ---------------------------------------------
    tool({
      name: "get_settings_info",
      description: "Get information about the current project settings and indexed state.",
      parameters: NO_ARGS,
      implementation: async (_args: {}, { signal }) =>
        withProject(() =>
          codeIndexClient.invoke("get_settings_info", {}, { limit: limit(), signal }),
        ),
    }),

    tool({
      name: "create_temp_directory",
      description: "Create the temporary directory used for storing index data.",
      parameters: NO_ARGS,
      implementation: async (_args: {}, { signal }) =>
        withProject(() =>
          codeIndexClient.invoke("create_temp_directory", {}, { limit: limit(), signal }),
        ),
    }),

    tool({
      name: "check_temp_directory",
      description: "Check the temporary directory used for storing index data.",
      parameters: NO_ARGS,
      implementation: async (_args: {}, { signal }) =>
        withProject(() =>
          codeIndexClient.invoke("check_temp_directory", {}, { limit: limit(), signal }),
        ),
    }),

    tool({
      name: "clear_settings",
      description: "Clear all settings and cached (indexed) data for the current project.",
      parameters: NO_ARGS,
      implementation: async (_args: {}, { status, signal }) => {
        status("Clearing settings and cached data...");
        return withProject(() =>
          codeIndexClient.invoke("clear_settings", {}, { limit: limit(), signal }),
        );
      },
    }),

    tool({
      name: "refresh_search_tools",
      description:
        "Manually re-detect the available command-line search tools on the system (e.g. after installing ripgrep).",
      parameters: NO_ARGS,
      implementation: async (_args: {}, { signal }) =>
        withProject(() =>
          codeIndexClient.invoke("refresh_search_tools", {}, { limit: limit(), signal }),
        ),
    }),

    tool({
      name: "get_file_watcher_status",
      description: "Get the file watcher service status and statistics.",
      parameters: NO_ARGS,
      implementation: async (_args: {}, { signal }) =>
        withProject(() =>
          codeIndexClient.invoke("get_file_watcher_status", {}, { limit: limit(), signal }),
        ),
    }),

    tool({
      name: "configure_file_watcher",
      description:
        "Configure the file watcher service settings. The watcher can rebuild the index automatically when files change.",
      parameters: {
        enabled: z
          .boolean()
          .nullable()
          .optional()
          .describe("Whether to enable the file watcher; omit to leave unchanged."),
        debounce_seconds: z
          .number()
          .min(0)
          .nullable()
          .optional()
          .describe("Debounce time in seconds before a rebuild is triggered."),
        additional_exclude_patterns: z
          .array(z.string())
          .nullable()
          .optional()
          .describe("Extra directory/file glob patterns to exclude from indexing."),
        observer_type: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Observer backend: \"auto\" (default), \"kqueue\" (macOS/BSD), " +
              "\"fsevents\" (macOS), or \"polling\" (cross-platform fallback).",
          ),
      },
      implementation: async (
        {
          enabled,
          debounce_seconds,
          additional_exclude_patterns,
          observer_type,
        }: {
          enabled?: boolean | null;
          debounce_seconds?: number | null;
          additional_exclude_patterns?: string[] | null;
          observer_type?: string | null;
        },
        { status, signal },
      ) => {
        status("Configuring the file watcher...");
        const args: Record<string, unknown> = {};
        if (enabled !== undefined && enabled !== null) args.enabled = enabled;
        if (debounce_seconds !== undefined && debounce_seconds !== null)
          args.debounce_seconds = debounce_seconds;
        if (additional_exclude_patterns !== undefined && additional_exclude_patterns !== null)
          args.additional_exclude_patterns = additional_exclude_patterns;
        if (observer_type !== undefined && observer_type !== null) args.observer_type = observer_type;
        return withProject(() =>
          codeIndexClient.invoke("configure_file_watcher", args, { limit: limit(), signal }),
        );
      },
    }),
  ];

  return tools;
}
