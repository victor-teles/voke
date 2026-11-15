"use client";

import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";

interface RevealProps {
  children: ReactNode;
  className?: string;
  /** Position in a staggered group; each step delays the reveal by 80ms. */
  index?: number;
}

/**
 * Fades its children up once, the first time they scroll into view. Content is visible by default
 * and only hidden ("armed") after hydration when it starts below the fold, so it still shows
 * without JavaScript, in print and in page captures.
 */
export const Reveal = ({
  children,
  className = "",
  index = 0,
}: RevealProps) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;

    if (element === null) {
      return;
    }

    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      element.getBoundingClientRect().top < window.innerHeight
    ) {
      return;
    }

    element.dataset.armed = "";

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          element.dataset.shown = "";
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.12 }
    );

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={`voke-reveal ${className}`}
      ref={ref}
      style={{ "--i": index } as CSSProperties}
    >
      {children}
    </div>
  );
};
