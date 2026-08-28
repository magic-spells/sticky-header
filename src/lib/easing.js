/*
  Settle easing for <sticky-header>.

  The settle is the step response of a damped harmonic oscillator, sampled over
  the normalized tween progress t (0 → 1). Progress is fed straight in as the
  oscillator's time in seconds, so the natural frequency doubles as the shape
  control: at OMEGA_N = 12 the response is visually complete by t = 1 for every
  damping ratio this module produces.

  Underdamped (overshoot > 0):
    x(t) = 1 − e^(−ζ·ωn·t) · (cos(ωd·t) + (ζ / √(1−ζ²)) · sin(ωd·t))
    ωd = ωn · √(1−ζ²)

  Critically damped (overshoot = 0):
    x(t) = 1 − e^(−ωn·t) · (1 + ωn·t)

  Both are normalized by their own value at t = 1 so every curve lands exactly
  on 1 — the residual is well under a pixel either way, but an exact landing
  means the tween's final frame never has to snap.
*/

// natural frequency — governs how much of the response fits inside the tween
const OMEGA_N = 12;

// default peak overshoot, matching the settle-overshoot attribute default
const DEFAULT_OVERSHOOT = 0.05;

// widest bounce the component accepts
const MAX_OVERSHOOT = 0.2;

/**
 * Damping ratio that produces a given peak overshoot in a step response.
 * Inverse of Mp = e^(−πζ / √(1−ζ²)).
 * @param {number} overshoot - Peak overshoot as a fraction (0.05 = 5%)
 * @returns {number} Damping ratio ζ in (0, 1)
 */
function dampingRatioForOvershoot(overshoot) {
	const logOvershoot = Math.log(overshoot);
	return -logOvershoot / Math.sqrt(Math.PI * Math.PI + logOvershoot * logOvershoot);
}

/**
 * Raw (un-normalized) underdamped step response.
 * @param {number} t - Time in seconds
 * @param {number} zeta - Damping ratio
 * @returns {number} Response value
 */
function underdamped(t, zeta) {
	const dampedFrequency = OMEGA_N * Math.sqrt(1 - zeta * zeta);
	const decay = Math.exp(-zeta * OMEGA_N * t);
	const ratio = zeta / Math.sqrt(1 - zeta * zeta);
	return 1 - decay * (Math.cos(dampedFrequency * t) + ratio * Math.sin(dampedFrequency * t));
}

/**
 * Raw (un-normalized) critically damped step response — no overshoot.
 * @param {number} t - Time in seconds
 * @returns {number} Response value
 */
function criticallyDamped(t) {
	return 1 - Math.exp(-OMEGA_N * t) * (1 + OMEGA_N * t);
}

// generated easings are cached by overshoot — a settle must not re-derive ζ
const easeCache = new Map();

/**
 * Builds a settle easing function for a given peak overshoot.
 * The returned function maps normalized progress 0 → 1 onto the oscillator's
 * step response, and is exact at both ends (0 → 0, 1 → 1).
 * @param {number} overshoot - Peak overshoot as a fraction; 0 = critically damped
 * @returns {(t: number) => number} Easing function
 */
function makeSettleEase(overshoot) {
	const amount = Number.isFinite(overshoot) ? Math.min(Math.max(overshoot, 0), MAX_OVERSHOOT) : 0;
	const cached = easeCache.get(amount);
	if (cached) return cached;

	let ease;
	if (amount <= 0) {
		const scale = 1 / criticallyDamped(1);
		ease = (t) => {
			if (t <= 0) return 0;
			if (t >= 1) return 1;
			return criticallyDamped(t) * scale;
		};
	} else {
		const zeta = dampingRatioForOvershoot(amount);
		const scale = 1 / underdamped(1, zeta);
		ease = (t) => {
			if (t <= 0) return 0;
			if (t >= 1) return 1;
			return underdamped(t, zeta) * scale;
		};
	}

	easeCache.set(amount, ease);
	return ease;
}

/**
 * The DEFAULT curve (5% overshoot) as a CSS `linear()` timing function, for
 * authors who want their own transitions to match the settle. 24 samples is
 * enough for the bounce to read correctly at any duration the component uses.
 */
const SETTLE_LINEAR_CURVE =
	'linear(0, 0.1062, 0.3275, 0.5628, 0.7602, 0.9018, 0.9893, 1.0339, 1.0492, 1.0473, 1.0374, 1.0255, 1.0148, 1.0068, 1.0016, 0.9988, 0.9976, 0.9975, 0.9979, 0.9985, 0.9991, 0.9995, 0.9998, 1)';

export {
	OMEGA_N,
	DEFAULT_OVERSHOOT,
	MAX_OVERSHOOT,
	SETTLE_LINEAR_CURVE,
	dampingRatioForOvershoot,
	makeSettleEase,
};
