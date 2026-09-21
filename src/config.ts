import { createConfigSchematics } from "@lmstudio/sdk";

/**
 * Per-chat configuration (applies to the current chat only).
 * LM Studio auto-generates the UI from this schema.
 */
export const configSchematics = createConfigSchematics()
  .field(
    "projectPath",
    "string",
    {
      displayName: "Project Path",
      subtitle:
        "Directory of the codebase to index & search. Leave empty and call set_project_path directly, or set a default here.",
    },
    "" // empty = not set by default; user must call set_project_path
  )
  .field(
    "resultLimit",
    "numeric",
    {
      displayName: "Result Limit (chars)",
      subtitle:
        "Max characters each tool returns before truncation. Set 0 for no truncation.",
    },
    2000
  )
  .build();

/**
 * Global configuration (applies to all chats). Used here only for an optional
 * override of the Python executable; everything else is auto-detected.
 */
export const globalConfigSchematics = createConfigSchematics()
  .field(
    "pythonExecutable",
    "string",
    {
      displayName: "Python Executable (optional)",
      subtitle:
        "Override the Python used to run the Code Index backend. Leave empty to auto-detect CodeIndex/.venv.",
    },
    ""
  )
  .build();
