import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

/** The illustrations in `public/illustrations`, one per area of the docs. */
export type PlateArt =
  | "deploy"
  | "durable"
  | "events"
  | "functions"
  | "http"
  | "local"
  | "plugins"
  | "reference";

interface PlateCardProps {
  art: PlateArt;
  children: ReactNode;
  href: string;
  title: string;
}

/** A grid of illustrated cards, for pages that send the reader somewhere else. */
export const PlateCards = ({ children }: { children: ReactNode }) => (
  <div className="not-prose my-8 grid gap-x-5 gap-y-9 sm:grid-cols-2">
    {children}
  </div>
);

/** A link card with one of the Voke illustrations above its title. */
export const PlateCard = ({ art, children, href, title }: PlateCardProps) => (
  <Link
    className="group block rounded-[16px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-fd-ring"
    data-card
    href={href}
  >
    <div className="voke-plate aspect-[16/9]">
      <Image
        alt=""
        height={576}
        src={`/illustrations/${art}.webp`}
        width={1024}
      />
    </div>
    <p className="mt-4 text-[1.02rem] font-semibold text-fd-foreground transition-colors group-hover:text-fd-primary">
      {title}
    </p>
    {/* MDX wraps the description in its own paragraph, so this is a div. */}
    <div className="mt-1.5 text-[0.94rem] leading-[1.6] text-fd-muted-foreground [&_p]:m-0">
      {children}
    </div>
  </Link>
);
