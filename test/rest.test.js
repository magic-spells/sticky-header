/*
  Movement-armed rest detection.

  The subtlest thing in the module. Rest is armed from actual MOVEMENT, not
  from scroll events, because a scroll event can land a frame before the delta
  it describes. Arming only from the event lets the fallback fire while the
  page is still moving: consumers commit to a rest, the trailing delta
  contradicts it, and there is nothing left to re-arm because the events had
  already stopped.

  These tests pin that down by ticking frames with movement past the point
  where an event-armed timer would have fired.
*/

import { afterEach, describe, expect, it } from 'vitest';
import { IDLE_MS } from '../src/lib/scroll-handler.js';
import { createEnv, record } from './harness.js';

let env = null;

afterEach(() => {
	env?.teardown();
	env = null;
});

describe('rest', () => {
	it('fires IDLE_MS after the last MOVEMENT, not after the last scroll event', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });
		env.frame();

		// one scroll event, then a long momentum glide reported only by frames —
		// exactly the iOS case, where `scroll` stops well before the page does
		env.scrollTo(100);
		const eventTime = env.now;

		let y = 100;
		for (let i = 0; i < 12; i += 1) {
			y += 10;
			env.setScrollY(y);
			env.frame(20); // 240ms of movement, twice the idle timeout
		}
		const lastMovement = env.now;

		expect(seen.rests).toEqual([]);
		expect(lastMovement - eventTime).toBeGreaterThan(IDLE_MS);

		// the glide stops: no more position changes, so nothing re-arms
		env.advance(IDLE_MS - 1);
		expect(seen.rests).toEqual([]);
		env.advance(1);
		expect(seen.rests.length).toBe(1);
		expect(seen.rests[0] - lastMovement).toBeCloseTo(IDLE_MS, 6);

		seen.sub.unsubscribe();
	});

	it('fires once, whichever of scrollend and the fallback gets there first', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });
		env.frame();

		env.scrollTo(100);
		env.frame();

		env.scrollEnd();
		expect(seen.rests.length).toBe(1);

		// the fallback timer is still notionally out there; it must be a no-op
		env.advance(IDLE_MS * 2);
		expect(seen.rests.length).toBe(1);

		seen.sub.unsubscribe();
	});

	it('ignores a scrollend with no movement behind it', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });
		env.frame();

		env.scrollEnd();
		env.scrollEnd();

		expect(seen.rests).toEqual([]);
		seen.sub.unsubscribe();
	});

	it('re-arms for the next gesture after a rest', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });
		env.frame();

		env.scrollTo(100);
		env.frame();
		env.advance(IDLE_MS);
		expect(seen.rests.length).toBe(1);

		env.scrollTo(300);
		env.frame();
		env.advance(IDLE_MS);
		expect(seen.rests.length).toBe(2);

		seen.sub.unsubscribe();
	});

	it('does not double-report when scrollend arrives after the fallback', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });
		env.frame();

		env.scrollTo(100);
		env.frame();
		env.advance(IDLE_MS);
		expect(seen.rests.length).toBe(1);

		env.scrollEnd();
		expect(seen.rests.length).toBe(1);

		seen.sub.unsubscribe();
	});

	it('wakes the loop so consumers get a frame to act on the rest', () => {
		env = createEnv();
		const seen = record(); // NOT kept awake — the loop must sleep on its own

		env.frame(); // the frame `subscribe()` scheduled; nothing moved, so it sleeps
		expect(env.frameScheduled).toBe(false);

		env.setScrollY(100);
		seen.sub.tick(); // an observer noticing something with no scroll behind it
		env.frame(); // movement: arms rest, and re-arms the loop for one more
		env.frame(); // no movement: this frame lets the loop sleep again
		expect(env.frameScheduled).toBe(false);

		env.advance(IDLE_MS);
		expect(seen.rests.length).toBe(1);
		expect(env.frameScheduled).toBe(true);

		seen.sub.unsubscribe();
	});
});
