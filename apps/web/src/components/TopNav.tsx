"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Board" },
  { href: "/northwind", label: "Northwind" },
] as const;

/** Tiny top nav shared by the board and the deployer page. */
export function TopNav() {
  const path = usePathname();
  return (
    <nav className="border-b border-zinc-200 bg-white/70 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/70">
      <div className="mx-auto flex w-full max-w-[1500px] items-center gap-1 px-4 py-1.5 sm:px-6">
        <span className="mr-2 font-mono text-[11px] uppercase tracking-wider text-zinc-400">bazaar</span>
        {LINKS.map((l) => {
          const active = l.href === "/" ? path === "/" : path?.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded px-2 py-0.5 text-xs ${active ? "bg-zinc-200/80 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50" : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"}`}
            >
              {l.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
