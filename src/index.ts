import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { rewindTool } from './rewind.ts';
import { Retri } from './retri.ts';
import { Snapshots } from './snapshots.ts';

/**
 * Retri: a rewind button the agent presses itself.
 *
 * Every turn that runs tools becomes a numbered checkpoint: a snapshot of the workspace plus the
 * point it reached in the conversation. When the agent calls `rewind`, the files go back to that
 * checkpoint, everything the model said and saw after it is hidden from its context, and the
 * agent's note is added in its place.
 */
export default function retri(pi: ExtensionAPI) {
	let state: Retri | undefined;

	pi.registerTool(rewindTool(() => state));

	pi.on('session_start', (_event, ctx) => {
		state = new Retri(new Snapshots(ctx.cwd, ctx.sessionManager.getSessionId()));
	});

	// A run begins: checkpoint the workspace and conversation as the prompt finds them.
	pi.on('turn_start', async (event, ctx) => {
		const leaf = ctx.sessionManager.getLeafId();
		if (event.turnIndex === 0 && state && leaf) await state.startRun(leaf);
	});

	// Label each tool result with the checkpoint its turn will become, so the model can name it.
	pi.on('tool_result', (event) => {
		if (!state || event.toolName === 'rewind' || event.parentToolCallId) return;
		return { content: [...event.content, { type: 'text', text: state.label(state.upcoming) }] };
	});

	// After the turn's tools have all finished: carry out a requested rewind, or save the checkpoint.
	pi.on('turn_end', async (event) => {
		if (!state) return;

		const rewind = await state.applyPendingRewind(event.context.contextEntries);
		if (rewind) return { entries: [...event.entries, ...rewind], continue: true };

		const last = event.toolResultEntryIds.at(-1);
		if (last) await state.checkpoint(last);
	});
}
