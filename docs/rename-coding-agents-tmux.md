# Rename plan: `opencode-tmux` → `coding-agents-tmux`

## Goal

Rename the project so the public name matches the product's current scope:

- supports multiple terminal coding agents, not just OpenCode
- still fits tmux plugin discovery and GitHub/npm search
- minimizes churn for existing users

Chosen target name:

- **new public repo/package name:** `coding-agents-tmux`

## Why rename

The current name still reflects the original OpenCode-first implementation, but the project now also supports:

- `codex`
- `pi`
- mixed-agent discovery, switching, popup navigation, and status summaries

The new name should:

- describe the broader scope
- remain searchable for tmux users
- leave room for future agent integrations

## Rename principles

1. **Compatibility first**
   - existing users should not lose working tmux configs after updating
   - old CLI names, env vars, paths, and plugin entry points should keep working during a transition period

2. **Public rename before deep internal rename**
   - update docs and public install paths first
   - keep internal `opencode-tmux` identifiers as compatibility shims where needed

3. **Prefer additive migration over flag day changes**
   - add new names
   - support old and new names together
   - deprecate old names later

4. **Make migration observable**
   - document what changed
   - emit warnings where practical
   - provide a clear migration path

## Scope

This rename affects at least these surfaces:

- GitHub repository slug
- README and user-facing docs
- tmux plugin name and install instructions
- npm package name
- CLI binary name
- shell scripts and test fixtures
- bundled OpenCode plugin file names
- bundled Pi extension install path/name
- env vars and tmux option names
- state directory names
- hard-coded messages, labels, and docs examples
- CI/docs badges and any repository URLs

## Non-goals for phase 1

These do **not** need to happen immediately if compatibility cost is high:

- renaming every internal type/function/class in one pass
- dropping all `opencode-tmux` aliases immediately
- forcing users to rewrite working tmux config on day one

## Current public surfaces to inventory

Primary known names today:

- repo slug: `corwinm/opencode-tmux`
- package name: `opencode-tmux`
- CLI binary: `opencode-tmux`
- tmux plugin entrypoint: `opencode-tmux.tmux`
- bundled OpenCode plugin file: `plugin/opencode-tmux.ts`
- Pi install path fragment: `~/.pi/agent/extensions/opencode-tmux/`
- state dir fragment: `~/.local/state/opencode-tmux/`
- tmux options: `@opencode-tmux-*`
- env vars: `OPENCODE_TMUX_*`

## Migration strategy

Use a phased rollout.

### Phase 0: inventory and design

Decide the exact migration targets and compatibility policy before changing behavior.

Questions to settle:

- Will the npm package be renamed immediately or later?
- Will the CLI binary gain a new primary name while keeping `opencode-tmux` as an alias?
- Will the tmux plugin entrypoint be renamed, or should the old entrypoint remain the canonical TPM file for one release?
- Will the state directory move immediately to `coding-agents-tmux`, or should the project read both and write the legacy path at first?
- How long should legacy env var and tmux option aliases remain supported?

### Phase 1: public docs and compatibility aliases

Ship the new public name while keeping existing installs working.

High-level plan:

- update docs to present `coding-agents-tmux` as the preferred name
- add compatibility aliases for old/new CLI names where possible
- teach runtime/config/state loaders to accept both legacy and new names
- add a migration guide
- keep old defaults functional

### Phase 2: dual-name runtime support

Support both old and new identifiers across runtime surfaces.

Examples:

- support both `OPENCODE_TMUX_*` and `CODING_AGENTS_TMUX_*`
- support both legacy and new state directories
- support both legacy and new tmux option prefixes
- support both old and new plugin install locations where practical

### Phase 3: switch defaults to new names

Once dual support exists:

- make docs, generated snippets, help text, and install commands prefer `coding-agents-tmux`
- write new config snippets with the new prefix/name
- keep legacy aliases in place

### Phase 4: deprecation and cleanup

After at least one stable transition window:

- document old names as deprecated
- optionally emit warnings when legacy names are used
- remove old names only in a future major cleanup, if ever

## Recommended compatibility policy

### Keep working immediately

For the first rename release, keep these working:

- `opencode-tmux` CLI invocation
- `@opencode-tmux-*` tmux options
- `OPENCODE_TMUX_*` env vars
- legacy state directories under `opencode-tmux`
- legacy plugin install paths that existing users already have

### Add new preferred names

Introduce these as preferred public names:

