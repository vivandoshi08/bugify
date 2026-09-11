"use client";

import { useSyncExternalStore } from "react";

const KEY = "bbb:howItWorks";
const EVT = "bbb:howItWorks";

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: "Post",
    body: "A buyer locks a reward per invariant in escrow, pinned to the hash of a private manifest (system prompt, tools, mocks).",
  },
  {
    title: "Commit",
    body: "A seller stakes a bond and posts keccak(transcript ‖ salt) on chain before revealing anything.",
  },
  {
    title: "Verify",
    body: "The verifier replays the transcript k times against the pinned agent and attests PASS or FAIL on chain — trace predicates, not an LLM judge.",
  },
  {
    title: "Settle",
    body: "After the dispute window anyone finalizes: PASS pays the reward and returns the bond, FAIL slashes the bond to the treasury.",
  },
];

// Open on first visit; the choice is remembered per browser. useSyncExternalStore keeps SSR
// (always open) and the client in step without a setState-in-effect flash.
const subscribe = (cb: () => void) => {
  window.addEventListener("storage", cb);
  window.addEventListener(EVT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(EVT, cb);
  };
};
const read = () => {
  try {
    return localStorage.getItem(KEY) !== "closed";
  } catch {
    return true;
  }
};
const write = (open: boolean) => {
  try {
    localStorage.setItem(KEY, open ? "open" : "closed");
  } catch {
    /* private mode etc. — the strip just won't remember */
  }
  window.dispatchEvent(new Event(EVT));
};

export function HowItWorks() {
  const open = useSyncExternalStore(subscribe, read, () => true);
  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="how-it-works"
        onClick={() => write(!open)}
        className="flex w-full items-center justify-between px-4 py-2 text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-300">How it works</span>
        <span className="text-[11px] text-zinc-500">
          {open ? "hide" : "show"} <span aria-hidden>{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && (
        <ol id="how-it-works" className="grid gap-x-6 gap-y-3 border-t border-zinc-200 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4 dark:border-zinc-800">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-2.5">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-900 font-mono text-[11px] text-white dark:bg-zinc-100 dark:text-zinc-900">
                {i + 1}
              </span>
              <div>
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{s.title}</div>
                <p className="text-xs leading-snug text-zinc-500">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
