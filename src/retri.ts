import type { ProjectedSessionEntry, SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';
import { forgetAfter, NOTES_TYPE } from './context.ts';
import type { Snapshots } from './snapshots.ts';

export interface Checkpoint {
	n: number;
	/** The last session entry the checkpoint includes. */
	entryId: string;
	/** The workspace as a snapshot tree. */
	tree: string;
	/** Which run (one user prompt and the work it starts) the checkpoint belongs to. */
	run: number;
}

/** Most rewinds allowed in one run, so an agent that keeps rewinding cannot loop forever. */
export const REWIND_LIMIT = 5;

/** One session's checkpoints, notes, and a rewind waiting for its turn to end. */
export class Retri {
	private readonly checkpoints = new Map<number, Checkpoint>();
	private readonly notes: string[] = [];
	private next = 0;
	private run = 0;
	private rewinds = 0;
	private pending?: { to: Checkpoint; note: string };

	constructor(private readonly snapshots: Snapshots) {}

	/** The number the current turn's checkpoint will get. */
	get upcoming() {
		return this.next;
	}

	label(n: number) {
		return `[checkpoint ${n}]`;
	}

	/** A new prompt starts a run. Rewinds stay inside it, so the user's earlier messages are never taken away. */
	async startRun(entryId: string) {
		this.run++;
		this.rewinds = 0;
		await this.checkpoint(entryId);
	}

	async checkpoint(entryId: string) {
		const n = this.next++;
		const tree = await this.snapshots.take(String(n));
		this.checkpoints.set(n, { n, entryId, tree, run: this.run });
		return n;
	}

	/** The session is over and its checkpoints can't be used again, so their snapshots go. */
	async dispose() {
		this.checkpoints.clear();
		this.pending = undefined;
		await this.snapshots.discard();
	}

	/** Checks a rewind the model asked for. Throwing turns into a failed tool result the model can read. */
	request(n: number, note: string) {
		const to = this.checkpoints.get(n);
		if (!to || to.run !== this.run) {
			const live = [...this.checkpoints.values()].filter((c) => c.run === this.run).map((c) => c.n);
			throw new Error(`There is no checkpoint ${n} to return to. Available: ${live.join(', ')}.`);
		}
		if (this.pending) throw new Error('A rewind is already happening this turn.');
		if (this.rewinds >= REWIND_LIMIT) {
			throw new Error(`This run has already rewound ${REWIND_LIMIT} times. Carry on from here or ask the user.`);
		}
		if (!note.trim()) throw new Error('Write a note: it is the only thing that survives the rewind.');
		this.pending = { to, note: note.trim() };
	}

	/**
	 * Runs once the turn's tools have all finished, so no tool from the same turn can write after the restore.
	 * Returns the session entries that hide the abandoned attempt and add the notes, or nothing if no rewind is waiting.
	 */
	async applyPendingRewind(context: ProjectedSessionEntry[]): Promise<SessionBoundaryDraft[] | undefined> {
		const pending = this.pending;
		if (!pending) return;
		this.pending = undefined;

		const { to, note } = pending;
		// Worked out before the files move: if the checkpoint can't be found in context, nothing changes.
		const forget = forgetAfter(context, to.entryId);
		await this.snapshots.restore(to.tree);
		for (const c of this.checkpoints.values()) if (c.n > to.n) this.checkpoints.delete(c.n);
		this.notes.push(note);
		this.rewinds++;

		return [
			...forget,
			{
				type: 'custom_message',
				customType: NOTES_TYPE,
				display: true,
				content: this.notesMessage(to.n),
			},
			{ type: 'custom', customType: 'retri', data: { event: 'rewind', to: to.n, note, run: this.run } },
		];
	}

	private notesMessage(n: number) {
		const lines = this.notes.map((note, i) => `${i + 1}. ${note}`);
		return [
			`You rewound to checkpoint ${n}. The files and this conversation are as they were then; what came after is gone.`,
			'Notes from the attempts you abandoned:',
			...lines,
		].join('\n');
	}
}
