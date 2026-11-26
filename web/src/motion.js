import { animate } from "motion";

// Shared motion vocabulary for Puffin. Movement is transform/opacity only,
// and every helper is a no-op when the listener prefers reduced motion or
// has enabled "Reduce nonessential animation" in Settings.
export const MOTION_EASE = [0.22, 1, 0.36, 1];
export const MOTION_SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.7 };

export function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return document.documentElement.dataset.reduceMotion === "true"
    || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function animateElement(element, keyframes, options) {
  if (!element || prefersReducedMotion()) return null;
  return animate(element, keyframes, options);
}

export function translateYOf(element) {
  if (!element) return 0;
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === "none") return 0;
  try {
    return new DOMMatrixReadOnly(transform).m42;
  } catch {
    return 0;
  }
}