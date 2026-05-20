# Remove legacy rename aliases plan

## Goal

Finish the public rename so `coding-agents-tmux` is the only documented and user-facing project name, except for one short README note that tells existing users the former name and that compatibility aliases may exist during the transition.

## Current target state

- README uses only `coding-agents-tmux` in install, setup, configuration, status, and CLI examples.
- Migration details move out of the README and stay in historical release/migration docs only while they are useful.
- Runtime compatibility aliases have been removed for the next release.
- Tests cover only the current public names.

## What is already done

- README title, install snippet, tmux options, status examples, and CLI examples prefer `coding-agents-tmux`.
- README no longer lists legacy plugin/state/extension paths outside the rename note.
- Canonical tmux entrypoint, package metadata, OpenCode plugin file, Pi extension path, state root, env vars, and tmux options have new-name support.

## Left to do

### Documentation

- [x] Keep only the short rename note in `README.md`; avoid adding legacy examples elsewhere in the README.
- [x] Keep `docs/rename-coding-agents-tmux-migration.md` in the repo as historical migration notes and update it as needed.
- [x] Update `docs/rename-coding-agents-tmux.md` after each cleanup milestone so it reflects current status instead of the original transition plan.
- [x] Audit all docs for accidental legacy-name promotion before release. Current legacy references are confined to README rename note, historical implementation/migration plans, and compatibility-context notes.

### Runtime cleanup

- [x] Decide the deprecation window for legacy CLI, env-var, tmux-option, state-dir, plugin-path, and extension-path aliases: remove them in the next release.
- [x] Decide whether legacy alias usage should emit runtime warnings before removal: no warnings needed because aliases are being removed in the next release.
- [x] Pick the exact release boundary for removing alias support: the next release is the removal boundary.
- [x] Remove legacy aliases only after the communicated transition window.

### Validation

- [x] Run `npm test`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run lint`.
- [x] Run `npm run shell:check`.
- [x] Run `npm run fmt:check`.
- [x] Verify TPM install/reload with the renamed repo and entrypoint.

## Release note checklist

- [x] State that the main README now documents only the new public surfaces.
- [x] Link existing users to the migration guide or release notes if legacy aliases are still supported.
- [x] Clearly state whether aliases are supported, deprecated with warnings, or removed in that release.
