import { Key, type KeybindingsManager, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AskAnswer, OtherAnswer, OptionAnswer, QuestionDef, TabAnswer, TabState } from "./domain.ts";
import { getOtherLabel } from "./domain.ts";
import { addWrapped, addWrappedWithPrefix, constrainFrameHeight, createNoteEditor, createQuestionEditor, isAskAgentKey, isSubmitEnter, normalizeFocusCycleKey, renderOptionalNote, sanitizeDisplayText, sanitizeEditorDisplay, sanitizeProgressLabel, truncateLabel, WrappedChoiceList, type WrappedChoiceItem } from "./tui-primitives.ts";

export type BatchUIResult = TabAnswer[] | { action: "regenerate"; answers: TabAnswer[] } | { action: "clarification"; clarification: string; answers: TabAnswer[]; activeQuestionIndex: number } | null;

export class TabbedQuestions {
	private questions: QuestionDef[];
	private tabs: TabState[];
	private activeTab: number;
	private done: (result: any) => void;
	private tui: any;
	private theme: any;
	private cachedWidth?: number;
	private cachedRows?: number;
	private cachedLines?: string[];
	private editMode: boolean;
	private editor: any;
	private choiceList: WrappedChoiceList | null;
	private selected: Map<string, AskAnswer>;
	private otherText: string;
	private otherEditor: ReturnType<typeof createQuestionEditor>;
	private _focused: boolean;
	private noteEditor: ReturnType<typeof createNoteEditor>;
	private noteFocused: boolean;
	private cancelArmed: boolean;
	private keybindings: KeybindingsManager;
	private tabChoiceLists: Map<number, WrappedChoiceList>;
	private reviewing: boolean;
	private partialReview: boolean;
	private reviewScroll: number;
	private feedback: string;
	private clarificationEditor: ReturnType<typeof createQuestionEditor>;
	private clarificationMode: boolean;

	constructor(
		questions: QuestionDef[],
		tui: any,
		theme: any,
		keybindings: KeybindingsManager,
		done: (result: any) => void,
	) {
		this.questions = questions;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.activeTab = 0;
		this.editMode = false;
		this._focused = false;
		this.selected = new Map();
		this.otherText = "";
		this.choiceList = null;
		this.tabChoiceLists = new Map();
		this.reviewing = false;
		this.partialReview = false;
		this.reviewScroll = 0;
		this.feedback = "";
		this.clarificationMode = false;
		this.clarificationEditor = createQuestionEditor(tui, theme);

		this.otherEditor = createQuestionEditor(tui, theme);
		this.otherEditor.onSubmit = (value: string) => {
			const trimmed = value.trim();
			if (!trimmed) {
				this.feedback = "Custom answer required.";
				this.invalidate();
				tui.requestRender();
				return;
			}
			this.feedback = "";
			this.otherText = trimmed;
			const tab = this.getActiveTab();
			if (tab) tab.otherText = trimmed;
			if (tab && tab.mode === "single-select") {
				const answer: AskAnswer = { type: "other" as const, label: trimmed, value: trimmed };
				tab.answer = answer;
				this.selected = new Map();
				this.selected.set("other", answer);
				tab.selected = new Map(this.selected);
				this.editMode = false;
				this.otherEditor.focused = false;
				this.invalidate();
				tui.requestRender();
				return;
			}
			this.selected.set("other", { type: "other" as const, label: trimmed, value: trimmed });
			this.editMode = false;
			this.otherEditor.focused = false;
			this.syncMultiSelectState();
			this.invalidate();
			tui.requestRender();
		};

		this.editor = createQuestionEditor(tui, theme);

		this.noteEditor = createNoteEditor(tui, theme);
		this.noteFocused = false;
		this.cancelArmed = false;

		// Initialize tabs
		const tabs: TabState[] = [];
		for (let i = 0; i < questions.length; i++) {
			const q = questions[i];

			tabs.push({
				questionIndex: i,
				mode: q.mode,
				answer: null,
				textBuffer: "",
				otherText: "",
				selected: new Map(),
				note: "",
			});
		}
		this.tabs = tabs;

		// Prepare active tab
		this.prepareActiveTab();

		if (this.tabs.length > 0) {
			this.noteEditor.setText(this.tabs[this.activeTab].note || "");
		}
	}

	private snapshot(): TabAnswer[] {
		if (this.editMode) this.preserveOtherDraft();
		else this.syncAnswerFromTab();
		return this.tabs.map((tab, index) => ({
			questionIndex: index,
			answer: tab.answer,
			note: tab.note,
		}));
	}

	private clarificationSnapshot(): TabAnswer[] {
		if (!this.editMode) return this.snapshot();

		this.preserveOtherDraft();
		const customAnswer = this.otherText.trim();
		return this.tabs.map((tab, index) => {
			let answer = tab.answer;
			if (index === this.activeTab && tab.mode === "single-select") {
				answer = customAnswer
					? { type: "other", label: customAnswer, value: customAnswer }
					: null;
			} else if (index === this.activeTab && tab.mode === "multi-select") {
				const draftSelection = new Map(this.selected);
				if (customAnswer) draftSelection.set("other", { type: "other", label: customAnswer, value: customAnswer });
				else draftSelection.delete("other");
				const values = Array.from(draftSelection.values());
				answer = values.length > 0 ? values : null;
			}
			return { questionIndex: index, answer, note: tab.note };
		});
	}

