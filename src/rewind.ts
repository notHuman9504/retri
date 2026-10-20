import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Retri } from './retri.ts';

/** The tool the model calls. It only checks and records the request; the rewind happens when the turn ends. */
export function rewindTool(state: () => Retri | undefined) {
	return defineTool({
		name: 'rewind',
		label: 'Rewind',
		description:
			'Go back to an earlier checkpoint when your current approach has gone wrong. ' +
			'Every tool result ends with "[checkpoint N]". Rewinding to N puts the project files back the way they were at N ' +
			'and removes everything after N from this conversation, so you continue from N as if the rest never happened. ' +
			'Your note is the only thing that carries over: say what failed and what to try instead.',
		promptSnippet: 'Go back to an earlier checkpoint, restoring files and conversation, and leave yourself a note',
		promptGuidelines: [
			'When an approach has failed or you see that an earlier decision was wrong, rewind to the checkpoint before that decision instead of undoing changes by hand.',
		],
		parameters: Type.Object({
			checkpoint: Type.Integer({ minimum: 0, description: 'The checkpoint number to return to, from a "[checkpoint N]" label.' }),
			note: Type.String({
				minLength: 1,
				description: 'What went wrong after that checkpoint and what to do differently. It is all you will remember of this attempt.',
			}),
		}),
		executionMode: 'sequential',
		async execute(_toolCallId, { checkpoint, note }) {
			const retri = state();
			if (!retri) throw new Error('Retri is not ready yet; no checkpoints exist in this session.');
			retri.request(checkpoint, note);
			return {
				content: [{ type: 'text', text: `Rewinding to checkpoint ${checkpoint}.` }],
				details: { checkpoint, note },
			};
		},
	});
}
