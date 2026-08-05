# @tutti-os/agent-acp-kit Agent Guide

This package is intended to become an independently published ACP-oriented local agent SDK. Treat it as reusable infrastructure, not as an AI Media Canvas feature folder.

## How To Use This Package

Use `README.md` as the public package guide for humans and external adopters. Use this `AGENTS.md` as the coding-agent guide for future implementation, refactor, and integration work.

The normal host integration should look like this:

```ts
import {
  createClaudeProvider,
  createCodexProvider,
  createLocalAgentRuntime,
} from "@tutti-os/agent-acp-kit";

const runtime = createLocalAgentRuntime({
  providers: [createCodexProvider(), createClaudeProvider()],
});

for await (const event of runtime.run({
  runId,
  provider,
  cwd,
  prompt,
  model,
  mcpServers,
  skillManifest,
  resume,
})) {
  if (event.type === "tool_call") {
    // Project package AgentEvent into the host stream/replay protocol.
  }
}
```

Important usage rules for agents:

- Do not add host-specific branches above this package for Codex versus Claude launch behavior. Put provider differences in provider plugins.
- Do not define application tools here. Pass host-owned tools through `mcpServers`.
- Do not introduce runtime event enums unless the public contract needs runtime reflection. `AgentEvent` is a TypeScript discriminated union; string narrowing is intentional.
- Do not make this package create messages, assistant anchors, canvas elements, media jobs, or billing records.
- Do not assume Claude Code has dynamic model discovery. Follow provider reality: Codex can discover models, Claude uses fallback hints plus custom model pass-through.
- Do not pass broad product secrets into provider env. Use host-created, run-scoped tool tokens.
- Treat provider detection as an installation/capability probe. Missing CLIs should return `supported: false` and `authState: "missing"` rather than throwing from provider-specific `detect()` functions.

## Package Responsibility

Own these concerns here:

- Provider detection, capabilities, model hints, and auth/config location reporting.
- Provider-specific launch plans, args, env, MCP delivery, and model normalization.
- Process supervision, stdin prompt delivery, timeout, cancel, stderr tail, and redaction.
- JSONL, plain stdout, and ACP JSON-RPC transports.
- Provider output parsing into `AgentEvent`.
- Skill materialization, prompt injection, and cleanup.
- Public testing helpers and provider conformance checks.

Do not own these concerns here:

- Host sessions, canvases, jobs, billing, media storage, or message persistence.
- UI event shapes, websocket protocol, replay protocol, or assistant message anchors.
- Product tool implementations.
- Product-specific MCP server paths or tokens.
- Cross-provider handoff policy beyond accepting a normalized `resume` input.

## Design Rules

- Keep the host adapter thin. If a change requires host business objects inside this package, move that logic back to the host.
- Keep provider differences inside provider plugins. The host should not branch on Codex versus Claude for launch args, MCP config, model normalization, or parser details.
- Keep transport behavior reusable. ACP fixes belong in `src/transports/acp`, not inside Hermes/Kimi/Kiro provider wrappers unless the provider truly differs.
- Keep events normalized. Every provider should emit terminal `done` and failed tool results with a clear status.
- Keep security explicit. Do not add broad token passthrough, global secrets, or silent sandbox bypass behavior without documenting the trusted-local-mode requirement.
- Prefer small contracts over framework abstractions. This package should remain usable from any Node host.

## Public API Discipline

Root exports should stay focused on:

- `createLocalAgentRuntime`
- Official provider factories
- Core input/event/capability/MCP/skill types
- Safe utility functions needed by hosts

Use subpath exports for specialized surfaces:

- `./tutti` for server-side auto CLI-backed/standalone catalog, composer, and skill integration.
- `./tutti/contracts` for browser-safe Tutti DTO types and guards with no Node imports.
- `./runtime-control-plane` for runtime selection/control-plane helpers.
- `./process-adapter` for the narrow cross-platform invocation resolver used by
  hosts that intentionally execute an Agent CLI outside the runtime facade.
- `./testing` for fake providers, fake ACP peers, fixtures, and conformance helpers.

Avoid exporting provider internals, launch-plan helpers, parser internals, or application-specific glue from the root.

## Provider Implementation Checklist

When adding or changing a provider:

- Add detection with executable path, version, auth state, supported flag, config dir, skills dir, and model hints where possible.
- Add launch-plan tests for command, args, cwd, env, model, prompt input, MCP config, resume, and extra allowed dirs.
- Add parser tests for text, tool start, tool result success/failure, stderr/error, and terminal done.
- Add cancellation behavior when the provider process or transport supports it.
- Add model behavior that matches the actual provider. Do not invent discovery if the CLI does not expose it.
- Add conformance coverage through `assertProviderConformance` where practical.

