import React, { useEffect, useRef, useState } from 'react';
import logo from '../assets/ensight-logo-hires.png';
import './EnsightLoadingScreen.css';

/**
 * EnSight brand loader — full choreography ported from the design handoff
 * (design_handoff_loading_page/README.md + ensight-logo-loader.jsx, "wipe"
 * variant). Driven by requestAnimationFrame rather than CSS @keyframes: the
 * spec is several overlapping value ramps on three distinct named easings
 * (enter/sweep) over sub-second windows within a 7s loop — hand-converting
 * that to keyframe percentages risks rounding drift against the "final,
 * pixel-perfect" spec, where recomputing the same formulas each frame can't.
 *
 * Values/timings below are not tunable knobs — see the handoff README for
 * what each one means; change them only if the approved design changes.
 */

const LOOP_SECONDS = 7.0;
const EXIT_FADE_SECONDS = 0.3;

const easeOutCubic = (x) => 1 - (1 - x) ** 3;
const easeInOutSine = (x) => -(Math.cos(Math.PI * x) - 1) / 2;

function ramp(from, to, start, end, ease) {
  return (t) => {
    if (t <= start) return from;
    if (t >= end) return to;
    return from + (to - from) * ease((t - start) / (end - start));
  };
}

const wipeX = ramp(101, 0, 0.1, 1.35, easeOutCubic);
const logoOpacityRamp = ramp(0, 1, 0.05, 0.9, easeOutCubic);
const barOpacityRamp = ramp(0, 1, 1.0, 1.55, easeOutCubic);
const sweep1Ramp = ramp(-70, 170, 1.7, 3.3, easeInOutSine);
const sweep2Ramp = ramp(-70, 170, 4.15, 5.95, easeInOutSine);
const settledRamp = ramp(0, 1, 1.4, 2.0, easeOutCubic);
const pageFadeRamp = ramp(1, 0, 6.25, 6.95, easeInOutSine);

function frac01(x) {
  return ((x % 1) + 1) % 1;
}

function computeFrame(t) {
  const settled = settledRamp(t);
  const pulse = 1 + 0.014 * settled * Math.sin((t - 1.6) * 2.2);
  const run = frac01((t - 1.6) * 0.55);
  return {
    wipeX: wipeX(t),
    logoOpacity: logoOpacityRamp(t),
    barOpacity: barOpacityRamp(t),
    sweep1: sweep1Ramp(t),
    sweep2: sweep2Ramp(t),
    pulse,
    runnerLeft: -80 + run * 320,
    pageOpacity: pageFadeRamp(t),
  };
}

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * @param {{ isLoading: boolean }} props - render this mounted for the app's
 *   lifetime; it manages its own presence (renders null once fully exited).
 */
export default function EnsightLoadingScreen({ isLoading }) {
  const [frame, setFrame] = useState(() => computeFrame(0));
  const [phase, setPhase] = useState(isLoading ? 'loop' : 'done');
  const [prevIsLoading, setPrevIsLoading] = useState(isLoading);
  const loopStartRef = useRef(null);
  const exitStartRef = useRef(null);
  const rafRef = useRef(null);
  const [reduced] = useState(prefersReducedMotion);

  // Adjust phase in response to an isLoading prop change — done during
  // render (React's sanctioned "derived state from props" pattern) rather
  // than in an effect, avoiding an extra render round-trip. The refs below
  // are reset in the separate effect that follows (ref writes belong in
  // effects/handlers, not render).
  if (isLoading !== prevIsLoading) {
    setPrevIsLoading(isLoading);
    if (isLoading) {
      setPhase('loop');
    } else if (phase === 'loop') {
      setPhase('exit');
    }
  }

  useEffect(() => {
    if (phase === 'loop') loopStartRef.current = null;
    else if (phase === 'exit') exitStartRef.current = null;
  }, [phase]);

  useEffect(() => {
    if (phase === 'done') return undefined;

    const tick = (now) => {
      if (phase === 'loop') {
        if (loopStartRef.current == null) loopStartRef.current = now;
        const elapsed = ((now - loopStartRef.current) / 1000) % LOOP_SECONDS;
        setFrame(computeFrame(elapsed));
      } else if (phase === 'exit') {
        if (exitStartRef.current == null) exitStartRef.current = now;
        const elapsed = (now - exitStartRef.current) / 1000;
        if (elapsed >= EXIT_FADE_SECONDS) {
          setPhase('done');
          return;
        }
        setFrame((prev) => ({
          ...prev,
          pageOpacity: prev.pageOpacity * (1 - easeOutCubic(elapsed / EXIT_FADE_SECONDS)),
        }));
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase]);

  if (phase === 'done') return null;

  return (
    <div className="ensight-loader" style={{ opacity: frame.pageOpacity }} role="status" aria-live="polite">
      <div
        className="ensight-loader__logo"
        style={{
          opacity: reduced ? 1 : frame.logoOpacity,
          transform: reduced ? 'none' : `scale(${frame.pulse})`,
          clipPath: reduced ? 'none' : `inset(-20% ${frame.wipeX}% -20% 0)`,
        }}
      >
        <img src={logo} alt="EnSight Technologies" className="ensight-loader__logo-img" />
        {!reduced && (
          <div
            className="ensight-loader__shine-mask"
            style={{ WebkitMaskImage: `url(${logo})`, maskImage: `url(${logo})` }}
          >
            <div className="ensight-loader__shine" style={{ left: `${frame.sweep1}%` }} />
            <div className="ensight-loader__shine" style={{ left: `${frame.sweep2}%` }} />
          </div>
        )}
      </div>
      <div className="ensight-loader__track" style={{ opacity: reduced ? 1 : frame.barOpacity }}>
        <div className="ensight-loader__runner" style={{ left: `${frame.runnerLeft}px` }} />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
