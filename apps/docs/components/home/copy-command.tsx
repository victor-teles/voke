"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

const copiedMs = 1600;

/** A shell command on a label plate, with a button that copies it. */
export const CopyCommand = ({ command }: { command: string }) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timer = setTimeout(() => setCopied(false), copiedMs);

    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
  };

  return (
    <div className="inline-flex items-stretch overflow-hidden rounded-[10px] border border-white/14 bg-white/[0.04] font-mono text-[0.86rem] text-voke-bone backdrop-blur-sm">
      <span className="flex items-center gap-2.5 py-2.5 pr-3 pl-3.5">
        <span aria-hidden="true" className="select-none text-white/40">
          $
        </span>
        {command}
      </span>
      <button
        aria-label={copied ? "Copied" : `Copy command: ${command}`}
        className="grid w-10 place-items-center border-l border-white/14 text-white/60 transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-voke-lamp"
        onClick={copy}
        type="button"
      >
        {copied ? (
          <Check aria-hidden="true" className="size-4 text-voke-lamp" />
        ) : (
          <Copy aria-hidden="true" className="size-4" />
        )}
      </button>
    </div>
  );
};
