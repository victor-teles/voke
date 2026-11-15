"use client";

import { useEffect, useRef, useState } from "react";

interface TerminalProps {
  command: string;
  /** Milliseconds to wait, once in view, before typing starts. */
  delay?: number;
  /** Lines the command prints. A line that starts with ">" is shown as the result. */
  output: readonly string[];
  title: string;
}

const typeMs = 42;
const lineMs = 170;

const prefersReducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A terminal that types its command and prints its output the first time it is seen. */
export const Terminal = ({
  command,
  delay = 0,
  output,
  title,
}: TerminalProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const [started, setStarted] = useState(false);
  const [typed, setTyped] = useState(0);
  const [lines, setLines] = useState(0);

  useEffect(() => {
    const element = ref.current;

    if (element === null) {
      return;
    }

    if (prefersReducedMotion()) {
      setTyped(command.length);
      setLines(output.length);

      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          timer = setTimeout(() => setStarted(true), delay);
          observer.disconnect();
        }
      },
      { threshold: 0.5 }
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [command.length, delay, output.length]);

  useEffect(() => {
    if (!started) {
      return;
    }

    if (typed < command.length) {
      const timer = setTimeout(() => setTyped(typed + 1), typeMs);

      return () => clearTimeout(timer);
    }

    if (lines < output.length) {
      const timer = setTimeout(() => setLines(lines + 1), lineMs);

      return () => clearTimeout(timer);
    }
  }, [started, typed, lines, command.length, output.length]);

  const typing = typed < command.length;

  return (
    <div
      className="voke-terminal flex h-full flex-col overflow-hidden rounded-[14px] border border-white/10 bg-voke-bakelite text-voke-bone"
      ref={ref}
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5 text-[0.74rem] tracking-wide text-white/50 uppercase">
        <span
          className="voke-lamp"
          data-off={lines < output.length ? "" : undefined}
        />
        {title}
      </div>
      {/* The full transcript is read by assistive technology; the animation is decorative. */}
      <pre className="sr-only">{`$ ${command}\n${output.map((line) => line.replace(/^>/u, "")).join("\n")}`}</pre>
      <div aria-hidden="true" className="min-h-[11.5rem] flex-1 px-4 py-3.5">
        <p className="whitespace-pre-wrap">
          <span className="text-white/40 select-none">$ </span>
          {command.slice(0, typed)}
          {typing || !started ? <span className="voke-caret" /> : null}
        </p>
        {output.slice(0, lines).map((line, index) =>
          line.startsWith(">") ? (
            <p
              className="break-all whitespace-pre-wrap text-voke-lamp"
              // oxlint-disable-next-line react/no-array-index-key -- the lines are static.
              key={index}
            >
              {line.slice(1)}
            </p>
          ) : (
            <p
              className="whitespace-pre-wrap text-white/60"
              // oxlint-disable-next-line react/no-array-index-key -- the lines are static.
              key={index}
            >
              {line === "" ? " " : line}
            </p>
          )
        )}
      </div>
    </div>
  );
};