	private getActiveTab(): TabState {
		return this.tabs[this.activeTab];
	}

	private saveOtherDraft(): void {
		const tab = this.getActiveTab();
		this.preserveOtherDraft();
		const customAnswer = this.otherText.trim();
		if (customAnswer) {
			const answer: OtherAnswer = { type: "other", label: customAnswer, value: customAnswer };
			if (tab.mode === "single-select") {
				tab.answer = answer;
				this.selected = new Map([["other", answer]]);
			} else {
				this.selected.set("other", answer);
				tab.answer = Array.from(this.selected.values());
			}
		} else {
			this.selected.delete("other");
			if (tab.mode === "single-select") {
				if (tab.answer && typeof tab.answer === "object" && !Array.isArray(tab.answer) && tab.answer.type === "other") {
					tab.answer = null;
				}
			} else {
				const answers = Array.from(this.selected.values());
				tab.answer = answers.length > 0 ? answers : null;
			}
		}
		tab.selected = new Map(this.selected);
	}

	private preserveOtherDraft(): void {
		this.otherText = this.otherEditor.getText();
		this.getActiveTab().otherText = this.otherText;
	}

	private canRegenerate(): boolean {
		let answeredCount = this.tabs.filter((tab) => this.isAnswered(tab)).length;
		const activeTab = this.getActiveTab();
		if (this.editMode && !this.isAnswered(activeTab) && this.otherEditor.getText().trim()) answeredCount++;
		return answeredCount > 0 && answeredCount < this.tabs.length;
	}

	private focusNote(): void {
		this.cancelArmed = false;
		if (this.editMode) {
			this.saveOtherDraft();
			this.editMode = false;
			this.otherEditor.focused = false;
		} else {
			this.syncAnswerFromTab();
		}
		this.noteFocused = true;
		this.noteEditor.focused = this._focused;
		this.invalidate();
		this.tui.requestRender();
	}

	private leaveNoteFocus(): void {
		this.noteFocused = false;
		this.noteEditor.focused = false;
		const tab = this.getActiveTab();
		tab.note = this.noteEditor.getText();
		if (tab.mode === "text") this.editor.focused = this._focused;
		this.invalidate();
		this.tui.requestRender();
	}


	private syncAnswerFromTab(): void {
		const tab = this.getActiveTab();
		if (!tab) return;
		if (tab.mode === "text") {
			const val = this.editor?.getExpandedText?.() ?? "";
			tab.answer = val;
			tab.textBuffer = val;
		} else if (tab.mode === "multi-select") {
			const vals = Array.from(this.selected.values());
			tab.answer = vals.length > 0 ? vals : null;
		}
		if (tab.mode !== "text") tab.otherText = this.otherText;
		tab.note = this.noteEditor.getText();
	}

	private syncMultiSelectState(): void {
		const tab = this.getActiveTab();
		if (!tab || tab.mode !== "multi-select") return;
		tab.selected = new Map(this.selected);
		const vals = Array.from(this.selected.values());
		tab.answer = vals.length > 0 ? vals : null;
		this.invalidate();
		this.tui.requestRender();
	}

	private selectTab(index: number): void {
		if (index < 0 || index >= this.tabs.length || (!this.reviewing && index === this.activeTab)) return;
		this.feedback = "";
		if (!this.reviewing) this.syncAnswerFromTab();
		this.reviewing = false;
		this.partialReview = false;
		this.activeTab = index;
		this.editMode = false;
		this.noteFocused = false;
		this.cancelArmed = false;
		this.otherEditor.focused = false;
		this.editor.focused = false;
		this.noteEditor.focused = false;
		this.prepareActiveTab();
		this.noteEditor.setText(this.tabs[index].note || "");
		this.invalidate();
		this.tui.requestRender();
	}

	private prepareActiveTab(): void {
		const tab = this.getActiveTab();
		if (!tab) return;
		if (tab.mode === "text") {
			this.editor.setText(tab.textBuffer || "");
			this.editor.focused = true;
		} else if (tab.mode === "single-select" || tab.mode === "multi-select") {
			this.selected = new Map(tab.selected || new Map());
			this.otherText = tab.otherText;
		}
		this.noteEditor.setText(tab.note || "");
	}

