# pi-context-seeker

share context, seek the seams, and make a decision.
call out the unknown!

**TLDR:** (yes the juice is worth the squeeze)

- ask for more questions and you shall receive!
- regenerate remaining questions based on answers and notes (if q1 changes direction, that context carries forward)
- ask for clarity between questions (never answer a question you don't understand!)
- stop anytime and submit only what you've answered (you're free!)
- recommended options show first if you're more of a glancer 
- shared understanding, less assumptions, it's always cheaper to ask!

- already interested? check out [installation](#installation)! hope you enjoy :)

**Usage:**
- best for work where understanding grows as decisions compound
  - dictation in the notes + regeneration is good for getting the thoughts out
- the most fruitful conversations happen at the edge of shared understanding

## everything underneath is vibed but the above is Lived

Adaptive questions for building shared context with the [Pi Coding Agent](https://github.com/earendil-works/pi)—giving you precise control over what an agent learns, making efficient use of its context window, and reducing tokens wasted on guesses and rework.

## Highlights

- **Regenerate unanswered questions from completed answers.** Answer the useful parts of a batch, press **Ctrl+R**, and let the agent replace only the questions that no longer fit. Your resolved answers and notes become context for the new questions instead of being asked again.
- **Submit what you answered and explicitly skip the rest.** Press **Ctrl+Enter** to review completed answers, see exactly which questions will be skipped, and submit only after confirming the review.
- **Attach notes to individual answers.** Keep the selected option clear while adding its caveats, conditions, or reasoning exactly where they belong.
- **Ask the agent what a question means without leaving the dialog.** Ask about ambiguous wording before a misunderstanding becomes part of the work.
- **Mix the right response types.** Use single-choice, multi-select, custom **Something else…** answers, and multiline free-form input in the same batch.
- **Review the whole batch before submitting it.** Catch accidental choices and see related decisions together before committing them to the conversation.
- **Spend context on decisions, not repairs.** Batch related unknowns, preserve resolved answers, and regenerate only what is stale instead of burning tokens on repeated clarification or work based on bad assumptions.

The package exposes three tools:

- **`ask_user_question`** asks one free-form, single-choice, or multiple-choice question.
- **`ask_questions`** starts on the first question, lets you move through related questions, and submits them together after review. It also accepts resume-shaped arguments only as a compatibility path for conversations whose tool list predates `resume_questions`.
- **`resume_questions`** is the canonical continuation-only tool the agent uses after a paused batch clarification. It can atomically revise only clean later questions while preserving batch identity, numbering, drafts, answers, and notes.

## Best usage: ask after every request

Append a prompt like this to every request:

> **Before you start, what answers do you need from me? Use the context you already have, think of as many useful questions as you can, and ask me everything that would materially improve the result.**

Give the agent as much relevant context as you can, especially context already shared in the conversation or project. The agent can use `ask_questions` to turn the remaining unknowns into one focused batch instead of guessing, repeatedly interrupting the work, or filling the conversation with misunderstood assumptions. This also makes the model think about what it needs to help you think—not only what it needs to execute the request.

More useful context usually produces better work. A question batch creates a quick path to shared understanding: answer what you know, add notes where nuance matters, and open an inline Ask agent thread on the current question. The agent can then resume the same frame with your transcript and state intact, while adapting only clean later questions that the clarification made stale.

### Regenerate unanswered questions

You do not have to finish a batch whose later questions no longer fit. After answering at least one question, leave the questions that need rethinking unanswered and press **Ctrl+R**. The plugin returns your completed answers and notes to the agent as new context, preserves them as resolved, and asks the agent to replace only the unanswered questions. The next batch can therefore adapt to everything you have said without making you answer the same questions again.

This loop can continue until you and the agent share enough context to proceed:

1. The agent asks a broad, useful batch.
2. Your answers change or sharpen its understanding.
3. **Regenerate unanswered** replaces stale questions with better ones.
4. The agent starts the work once the important unknowns are resolved.

### Submit answered questions and skip the rest

When the answers you have already provided are enough, press **Ctrl+Enter**. The review clearly marks every unanswered question as **skipped** and keeps **Enter Submit** as a separate confirmation. This is distinct from **Escape**, which cancels the whole batch, and **Ctrl+R**, which asks the agent to regenerate the unanswered questions.

### Questions as context management

The dialog is also a small context editor. It gives you control over both the shape of your response and what the agent treats as settled:

- **Choices constrain scope.** Select a precise option when the decision is bounded, use multi-select when several items belong together, or choose **Something else…** when the offered frame is wrong.
- **Free-form answers preserve depth.** Open-ended questions use a multiline editor instead of forcing nuanced input into a menu.
- **Notes separate the rule from the exception.** Keep the main answer easy to interpret while attaching caveats, conditions, or reasoning to that question.
- **Review prevents accidental context.** A batch is not final until you inspect and submit it.
- **Clarification prevents false agreement.** Ask from the current question without leaving its frame. A read-only Preview browses one complete referenced question at a time, and clean later questions may be sparsely adapted when the agent resumes.
- **Regeneration keeps context current.** Ctrl+R remains the separate broader flow: resolved answers remain explicit context while the remaining batch is regenerated.

The result is higher-signal conversation history. Instead of mixing requirements, uncertainty, corrections, and guesses into one long message, the tool returns structured answers and notes that show what you chose, what you qualified, and what still needs work.

That can also make better use of a limited token budget. Asking a focused batch has an upfront cost, but it can avoid repeated clarification turns, discarded implementations, and obsolete assumptions taking up the context window. This is especially useful with local models that have smaller context windows, metered APIs, or any workflow where cost and context pressure matter.

## Comparison

These tools share the same basic goal, but optimize for different workflows. This comparison reflects **Claude Code 2.1.221**, **Codex CLI 0.146.1**, and the current version of this package; upstream behavior can change quickly.

| Capability | `pi-context-seeker` | Claude Code `AskUserQuestion` | Codex `request_user_input` |
|---|---|---|---|
| Questions per batch | 1 or more; no schema maximum | 1–4 | 1–3 |
| Choice options | 1 or more; no schema maximum | 2–4 | 2–3 |
| Native open-ended question | **Yes** — omit options | No — use the automatic custom-text choice | No — use the automatic custom-text choice |
| Custom answer alongside choices | **Yes** — **Something else…** | **Yes** — **Other** | **Yes** — **Other** |
| Multi-select | **Yes** | **Yes** | No |
| Explicit recommendation field and badge | **Yes** | No — recommendation is a label convention | No — recommendation is a label convention |
| Per-question answer notes | **Yes** | Limited to supported preview/annotation flows | No |
| Review before final submission | **Yes** | **Yes** | Batch submission, but no separate review screen |
| Ask the agent for clarification inside the dialog | **Yes** | **Yes** — **Chat about this** | No |
| Dedicated “regenerate unanswered only” action | **Yes** | Partial — chat can lead Claude to reformulate questions | No |
| Explicit partial submit that marks the rest skipped | **Yes** | No | No |
| Preserve resolved answers while questions are regenerated | **Yes** | Partial — current answers are returned as clarification context | No dedicated regeneration flow |
| Visual/code previews for options | No | **Yes** | No |
| Structured result returned to the agent | **Yes** | **Yes** | **Yes** |
| Availability | Pi interactive TUI | Claude Code | Depends on the active Codex mode and tool list |

The main difference is not merely how many questions fit in one dialog. This package is designed for a longer **question → answer → regenerate → shared understanding** loop, with native free-form input and per-question notes. Claude Code has a smaller batch limit and richer option previews. Codex keeps the interaction compact and decision-oriented.

> **Preview:** No screenshot or animation is included yet. Contributions of an accurate demo are welcome.

## Additional features

- Optional question details and recommended-choice badges
- Width-aware terminal rendering and serialized dialogs
- Structured results for answered, cancelled, unavailable, regeneration, and clarification states

## Installation

### From npm (recommended)

```bash
pi install npm:pi-context-seeker
```

To update an existing npm installation:

```bash
pi update npm:pi-context-seeker
```

### From Git

```bash
pi install git:https://github.com/the-sleeping-teemo/pi-context-seeker
```

### From a local checkout

Use this option when developing or testing local changes:

```bash
git clone https://github.com/the-sleeping-teemo/pi-context-seeker.git
cd pi-context-seeker
npm install
pi install .
```

Restart Pi if it is already running. The package manifest explicitly loads only `extensions/context-seeker.ts`; test modules are not extension entry points.

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

- **Up/Down**: move focus through choices without changing the selected answer, or scroll review content
- **Space** (single-select): select the focused answer, replace the prior selection, or toggle the focused selection off. On an empty **Something else…**, it opens the custom-answer editor
- **E** (single-select): while **Something else…** is focused, open its editor. Saved text is preserved and editing resumes at the end, whether the custom answer is selected or cached after being toggled off
- **Enter** (single-select): confirm and advance only when an answer is already selected. With no selection, the question stays open and shows guidance
- **1–9** (choices): focus that numbered answer and apply the same selection action as **Space**; numeric shortcuts never confirm or advance
- **Enter** (other fields): save an edited custom answer, advance text and multi-select questions, or submit as indicated
- **Left/Right** (batch): with no answers, cycle through questions while Review stays unavailable (`○`). After the first answer is saved, Review joins the cycle after the last question and wraps in both directions. Partial Review is marked `◐`; complete Review remains available and is marked `✓`
- **Tab / Shift+Tab**: move to or from the optional note; in batch mode, cycle question tabs where indicated
- **Shift+Enter** (Ctrl+J in supported terminals): insert a newline in an editor
- **Ctrl+Enter / Alt+Enter** (single question): submit a free-form question while editing its note
- **Ctrl+C**: clear the active answer, custom-answer, or note editor where shown
- **Escape**: go back, clear/cancel, or require a second press when answers would be discarded
- **Ctrl+Enter** (batch): open Review directly from any question once at least one answer exists, without confirming each answer with **Enter**. Partial Review shows every unanswered question as skipped
- **Ctrl+R**: regenerate unanswered batch questions when some questions are already resolved
- **Ctrl+/**: open Ask agent on the current question (Ctrl+? is also accepted); the multiline editor receives focus immediately
- **Tab / Shift+Tab** (Ask agent): enter a read-only **Preview**, or return to Compose with the draft and insertion point unchanged
- **Left / Right** (batch Preview): browse one complete question at a time, wrapping at both ends without changing the active question or answer state
- **Up / Down, PageUp / PageDown** (batch Preview): move through the normal read-only choice window when needed
- Standalone Preview supports **Tab / Shift+Tab** to return to Compose and **Escape** to close Ask agent; it has no cross-question navigation
- **Enter** (Compose only): submit; Preview ignores text and submit keys. **Escape** closes Ask agent in one step and keeps the original question active
- The batch retains one shared clarification transcript in continuation data. Agent answers stay as complete assistant messages in the main chat; the preserved ordinary question form then reopens. The immutable opening question controls resume position and later-question revision eligibility. Revised clean later questions show **Updated** until you first interact with them.

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
- Key handling depends on the terminal correctly reporting modified keys; Ctrl+? is also accepted as an equivalent encoding for Ctrl+/.
- The package has no screenshot or animation yet.
- Compatibility with older Pi versions and every terminal emulator is not guaranteed.

## Development

```bash
npm install
npm test
npm run typecheck
npm run pack:check
```

`npm test` runs the focused interaction and rendering regression tests. `pack:check` prints the files that would be published without creating or publishing a release.

There is intentionally no build script. Pi loads extension `.ts` files directly through jiti, and this package publishes `extensions/context-seeker.ts` rather than generated JavaScript. Use `npm run typecheck` for compile-time validation and `npm run pack:check` to verify the publish contents.

## Contributing

Issues, focused pull requests, terminal compatibility reports, documentation improvements, and an honest demo asset are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). This project is licensed under the [MIT License](LICENSE).
