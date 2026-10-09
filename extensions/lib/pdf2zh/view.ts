/**
 * /pdf2zh — live progress view for the translation pipeline.
 *
 * Same interaction contract as lib/review/phase-loader.ts (esc / ctrl+c aborts),
 * extended with a progress bar and a scrolling log tail, because a full run is
 * long (MinerU polling + N translation chunks) and users need to see it advance
 * rather than stare at a spinner.
 */
import { matchesKey, Key, Container, Text, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { progressBar } from "./progress.ts";
import { STAGE_LABEL, type Progress, type Stage } from "./types.ts";

export { progressBar };

const LOG_LINES = 4;

export class Pdf2zhProgressView extends Container {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly headline: Text;
	private readonly bar: Text;
	private readonly tail: Text;
	private readonly hint: Text;
	private readonly signalController = new AbortController();
	private abortHandler: (() => void) | undefined;

	private stage: Stage = "prepare";
	private logs: string[] = [];

	constructor(tui: TUI, theme: Theme) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.headline = new Text("", 1, 0);
		this.bar = new Text("", 1, 0);
		this.tail = new Text("", 1, 0);
		this.hint = new Text(theme.fg("dim", "escape 取消"), 1, 0);
		this.addChild(this.headline);
		this.addChild(this.bar);
		this.addChild(this.tail);
		this.addChild(this.hint);
		this.render_();
	}

	get signal(): AbortSignal {
		return this.signalController.signal;
	}

	set onAbort(fn: (() => void) | undefined) {
		this.abortHandler = fn;
	}

	/** Update the view. Safe to call at pipeline log rate. */
	update(p: Progress): void {
		// `idle` carries OCR chatter but must not downgrade an active stage.
		if (p.stage !== "idle" || this.stage === "prepare") this.stage = p.stage;
		if (p.detail) {
			this.logs = [...this.logs, p.detail].slice(-LOG_LINES);
		}
		this.render_(p.done, p.total);
	}

	/** Final paint, so the last state stays on screen after the child exits. */
	finish(stage: Stage): void {
		this.stage = stage;
		this.render_();
	}

	private render_(done?: number, total?: number): void {
		const label = STAGE_LABEL[this.stage];
		const hasCounter = done !== undefined && total !== undefined && total > 0;

		if (hasCounter) {
			const ratio = done! / total!;
			const pct = Math.floor(ratio * 100);
			this.headline.setText(
				this.theme.fg("accent", `⟳ ${label}  `) + this.theme.fg("text", `${done}/${total}`) + this.theme.fg("dim", `  ${pct}%`),
			);
			this.bar.setText("  " + this.theme.fg("accent", progressBar(ratio)) + this.theme.fg("dim", `  ${pct}%`));
		} else {
			this.headline.setText(this.theme.fg("accent", `⟳ ${label}`));
			this.bar.setText("");
		}

		this.tail.setText(
			this.logs
				.slice(-LOG_LINES)
				.map((l) => "  " + this.theme.fg("dim", l.length > 96 ? `${l.slice(0, 95)}…` : l))
				.join("\n"),
		);

		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.signalController.abort();
			this.abortHandler?.();
		}
	}

	dispose(): void {
		this.signalController.abort();
	}
}
