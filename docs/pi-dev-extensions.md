# Pi extension-driven waiting state: implementation plan

## Goal

Add an extensible path for **custom Pi extensions** to tell `coding-agents-tmux` that a Pi pane is currently **waiting on the user**, even when that waiting state happens inside a custom tool or custom UI flow.

Primary target use case:

- a user writes a custom Pi extension tool such as `ask_user_question`
- that tool opens a Pi UI prompt (`ctx.ui.input()`, `ctx.ui.select()`, `ctx.ui.confirm()`, or `ctx.ui.custom()`)
- while the tool is waiting, `coding-agents-tmux` should mark the pane as:
  - `waiting-input` for freeform answers
  - `waiting-question` for structured choice flows
- once the user answers or cancels, the pane should return to normal lifecycle-driven state

This plan is intentionally about **external tmux/runtime status**, not just Pi's local footer status.

## Background

Current Pi support already works like this:

- `plugin/pi-tmux.ts` is installed as a bundled Pi extension
- that extension writes normalized Pi runtime state files under the Pi state directory
- `src/core/pi.ts` reads those state files and maps them onto `RuntimeInfo`
- `coding-agents-tmux` then uses that normalized runtime state for list/switch/popup/status views

Current limitation:

- `plugin/pi-tmux.ts` only derives state from lifecycle events such as:
  - `session_start`
  - `agent_start`
  - `turn_start`
  - `agent_end`
  - `session_shutdown`
- `agent_end` does only best-effort text heuristics to classify `waiting-input`
- there is currently **no explicit extensibility hook** for a separate Pi extension to say:
  - "this pane is waiting for a custom extension prompt right now"

That means custom tools can show waiting **inside Pi** with `ctx.ui.setStatus()`, but they cannot reliably update the **tmux-facing** status.

## Desired outcome

After this work, third-party Pi extensions should be able to do something like:

1. emit an event saying "set pane waiting status"
2. wait for user input inside Pi
3. emit an event saying "clear that waiting status"

The bundled Pi bridge extension should remain the **single writer** of the normalized Pi state file.

## Design principles

### 1. Keep a single authoritative state writer

We should **not** have arbitrary third-party Pi extensions write directly into:

- `~/.local/state/coding-agents-tmux/pi-state`

Reasons:

- avoids file write races
- avoids schema drift across extensions
- avoids every extension needing to know tmux pane mapping and state file naming
- keeps future state evolution centralized

### 2. Use Pi's extension event bus for extensibility

Pi extensions already support cross-extension communication through `pi.events`.

That is the cleanest integration point:

- custom extensions emit semantic state override events
- `plugin/pi-tmux.ts` listens for them
- the bundled bridge merges them with lifecycle state and persists the effective state

### 3. Preserve lifecycle-driven defaults

The current lifecycle-based Pi status should remain the default baseline.

The new extension-driven waiting state should be an **override layer**, not a replacement for the existing model.

### 4. Support both waiting modes already used by the repo

The repo already understands both:

- `waiting-input`
- `waiting-question`

We should let Pi extensions publish both so tmux UI can distinguish:

- freeform answer flows
- structured question / option picker flows

## Proposed architecture

### Current shape

Today `plugin/pi-tmux.ts` roughly does:

- listen to lifecycle events
- derive a status
- write state file

### Proposed shape

`plugin/pi-tmux.ts` should instead maintain:

- `baseState`: derived from normal Pi lifecycle events
- `overrides`: transient extension-driven status overrides keyed by id
- `effectiveState`: the state actually written to disk

High-level flow:

1. lifecycle event updates `baseState`
2. custom extension emits override event(s)
3. bundled Pi bridge updates `overrides`
4. bundled Pi bridge computes `effectiveState = strongest override or baseState`
5. bundled Pi bridge writes `effectiveState` to the Pi state file
6. `src/core/pi.ts` keeps reading the same normalized file format as before

## Proposed event contract

Use Pi's shared extension event bus.

### Proposed event name

```ts
"coding-agents-tmux:status";
```

This is intentionally simple and namespaced.

### Proposed payload

