"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

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

interface Point {
  x: number;
  y: number;
}

interface Geometry {
  inlet: Point;
  sockets: Point[];
}

interface Patch {
  previous: number | null;
  selected: number;
}

const autoplayMs = 5600;
const cornerRadius = 18;
// The new cord starts while the old one is still pulling back.
const overlapMs = 170;

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const centre = (
  element: Element | null | undefined,
  box: DOMRect
): Point | null => {
  const rect = element?.getBoundingClientRect();

  if (rect === undefined || rect.width === 0) {
    return null;
  }

  return {
    x: rect.left + rect.width / 2 - box.left,
    y: rect.top + rect.height / 2 - box.top,
  };
};

/** A cord that leaves `from` level, turns twice halfway with rounded corners, and arrives level. */
const cordPath = (from: Point, to: Point): string => {
  const rise = to.y - from.y;

  if (Math.abs(rise) < 2) {
    return `M ${from.x} ${from.y} H ${to.x}`;
  }

  const midX = (from.x + to.x) / 2;
  const turn = Math.min(
    cornerRadius,
    Math.abs(rise) / 2,
    Math.abs(midX - from.x)
  );
  const across = Math.sign(to.x - from.x) || 1;
  const down = Math.sign(rise);

  return `M ${from.x} ${from.y} H ${midX - across * turn} Q ${midX} ${from.y} ${midX} ${from.y + down * turn} V ${to.y - down * turn} Q ${midX} ${to.y} ${midX + across * turn} ${to.y} H ${to.x}`;
};

const delay = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;
const order = (index: number) => ({ "--i": index }) as CSSProperties;

/**
 * The jack field: pick what calls the Function on the left, and a cord is patched into the
 * Function on the right. It cycles on its own, while it is on screen, until someone takes over.
 */
export const Wiring = ({ sources }: { sources: readonly WiringSource[] }) => {
  const [patch, setPatch] = useState<Patch>({ previous: null, selected: 0 });
  const [autoplay, setAutoplay] = useState(true);
  const [inView, setInView] = useState(false);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const inlet = useRef<HTMLSpanElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const sockets = useRef<(HTMLSpanElement | null)[]>([]);
  const count = sources.length;
  const { previous, selected } = patch;
  const source = sources[selected];

  const measure = useCallback(() => {
    const box = stage.current?.getBoundingClientRect();

    if (box === undefined) {
      return;
    }

    const to = centre(inlet.current, box);
    const from = sockets.current
      .slice(0, count)
      .map((socket) => centre(socket, box));
    const measured = from.filter((point) => point !== null);

    // Below the desktop layout the sockets are hidden, and there is no cord to draw.
    setGeometry(
      to === null || measured.length !== count
        ? null
        : { inlet: to, sockets: measured }
    );
  }, [count]);

  useLayoutEffect(() => {
    const element = stage.current;

    if (element === null) {
      return;
    }

    const observer = new ResizeObserver(measure);

    measure();
    observer.observe(element);
    // The labels set the column's height, so the sockets move when the fonts arrive.
    document.fonts.addEventListener("loadingdone", measure);

    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [measure]);

  useEffect(() => {
    const element = stage.current;

    if (element === null) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => setInView(entries.some((entry) => entry.isIntersecting)),
      { threshold: 0.35 }
    );

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!(autoplay && inView) || prefersReducedMotion()) {
      return;
    }

    const timer = setInterval(
      () =>
        setPatch((current) => ({
          previous: current.selected,
          selected: (current.selected + 1) % count,
        })),
      autoplayMs
    );

    return () => clearInterval(timer);
  }, [autoplay, inView, count]);

  const choose = (index: number) => {
    setAutoplay(false);
    setPatch((current) =>
      current.selected === index
        ? current
        : { previous: current.selected, selected: index }
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1 }[
      event.key
    ];

    if (step === undefined) {
      return;
    }

    event.preventDefault();
    const next = (selected + step + count) % count;

    choose(next);
    tabs.current[next]?.focus();
  };

  if (source === undefined) {
    return null;
  }

  const cordTo = (index: number | null): string | null => {
    const socket = index === null ? undefined : geometry?.sockets[index];

    return geometry === null || socket === undefined
      ? null
      : cordPath(geometry.inlet, socket);
  };
  const leaving = cordTo(previous);
  const arriving = cordTo(selected);
  const moved = previous !== null;

  return (
    <div
      className="voke-wiring"
      data-moved={moved ? "" : undefined}
      onPointerEnter={() => setAutoplay(false)}
      ref={stage}
    >
      <div
        aria-label="What calls the Function"
        aria-orientation="vertical"
        className="voke-jacks"
        onKeyDown={onKeyDown}
        role="tablist"
      >
        {sources.map((item, index) => (
          <button
            aria-controls="voke-wiring-panel"
            aria-selected={index === selected}
            className="voke-jack"
            id={`voke-wiring-tab-${item.id}`}
            key={item.id}
            onClick={() => choose(index)}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            role="tab"
            tabIndex={index === selected ? 0 : -1}
            type="button"
          >
            {item.label}
            <span
              aria-hidden="true"
              className="voke-socket"
              ref={(element) => {
                sockets.current[index] = element;
              }}
            />
          </button>
        ))}
      </div>

      <div aria-hidden="true" />

      <div
        aria-labelledby={`voke-wiring-tab-${source.id}`}
        className="voke-function"
        id="voke-wiring-panel"
        role="tabpanel"
      >
        <div className="voke-function-head">
          <span aria-hidden="true" className="voke-inlet" ref={inlet} />
          <span className="voke-function-file">{source.file}</span>
          <span className="voke-function-when" key={source.id}>
            {source.when}
          </span>
        </div>
        <div className="voke-function-code voke-flush" key={source.id}>
          {source.code}
        </div>
        <div className="voke-deploys" key={`deploys-${source.id}`}>
          <span className="voke-deploys-label">Voke deploys</span>
          {source.deploys.map((item, index) => (
            <span className="voke-chip" key={item} style={order(index)}>
              {item}
            </span>
          ))}
        </div>
      </div>

      <svg aria-hidden="true" className="voke-cords">
        {leaving === null ? null : (
          <path
            className="voke-cord"
            d={leaving}
            data-state="out"
            key={`out-${previous}-${selected}`}
            pathLength={1}
          />
        )}
        {arriving === null ? null : (
          <path
            className="voke-cord"
            d={arriving}
            data-state="in"
            key={`in-${selected}`}
            pathLength={1}
            style={delay(moved ? overlapMs : 0)}
          />
        )}
      </svg>
    </div>
  );
};
