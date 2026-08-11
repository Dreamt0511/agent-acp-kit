import { describe, expect, it } from "vitest";

import { isTuttiAgentCatalog, isTuttiAgentProviderCatalog } from "../../src/tutti/contracts.js";

function catalog() {
  return {
    schemaVersion: 2,
    source: "tutti-cli",
    defaultProviderId: "codex",
    providers: [
      {
        providerId: "codex",
        displayName: "Codex",
        availability: { status: "available", reasonCode: "", detail: "" },
        runtimeSupported: true,
      },
    ],
  };
}

describe("Tutti browser-safe contracts", () => {
  it("accepts exact agent catalogs with duplicate provider metadata", () => {
    const value = {
      schemaVersion: 1,
      source: "tutti-cli",
      defaultAgentTargetId: "team:codex-one",
      agents: [
        {
          agentTargetId: "team:codex-one",
          providerId: "codex",
          displayName: "Codex One",
          availability: {
            status: "available",
            reasonCode: "",
            detail: "",
          },
          runtimeSupported: true,
        },
        {
          agentTargetId: "team:codex-two",
          providerId: "codex",
          displayName: "Codex Two",
          availability: {
            status: "available",
            reasonCode: "",
            detail: "",
          },
          runtimeSupported: true,
        },
      ],
    };
    expect(isTuttiAgentCatalog(value)).toBe(true);
    expect(
      isTuttiAgentCatalog({
        ...value,
        agents: [value.agents[0], value.agents[0]],
      }),
    ).toBe(false);
  });

  it("accepts a filtered catalog whose global default is outside the result", () => {
    const value = {
      schemaVersion: 1,
      source: "tutti-cli",
      defaultAgentTargetId: "local:codex",
      agents: [
        {
          agentTargetId: "extension:hermes",
          providerId: "hermes",
          displayName: "Hermes",
          availability: { status: "available", reasonCode: "", detail: "" },
          runtimeSupported: true,
        },
      ],
    };
    expect(isTuttiAgentCatalog(value)).toBe(true);
  });

  it("accepts a catalog whose default resolves to one unique provider", () => {
    expect(isTuttiAgentProviderCatalog(catalog())).toBe(true);
    expect(
      isTuttiAgentProviderCatalog({
        ...catalog(),
        defaultProviderId: "",
        providers: [],
      }),
    ).toBe(true);
  });

  it("rejects duplicate providers and missing defaults", () => {
    const valid = catalog();
    expect(
      isTuttiAgentProviderCatalog({
        ...valid,
        providers: [...valid.providers, ...valid.providers],
      }),
    ).toBe(false);
    expect(
      isTuttiAgentProviderCatalog({
        ...valid,
        defaultProviderId: "missing",
      }),
    ).toBe(false);
    expect(
      isTuttiAgentProviderCatalog({
        ...valid,
        defaultProviderId: "",
      }),
    ).toBe(false);
  });

  it("rejects non-canonical provider IDs", () => {
    const valid = catalog();
    expect(
      isTuttiAgentProviderCatalog({
        ...valid,
        defaultProviderId: "claude",
        providers: [{ ...valid.providers[0], providerId: "claude" }],
      }),
    ).toBe(false);
    expect(
      isTuttiAgentProviderCatalog({
        ...valid,
        defaultProviderId: " codex ",
        providers: [{ ...valid.providers[0], providerId: " codex " }],
      }),
    ).toBe(false);
  });
});
