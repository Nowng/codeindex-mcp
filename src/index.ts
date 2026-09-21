import { type PluginContext } from "@lmstudio/sdk";
import { toolsProvider } from "./toolsProvider.js";
import { configSchematics, globalConfigSchematics } from "./config.js";

export { toolsProvider, configSchematics, globalConfigSchematics };

/**
 * LM Studio plugin entry point.
 *
 * `lms dev`, the Hub install, and `lms push` all load this module and call
 * `main(pluginContext)` to register every feature this plugin exposes: the
 * per-chat & global configuration UI, and the tools provider (which wraps the
 * upstream Code Index MCP tools). Returning the chainable context keeps this
 * compatible with the SDK's `PluginContext` contract.
 */
export async function main(ctx: PluginContext): Promise<void> {
  ctx
    .withConfigSchematics(configSchematics)
    .withGlobalConfigSchematics(globalConfigSchematics)
    .withToolsProvider(toolsProvider);
}
