import type { CSSProperties } from "react";

/*
 * The hero artwork, drawn in code in the cut-paper style of the illustrations: every call arrives
 * on its own line, turns once, and lands in its own socket. Nothing crosses. The lines share one
 * centre, so they nest like lanes on a track.
 */
const centre = { x: 640, y: 250 };
const socketY = 146;
const lanes = [90, 186, 282, 378, 474].map((radius, index) => ({
  ink: index % 2 === 0,
  radius,
  x: centre.x - radius,
  y: centre.y + radius,
}));

const step = (index: number) => ({ "--i": index }) as CSSProperties;

export const HeroArt = () => (
  <svg
    aria-hidden="true"
    className="voke-hero-svg"
    fill="none"
    viewBox="0 0 900 800"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      {/* Paper grain, printed only where there is ink. */}
      <filter height="120%" id="voke-grain" width="120%" x="-10%" y="-10%">
        <feTurbulence
          baseFrequency="1.1"
          numOctaves="2"
          result="noise"
          seed="4"
          type="fractalNoise"
        />
        <feColorMatrix
          in="noise"
          result="speckle"
          type="matrix"
          values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -0.5 1.12"
        />
        <feComposite in="SourceGraphic" in2="speckle" operator="in" />
      </filter>
    </defs>
    <g filter="url(#voke-grain)">
      {lanes.map((lane, index) => (
        <g key={lane.radius}>
          <path
            className="voke-lane"
            d={`M 1100 ${lane.y} H ${centre.x} A ${lane.radius} ${lane.radius} 0 0 1 ${lane.x} ${centre.y} V ${socketY}`}
            pathLength={1}
            stroke={
              lane.ink ? "var(--color-voke-ink)" : "var(--color-voke-bone)"
            }
            strokeWidth={36}
            style={step(index)}
          />
          {/* The socket takes the other ink, so the plug always reads against it. */}
          <circle
            cx={lane.x}
            cy={socketY}
            fill="var(--color-voke-bakelite)"
            r={29}
            stroke={
              lane.ink ? "var(--color-voke-bone)" : "var(--color-voke-ink)"
            }
            strokeWidth={22}
          />
          <circle
            className="voke-plug"
            cx={lane.x}
            cy={socketY}
            fill={lane.ink ? "var(--color-voke-ink)" : "var(--color-voke-bone)"}
            r={19}
            style={step(index)}
          />
          <circle
            className="voke-plug"
            cx={lane.x}
            cy={socketY - 78}
            fill="var(--color-voke-lamp)"
            r={9}
            style={step(index)}
          />
        </g>
      ))}
    </g>
  </svg>
);
