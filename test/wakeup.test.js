/*
  Waking up after a gap.

  A backgrounded tab stops delivering rAF entirely. The frame that arrives when
  it comes back carries a timestamp minutes later than the last one, and an
  unclamped dt turns that into one enormous easing step — a consumer's ease
  teleports, and velocity decay skips to zero in a single visible jump. The
  64ms ceiling makes the wakeup frame look like a bad frame instead.
*/

import { afterEach, describe, expect, it } from 'vitest';
import {
	ScrollHandler,
	expApproach,
	FIRST_FRAME_DELTA,
	MAX_FRAME_DELTA,
	VELOCITY_DECAY_TAU,
} from '../src/lib/scroll-handler.js';
import { createEnv, record } from './harness.js';

let env = null;

afterEach(() => {
	env?.teardown();
	env = null;
});

describe('frame delta', () => {
	it('reports the 16ms default on the first frame of a woken loop', () => {
		env = createEnv();
		const seen = record();

		env.frame(500); // the loop was asleep; this gap means nothing
		expect(seen.last.dt).toBe(FIRST_FRAME_DELTA);

		seen.sub.unsubscribe();
	});

	it('reports the real delta on an ordinary frame', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });

		env.frame();
		env.frame(8);
		expect(seen.last.dt).toBeCloseTo(8, 9);

		seen.sub.unsubscribe();
	});

	it('clamps a background-tab gap to one MAX_FRAME_DELTA frame', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });

		env.frame(); // seed
		env.frame(30_000); // the tab was in the background for half a minute

		expect(seen.last.dt).toBe(MAX_FRAME_DELTA);
		seen.sub.unsubscribe();
	});

	it('keeps the wakeup frame from taking a giant velocity step', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });

		env.frame();
		ScrollHandler._velocity = 10;
		env.frame(30_000);

		// exactly one clamped frame of decay, not thirty seconds of it
		expect(ScrollHandler.velocity).toBeCloseTo(
			10 * Math.exp(-MAX_FRAME_DELTA / VELOCITY_DECAY_TAU),
			9
		);
		expect(ScrollHandler.velocity).toBeGreaterThan(3);

		seen.sub.unsubscribe();
	});

	it('keeps the wakeup frame from taking a giant ease step', () => {
		env = createEnv();
		let eased = 0;
		const sub = ScrollHandler.subscribe({
			frame({ dt }) {
				eased = expApproach(eased, 100, dt, 200);
				return true;
			},
		});

		env.frame();
		env.frame(30_000);

		// 64ms at tau 200 covers about 27% of the gap; an unclamped 30s frame
		// would have covered essentially all of it
		expect(eased).toBeLessThan(50);
		sub.unsubscribe();
	});

	it('never reports a negative delta for an out-of-order timestamp', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });

		env.frame();
		env.frame(-5); // idle and occluded pages have been observed doing this
		expect(seen.last.dt).toBe(0);

		seen.sub.unsubscribe();
	});
});
