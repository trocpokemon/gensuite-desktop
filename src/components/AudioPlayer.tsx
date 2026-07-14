import { useEffect, useId, useRef, useState } from 'react';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';

interface AudioPlayerProps {
  src: string;
  onError?: () => void;
  onDuration?: (durationSec: number) => void;
  className?: string;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function readDuration(audio: HTMLAudioElement): number {
  let duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  if (audio.seekable.length > 0) {
    const seekableEnd = audio.seekable.end(audio.seekable.length - 1);
    if (Number.isFinite(seekableEnd)) duration = Math.max(duration, seekableEnd);
  }
  return duration;
}

export function AudioPlayer({ src, onError, onDuration, className = '' }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastDurationRef = useRef(0);
  const playerId = useId();
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    lastDurationRef.current = 0;
  }, [src]);

  useEffect(() => {
    const pauseOtherPlayers = (event: Event) => {
      const owner = (event as CustomEvent<string>).detail;
      if (owner !== playerId && audioRef.current && !audioRef.current.paused) audioRef.current.pause();
    };
    window.addEventListener('gensuite:audio-play', pauseOtherPlayers);
    return () => window.removeEventListener('gensuite:audio-play', pauseOtherPlayers);
  }, [playerId]);

  const syncDuration = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const measured = readDuration(audio);
    if (measured <= 0) return;
    setDuration(measured);
    if (Math.abs(measured - lastDurationRef.current) > 0.1) {
      lastDurationRef.current = measured;
      onDuration?.(measured);
    }
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      window.dispatchEvent(new CustomEvent('gensuite:audio-play', { detail: playerId }));
      await audio.play().catch(() => undefined);
    } else {
      audio.pause();
    }
  };

  const seek = (value: number) => {
    const audio = audioRef.current;
    if (!audio || duration <= 0) return;
    audio.currentTime = Math.min(value, duration);
    setCurrentTime(audio.currentTime);
  };

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div className={`flex min-w-0 items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.035] px-3 py-2 ${className}`}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        muted={muted}
        onLoadedMetadata={syncDuration}
        onDurationChange={syncDuration}
        onCanPlay={syncDuration}
        onProgress={syncDuration}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrentTime(0); }}
        onError={onError}
        className="hidden"
      />
      <button type="button" onClick={() => void togglePlayback()} aria-label={playing ? 'Tạm dừng' : 'Phát'} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white text-black transition-transform hover:scale-105">
        {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="ml-0.5" />}
      </button>
      <span className="w-[76px] shrink-0 font-mono text-[11px] tabular-nums text-white/65">{formatTime(currentTime)} / {formatTime(duration)}</span>
      <input
        type="range"
        min={0}
        max={duration || 1}
        step={0.01}
        value={Math.min(currentTime, duration || 1)}
        onChange={(event) => seek(Number(event.target.value))}
        aria-label="Tiến độ audio"
        className="audio-progress h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full"
        style={{ background: `linear-gradient(to right, #34d399 0%, #34d399 ${progress}%, rgba(255,255,255,.16) ${progress}%, rgba(255,255,255,.16) 100%)` }}
      />
      <button type="button" onClick={() => setMuted((value) => !value)} aria-label={muted ? 'Bật âm thanh' : 'Tắt âm thanh'} className="shrink-0 rounded-lg p-1.5 text-white/55 hover:bg-white/[0.07] hover:text-white">
        {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </button>
    </div>
  );
}
