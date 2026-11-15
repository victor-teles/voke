"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, ReactNode } from "react";

export interface WiringSource {
  /** What Voke deploys for a Function with this Event Source. */
  deploys: readonly string[];
  /** The file name shown above the code. */
  file: string;
  id: string;
  /** The AWS service that calls the Function. */
  label: string;
  /** The Function's code, already highlighted on the server. */
  code: ReactNode;
  /** One line that says when the Function runs. */
  when: string;
}

interface Cord {
  height: number;
  path: string;
  width: number;
}

const autoplayMs = 4200;

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// A cord hangs: it leaves the jack level, sags below both ends, and rises into the plug.
const cordPath = (
  fromY: number,
  toY: number,
  width: number,
  height: number
): string => {
  const sag = Math.min(height - 8, Math.max(fromY, toY) + 46);

  return `M 0 ${fromY} C ${width * 0.42} ${fromY}, ${width * 0.3} ${sag}, ${width * 0.55} ${sag} S ${width * 0.72} ${toY}, ${width} ${toY}`;
};

/**
 * The jack field: pick what calls the Function on the left, and a cord is patched into the
 * Function on the right. It cycles on its own until someone takes over.
 */
export const Wiring = ({ sources }: { sources: readonly WiringSource[] }) => {
  const [selected, setSelected] = useState(0);
  const [autoplay, setAutoplay] = useState(true);
  const [cord, setCord] = useState<Cord | null>(null);
  const jacks = useRef<(HTMLButtonElement | null)[]>([]);
  const gap = useRef<HTMLDivElement>(null);
  const plug = useRef<HTMLSpanElement>(null);
  const source = sources[selected] ?? sources[0];

  const measure = useCallback(() => {
    const area = gap.current;
    const jack = jacks.current[selected];
    const target = plug.current;

    if (
      area === null ||
      jack === null ||
      jack === undefined ||
      target === null
    ) {
      return;
    }

    const box = area.getBoundingClientRect();

    if (box.width < 24) {
      setCord(null);

      return;
    }

    const jackBox = jack.getBoundingClientRect();
    const plugBox = target.getBoundingClientRect();
    const fromY = jackBox.top + jackBox.height / 2 - box.top;
    const toY = plugBox.top + plugBox.height / 2 - box.top;

    setCord({
      height: box.height,
      path: cordPath(fromY, toY, box.width, box.height),
      width: box.width,
    });
  }, [selected]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const observer = new ResizeObserver(measure);

    if (gap.current !== null) {
      observer.observe(gap.current);
    }

    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => {
    if (!autoplay || prefersReducedMotion()) {
      return;
    }

    const timer = setInterval(
      () => setSelected((current) => (current + 1) % sources.length),
      autoplayMs
    );

    return () => clearInterval(timer);
  }, [autoplay, sources.length]);

  const choose = (index: number) => {
    setAutoplay(false);
    setSelected(index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1 }[
      event.key
    ];

    if (step === undefined) {
      return;
    }

    event.preventDefault();
    const next = (selected + step + sources.length) % sources.length;

    choose(next);
    jacks.current[next]?.focus();
  };

  if (source === undefined) {
    return null;
  }

  return (
    <div
      className="grid gap-5 lg:grid-cols-[15.5rem_minmax(3rem,7rem)_minmax(0,1fr)] lg:gap-0"
      onPointerEnter={() => setAutoplay(false)}
    >
      <div
        aria-label="What calls the Function"
        aria-orientation="vertical"
        className="flex flex-wrap gap-1 lg:flex-col lg:flex-nowrap"
        onKeyDown={onKeyDown}
        role="tablist"
      >
        {sources.map((item, index) => (
          <button
            aria-controls="voke-wiring-panel"
            aria-selected={index === selected}
            className="voke-jack w-auto! lg:w-full!"
            id={`voke-wiring-tab-${item.id}`}
            key={item.id}
            onClick={() => choose(index)}
            ref={(element) => {
              jacks.current[index] = element;
            }}
            role="tab"
            tabIndex={index === selected ? 0 : -1}
            type="button"
          >
            <span aria-hidden="true" className="voke-socket" />
            <span className="text-[0.94rem] font-medium whitespace-nowrap">
              {item.label}
            </span>
          </button>
        ))}
      </div>

      <div aria-hidden="true" className="relative hidden lg:block" ref={gap}>
        {cord === null ? null : (
          <svg
            className="absolute inset-0 overflow-visible"
            height={cord.height}
            key={`${source.id}-${cord.path}`}
            viewBox={`0 0 ${cord.width} ${cord.height}`}
            width={cord.width}
          >
            <path className="voke-cord" d={cord.path} pathLength={1} />
            <circle className="voke-signal motion-reduce:hidden" r="3.5">
              <animateMotion
                begin="0.55s"
                dur="1.5s"
                path={cord.path}
                repeatCount="indefinite"
              />
            </circle>
          </svg>
        )}
      </div>

      <div
        aria-labelledby={`voke-wiring-tab-${source.id}`}
        className="min-w-0 overflow-hidden rounded-[14px] border border-fd-border bg-fd-card shadow-[0_30px_70px_-40px_rgb(12_14_18/0.45)]"
        id="voke-wiring-panel"
        role="tabpanel"
      >
        <div className="flex items-center gap-3 border-b border-fd-border px-4 py-2.5">
          <span
            className="voke-socket text-fd-foreground opacity-100!"
            ref={plug}
          />
          <span className="font-mono text-[0.8rem] text-fd-muted-foreground">
            {source.file}
          </span>
          <span className="ml-auto flex items-center gap-2 font-mono text-[0.72rem] tracking-wide text-fd-muted-foreground uppercase">
            <span className="voke-lamp" />
            {source.when}
          </span>
        </div>
        <div
          className="voke-code-swap voke-flush min-h-[19.5rem] text-[0.84rem]"
          key={source.id}
        >
          {source.code}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-fd-border bg-fd-muted/50 px-4 py-3">
          <span className="voke-eyebrow mr-1 text-fd-muted-foreground">
            Voke deploys
          </span>
          {source.deploys.map((item) => (
            <span
              className="rounded-md border border-fd-border bg-fd-background px-2 py-1 font-mono text-[0.74rem] text-fd-foreground"
              key={item}
            >
              {item}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};
