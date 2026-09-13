/**
 * One-step provider setup: point every model slot of a terrarium at one
 * provider preset, so a fresh clone can go live with two commands
 * (`flytown init --provider deepseek`, then the key prompt).
 */
import { MODEL_SLOTS, PROVIDER_PRESETS, resolveProviderRuntime } from "./providers.js";
import type { ModelSlot, ProviderConfig, ProviderPresetId } from "./types.js";

export interface ProviderSetupOptions {
  /** Model for every chat slot; the embedding slot keeps the preset default. */
  model?: string;
  /** Model for the soldier slot, when it should differ from `model`. */
  soldierModel?: string;
  baseURL?: string;
  apiKeyEnv?: string;
  /** Keep existing per-slot routes instead of clearing them. */
  keepRoutes?: boolean;
}

export function isProviderPresetId(id: string | undefined): id is ProviderPresetId {
  return !!id && Object.prototype.hasOwnProperty.call(PROVIDER_PRESETS, id);
}

/**
 * The provider config after switching to `preset`. Model overrides and routes
 * are reset so every slot really uses the new provider. Extra request fields
 * are provider-specific, so they carry over only when the preset is unchanged;
 * the preset's own required fields apply either way (see providers.ts).
 */
export function applyProviderPreset(current: ProviderConfig | undefined, preset: ProviderPresetId, opts: ProviderSetupOptions = {}): ProviderConfig {
  if (preset === "custom" && !opts.baseURL) throw new Error("the custom preset needs --base-url");
  const info = PROVIDER_PRESETS[preset];
  const samePreset = current?.preset === preset;
  const models: Partial<Record<ModelSlot, string>> = {};
  if (opts.model) for (const slot of MODEL_SLOTS) if (slot !== "embedding") models[slot] = opts.model;
  if (opts.soldierModel) models.soldier = opts.soldierModel;
  return {
    preset,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    apiKeyEnv: opts.apiKeyEnv ?? info.apiKeyEnv,
    ...(Object.keys(models).length > 0 ? { models } : {}),
    ...(opts.keepRoutes && current?.routes && Object.keys(current.routes).length > 0 ? { routes: current.routes } : {}),
    outputFormat: current?.outputFormat ?? "freeform",
    ...(samePreset && current?.requestParams ? { requestParams: current.requestParams } : {}),
  };
}

/** Human-readable description of what a config will do. Never includes key values. */
export function describeProvider(config: ProviderConfig, env: Record<string, string | undefined>, storedKeys: Record<string, string>): { lines: string[]; missingApiKey?: string } {
  const runtime = resolveProviderRuntime(config, env, storedKeys);
  const bySlotModel = new Map<string, ModelSlot[]>();
  for (const slot of MODEL_SLOTS) {
    const model = config.routes?.[slot]?.model ?? runtime.models[slot];
    bySlotModel.set(model, [...(bySlotModel.get(model) ?? []), slot]);
  }
  const keyStatus = runtime.missingApiKey
    ? `missing — store it with: flytown secret set ${runtime.missingApiKey}`
    : runtime.apiKeySource === "env" ? `from the ${runtime.apiKeyEnv} environment variable`
    : runtime.apiKeySource === "stored" ? `stored for this terrarium (${runtime.apiKeyEnv})`
    : "not needed (local provider)";
  const lines = [
    `provider: ${runtime.label} (${runtime.id})`,
    `base URL: ${runtime.baseURL ?? "provider default"}`,
    ...[...bySlotModel.entries()].map(([model, slots]) => `model:    ${model} for ${slots.join(", ")}`),
    `request:  ${runtime.requestParams ? JSON.stringify(runtime.requestParams) : "no extra fields"}`,
    `API key:  ${keyStatus}`,
  ];
  if (config.routes && Object.keys(config.routes).length > 0) lines.push(`routes:   per-slot routes override ${Object.keys(config.routes).join(", ")} (see flytown route)`);
  const note = PROVIDER_PRESETS[runtime.id]?.note;
  if (note) lines.push(`note:     ${note}`);
  return { lines, ...(runtime.missingApiKey ? { missingApiKey: runtime.missingApiKey } : {}) };
}