```ts
type CodingAgentsTmuxStatusEvent =
  | {
      op: "set";
      id: string;
      status: "running" | "waiting-input" | "waiting-question" | "idle";
      activity?: "busy" | "idle" | "unknown";
      detail: string;
      priority?: number;
    }
  | {
      op: "clear";
      id: string;
    };
```

### Field guidance

- `id`
  - unique key for the override
  - recommended: use the tool call id for tool-backed flows
- `status`
  - `waiting-input` for freeform responses
  - `waiting-question` for confirm/select/multiple-choice flows
- `activity`
  - defaults should be derived if omitted
  - waiting states should normally imply `busy`
- `detail`
  - human-readable detail stored in the state file
  - example: `"Waiting for answer: Which deployment target should I use?"`
- `priority`
  - optional escape hatch if multiple overrides are active
  - can be omitted in v1 if we use fixed status precedence instead

## Status precedence proposal

If multiple overrides are active, the bundled Pi bridge should select the strongest one.

Recommended precedence:

1. `waiting-question`
2. `waiting-input`
3. `running`
4. `idle`

If no overrides are active:

- fall back to lifecycle-derived `baseState`

Recommended activity defaults:

- `waiting-question` -> `busy`
- `waiting-input` -> `busy`
- `running` -> `busy`
- `idle` -> `idle`

## Proposed bundled Pi bridge changes

### File: `plugin/pi-tmux.ts`

Planned changes:

#### 1. Extend local Pi extension API typing

The local lightweight `PiExtensionAPI` type in `plugin/pi-tmux.ts` should be updated to include:

- `pi.events.on(...)`
- optionally typed payload helpers local to this file

#### 2. Store last usable context data

The event bus callback itself does not receive the normal Pi `ctx`, so the bundled extension should keep enough session-local data in memory to persist updated state when override events arrive.

At minimum retain:

- current cwd
- current session file
- current session name/title
- pane id
- last known target

#### 3. Split base state from effective state

Refactor state handling into something like:

- `setBaseState(...)`
- `setOverride(...)`
- `clearOverride(id)`
- `computeEffectiveState()`
- `persistEffectiveState()`

#### 4. Add override map

Maintain:

```ts
const overrides = new Map<string, StatusOverride>();
```

Each override should carry at least:

- `id`
- `status`
- `activity`
- `detail`
- `updatedAt`
- optional `priority`

#### 5. Compute effective state before writing

Every state write should go through a merge step:

- start from `baseState`
- apply highest-priority active override, if any
- write the merged state file

#### 6. Widen Pi state status support

The local `PiStateFile` typing in `plugin/pi-tmux.ts` should be widened to support:

- `waiting-question`

The rest of the repo already understands this status.

#### 7. Preserve existing lifecycle behavior

Do not remove the current lifecycle mapping.

Lifecycle remains responsible for:

- `new`
- `running`
- `idle`
- best-effort default `waiting-input`

The extension override layer only improves fidelity for custom flows.

## Proposed custom extension usage

A custom Pi extension tool should be able to do this pattern:

1. emit a waiting override before prompting the user
2. optionally set a local Pi footer status with `ctx.ui.setStatus()`
3. await `ctx.ui.input()`, `ctx.ui.select()`, `ctx.ui.confirm()`, or `ctx.ui.custom()`
4. clear the waiting override in a `finally` block

Example shape:

```ts
pi.events.emit("coding-agents-tmux:status", {
  op: "set",
  id: toolCallId,
  status: "waiting-input",
  activity: "busy",
  detail: `Waiting for answer: ${params.question}`,
});

try {
  const answer = await ctx.ui.input(params.question, "Type your answer...");
  // ... return tool result
} finally {
  pi.events.emit("coding-agents-tmux:status", {
    op: "clear",
    id: toolCallId,
  });
}
```

For structured choices:

```ts
pi.events.emit("coding-agents-tmux:status", {
  op: "set",
  id: toolCallId,
  status: "waiting-question",
  detail: `Waiting for user choice: ${params.question}`,
});
```

## Compatibility considerations

### No changes needed in `src/core/pi.ts`

`src/core/pi.ts` already reads normalized Pi state files and already supports both:

