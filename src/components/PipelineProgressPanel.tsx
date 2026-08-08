import { AlertTriangle, Check, Download, Languages, Layers3, Loader2, Mic2, Radio } from 'lucide-react';

export type PipelineStepStatus = 'pending' | 'active' | 'completed' | 'skipped' | 'error';

export interface PipelineProgressStep {
  id: string;
  label: string;
  status: PipelineStepStatus;
  percent: number;
  detail?: string;
}

interface Props {
  steps: PipelineProgressStep[];
  running: boolean;
  inactivitySeconds: number;
}

const STEP_ICONS = {
  download: Download,
  recognition: Radio,
  translation: Languages,
  voice: Mic2,
  capcut: Layers3,
} as const;

function activitySummary(seconds: number): { label: string; className: string; warning: boolean } {
  if (seconds >= 90) return { label: `Không có tiến triển trong ${seconds} giây · Có dấu hiệu bị gián đoạn`, className: 'text-red-300', warning: true };
  if (seconds >= 30) return { label: `Chưa có cập nhật mới trong ${seconds} giây · Tác vụ vẫn đang chờ phản hồi`, className: 'text-amber-200', warning: true };
  return { label: 'Hệ thống đang xử lý bình thường', className: 'text-emerald-300', warning: false };
}

function statusLabel(step: PipelineProgressStep, percent: number): string {
  if (step.status === 'completed') return 'Hoàn tất';
  if (step.status === 'active') return `${percent}%`;
  if (step.status === 'error') return 'Cần kiểm tra';
  if (step.status === 'skipped') return 'Bỏ qua';
  return 'Đang chờ';
}

export function PipelineProgressPanel({ steps, running, inactivitySeconds }: Props) {
  const activity = activitySummary(inactivitySeconds);
  const overallPercent = Math.round(steps.reduce((total, step) => total + Math.max(0, Math.min(100, step.percent)), 0) / Math.max(1, steps.length));
  const completed = steps.filter((step) => step.status === 'completed').length;
  const activeStep = steps.find((step) => step.status === 'active' || step.status === 'error');

  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.075] bg-[linear-gradient(145deg,rgba(255,255,255,.032),rgba(255,255,255,.012))]" aria-live="polite">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.06] px-5 py-4">
        <div>
          <p className="text-[9px] font-black uppercase tracking-[0.2em] text-emerald-300/75">Quy trình xử lý</p>
          <div className="mt-1 flex items-baseline gap-2"><h3 className="text-base font-black text-white">Tạo dự án chỉnh sửa</h3><span className="text-[10px] font-semibold text-white/30">{completed}/{steps.length} giai đoạn</span></div>
        </div>
        <div className="min-w-[180px] text-right">
          <div className="flex items-center justify-end gap-2"><span className="text-[10px] font-semibold text-white/35">Tiến độ tổng</span><span className="font-mono text-sm font-black text-emerald-300">{overallPercent}%</span></div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-300 transition-[width] duration-500" style={{ width: `${overallPercent}%` }} /></div>
        </div>
      </div>

      <div className="overflow-x-auto px-5 py-5">
        <div className="grid min-w-[760px] grid-cols-5">
          {steps.map((step, index) => {
            const percent = Math.max(0, Math.min(100, Math.round(step.percent)));
            const active = step.status === 'active';
            const failed = step.status === 'error';
            const completedStep = step.status === 'completed';
            const Icon = STEP_ICONS[step.id as keyof typeof STEP_ICONS] ?? Layers3;
            return <div key={step.id} className="relative flex min-w-0 flex-col items-center px-2 text-center">
              {index < steps.length - 1 && <span className={`absolute left-[calc(50%+24px)] right-[calc(-50%+24px)] top-5 h-px ${completedStep ? 'bg-emerald-400/55' : 'bg-white/[0.08]'}`} />}
              <span className={`relative z-10 grid h-10 w-10 place-items-center rounded-xl border transition-all duration-300 ${completedStep ? 'border-emerald-300/60 bg-emerald-400 text-[#07120f] shadow-[0_0_22px_rgba(52,211,153,.18)]' : active ? 'border-emerald-300/50 bg-emerald-400/10 text-emerald-200 shadow-[0_0_0_4px_rgba(52,211,153,.07),0_0_24px_rgba(52,211,153,.14)]' : failed ? 'border-red-300/45 bg-red-400/10 text-red-200' : 'border-white/[0.09] bg-[#171819] text-white/25'}`}>
                {completedStep ? <Check size={17} strokeWidth={3} /> : active ? <Loader2 size={17} className="animate-spin" /> : failed ? <AlertTriangle size={17} /> : <Icon size={16} />}
              </span>
              <p className={`mt-2.5 truncate text-[11px] font-bold ${active ? 'text-white' : failed ? 'text-red-100' : completedStep ? 'text-white/75' : 'text-white/35'}`}>{step.label}</p>
              <p className={`mt-1 text-[9px] font-semibold tabular-nums ${active ? 'text-emerald-300' : failed ? 'text-red-300' : completedStep ? 'text-emerald-300/65' : 'text-white/20'}`}>{statusLabel(step, percent)}</p>
            </div>;
          })}
        </div>
      </div>

      {(activeStep || running) && <div className="mx-5 mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.065] bg-black/20 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${activeStep?.status === 'error' ? 'bg-red-400/10 text-red-300' : 'bg-emerald-400/10 text-emerald-300'}`}>{activeStep?.status === 'error' ? <AlertTriangle size={15} /> : <Loader2 size={15} className="animate-spin" />}</span>
          <div className="min-w-0"><p className="truncate text-[11px] font-bold text-white/75">{activeStep?.label || 'Đang chuẩn bị'}</p><p className="mt-0.5 truncate text-[10px] text-white/35">{activeStep?.detail || 'Đang khởi tạo quy trình xử lý'}</p></div>
        </div>
        {running && <p className={`flex items-center gap-1.5 text-[10px] font-semibold ${activity.className}`}>{activity.warning && <AlertTriangle size={12} />}{activity.label}</p>}
      </div>}
    </div>
  );
}
