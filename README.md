# pi-ask-user-question

Interactive question tools for [Pi](https://github.com/badlogic/pi-mono) that let an agent pause and ask for a decision instead of guessing.

- **`ask_user_question`** asks one free-form, single-choice, or multiple-choice question.
- **`ask_questions`** collects several related answers in a tabbed form and submits them together.

> **Preview:** No screenshot or animation is included yet. Contributions of an accurate demo are welcome.

## Features

- Single-select, multi-select, and multiline free-form answers
- A custom “Something else…” answer for choice questions
- Optional details, recommended-choice badges, and per-question notes
- Tabbed batch questions with review-before-submit
- Revision of unanswered batch questions without repeating resolved ones
- Inline **Ask agent** clarification flow that preserves relevant answer context
- Width-aware terminal rendering and serialized dialogs
- Structured results for answered, cancelled, unavailable, revise, and clarification states

## Install and use

### From Git

```bash
pi install git:https://github.com/sentabi1/pi-ask-user-question
```

### From a local checkout

```bash
git clone https://github.com/sentabi1/pi-ask-user-question.git
cd pi-ask-user-question
npm install
pi install .
```

Restart Pi if it is already running. The package manifest explicitly loads only `extensions/ask-user-question.ts`; the test module is not an extension entry point.

## Tool parameters

Pi calls these tools on behalf of the model. The examples below show their parameter objects.

### Single choice

```json
{
  "question": "Which database should we use?",
  "details": "For the primary application store",
  "options": [
    { "label": "PostgreSQL", "value": "postgres", "recommended": true },
    { "label": "SQLite", "value": "sqlite", "description": "Simpler deployment" }
  ]
}
```

### Multiple choice

```json
{
  "question": "Which checks should run in CI?",
  "options": [
    { "label": "Tests" },
    { "label": "Typecheck" },
    { "label": "Lint" }
  ],
  "multiSelect": true
}
```

### Free-form

Omit `options` to open the multiline editor:

```json
{
  "question": "What should the release notes emphasize?",
  "details": "A short paragraph is enough."
}
```

### Batch

```json
{
  "questions": [
    {
      "question": "Which runtime should we target?",
      "label": "Runtime",
      "options": [{ "label": "Node.js" }, { "label": "Bun" }]
    },
    {
      "question": "Describe the deployment environment.",
      "label": "Deployment"
    },
    {
      "question": "Select required platforms.",
      "label": "Platforms",
      "options": [{ "label": "Linux" }, { "label": "macOS" }],
      "multiSelect": true
    }
  ]
}
```

Each option requires a nonblank `label`; `value`, `description`, and `recommended` are optional. `multiSelect` is valid only when options are present.

## Keyboard controls

Controls vary with the active field; the UI shows the available actions.

- **Up/Down**: move through choices or review content
- **Enter**: select, confirm, save an edited custom answer, advance, or submit as indicated
- **Space**: select or toggle choices in the batch UI
- **Left/Right**: move between batch questions
- **Tab / Shift+Tab**: move to or from the optional note; in batch mode, cycle question tabs where indicated
- **Shift+Enter** (Ctrl+J in supported terminals): insert a newline in an editor
- **Ctrl+Enter / Alt+Enter**: submit a free-form question while editing its note
- **Ctrl+C**: clear the active text editor where shown
- **Escape**: go back, clear/cancel, or require a second press when answers would be discarded
- **Ctrl+R**: revise unanswered batch questions when some questions are already resolved
- **Ctrl+?** (Ctrl+/ equivalent): ask the agent for clarification; Enter sends it and Escape returns

## Non-TUI behavior

The tools require Pi's interactive TUI. In RPC, print, or other non-interactive modes they do not prompt on stdin: they return a structured `unavailable` result. An already-aborted call returns `cancelled`.

## Security

Question text, answer text, notes, and clarification requests become tool results and may be sent to the active model provider or retained in session history. Do not enter secrets unless you trust that provider and your Pi configuration. This package does not add network requests or credential storage of its own.

## Compatibility

The package uses the current Pi extension API and declares `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` as peer dependencies with `*`, as recommended for Pi packages. It is intended for current Pi releases and terminals that support the displayed key sequences. Older Pi/TUI versions are not tested.

## Optional herdr interoperability

While a dialog is open, the extension emits `herdr:blocked` on Pi's shared event bus:

```ts
{ active: true, label: "Waiting for your answer" }
{ active: false }
```

Batch dialogs use “Waiting for your answers”. This is optional interoperability metadata; no herdr package is required.

## Known limitations

- Questions are interactive only in TUI mode.
- Only one question dialog is shown at a time.
- Key handling depends on the terminal correctly reporting modified keys; Ctrl+/ is accepted as an equivalent encoding for Ctrl+?.
- The package has no screenshot or animation yet.
- Compatibility with older Pi versions and every terminal emulator is not guaranteed.

## Development

```bash
npm install
npm test
npm run typecheck
npm run pack:check
```

`npm test` runs the focused interaction and rendering regression test. `pack:check` prints the files that would be published without creating or publishing a release.

## Contributing

Issues, focused pull requests, terminal compatibility reports, documentation improvements, and an honest demo asset are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). This project is licensed under the [MIT License](LICENSE).