- `waiting-input`
- `waiting-question`

So if `plugin/pi-tmux.ts` writes those states, the rest of the pipeline should continue to work with little or no change.

### Backward compatibility

If no custom extension emits override events:

- Pi support should behave exactly as it does today

If a user has the bundled Pi extension installed but an older version is still loaded in a running Pi session:

- behavior remains unchanged until that Pi session restarts

## Failure handling

The override flow should fail safely.

If a custom extension emits malformed data or throws before clearing:

- malformed events should be ignored
- stale overrides should not permanently poison the session

Possible protections:

- validate incoming event payloads defensively
- support overwrite on repeated `set` for the same `id`
- optionally expire very old overrides on lifecycle transitions or on a max age timeout

Recommended v1 behavior:

- validate shape
- ignore malformed payloads
- remove overrides explicitly on `clear`
- clear all overrides on `agent_end` and `session_shutdown`

That keeps stale waiting states from surviving past a completed run.

## Implementation phases

### Phase 0: planning

- [ ] Write this plan doc
- [ ] Confirm event naming and payload shape
- [ ] Confirm whether `priority` is needed in v1

### Phase 1: bundled Pi bridge refactor

- [ ] Update local typings in `plugin/pi-tmux.ts` to support `pi.events`
- [ ] Refactor current persistence logic into base-state + effective-state flow
- [ ] Add transient override storage
- [ ] Merge override state before persisting
- [ ] Add support for `waiting-question` in local Pi bridge typing

### Phase 2: lifecycle and cleanup behavior

- [ ] Ensure `agent_start` / `turn_start` update only base state
- [ ] Ensure `agent_end` recomputes effective state after lifecycle change
- [ ] Clear overrides on `agent_end`
- [ ] Clear overrides on `session_shutdown`
- [ ] Confirm state files never remain stuck in waiting mode after completion

### Phase 3: tests

Add or extend tests for:

- [ ] single waiting override -> state file becomes `waiting-input`
- [ ] structured waiting override -> state file becomes `waiting-question`
- [ ] clear event -> state falls back to lifecycle-derived state
- [ ] multiple overrides -> strongest status wins
- [ ] malformed payload -> ignored safely
- [ ] `agent_end` clears stale overrides
- [ ] `src/core/pi.ts` reads resulting waiting states unchanged

Suggested test files:

- `test/pi.test.ts`
- possibly a new focused test around bundled Pi extension behavior if needed

### Phase 4: documentation

- [ ] Document the event contract for third-party Pi extensions
- [ ] Add a minimal custom extension example
- [ ] Update README Pi section if this becomes a supported extension surface

## Suggested documentation snippet for extension authors

If this lands as a supported integration point, document a small recipe like:

- set local Pi footer status with `ctx.ui.setStatus()` for in-Pi visibility
- emit `coding-agents-tmux:status` `set` before awaiting user input
- emit `clear` in `finally`
- prefer:
  - `waiting-input` for freeform input
  - `waiting-question` for selects/confirms/options

## Risks and tradeoffs

### Risk: event contract becomes semi-public API

Once documented, other extensions may rely on it.

Mitigation:

- keep the payload very small
- document only the supported fields
- keep the bundled bridge tolerant of unknown fields

### Risk: stale overrides if extension forgets to clear

Mitigation:

- recommend `try/finally`
- clear overrides automatically on `agent_end`
- optionally add future TTL cleanup if needed

### Risk: multiple extensions emit competing overrides

Mitigation:

- fixed precedence rules
- optional `priority` only if real use cases require it

## Recommendation

Implement this as an **event-bus-driven override layer inside `plugin/pi-tmux.ts`**.

That gives us:

- a clean extensibility surface for custom Pi extensions
- no direct third-party writes to state files
- minimal change to the rest of the repo
- reuse of the repo's existing waiting status model

## Short version

The clean architecture is:

- **custom Pi extension** emits waiting status intent through `pi.events`
- **bundled Pi bridge** listens, merges with lifecycle state, and writes the normalized Pi state file
- **`src/core/pi.ts`** keeps reading the same normalized state file format
- **`coding-agents-tmux`** immediately reflects that pane as waiting