- `coding-agents-tmux` repo/package/docs name
- `coding-agents-tmux` CLI name, if feasible
- `@coding-agents-tmux-*` tmux options
- `CODING_AGENTS_TMUX_*` env vars
- `~/.local/state/coding-agents-tmux/` state root

### Read-both / write-new policy

Preferred long-term behavior:

- **read:** both legacy and new config/env/state names
- **write:** prefer new names
- **fallback:** continue honoring old names if no new value exists

Potential exception:

- if moving writes to the new state dir would break older plugin/extension versions, temporarily keep writing legacy paths until all bundled integrations are dual-compatible

## Detailed work plan

### 1. Documentation and product naming

Tasks:

- update `README.md` title and main description
- update install examples from `corwinm/opencode-tmux` to `corwinm/coding-agents-tmux`
- add a migration section for existing users
- audit docs for `opencode`-specific language that really means mixed coding agents
- add release notes/changelog entry for the rename

Checklist:

- [ ] Update `README.md` title
- [ ] Update README install snippet
- [ ] Update README usage examples
- [ ] Add migration section to README
- [ ] Add a dedicated rename/migration doc or release notes entry
- [ ] Audit docs/ for stale `opencode-tmux` references

### 2. Repository and package metadata

Tasks:

- rename the GitHub repository slug
- update `package.json` name and metadata if the npm package will be renamed now
- update package lock metadata
- update any homepage/repository URLs
- update badges, workflow references, and generated links

Checklist:

- [ ] Rename GitHub repo to `coding-agents-tmux`
- [ ] Update `package.json` name
- [ ] Update `package-lock.json` package metadata
- [ ] Update repository URLs in package metadata
- [ ] Audit CI/workflow references to the old slug

### 3. CLI naming and binary compatibility

Tasks:

- decide whether `coding-agents-tmux` becomes the primary CLI binary now
- if yes, add a new binary while keeping `opencode-tmux` as a compatibility alias
- update docs/help/examples to show the new command
- update tests to cover both names if both are supported

Checklist:

- [ ] Decide primary CLI name policy
- [ ] Add `coding-agents-tmux` binary entry
- [ ] Keep `opencode-tmux` binary alias working
- [ ] Update help text and examples to prefer `coding-agents-tmux`
- [ ] Update tests for binary aliases

### 4. tmux plugin entrypoint and TPM story

Tasks:

- decide the canonical TPM plugin slug and entrypoint file
- if the repo slug changes, ensure TPM installation still lands on a working entrypoint
- consider keeping `opencode-tmux.tmux` as a shim/alias even if a new `coding-agents-tmux.tmux` is introduced
- update user-facing messages in tmux scripts

Checklist:

- [ ] Decide whether to add `coding-agents-tmux.tmux`
- [ ] Keep `opencode-tmux.tmux` working as a shim or alias
- [ ] Update tmux plugin install docs
- [ ] Update tmux script messages and labels
- [ ] Verify TPM install/reload still works after rename

### 5. Bundled integration file names

Tasks:

- decide whether to rename `plugin/opencode-tmux.ts`
- decide whether Pi extension install path should move from `.../opencode-tmux/...` to `.../coding-agents-tmux/...`
- preserve compatibility with already-installed symlinks/extension directories

Checklist:

- [ ] Decide new bundled plugin filename policy
- [ ] Add compatibility path for existing OpenCode plugin installs
- [ ] Add compatibility path for existing Pi extension installs
- [ ] Update docs for integration install locations
- [ ] Verify restart instructions remain accurate

### 6. Env vars and tmux options

Tasks:

- introduce `CODING_AGENTS_TMUX_*` aliases for public env vars
- introduce `@coding-agents-tmux-*` aliases for public tmux options
- document precedence rules
- keep old names working

Recommended precedence:

1. new name
2. old name
3. default

Checklist:

- [ ] Inventory all `OPENCODE_TMUX_*` env vars
- [ ] Add `CODING_AGENTS_TMUX_*` aliases
- [ ] Inventory all `@opencode-tmux-*` tmux options
- [ ] Add `@coding-agents-tmux-*` aliases
- [ ] Document precedence rules
- [ ] Add tests for old/new option resolution

### 7. State directories and on-disk compatibility

Tasks:

- introduce a new state root under `~/.local/state/coding-agents-tmux`
- keep reading from `~/.local/state/opencode-tmux`
- decide when bundled integrations should start writing the new path
- avoid split-brain state during transition

Suggested rollout:

