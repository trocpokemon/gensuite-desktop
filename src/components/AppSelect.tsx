import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface AppSelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface Props<T extends string> {
  value: T;
  options: readonly AppSelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
  ariaLabel?: string;
}

interface MenuPosition {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

const VIEWPORT_GAP = 8;
const MENU_GAP = 6;
const MENU_MAX_HEIGHT = 280;

export function AppSelect<T extends string>({
  value,
  options,
  onChange,
  placeholder = 'Chọn một mục…',
  disabled = false,
  className = '',
  menuClassName = '',
  ariaLabel,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const updatePosition = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const availableBelow = window.innerHeight - rect.bottom - VIEWPORT_GAP - MENU_GAP;
    const availableAbove = rect.top - VIEWPORT_GAP - MENU_GAP;
    const openAbove = availableBelow < 160 && availableAbove > availableBelow;
    const available = Math.max(96, openAbove ? availableAbove : availableBelow);
    const width = Math.min(Math.max(rect.width, 180), window.innerWidth - VIEWPORT_GAP * 2);
    const left = Math.min(Math.max(VIEWPORT_GAP, rect.left), window.innerWidth - width - VIEWPORT_GAP);
    setPosition({
      left,
      width,
      maxHeight: Math.min(MENU_MAX_HEIGHT, available),
      ...(openAbove
        ? { bottom: window.innerHeight - rect.top + MENU_GAP }
        : { top: rect.bottom + MENU_GAP }),
    });
  };

  const firstEnabled = () => options.findIndex((option) => !option.disabled);
  const moveActive = (direction: 1 | -1) => {
    if (!options.length) return;
    let next = activeIndex >= 0 ? activeIndex : selectedIndex;
    for (let count = 0; count < options.length; count += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next].disabled) {
        setActiveIndex(next);
        return;
      }
    }
  };

  const openMenu = () => {
    if (disabled || !options.length) return;
    setActiveIndex(selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : firstEnabled());
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu();
      else moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault();
      choose(activeIndex);
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const reposition = () => updatePosition();
    window.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    menuRef.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  return <>
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      onClick={() => open ? setOpen(false) : openMenu()}
      onKeyDown={handleKeyDown}
      className={`field-surface flex w-full items-center gap-2 text-left text-white/80 transition disabled:cursor-not-allowed disabled:opacity-45 ${open ? 'border-emerald-400/70 ring-2 ring-emerald-400/10' : ''} ${className}`}
    >
      <span className={`min-w-0 flex-1 truncate ${selected ? '' : 'text-white/30'}`}>{selected?.label ?? placeholder}</span>
      <ChevronDown size={14} className={`shrink-0 text-white/35 transition-transform ${open ? 'rotate-180 text-emerald-300' : ''}`} />
    </button>
    {open && position && createPortal(
      <div
        ref={menuRef}
        id={listboxId}
        role="listbox"
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`fixed z-[1000] overflow-y-auto rounded-xl border border-white/10 bg-[#111112] p-1.5 shadow-[0_22px_70px_rgba(0,0,0,.82)] voice-pop-in ${menuClassName}`}
        style={{ left: position.left, width: position.width, maxHeight: position.maxHeight, top: position.top, bottom: position.bottom }}
      >
        {options.map((option, index) => {
          const selectedOption = option.value === value;
          const active = index === activeIndex;
          return <button
            key={`${option.value}-${index}`}
            type="button"
            role="option"
            aria-selected={selectedOption}
            disabled={option.disabled}
            data-option-index={index}
            onMouseEnter={() => !option.disabled && setActiveIndex(index)}
            onClick={() => choose(index)}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs transition disabled:cursor-not-allowed disabled:text-white/20 ${selectedOption ? 'bg-emerald-400/12 text-emerald-300' : active ? 'bg-white/[0.07] text-white' : 'text-white/65 hover:bg-white/[0.05] hover:text-white'}`}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {selectedOption && <Check size={14} className="shrink-0" />}
          </button>;
        })}
      </div>,
      document.body,
    )}
  </>;
}