## MCP And Tool Rules

- This package accepts MCP server configs; it does not implement product tools.
- Normalize stdio/http MCP config in `src/core/mcp.ts`.
- Convert normalized MCP config inside provider code because each provider expects a different delivery format.
- Keep tool tokens run-scoped and host-generated. Never create or persist product tokens here.
- Redact MCP env values and headers from process output.

## Skills Rules

- The host chooses which skills apply to a run.
- This package only delivers selected skills.
- Materialized skill paths must be per-run and cleaned up.
- Prompt-injected skills must not mutate global user skill directories.
- Do not silently include all user/global skills in a run.

## Resume And Cancellation Rules

- Same-provider resume can use provider session ids or resume tokens when supported.
- If resume metadata is missing, degrade to `fresh`.
- Cross-provider resume is host-level handoff, not package-level magic.
- Cancellation must produce or preserve one terminal status. Late process output must not overwrite a durable terminal event in the host.
- Codex same-provider resume is a different argv shape: use `codex exec resume --json <session-id> -`, not `codex exec --resume`.
- Claude Code same-provider resume is a flag on the print invocation: use `claude -p --output-format stream-json --resume <session-id>`.
- Gemini is not currently a built-in provider. If it is added later, choose one transport shape first: `gemini --acp` through ACP JSON-RPC, or `gemini -p ... --output-format stream-json --resume <session-id>` through JSONL. Do not mix ACP flags with stream-json parsing.
- Hosts should pass durable `history` on every run and treat native provider resume as an optimization. Store `done.sessionId` and `done.resumeToken` when providers emit them.

## Testing Expectations

Before claiming package work is complete, run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

For changes that affect a host integration, also run the host tests that consume `@tutti-os/agent-acp-kit`.

Tutti integration rules:

- Auto detection is the only app-facing behavior. Do not add app-provided `mode` or `required` switches.
- Absence of `TUTTI_CLI` means standalone; a configured CLI failure is typed and must not fall back.
- `loadTuttiAgentCatalog()` and exact `agentTargetId` values define app-facing selection. Runtime registration may disable an entry but may not add one omitted by the CLI.
- Never collapse or deduplicate catalog entries by provider. Several exact agents may intentionally share one runtime provider.
- Provider aliases are input-only runtime metadata. Public agent identity comes from the live catalog, and `nexight` must never alias `tutti-agent`.
- Dual-stack fallback may use the old provider contract only when the CLI explicitly reports `agent list` as an unknown command and the old catalog proves one unambiguous exact target. Ordinary CLI failures must remain typed failures.
- App identity, daemon URL/token, CLI argv, schema validation, timeout, and cancellation do not belong in consumer apps.

For release readiness, run:

```bash
pnpm pack:check
pnpm test:packed-consumer
```

and verify the tarball includes `dist`, `README.md`, `AGENTS.md`, and `package.json`.

## Release Workflow

Normal package releases should use `.github/workflows/npm-package-release.yml`.

Release requirements:

- Stable `latest` releases must run from the `main` branch with `version_bump=current` after a PR has already bumped `package.json` to the target stable version.
- Beta and other prerelease packages may run from a feature or release branch with `dist_tag=beta` and `version_bump=prepatch`, `preminor`, `premajor`, `prerelease`, or `custom`.
- Use `custom_version` only when `version_bump=custom`.
- Use `preid` for prerelease bump identifiers, normally `beta`.
- Keep the repository secret `NPM_TOKEN` configured with npm publish permission.
- Use `dry_run: true` first when changing release behavior.
- Do not make the workflow commit directly to `main`; stable version bumps must go through PRs.
- Let the workflow publish and push tag `v<version>`. For prerelease branch runs, the workflow may also commit the prerelease version bump back to the triggering branch before publishing.

Do not publish ad hoc from a local machine unless GitHub Actions is unavailable. If local publishing is necessary, run typecheck, tests, build, and `pnpm pack:check` before `npm publish`.

## Documentation Expectations

Update `README.md` when any of these change:

- Public exports.
- `AgentRunInput` or `AgentEvent` semantics.
- Provider support or provider model behavior.
- MCP delivery behavior.
- Skill delivery behavior.
- Security assumptions.
- Testing or publishing workflow.