1. readers support both roots
2. bundled writers support both roots or remain on old root temporarily
3. generated docs/snippets prefer new root
4. eventually switch writers to new root once all bundled readers are dual-compatible

Checklist:

- [ ] Add support for reading legacy and new state roots
- [ ] Decide write-path migration strategy
- [ ] Update bundled OpenCode plugin state path handling
- [ ] Update bundled Pi extension state path handling
- [ ] Update Codex state path handling
- [ ] Add tests for legacy/new state lookup behavior

### 8. Internal code and user-facing strings

Tasks:

- update user-facing text from `opencode-tmux` to `coding-agents-tmux` where it refers to the product
- leave purely internal names alone if renaming them adds churn without user benefit
- rename internal symbols only when doing so improves maintainability

Checklist:

- [ ] Audit CLI help text
- [ ] Audit script error/status messages
- [ ] Audit popup/menu titles
- [ ] Audit tests for hard-coded product strings
- [ ] Decide which internal symbols should remain legacy for now

### 9. Test coverage

Add coverage for:

- old and new CLI names
- old and new env vars
- old and new tmux options
- old and new state roots
- install/update flows after repo slug change
- legacy compatibility behavior

Checklist:

- [ ] Add CLI alias tests
- [ ] Add env var alias tests
- [ ] Add tmux option alias tests
- [ ] Add state root compatibility tests
- [ ] Add install-flow tests for renamed repo/plugin paths
- [ ] Run full test suite

### 10. Release and migration communication

Tasks:

- publish release notes explaining the rename
- call out what existing users do and do not need to change
- document deprecated names as supported aliases
- include copy-paste migration examples

Checklist:

- [ ] Draft release notes
- [ ] Write migration examples for tmux config
- [ ] Document compatibility guarantees
- [ ] Document deprecated-but-supported names

## Proposed implementation order

1. Write this plan
2. Inventory all old-name surfaces in code/tests/docs
3. Decide compatibility policy for CLI, tmux options, env vars, and state dirs
4. Add dual-support code paths first
5. Update tests for compatibility
6. Update docs to prefer the new name
7. Rename repo/package metadata
8. Validate install flows end to end
9. Ship release notes and migration guidance

## Risks and watchouts

### 1. Broken existing tmux installs

Risk:

- users may still reference `corwinm/opencode-tmux` in `~/.tmux.conf`
- plugin file names may be assumed by TPM or local scripts

Mitigation:

- keep compatibility entrypoints/shims
- clearly document the old and new TPM snippets during transition

### 2. Split state between old and new directories

Risk:

- one component writes new paths while another only reads old paths

Mitigation:

- make readers dual-compatible before moving writers
- add tests that exercise mixed-version scenarios

### 3. Config fragmentation

Risk:

- some users set old env vars, others set new ones
- conflicting values could be confusing

Mitigation:

- define and document explicit precedence
- optionally warn when both are set to different values

### 4. Partial rename churn

Risk:

- renaming too much internally creates noise without improving user experience

Mitigation:

- prioritize public surfaces first
- defer deep internal symbol cleanup

## Open decisions

- [ ] Should `opencode-tmux` remain a permanent CLI alias?
- [ ] Should `@opencode-tmux-*` remain a permanent tmux option alias?
- [ ] Should `OPENCODE_TMUX_*` remain a permanent env var alias?
- [ ] Should the legacy state dir remain readable forever?
- [ ] Should the old tmux entrypoint file remain in-repo indefinitely?
- [ ] Should the npm package rename happen in the same release or later?

## Success criteria

The rename is successful when:

- new users discover and install the project as `coding-agents-tmux`
- existing users can upgrade without their current setup breaking
- docs consistently present the new name
- tests cover old/new compatibility paths
- runtime integrations continue to work for OpenCode, Codex, and Pi

## Progress tracker

### Current status

- [x] Choose the new project name
- [x] Write a rename plan and checklist
- [ ] Inventory all old-name references in code/docs/tests
- [ ] Decide compatibility policy for public surfaces
- [ ] Implement dual-support aliases
- [ ] Update tests
- [ ] Update docs to prefer the new name
- [ ] Rename repo/package metadata
- [ ] Validate install and migration flows
- [ ] Publish migration guidance

### Notes

- 2026-04-14: Chose `coding-agents-tmux` as the new public name.
- 2026-04-14: Wrote the initial phased rename plan and checklist in `docs/rename-coding-agents-tmux.md`.
