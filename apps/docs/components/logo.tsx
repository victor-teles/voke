/** The Voke mark: a jack socket with a lit lamp. The "o" of the wordmark is the socket. */
export const LogoMark = ({ className }: { className?: string }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="3.4" />
    <circle cx="12" cy="12" fill="var(--color-voke-lamp)" r="2.7" />
  </svg>
);

export const Logo = () => (
  <span className="inline-flex items-center gap-2 font-[family-name:var(--font-display)] text-[1.15rem] font-bold tracking-tight [font-variation-settings:'wdth'_88]">
    <LogoMark className="size-[1.35rem]" />
    Voke
  </span>
);
