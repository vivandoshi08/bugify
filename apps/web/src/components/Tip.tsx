"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Props = { text: ReactNode; children: ReactNode; className?: string; plain?: boolean };

/**
 * Hover / focus tooltip. The trigger is focusable so keyboards reach it; Esc dismisses.
 * The popover is portalled to <body> with fixed positioning so it escapes the tables'
 * overflow-x:auto wrappers instead of being clipped by them.
 */
export function Tip({ text, children, className = "", plain = false }: Props) {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 296)), top: r.bottom + 6 });
  };
  const hide = () => setPos(null);
  const trigger = plain ? "" : "cursor-help underline decoration-dotted decoration-zinc-400 underline-offset-2 dark:decoration-zinc-500";

  return (
    <>
      <span
        ref={ref}
        tabIndex={0}
        aria-describedby={pos ? id : undefined}
        className={`inline-flex rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 ${trigger} ${className}`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => {
          if (e.key === "Escape") hide();
        }}
      >
        {children}
      </span>
      {pos &&
        createPortal(
          <span
            role="tooltip"
            id={id}
            style={pos}
            className="pointer-events-none fixed z-50 w-max max-w-[288px] rounded border border-zinc-200 bg-white px-2 py-1.5 text-left text-[11px] font-normal normal-case leading-snug tracking-normal text-zinc-700 shadow-md dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            {text}
          </span>,
          document.body,
        )}
    </>
  );
}