	private regenerate(): void {
		// Ctrl+R bypasses the custom editor's submit handler, so commit its
		// nonblank draft before checking whether regeneration is available.
		if (this.editMode) this.saveOtherDraft();
		this.syncAnswerFromTab();
		const answers = this.snapshot().map((answer) => ({ ...answer, note: answer.note || "" }));
		const answeredCount = this.tabs.filter((tab) => this.isAnswered(tab)).length;
		if (answeredCount === 0) {
			this.feedback = "Answer a question first.";
		} else if (answeredCount === this.tabs.length) {
			this.feedback = "All answered. Use Review.";
		} else {
			this.done({ action: "regenerate", answers });
			return;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private isAnswered(tab: TabState): boolean {
		if (typeof tab.answer === "string") return tab.answer.trim().length > 0;
		return tab.answer !== null && (!Array.isArray(tab.answer) || tab.answer.length > 0);
	}

	private advance(): void {
		if (this.activeTab < this.tabs.length - 1) this.selectTab(this.activeTab + 1);
		else this.openReview();
	}

	private openReview(allowSkipped = false): void {
		// Ctrl+Enter can be pressed from any editable field. Preserve the active
		// draft before deciding which questions are answered.
		if (this.editMode) this.saveOtherDraft();
		else this.syncAnswerFromTab();

		const answeredCount = this.tabs.filter((tab) => this.isAnswered(tab)).length;
		if (allowSkipped && answeredCount === 0) {
			this.feedback = "Answer a question first.";
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (!allowSkipped) {
			for (let i = 0; i < this.tabs.length; i++) {
				const tab = this.tabs[i];
				if (!this.isAnswered(tab)) {
					this.activeTab = i;
					this.editMode = false;
					this.noteFocused = false;
					this.otherEditor.focused = false;
					this.noteEditor.focused = false;
					this.prepareActiveTab();
					this.feedback = `Answer question ${i + 1} before Review.`;
					this.invalidate();
					this.tui.requestRender();
					return;
				}
			}
		}
		this.reviewing = true;
		this.partialReview = answeredCount < this.tabs.length;
		this.reviewScroll = 0;
		this.editMode = false;
		this.noteFocused = false;
		this.cancelArmed = false;
		this.otherEditor.focused = false;
		this.noteEditor.focused = false;
		this.editor.focused = false;
		this.invalidate();
		this.tui.requestRender();
	}

	private submitAll(): void {
		if (!this.reviewing) return this.openReview();
		this.done(this.snapshot().map((answer) => ({ ...answer, note: answer.note || "" })));
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedRows = undefined;
		this.cachedLines = undefined;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(val: boolean) {
		this._focused = val;
		this.invalidate();
		if (this.clarificationMode) {
			this.clarificationEditor.focused = val;
		} else if (this.editMode) {
			this.otherEditor.focused = val;
		} else if (this.noteFocused) {
			this.noteEditor.focused = val;
		} else {
			const tab = this.getActiveTab();
			if (tab?.mode === "text") {
				this.editor.focused = val;
			}
		}
	}

	handleInput(data: string): void {
		if (this.clarificationMode) {
			if (matchesKey(data, Key.escape)) {
				this.clarificationMode = false;
				this.clarificationEditor.focused = false;
				if (this.editMode) this.otherEditor.focused = this._focused;
				else if (this.noteFocused) this.noteEditor.focused = this._focused;
				else if (this.getActiveTab()?.mode === "text") this.editor.focused = this._focused;
				this.feedback = "";
			} else if (isSubmitEnter(data)) {
				const clarification = this.clarificationEditor.getExpandedText().trim();
				if (!clarification) this.feedback = "Question required.";
				else return this.done({ action: "clarification", clarification, answers: this.clarificationSnapshot(), activeQuestionIndex: this.activeTab });
			} else {
				this.clarificationEditor.handleInput(data);
				this.feedback = "";
			}
			this.invalidate(); this.tui.requestRender(); return;
		}
		if (isAskAgentKey(data) && !this.reviewing) {
			if (this.editMode) this.preserveOtherDraft();
			else this.syncAnswerFromTab();
			this.clarificationMode = true;
			this.otherEditor.focused = false;
			this.noteEditor.focused = false;
			this.editor.focused = false;
			this.clarificationEditor.focused = this._focused;
			this.feedback = "";
			this.invalidate(); this.tui.requestRender(); return;
		}
		data = normalizeFocusCycleKey(data);
		if (this.reviewing) {
			if (this.keybindings.matches(data, "tui.select.up")) {
				this.reviewScroll = Math.max(0, this.reviewScroll - 1);
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.down")) {
				this.reviewScroll++;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.enter)) return this.submitAll();
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.left) || data.toLowerCase() === "b") {
				const firstSkipped = this.tabs.findIndex((tab) => !this.isAnswered(tab));
				this.selectTab(this.partialReview && firstSkipped >= 0 ? firstSkipped : this.tabs.length - 1);
				return;
			}
			if (/^[1-9]$/.test(data)) this.selectTab(parseInt(data, 10) - 1);
			return;
		}
		if (!matchesKey(data, Key.escape)) this.cancelArmed = false;
		if (matchesKey(data, Key.ctrl("r"))) {
			this.regenerate();
			return;
		}
		if (matchesKey(data, Key.ctrl("enter"))) {
			this.openReview(true);
			return;
		}
		if (matchesKey(data, Key.alt("enter"))) return;
		if (this.editMode) {
			if (matchesKey(data, Key.ctrl("c"))) {
				this.otherEditor.setText("");
				this.otherText = "";
				const tab = this.getActiveTab();
				tab.otherText = "";
				this.selected.delete("other");
				if (tab.mode === "multi-select") this.syncMultiSelectState();
				else tab.answer = null;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.tab)) {
				this.focusNote();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				this.preserveOtherDraft();
				this.editMode = false;
				this.otherEditor.focused = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			this.otherEditor.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Note editor is focused
		if (this.noteFocused) {
			if (matchesKey(data, Key.tab)) {
				this.leaveNoteFocus();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				this.leaveNoteFocus();
				return;
			}
			this.noteEditor.handleInput(data);
			const tab = this.getActiveTab();
			if (tab) tab.note = this.noteEditor.getText();
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		const tab = this.getActiveTab();
		if (!tab) return;
		if (this.feedback && !matchesKey(data, Key.ctrl("enter")) && !matchesKey(data, Key.alt("enter"))) {
			this.feedback = "";
		}

		if (tab.mode === "text" && matchesKey(data, Key.ctrl("c"))) {
			this.editor.setText("");
			tab.textBuffer = "";
			tab.answer = null;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Left/Right arrows to switch tabs
		if (matchesKey(data, Key.left)) {
			this.selectTab((this.activeTab - 1 + this.tabs.length) % this.tabs.length);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.selectTab((this.activeTab + 1) % this.tabs.length);
			return;
		}

		// Tab to focus note editor
		if (matchesKey(data, Key.tab)) {
			this.focusNote();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			const hasWork = this.tabs.some((candidate) => this.isAnswered(candidate) || candidate.note.trim() || candidate.otherText.trim());
			if (!hasWork || this.cancelArmed) return this.done(null);
			this.cancelArmed = true;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Enter confirms the current answer and advances; the last question opens Review.
		if (tab.mode === "text" && isSubmitEnter(data)) {
			this.syncAnswerFromTab();
			this.advance();
			return;
		}

		// Delegate to tab type
		if (tab.mode === "text") {
			this.editor.handleInput(data);
			tab.textBuffer = this.editor.getExpandedText() || "";
			tab.answer = tab.textBuffer;
			this.invalidate();
			this.tui.requestRender();
		} else if (tab.mode === "single-select") {
			this.handleSingleSelectInput(data, tab);
		} else if (tab.mode === "multi-select") {
			this.handleMultiSelectInput(data);
		}
	}

	private handleSingleSelectInput(data: string, tab: TabState): void {
		const question = this.questions[this.activeTab];
		const choiceList = this.getOrCreateChoiceList(question);

		if (/^[1-9]$/.test(data)) {
			const index = parseInt(data, 10) - 1;
			if (index < choiceList.length) {
				choiceList.setSelectedIndex(index);
				const item = choiceList.selectedItem;
				if (item.isOther) {
					if (tab.selected.has("other")) this.advance();
					else this.openOtherEditor();
				} else if (tab.selected.has(item.id)) this.advance();
				else this.selectOption(tab, item);
				return;
			}
		}

		const action = choiceList.handleInput(data);
		if (action === "changed") {
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (action === "confirm") {
			const item = choiceList.selectedItem;
			if (item.isOther) {
				if (tab.selected.has("other")) this.advance();
				else this.openOtherEditor();
			} else if (tab.selected.has(item.id)) this.advance();
			else this.selectOption(tab, item);
			return;
		}
		if (action === "cancel") {
			this.handleInput(Key.escape);
		}
	}

	private selectOption(tab: TabState, item: WrappedChoiceItem): void {
		const answer: AskAnswer = {
			type: "option",
			label: item.option!.label,
			value: item.option!.value,
			index: item.index,
		} as OptionAnswer;
		tab.answer = answer;
		this.selected = new Map();
		this.selected.set(item.id, answer);
		tab.selected = new Map(this.selected);
		this.invalidate();
		this.tui.requestRender();
	}

	private openOtherEditor(): void {
		if (this.choiceList) this.choiceList.selectOther();
		const tab = this.getActiveTab();
		if (tab.mode === "single-select") {
			tab.answer = null;
			tab.selected = new Map();
			this.selected = new Map();
		}
		this.cancelArmed = false;
		this.editMode = true;
		this.otherEditor.setText(this.otherText);
		this.otherEditor.focused = true;
		this.invalidate();
		this.tui.requestRender();
	}

	private handleMultiSelectInput(data: string): void {
		const question = this.questions[this.activeTab];
		const choiceList = this.getOrCreateChoiceList(question);

		if (/^[1-9]$/.test(data)) {
			const index = parseInt(data, 10) - 1;
			if (index < choiceList.length) {
				choiceList.setSelectedIndex(index);
				const item = choiceList.selectedItem;
				if (item.isOther) this.toggleOther();
				else {
					this.toggleOption(item);
					this.syncMultiSelectState();
				}
				return;
			}
		}

		if (matchesKey(data, Key.space)) {
			const item = choiceList.selectedItem;
			if (item.isOther) this.toggleOther();
			else {
				this.toggleOption(item);
				this.syncMultiSelectState();
			}
			return;
		}

		const action = choiceList.handleInput(data);
		if (action === "changed") {
			this.invalidate();
			this.tui.requestRender();
		} else if (action === "confirm") {
			if (choiceList.selectedItem.isOther) this.openOtherEditor();
			else if (this.isAnswered(this.getActiveTab())) this.advance();
		} else if (action === "cancel") {
			this.handleInput(Key.escape);
		}
	}

	private toggleOption(item: WrappedChoiceItem): void {
		const option = item.option;
		if (!option) return;
		if (this.selected.has(item.id)) this.selected.delete(item.id);
		else this.selected.set(item.id, {
			type: "option", label: option.label, value: option.value, index: item.index,
		} as OptionAnswer);
	}

	private toggleOther(): void {
		if (this.selected.has("other")) {
			this.selected.delete("other");
			this.syncMultiSelectState();
			return;
		}
		const cached = this.otherText.trim();
		if (cached) {
			this.selected.set("other", { type: "other", label: cached, value: cached });
			this.syncMultiSelectState();
			return;
		}
		this.openOtherEditor();
	}

	private renderActionBar(width: number): string[] {
		const lines: string[] = [];
		const indent = width > 1 ? " " : "";
		const tokenBudget = Math.max(1, width - visibleWidth(indent));
		const compactVariants = new Map<string, string[]>([
			["Ctrl+Enter Review answered", ["^Enter Review"]],
			["Ctrl+R Regenerate unanswered", ["Ctrl+R Regenerate"]],
			["Answers entered", ["Has answers"]],
			["Esc again to cancel", ["Esc again"]],
			["Space Toggle", ["Space"]],
			["Enter Select", ["Enter Pick"]],
			["Ctrl+C Clear", ["^C Clear"]],
			["Tab Add note", ["Tab Note"]],
			["←→ Questions", ["←→ Qs"]],
		]);
		const fitToken = (token: string) => {
			for (const candidate of [token, ...(compactVariants.get(token) ?? [])]) {
				if (visibleWidth(candidate) <= tokenBudget) return candidate;
			}
			return truncateLabel(token, tokenBudget);
		};
		const row = (tokens: string[], color = "dim") => {
			let packed = "";
			const flush = () => {
				if (!packed) return;
				lines.push(truncateToWidth(this.theme.fg(color, `${indent}${packed}`), width));
				packed = "";
			};
			for (const rawToken of tokens) {
				const token = fitToken(rawToken);
				const candidate = packed ? `${packed} · ${token}` : token;
				if (packed && visibleWidth(candidate) > tokenBudget) flush();
				packed = packed ? `${packed} · ${token}` : token;
			}
			flush();
		};

		if (this.clarificationMode) {
			row(["Ask agent", "Enter Ask", "Esc Back"], "accent");
			return lines;
		}
		if (this.reviewing) {
			row(["✓ Ready", "Enter Submit", "↑↓ Scroll", "Esc Back"], "success");
			return lines;
		}
		const clarificationAction = ["Ctrl+? Ask agent"];
		const partialActions = this.canRegenerate()
			? ["Ctrl+Enter Review answered", "Ctrl+R Regenerate unanswered"]
			: [];
		if (this.editMode) {
			row(["Editing", "Enter Save", "Ctrl+C Clear", ...partialActions, ...clarificationAction, "Esc Back"], "accent");
			const minimumLines = width < 24 ? 5 : 2;
			while (lines.length < minimumLines) lines.push("");
			return lines;
		}
		if (this.noteFocused) {
			row(["Note", "Tab Back", ...partialActions, ...clarificationAction, "Esc Back"], "accent");
			const minimumLines = width < 24 ? 5 : 2;
			while (lines.length < minimumLines) lines.push("");
			return lines;
		}
		if (this.cancelArmed) {
			row(["Answers entered", ...clarificationAction, "Esc again to cancel"], "warning");
			return lines;
		}

		const tab = this.getActiveTab();
		const item = tab.mode === "text"
			? undefined
			: this.getOrCreateChoiceList(this.questions[this.activeTab]).selectedItem;
		const itemSelected = item ? tab.selected.has(item.id) : false;
		let primary: string[];
		if (tab.mode === "text") primary = ["Enter Next"];
		else if (tab.mode === "single-select") {
			primary = [item?.isOther && !itemSelected ? "Enter Edit" : itemSelected ? "Enter Next" : "Enter Select"];
		} else if (item?.isOther) primary = ["Space Toggle", "Enter Edit"];
		else primary = this.isAnswered(tab) ? ["Space Toggle", "Enter Next"] : ["Space Select"];

		row([...primary, ...clarificationAction, "Esc Cancel"], this.isAnswered(tab) ? "success" : "warning");

		const navigation = [...(tab.mode === "text" ? ["Ctrl+C Clear"] : []), "Tab Add note", "←→ Questions"];
		const combined = [...partialActions, ...navigation];
		if (width >= 24 && visibleWidth(combined.join(" · ")) + 1 <= width) row(combined);
		else {
			partialActions.forEach((action) => row([action]));
			if (width < 24) navigation.forEach((action) => row([action]));
			else row(navigation);
		}
		return lines;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width && this.cachedRows === this.tui.terminal?.rows) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;
		const compactHeight = (this.tui.terminal?.rows ?? 40) < 20;
		const add = (text: string) => lines.push(truncateToWidth(text, width));

		add(th.fg("borderMuted", "─".repeat(width)));

		// Show every semantic label when it fits. Under pressure, inactive
		// questions become status+number tokens so the active label and Review
		// remain useful instead of all labels receiving the same tiny budget.
		const reviewStep = this.tabs.length;
		const stepCount = reviewStep + 1;
		const activeStep = this.reviewing ? reviewStep : this.activeTab;
		const answered = (index: number) => index === reviewStep
			? this.reviewing || this.tabs.every((candidate) => this.isAnswered(candidate))
			: this.isAnswered(this.tabs[index]);
		const hasNote = (index: number) => index < reviewStep && this.tabs[index].note.trim().length > 0;
		const stepLabel = (index: number) => index === reviewStep
			? "Review"
			: sanitizeProgressLabel(this.questions[index].label || `Q${index + 1}`);
		const plainFullToken = (index: number) => ` ${answered(index) ? "✓" : "○"} ${stepLabel(index)}${hasNote(index) ? " •" : ""} `;
		const fullWidth = Array.from({ length: stepCount }, (_, index) => visibleWidth(plainFullToken(index)))
			.reduce((total, tokenWidth) => total + tokenWidth, stepCount - 1);
		let compact = fullWidth > width;
		const visibleSteps = new Set<number>();
		if (!compact) {
			for (let index = 0; index < stepCount; index++) visibleSteps.add(index);
		} else {
			visibleSteps.add(activeStep);
			visibleSteps.add(reviewStep);
		}

		let extreme = false;
		let reviewLabel = "Review";
		let showReviewStatus = true;
		let extremeSeparator = "";
		const plainCompactToken = (index: number, activeLabel?: string) => {
			const status = answered(index) ? "✓" : "○";
			if (index === activeStep) {
				const label = activeLabel ?? stepLabel(index);
				return `${status}${label ? ` ${label}` : ""}${hasNote(index) && !extreme ? " •" : ""}`;
			}
			if (index === reviewStep) return extreme ? `${showReviewStatus ? status : ""}${reviewLabel}` : `${status} Review`;
			return `${status}${index + 1}${hasNote(index) ? "•" : ""}`;
		};
		const plainBar = (steps: Set<number>, activeLabel?: string, showWindows = true) => {
			const indices = [...steps].sort((a, b) => a - b);
			const parts: string[] = [];
			if (showWindows && indices[0] > 0) parts.push("‹");
			for (let position = 0; position < indices.length; position++) {
				const index = indices[position];
				if (showWindows && position > 0 && index > indices[position - 1] + 1) parts.push("›");
				parts.push(plainCompactToken(index, index === activeStep ? activeLabel : undefined));
			}
			return parts.join(extreme ? extremeSeparator : " ");
		};

		if (compact && visibleWidth(plainBar(visibleSteps)) <= width) {
			// Retain the established moving-window density for large batches;
			// compact tokens spend its space better rather than flooding the line.
			const maxVisibleSteps = Math.max(2, Math.floor((Math.max(1, width) - 4) / 10));
			const candidates = Array.from({ length: reviewStep }, (_, index) => index)
				.filter((index) => !visibleSteps.has(index))
				.sort((a, b) => Math.abs(a - activeStep) - Math.abs(b - activeStep));
			for (const index of candidates) {
				if (visibleSteps.size >= maxVisibleSteps) break;
				const candidateSteps = new Set(visibleSteps).add(index);
				if (visibleWidth(plainBar(candidateSteps)) <= width) visibleSteps.add(index);
			}
		}

		let activeLabel = stepLabel(activeStep);
		let showWindows = true;
		if (compact && visibleWidth(plainBar(visibleSteps)) > width) {
			// At extreme widths, statuses are the irreducible progress signal.
			// Spend the remaining columns on Review, then on the active semantic
			// label; spacing, note marks, and windows yield before either status.
			showWindows = false;
			extreme = true;
			if (activeStep === reviewStep) {
				activeLabel = width >= 3 ? truncateLabel(activeLabel, width - 2) : "";
			} else {
				showReviewStatus = width >= 2;
				const statusWidth = 1 + (showReviewStatus ? 1 : 0);
				extremeSeparator = width >= statusWidth + visibleWidth(reviewLabel) + 1 ? " " : "";
				const reviewBudget = Math.max(0, width - statusWidth - visibleWidth(extremeSeparator));
				reviewLabel = truncateLabel(reviewLabel, Math.min(visibleWidth(reviewLabel), reviewBudget));
				const remaining = width - statusWidth - visibleWidth(extremeSeparator) - visibleWidth(reviewLabel);
				activeLabel = truncateLabel(activeLabel, Math.max(0, remaining - 1));
			}
		}

		const tabBarParts: string[] = [];
		const indices = [...visibleSteps].sort((a, b) => a - b);
		if (compact && showWindows && indices[0] > 0) tabBarParts.push(th.fg("dim", "‹"));
		for (let position = 0; position < indices.length; position++) {
			const index = indices[position];
			if (compact && showWindows && position > 0 && index > indices[position - 1] + 1) {
				tabBarParts.push(th.fg("dim", "›"));
			}
			const status = answered(index) ? "✓" : "○";
			const noteMark = hasNote(index) && !extreme ? (compact && index !== activeStep ? "•" : " •") : "";
			const token = compact
				? index === activeStep
					? `${status}${activeLabel ? ` ${activeLabel}` : ""}${noteMark}`
					: index === reviewStep
						? extreme ? `${showReviewStatus ? status : ""}${reviewLabel}` : `${status} Review`
						: `${status}${index + 1}${noteMark}`
				: plainFullToken(index);
			const styledStatus = answered(index) ? th.fg("success", status) : th.fg("dim", status);
			const styledToken = token.replace(status, styledStatus);
			if (index === activeStep) tabBarParts.push(th.bg("selectedBg", th.fg("accent", th.bold(styledToken))));
			else if (answered(index)) tabBarParts.push(th.fg("success", styledToken));
			else tabBarParts.push(th.fg("dim", styledToken));
		}
		const separator = extreme ? extremeSeparator : " ";
		const tabBar = tabBarParts.join(th.fg("borderMuted", separator));
		add(tabBar);

		add(th.fg("borderMuted", "─".repeat(width)));

		if (!compactHeight) lines.push("");

		if (this.reviewing) {
			const answeredCount = this.tabs.filter((candidate) => this.isAnswered(candidate)).length;
			const skippedCount = this.tabs.length - answeredCount;
			const reviewTitle = this.partialReview
				? `Review ${answeredCount} ${answeredCount === 1 ? "answer" : "answers"} · ${skippedCount} skipped`
				: "Review your answers";
			add(th.fg("text", th.bold(reviewTitle)));
			if (this.feedback) add(th.fg("warning", ` ${this.feedback}`));
			lines.push("");
			const summaryLines: string[] = [];
			this.questions.forEach((question, index) => {
				const tab = this.tabs[index];
				const answers = Array.isArray(tab.answer) ? tab.answer : tab.answer ? [tab.answer] : [];
				const summary = this.isAnswered(tab)
					? answers.map((answer) => typeof answer === "string" ? answer : answer.label).join(" · ")
					: "(skipped)";
				const questionPrefix = `${index + 1}. `;
				addWrappedWithPrefix(
					summaryLines,
					th.fg("muted", questionPrefix),
					th.fg("muted", sanitizeDisplayText(question.question)),
					width,
					" ".repeat(visibleWidth(questionPrefix)),
				);
				addWrappedWithPrefix(summaryLines, "   ", th.fg("accent", sanitizeDisplayText(summary)), width, "   ");
				if (tab.note.trim()) addWrappedWithPrefix(summaryLines, "   ", th.fg("dim", `Note: ${sanitizeDisplayText(tab.note.trim())}`), width, "   ");
				summaryLines.push("");
			});
			const actionLines = this.renderActionBar(width);
			const budget = Math.max(0, (this.tui.terminal?.rows ?? 40) - lines.length - actionLines.length - 2);
			const maxScroll = Math.max(0, summaryLines.length - budget);
			this.reviewScroll = Math.min(this.reviewScroll, maxScroll);
			const visible = summaryLines.slice(this.reviewScroll, this.reviewScroll + budget);
			if (visible.length > 0 && this.reviewScroll > 0) visible[0] = th.fg("dim", " ↑ more");
			if (visible.length > 0 && this.reviewScroll < maxScroll) visible[visible.length - 1] = th.fg("dim", " ↓ more");
			lines.push(...visible);
			add(th.fg("borderMuted", "─".repeat(width)));
			lines.push(...actionLines);
			add(th.fg("accent", "─".repeat(width)));
			constrainFrameHeight(lines, this.tui.terminal?.rows, actionLines.length + 2);
			this.cachedWidth = width;
			this.cachedRows = this.tui.terminal?.rows;
			this.cachedLines = lines;
			return lines;
		}

		const tab = this.getActiveTab();
		const q = this.questions[this.activeTab];

		if (this.clarificationMode) {
			addWrapped(lines, th.fg("text", th.bold("What do you want to ask the agent?")), width);
			lines.push("");
			for (const line of this.clarificationEditor.render(Math.max(1, width - 2))) add(` ${sanitizeEditorDisplay(line)}`);
			if (this.feedback) add(th.fg("warning", ` ${this.feedback}`));
			const actionLines = this.renderActionBar(width);
			add(th.fg("borderMuted", "─".repeat(width)));
			lines.push(...actionLines);
			add(th.fg("accent", "─".repeat(width)));
			constrainFrameHeight(lines, this.tui.terminal?.rows, actionLines.length + 2);
			this.cachedWidth = width; this.cachedRows = this.tui.terminal?.rows; this.cachedLines = lines;
			return lines;
		}

		// Question header
		addWrapped(lines, th.fg("text", th.bold(`Q${this.activeTab + 1}: ${sanitizeDisplayText(q.question)}`)), width);
		if (q.details) addWrapped(lines, th.fg("muted", ` ${sanitizeDisplayText(q.details)}`), width);
		if (!compactHeight) lines.push("");

		const notePreview: string[] = [];
		renderOptionalNote(notePreview, width, th, this.noteEditor, this.noteFocused, tab.mode === "multi-select" ? 9 : tab.mode === "single-select" ? 6 : 2);
		const actionLines = this.renderActionBar(width);
		const reservedTailLines = notePreview.length + (compactHeight ? 0 : 2) + actionLines.length + 2;
		const availableBodyLines = Math.max(0, (this.tui.terminal?.rows ?? Number.POSITIVE_INFINITY) - lines.length - reservedTailLines);
		if (tab.mode === "text") {
			this.renderTextTab(width, lines, add, th);
		} else if (tab.mode === "single-select") {
			this.renderSingleSelectTab(width, lines, add, th, tab, q, availableBodyLines);
		} else if (tab.mode === "multi-select") {
			this.renderMultiSelectTab(width, lines, add, th, q, availableBodyLines);
		}

		if (this.feedback) add(th.fg("warning", ` ${this.feedback}`));
		if (!compactHeight) lines.push("");

		// A native one-line note action, not a second bordered editor panel.
		const noteIndent = tab.mode === "multi-select" ? 9 : tab.mode === "single-select" ? 6 : 2;
		renderOptionalNote(lines, width, th, this.noteEditor, this.noteFocused, noteIndent);

		if (!compactHeight) lines.push("");

		add(th.fg("borderMuted", "─".repeat(width)));
		lines.push(...actionLines);
		add(th.fg("accent", "─".repeat(width)));
		constrainFrameHeight(lines, this.tui.terminal?.rows, actionLines.length + 2);

		this.cachedWidth = width;
		this.cachedRows = this.tui.terminal?.rows;
		this.cachedLines = lines;
		return lines;
	}

	private renderTextTab(width: number, lines: string[], add: (text: string) => void, th: any): void {
		add(th.fg("accent", "─".repeat(width)));
		const editorPadding = width > 2 ? 1 : 0;
		const editorIndent = " ".repeat(editorPadding);
		for (const line of this.editor.render(Math.max(1, width - editorPadding * 2))) {
			add(`${editorIndent}${sanitizeEditorDisplay(line)}`);
		}
	}

	private getOrCreateChoiceList(question: QuestionDef): WrappedChoiceList {
		const existing = this.tabChoiceLists.get(this.activeTab);
		if (existing) {
			this.choiceList = existing;
			return existing;
		}

		const choiceList = new WrappedChoiceList(
			question.options,
			getOtherLabel(question.options),
			Math.min(question.options.length + 1, 8, Math.max(1, Math.floor((this.tui.terminal?.rows ?? 24) / 4))),
			this.keybindings,
			this.theme,
		);
		this.choiceList = choiceList;
		this.tabChoiceLists.set(this.activeTab, choiceList);
		return choiceList;
	}

	private renderSingleSelectTab(width: number, lines: string[], add: (text: string) => void, _th: any, tab: TabState, q: QuestionDef, availableLines: number): void {
		const choiceList = this.getOrCreateChoiceList(q);
		for (const line of choiceList.render(Math.max(1, width - 1), {
			selectedAnswers: tab.selected,
			inlineOtherEditor: this.editMode ? this.otherEditor : undefined,
			showRadio: true,
			availableLines,
		})) {
			add(` ${sanitizeEditorDisplay(line)}`);
		}
	}

	private renderMultiSelectTab(width: number, lines: string[], add: (text: string) => void, th: any, q: QuestionDef, availableLines: number): void {
		const choiceList = this.getOrCreateChoiceList(q);
		const choiceBudget = Math.max(0, availableLines - 2);

		if (this.selected.size > 0) {
			add(th.fg("success", ` ✓ ${this.selected.size} selected`));
		} else {
			add(th.fg("dim", " ○ Select options below"));
		}
		lines.push("");
		lines.push(...choiceList.render(width, {
			selectedAnswers: this.selected,
			inlineOtherEditor: this.editMode ? this.otherEditor : undefined,
			availableLines: choiceBudget,
		}));
	}
}
