import type { AgentPermissionSemantic } from "../core/permissions.js";
import { isAgentPermissionSemantic } from "../core/permissions.js";

export type TuttiAgentIntegrationSource = "tutti-cli" | "standalone";

export type TuttiAgentAvailabilityStatus = "available" | "unavailable" | "unknown";

export interface TuttiAgentProviderAvailability {
  status: TuttiAgentAvailabilityStatus;
  reasonCode: string;
  detail: string;
}

export interface TuttiAgentProviderCatalogEntry {
  providerId: string;
  displayName: string;
  agentTargetId?: string;
  executablePath?: string;
  availability: TuttiAgentProviderAvailability;
  runtimeSupported: boolean;
}

export interface TuttiAgentCatalogEntry {
  agentTargetId: string;
  /** Canonical provider id accepted by the local runtime. */
  providerId: string;
  displayName: string;
  executablePath?: string;
  availability: TuttiAgentProviderAvailability;
  runtimeSupported: boolean;
}

export interface TuttiAgentCatalog {
  schemaVersion: 1;
  source: TuttiAgentIntegrationSource;
  defaultAgentTargetId: string;
  agents: TuttiAgentCatalogEntry[];
}

export interface TuttiAgentProviderCatalog {
  schemaVersion: 2;
  source: TuttiAgentIntegrationSource;
  defaultProviderId: string;
  providers: TuttiAgentProviderCatalogEntry[];
}

export interface TuttiAgentComposerOption {
  id: string;
  value: string;
  label: string;
  description?: string;
  supportsImageInput?: boolean;
}

export interface TuttiAgentComposerConfig {
  configurable: boolean;
  currentValue: string;
  defaultValue: string;
  options: TuttiAgentComposerOption[];
}

export interface TuttiAgentPermissionMode {
  id: string;
  label: string;
  description?: string;
  semantic: AgentPermissionSemantic;
}

export interface TuttiAgentPermissionConfig {
  configurable: boolean;
  defaultValue: string;
  modes: TuttiAgentPermissionMode[];
}

export interface TuttiAgentComposerOptions {
  schemaVersion: 2;
  source: TuttiAgentIntegrationSource;
  agentTargetId: string;
  providerId: string;
  effectiveSettings: Record<string, unknown>;
  modelConfig: TuttiAgentComposerConfig;
  permissionConfig: TuttiAgentPermissionConfig;
  reasoningConfig: TuttiAgentComposerConfig;
  speedConfig: TuttiAgentComposerConfig;
}

export function isTuttiAgentCatalog(value: unknown): value is TuttiAgentCatalog {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (value.source !== "tutti-cli" && value.source !== "standalone") return false;
  if (typeof value.defaultAgentTargetId !== "string" || !Array.isArray(value.agents)) {
    return false;
  }
  if (!value.agents.every(isAgentCatalogEntry)) return false;
  const agentTargetIds = value.agents.map((agent) => agent.agentTargetId);
  if (new Set(agentTargetIds).size !== agentTargetIds.length) return false;
  return agentTargetIds.length > 0 || value.defaultAgentTargetId === "";
}

export function isTuttiAgentProviderCatalog(value: unknown): value is TuttiAgentProviderCatalog {
  if (!isRecord(value) || value.schemaVersion !== 2) return false;
  if (value.source !== "tutti-cli" && value.source !== "standalone") return false;
  if (typeof value.defaultProviderId !== "string" || !Array.isArray(value.providers)) {
    return false;
  }
  if (!value.providers.every(isProviderCatalogEntry)) return false;
  const providerIds = value.providers.map((provider) => provider.providerId);
  if (new Set(providerIds).size !== providerIds.length) return false;
  return providerIds.length === 0
    ? value.defaultProviderId === ""
    : providerIds.includes(value.defaultProviderId);
}

export function isTuttiAgentComposerOptions(value: unknown): value is TuttiAgentComposerOptions {
  return (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    (value.source === "tutti-cli" || value.source === "standalone") &&
    isNonEmptyString(value.agentTargetId) &&
    typeof value.providerId === "string" &&
    isRecord(value.effectiveSettings) &&
    isComposerConfig(value.modelConfig) &&
    isPermissionConfig(value.permissionConfig) &&
    isComposerConfig(value.reasoningConfig) &&
    isComposerConfig(value.speedConfig)
  );
}

function isAgentCatalogEntry(value: unknown) {
  return (
    isRecord(value) &&
    isNonEmptyString(value.agentTargetId) &&
    isCanonicalProviderId(value.providerId) &&
    isNonEmptyString(value.displayName) &&
    (value.executablePath === undefined || isNonEmptyString(value.executablePath)) &&
    typeof value.runtimeSupported === "boolean" &&
    isAvailability(value.availability)
  );
}

function isProviderCatalogEntry(value: unknown) {
  return (
    isRecord(value) &&
    isCanonicalProviderId(value.providerId) &&
    isNonEmptyString(value.displayName) &&
    (value.agentTargetId === undefined || isNonEmptyString(value.agentTargetId)) &&
    (value.executablePath === undefined || isNonEmptyString(value.executablePath)) &&
    typeof value.runtimeSupported === "boolean" &&
    isAvailability(value.availability)
  );
}

function isCanonicalProviderId(value: unknown): value is string {
  return isNonEmptyString(value) && value === value.trim() && value !== "claude";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAvailability(value: unknown) {
  return (
    isRecord(value) &&
    (value.status === "available" ||
      value.status === "unavailable" ||
      value.status === "unknown") &&
    typeof value.reasonCode === "string" &&
    typeof value.detail === "string"
  );
}

function isComposerConfig(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.configurable === "boolean" &&
    typeof value.currentValue === "string" &&
    typeof value.defaultValue === "string" &&
    Array.isArray(value.options) &&
    value.options.every(
      (option) =>
        isRecord(option) &&
        typeof option.id === "string" &&
        typeof option.value === "string" &&
        typeof option.label === "string" &&
        (option.description === undefined || typeof option.description === "string") &&
        (option.supportsImageInput === undefined || typeof option.supportsImageInput === "boolean"),
    )
  );
}

function isPermissionConfig(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.configurable === "boolean" &&
    typeof value.defaultValue === "string" &&
    Array.isArray(value.modes) &&
    value.modes.every(
      (mode) =>
        isRecord(mode) &&
        typeof mode.id === "string" &&
        typeof mode.label === "string" &&
        (mode.description === undefined || typeof mode.description === "string") &&
        isAgentPermissionSemantic(mode.semantic),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
