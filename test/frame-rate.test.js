/*
  Frame-rate independence — the whole point of the extraction.

  The source packages decayed velocity by a fixed factor PER FRAME, which runs
  twice as often on a 120Hz display and so kills a flick twice as fast per unit
  of wall-clock time. Everything here checks that the same wall-clock span now
  produces the same result however it was carved into frames, and that the
  60Hz behaviour is byte-for-byte the old one.
*/

import { afterEach, describe, expect, it } from 'vitest';
import {
	ScrollHandler,
	expApproach,
	EMA_TAU,
	VELOCITY_DECAY_TAU,
	REFERENCE_FRAME_MS,
} from '../src/lib/scroll-handler.js';
import { createEnv, record } from './harness.js';

let env = null;

afterEach(() => {
	env?.teardown();
	env = null;
});

/** Three ways to spend exactly 200ms. */
const SIXTY = Array.from({ length: 12 }, () => REFERENCE_FRAME_MS); // 200ms
const ONE_TWENTY = Array.from({ length: 24 }, () => REFERENCE_FRAME_MS / 2); // 200ms
const DROPPED = [40, 16, 64, 30, 8, 42]; // 200ms, with two near-ceiling stalls

describe('the derived time constants reproduce the original 60Hz numbers', () => {
	it('decays by exactly 0.76 over one 60Hz frame', () => {
		expect(Math.exp(-REFERENCE_FRAME_MS / VELOCITY_DECAY_TAU)).toBeCloseTo(0.76, 12);
	});

	it('weights an EMA sample by exactly 0.15 over one 60Hz frame', () => {
		expect(1 - Math.exp(-REFERENCE_FRAME_MS / EMA_TAU)).toBeCloseTo(0.15, 12);
	});

	it('lands where the spec said it would', () => {
		expect(VELOCITY_DECAY_TAU).toBeCloseTo(60.73, 2);
		expect(EMA_TAU).toBeCloseTo(102.55, 2);
	});
});

describe('expApproach', () => {
	/**
	 * @param {Array<number>} pattern - Frame deltas in ms
	 * @returns {number} Where the value ends up
	 */
	function run(pattern) {
		let current = 0;
		for (const dt of pattern) current = expApproach(current, 100, dt, 120);
		return current;
	}

	it('reaches the same value at 60Hz, at 120Hz and through dropped frames', () => {
		const sixty = run(SIXTY);
		expect(run(ONE_TWENTY)).toBeCloseTo(sixty, 9);
		expect(run(DROPPED)).toBeCloseTo(sixty, 9);
	});

	it('covers ~63% of the gap in one time constant', () => {
		expect(expApproach(0, 100, 120, 120)).toBeCloseTo(63.212, 3);
	});

	it('snaps to target for a non-positive time constant', () => {
		expect(expApproach(0, 100, 16, 0)).toBe(100);
		expect(expApproach(0, 100, 16, -5)).toBe(100);
	});

	it('never overshoots, even on a frame far longer than the constant', () => {
		expect(expApproach(0, 100, 1000, 120)).toBeLessThan(100);
		expect(expApproach(0, 100, 1000, 120)).toBeGreaterThan(99.9);
		// far enough out it lands ON the target rather than past it — the
		// approach is asymptotic, so there is no overshoot to guard against
		expect(expApproach(0, 100, 5000, 120)).toBe(100);
	});
});

describe('velocity decay', () => {
	/**
	 * Runs a decay pattern on a live handler and reports the surviving velocity.
	 * The subscriber returns true so the loop never sleeps — a sleep resets
	 * `_lastFrameTime`, and the next frame would then report the 16ms default
	 * rather than the dt under test.
	 * @param {Array<number>} pattern - Frame deltas in ms
	 * @returns {number}
	 */
	function decay(pattern) {
		env = createEnv();
		const seen = record({ keepAwake: true });
		env.frame(); // seeds _lastFrameTime; velocity is still 0 here
		ScrollHandler._velocity = 10;
		for (const dt of pattern) env.frame(dt);
		const velocity = ScrollHandler.velocity;
		seen.sub.unsubscribe();
		env.teardown();
		env = null;
		return velocity;
	}

	it('is identical at 60Hz, at 120Hz and through dropped frames', () => {
		const sixty = decay(SIXTY);
		// 10 * exp(-200 / 60.73)
		expect(sixty).toBeCloseTo(10 * Math.exp(-200 / VELOCITY_DECAY_TAU), 9);
		expect(decay(ONE_TWENTY)).toBeCloseTo(sixty, 9);
		expect(decay(DROPPED)).toBeCloseTo(sixty, 9);
	});

	it('snaps to exactly zero below the threshold', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });
		env.frame();
		ScrollHandler._velocity = 0.02;
		env.frame(REFERENCE_FRAME_MS); // 0.02 * 0.76 = 0.0152, still above 0.01
		expect(ScrollHandler.velocity).toBeGreaterThan(0);
		env.frame(REFERENCE_FRAME_MS); // 0.0152 * 0.76 = 0.0116
		env.frame(REFERENCE_FRAME_MS); // 0.0088 — under the threshold
		expect(ScrollHandler.velocity).toBe(0);
		seen.sub.unsubscribe();
	});

	it('is pinned to zero under reduced motion', () => {
		env = createEnv({ reducedMotion: true });
		const seen = record({ keepAwake: true });
		env.scrollTo(200);
		env.frame();
		expect(seen.last.velocity).toBe(0);
		expect(seen.last.reducedMotion).toBe(true);
		seen.sub.unsubscribe();
	});
});

describe('velocity accumulation', () => {
	it('weights each scroll event by the time it represents, not by a fixed 0.15', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });

		// two events 16.667ms apart: the classic 0.15 weight
		env.scrollTo(10);
		env.frame();
		const before = ScrollHandler.velocity;
		env.advance(REFERENCE_FRAME_MS);
		env.scrollTo(20);
		const afterFast = ScrollHandler.velocity;

		// the same 10px step after a much longer gap must count for more
		ScrollHandler._velocity = before;
		env.advance(500);
		env.scrollTo(30);
		const afterSlow = ScrollHandler.velocity;

		expect(afterSlow - before).toBeGreaterThan(afterFast - before);
		seen.sub.unsubscribe();
	});

	it('clamps at ±100', () => {
		env = createEnv({ scrollHeight: 100000 });
		const seen = record({ keepAwake: true });

		let y = 0;
		for (let i = 0; i < 10; i += 1) {
			y += 5000;
			env.advance(64);
			env.scrollTo(y);
		}
		expect(ScrollHandler.velocity).toBe(100);

		for (let i = 0; i < 10; i += 1) {
			y -= 5000;
			env.advance(64);
			env.scrollTo(y);
		}
		expect(ScrollHandler.velocity).toBe(-100);

		seen.sub.unsubscribe();
	});
});
