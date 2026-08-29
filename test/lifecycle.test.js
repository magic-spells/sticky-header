/*
  Subscription lifecycle and the self-terminating loop.

  The handler is a module singleton, so "nobody is using it" has to mean
  literally nothing bound: no scroll listener, no resize listener, no timer, no
  rAF. And while it IS bound, an idle page must still cost zero frames — the
  loop only stays awake for movement, for surviving velocity, or because a
  subscriber asked for another frame.
*/

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScrollHandler } from '../src/lib/scroll-handler.js';
import { createEnv, record } from './harness.js';

let env = null;

afterEach(() => {
	env?.teardown();
	env = null;
});

/**
 * @param {object} spy - A vi.spyOn result
 * @param {string} type - Event name
 * @returns {number} How many times that event type was passed
 */
function callsFor(spy, type) {
	return spy.mock.calls.filter(([name]) => name === type).length;
}

describe('listeners', () => {
	it('attaches on the first subscriber and detaches on the last', () => {
		env = createEnv();
		const add = vi.spyOn(window, 'addEventListener');
		const remove = vi.spyOn(window, 'removeEventListener');

		const first = record();
		expect(callsFor(add, 'scroll')).toBe(1);
		expect(callsFor(add, 'scrollend')).toBe(1);
		expect(callsFor(add, 'resize')).toBe(1);
		expect(callsFor(add, 'load')).toBe(1);
		expect(callsFor(add, 'pageshow')).toBe(1);

		// a second subscriber must not bind a second set
		const second = record();
		expect(callsFor(add, 'scroll')).toBe(1);
		expect(callsFor(remove, 'scroll')).toBe(0);

		first.sub.unsubscribe();
		expect(callsFor(remove, 'scroll')).toBe(0);

		second.sub.unsubscribe();
		expect(callsFor(remove, 'scroll')).toBe(1);
		expect(callsFor(remove, 'scrollend')).toBe(1);
		expect(callsFor(remove, 'resize')).toBe(1);
		expect(callsFor(remove, 'load')).toBe(1);
		expect(callsFor(remove, 'pageshow')).toBe(1);

		add.mockRestore();
		remove.mockRestore();
	});

	it('goes quiet completely once the last subscriber leaves', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });
		env.frame();
		expect(env.frameScheduled).toBe(true);

		seen.sub.unsubscribe();

		expect(env.frameScheduled).toBe(false);
		expect(ScrollHandler.velocity).toBe(0);
		// a scroll after the teardown reaches nobody
		env.scrollTo(400);
		expect(env.frameScheduled).toBe(false);
	});

	it('re-attaches for a later subscriber', () => {
		env = createEnv();
		record().sub.unsubscribe();

		const seen = record();
		expect(env.frameScheduled).toBe(true);
		env.frame();
		expect(seen.frames.length).toBe(1);
		seen.sub.unsubscribe();
	});
});

describe('the loop', () => {
	it('stops when nothing moved, velocity is 0 and no subscriber wants a frame', () => {
		env = createEnv();
		const seen = record();

		env.frame();
		expect(seen.frames.length).toBe(1);
		expect(env.frameScheduled).toBe(false);

		seen.sub.unsubscribe();
	});

	it('keeps running while a subscriber returns true', () => {
		env = createEnv();
		let wants = true;
		const sub = ScrollHandler.subscribe({ frame: () => wants });

		env.frame();
		expect(env.frameScheduled).toBe(true);
		env.frame();
		expect(env.frameScheduled).toBe(true);

		wants = false;
		env.frame();
		expect(env.frameScheduled).toBe(false);

		sub.unsubscribe();
	});

	it('keeps running while velocity survives', () => {
		env = createEnv();
		const seen = record();

		env.scrollTo(200);
		env.frame();
		expect(ScrollHandler.velocity).toBeGreaterThan(0);
		expect(env.frameScheduled).toBe(true);

		// no more movement: the velocity decays out and the loop lets go
		let guard = 0;
		while (env.frameScheduled && guard < 200) {
			env.frame();
			guard += 1;
		}
		expect(guard).toBeLessThan(200);
		expect(ScrollHandler.velocity).toBe(0);

		seen.sub.unsubscribe();
	});

	it('wakes on sub.tick() with no scroll behind it', () => {
		env = createEnv();
		const seen = record();

		env.frame();
		expect(env.frameScheduled).toBe(false);

		seen.sub.tick();
		expect(env.frameScheduled).toBe(true);
		env.frame();
		expect(seen.frames.length).toBe(2);

		seen.sub.unsubscribe();
	});

	it('never schedules two frames at once', () => {
		env = createEnv();
		const seen = record();

		seen.sub.tick();
		seen.sub.tick();
		ScrollHandler.tick();
		env.frame();
		expect(env.frameScheduled).toBe(false);

		seen.sub.unsubscribe();
	});
});

describe('dispatch', () => {
	it('runs frame callbacks in subscription order with one shared packet', () => {
		env = createEnv();
		const order = [];
		const packets = [];

		const a = ScrollHandler.subscribe({
			frame(packet) {
				order.push('a');
				packets.push(packet);
			},
		});
		const b = ScrollHandler.subscribe({
			frame(packet) {
				order.push('b');
				packets.push(packet);
			},
		});

		env.frame();
		expect(order).toEqual(['a', 'b']);
		expect(packets[0]).toBe(packets[1]);

		a.unsubscribe();
		b.unsubscribe();
	});

	it('survives a callback that throws', () => {
		env = createEnv();
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const seen = [];

		const bad = ScrollHandler.subscribe({
			frame() {
				throw new Error('boom');
			},
		});
		const good = ScrollHandler.subscribe({ frame: (packet) => void seen.push(packet.y) });

		env.frame();
		expect(seen.length).toBe(1);
		expect(errors).toHaveBeenCalled();

		bad.unsubscribe();
		good.unsubscribe();
		errors.mockRestore();
	});

	it('does not call a subscriber that unsubscribed mid-pass', () => {
		env = createEnv();
		const seen = [];

		const second = { sub: null };
		const first = ScrollHandler.subscribe({
			frame() {
				seen.push('first');
				second.sub.unsubscribe();
			},
		});
		second.sub = ScrollHandler.subscribe({
			frame() {
				seen.push('second');
			},
		});

		env.frame();
		expect(seen).toEqual(['first']);

		first.unsubscribe();
	});

	it('tolerates a subscription with no callbacks at all', () => {
		env = createEnv();
		const sub = ScrollHandler.subscribe();
		expect(() => env.frame()).not.toThrow();
		sub.unsubscribe();
	});
});
