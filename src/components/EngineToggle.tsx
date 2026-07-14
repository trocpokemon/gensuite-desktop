import type { ReactNode } from 'react';

// Segmented toggle used across all steps to swap providers (free/local vs cloud).
// Purely presentational: parent owns the selected value and options.

export interface EngineOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  /** Marks a premium/cloud option — gets the warm accent treatment. */
  premium?: boolean;
  icon?: ReactNode;
}

interface Props<T extends string> {
  label?: string;
  value: T;
  options: EngineOption<T>[];
  onChange: (value: T) => void;
}

export function EngineToggle<T extends string>({ label, value, options, onChange }: Props<T>) {
  return (
    <div className="flex flex-col gap-xs">
      {label && <span className="text-xs font-medium uppercase tracking-wide text-text/50">{label}</span>}
      <div className="inline-flex w-fit rounded-xl border border-white/10 bg-white/[0.035] p-1 shadow-inner">
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              title={opt.hint}
              className={`flex cursor-pointer items-center gap-sm rounded-lg px-md py-2 text-[13px] font-semibold transition-all duration-200 ${
                active
                  ? opt.premium
                    ? 'bg-emerald-400/15 text-emerald-300 shadow-sm ring-1 ring-inset ring-emerald-400/15'
                    : 'bg-white/10 text-white shadow-sm'
                  : 'text-white/45 hover:bg-white/[0.04] hover:text-white/80'
              }`}
            >
              {opt.icon}
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
