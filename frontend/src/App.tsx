import { Children, isValidElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

declare global {
  interface Window {
    abe?: { pickFolder: () => Promise<string | null>; restart?: () => Promise<void> };
  }
}

type ItemStatus = "pending" | "downloading" | "done" | "error";
type Mode = "audio" | "video";
type AudioFormat = "mp3" | "m4a" | "wav" | "flac" | "opus" | "original";
type AudioQuality = "best" | "320" | "256" | "192" | "128";
type VideoFormat = "mp4" | "mkv" | "webm";
type CookieBrowser = "" | "chrome" | "edge" | "firefox" | "brave" | "opera" | "vivaldi";
type VideoQuality = "best" | "2160" | "1440" | "1080" | "720" | "480" | "360";

interface DownloadItem {
  url: string;
  title: string | null;
  status: ItemStatus;
  progress: number;
  error: string | null;
  filename: string | null;
  filepath?: string | null;
  speed?: number | null;
  eta?: number | null;
}

interface Job {
  id: string;
  items: DownloadItem[];
  finished: boolean;
  cfg: { save_to_folder: boolean };
}

interface ResolvedItem {
  url: string;
  title: string | null;
  playlist_title: string | null;
  thumbnail: string | null;
  error: string | null;
  key?: string | null;
  duration?: number | null;
}

type FilenameTemplate =
  | "title"
  | "artist_title"
  | "title_artist"
  | "numbered"
  | "numbered_artist"
  | "channel_title"
  | "date_title"
  | "title_year"
  | "title_id";

interface ItemExtras {
  metaTitle: string;
  start: string;
  end: string;
}

interface HistoryEntry {
  key: string;
  url: string;
  title: string | null;
  filepath: string | null;
  when: number;
}

interface SessionState {
  urls: string;
  preview: ResolvedItem[] | null;
  selected: string[];
  overrides: Record<string, ItemConfig>;
  extras: Record<string, ItemExtras>;
}

function canonicalKey(url: string): string {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{11})/);
  if (m && /(youtube\.com|youtu\.be)/i.test(url)) return `yt:${m[1]}`;
  return url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
}

function fmtSpeed(bps?: number | null): string {
  if (!bps) return "";
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  return `${Math.round(bps / 1024)} KB/s`;
}

function fmtEta(sec?: number | null): string {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}min ${String(s).padStart(2, "0")}s` : `${s}s`;
}

// "1:30" ou "90" -> segundos; vazio -> undefined.
function parseTime(text: string): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const parts = t.split(":").map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const statusLabel: Record<ItemStatus, string> = {
  pending: "Aguardando",
  downloading: "Baixando",
  done: "Concluído",
  error: "Erro",
};

const statusColor: Record<ItemStatus, string> = {
  pending: "text-dim",
  downloading: "text-accent",
  done: "text-ok",
  error: "text-bad",
};

const btn =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-sm border border-line px-4 py-1.5 text-sm font-medium text-bone transition hover:border-dim hover:bg-panel disabled:cursor-not-allowed disabled:opacity-40";
const btnSmall =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-sm border border-line px-3 py-1.5 text-sm font-medium text-bone transition hover:border-dim hover:bg-panel disabled:cursor-not-allowed disabled:opacity-40";
const btnPrimary =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-sm bg-amber px-5 py-1.5 text-sm font-bold text-on-accent transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40";
const fieldCls =
  "h-10 w-full rounded-sm border border-line bg-panel px-3 py-1.5 text-sm text-bone outline-none focus:border-accent disabled:opacity-40";

const blockCls = "mt-3 rounded-sm border border-line bg-panel p-3 first-of-type:mt-0";

const WAVE_BARS = 56;

function waveHeights(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out: number[] = [];
  for (let i = 0; i < WAVE_BARS; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    const r = ((h >>> 0) % 1000) / 1000;
    const envelope = 0.55 + 0.45 * Math.sin((i / WAVE_BARS) * Math.PI);
    out.push(Math.max(0.15, r * envelope));
  }
  return out;
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    paste: "M9 4h6v3H9zM7 5H5v15h14V5h-2M9 12h6M9 16h4",
    trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
    folder: "M3 6h6l2 2h10v11H3z",
    folderOpen: "M3 19V6h6l2 2h8v3M3 19l3-8h16l-3 8z",
    checks: "M4 7l3 3 5-6M4 16l3 3 5-6M15 8h6M15 17h6",
    square: "M5 5h14v14H5z",
    download: "M12 4v11M7 11l5 5 5-5M5 20h14",
    downloadAll: "M12 3v10M7 9l5 5 5-5M4 17h16M4 21h16",
    x: "M6 6l12 12M18 6L6 18",
    sliders: "M4 7h10M18 7h2M4 17h2M10 17h10M14 5v4M8 15v4",
    retry: "M20 12a8 8 0 1 1-3-6.2M20 4v5h-5",
    save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
    undo: "M9 7L4 12l5 5M4 12h10a6 6 0 0 1 0 12",
    music: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
    film: "M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4",
    file: "M6 3h8l4 4v14H6zM14 3v4h4",
    upload: "M12 16V4M7 9l5-5 5 5M5 20h14",
    play: "M7 4l13 8-13 8z",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    reset: "M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4M12 8v4l3 2",
    tip: "M4 5h16v11H9l-5 4zM9 9h6M9 12h4",
    chevronDown: "M6 9l6 6 6-6",
    chevronUp: "M6 15l6-6 6 6",
    expandAll: "M7 8l5-4 5 4M7 16l5 4 5-4",
    collapseAll: "M7 4l5 4 5-4M7 20l5-4 5 4",
    stop: "M6 6h12v12H6z",
    history: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2",
    refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
    bug: "M9 9h6v8a3 3 0 0 1-6 0zM9 7a3 3 0 0 1 6 0M4 12h5M15 12h5M5 6l3 2M19 6l-3 2M5 19l3-2M19 19l-3-2",
    clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  };
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d={paths[name]} />
    </svg>
  );
}

function IconSelect({
  icon,
  optionIcon,
  className = "",
  value,
  onChange,
  disabled,
  children,
}: {
  icon: string;
  optionIcon?: (value: string) => string;
  className?: string;
  value: string | number;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const options = Children.toArray(children).flatMap((c) =>
    isValidElement<{ value: string | number; children: React.ReactNode }>(c)
      ? [{ value: String(c.props.value), label: c.props.children }]
      : []
  );
  const current = String(value);
  const idx = Math.max(0, options.findIndex((o) => o.value === current));
  const iconFor = (v: string) => (optionIcon ? optionIcon(v) : icon);

  const choose = (v: string) => {
    onChange({ target: { value: v } } as React.ChangeEvent<HTMLSelectElement>);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
        if (e.key === "ArrowDown" && idx < options.length - 1) {
          e.preventDefault();
          choose(options[idx + 1].value);
          setOpen(true);
        }
        if (e.key === "ArrowUp" && idx > 0) {
          e.preventDefault();
          choose(options[idx - 1].value);
          setOpen(true);
        }
      }}
    >
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`${className} flex items-center gap-2 text-left`}
      >
        <span className="text-dim">
          <Icon name={iconFor(current)} />
        </span>
        <span className="min-w-0 flex-1 truncate">{options[idx]?.label}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-dim">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-sm border border-line bg-panel py-1 shadow-lg"
        >
          {options.map((o) => {
            const selected = o.value === current;
            return (
              <li
                key={o.value}
                role="option"
                aria-selected={selected}
                onClick={() => choose(o.value)}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-bone/10 ${
                  selected ? "font-bold text-accent" : "text-bone"
                }`}
              >
                <span className={selected ? "text-accent" : "text-dim"}>
                  <Icon name={iconFor(o.value)} />
                </span>
                {o.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type Platform =
  | "youtube"
  | "instagram"
  | "tiktok"
  | "x"
  | "facebook"
  | "vimeo"
  | "soundcloud"
  | "twitch"
  | "reddit"
  | "g1"
  | "other";

function detectPlatform(url: string): Platform {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }
  const has = (...names: string[]) => names.some((n) => host === n || host.endsWith("." + n));
  if (has("youtube.com", "youtu.be")) return "youtube";
  if (has("instagram.com")) return "instagram";
  if (has("tiktok.com")) return "tiktok";
  if (has("twitter.com", "x.com")) return "x";
  if (has("facebook.com", "fb.watch")) return "facebook";
  if (has("vimeo.com")) return "vimeo";
  if (has("soundcloud.com")) return "soundcloud";
  if (has("twitch.tv")) return "twitch";
  if (has("reddit.com", "redd.it")) return "reddit";
  if (has("globo.com", "globoplay.globo.com", "g1.globo.com")) return "g1";
  return "other";
}

const PLATFORM_LABEL: Record<Platform, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
  x: "X (Twitter)",
  facebook: "Facebook",
  vimeo: "Vimeo",
  soundcloud: "SoundCloud",
  twitch: "Twitch",
  reddit: "Reddit",
  g1: "G1",
  other: "Outro site",
};

function PlatformIcon({ url }: { url: string }) {
  const platform = detectPlatform(url);
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    className: "mr-2 inline-block shrink-0 align-[-3px]",
    role: "img" as const,
    "aria-label": PLATFORM_LABEL[platform],
  };
  let art: React.ReactNode;
  switch (platform) {
    case "youtube":
      art = (
        <>
          <rect x="1" y="5" width="22" height="14" rx="4" fill="#ff0000" />
          <path d="M10 9l5.5 3L10 15z" fill="#fff" />
        </>
      );
      break;
    case "instagram":
      art = (
        <>
          <defs>
            <linearGradient id="ig-grad" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#feda75" />
              <stop offset="0.45" stopColor="#d62976" />
              <stop offset="1" stopColor="#4f5bd5" />
            </linearGradient>
          </defs>
          <rect x="2" y="2" width="20" height="20" rx="6" fill="url(#ig-grad)" />
          <circle cx="12" cy="12" r="4.4" fill="none" stroke="#fff" strokeWidth="2" />
          <circle cx="17.4" cy="6.6" r="1.3" fill="#fff" />
        </>
      );
      break;
    case "tiktok":
      art = (
        <>
          <rect x="2" y="2" width="20" height="20" rx="5" fill="#111" />
          <path d="M13 6v8.2a2.4 2.4 0 1 1-2.4-2.4M13 6c.3 2 1.6 3.2 3.6 3.4" fill="none" stroke="#25f4ee" strokeWidth="2" strokeLinecap="round" transform="translate(-0.8 0.5)" />
          <path d="M13 6v8.2a2.4 2.4 0 1 1-2.4-2.4M13 6c.3 2 1.6 3.2 3.6 3.4" fill="none" stroke="#fe2c55" strokeWidth="2" strokeLinecap="round" transform="translate(0.8 -0.5)" />
          <path d="M13 6v8.2a2.4 2.4 0 1 1-2.4-2.4M13 6c.3 2 1.6 3.2 3.6 3.4" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        </>
      );
      break;
    case "x":
      art = (
        <>
          <rect x="2" y="2" width="20" height="20" rx="5" fill="#111" />
          <path d="M7 7l10 10M17 7L7 17" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        </>
      );
      break;
    case "facebook":
      art = (
        <>
          <circle cx="12" cy="12" r="10" fill="#1877f2" />
          <path d="M13.2 20v-6.6h2.2l.4-2.6h-2.6V9.2c0-.8.3-1.3 1.4-1.3h1.3V5.6c-.2 0-1-.1-1.9-.1-2 0-3.3 1.2-3.3 3.4v1.9H8.5v2.6h2.2V20z" fill="#fff" />
        </>
      );
      break;
    case "vimeo":
      art = (
        <>
          <rect x="2" y="2" width="20" height="20" rx="5" fill="#1ab7ea" />
          <path d="M5.5 10l1-1c1.4-1.2 2.2-.6 2.5 1l.8 3.4c.4 1.6.9 1.6 1.9.3 1.5-1.9 2.6-3.1 3.4-3.6" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        </>
      );
      break;
    case "soundcloud":
      art = (
        <>
          <rect x="2" y="2" width="20" height="20" rx="5" fill="#ff5500" />
          <path d="M6 15v-3M8.5 15v-5M11 15V9.5c2.2-1.3 5 0 5.2 2.2 1.6-.2 2.6.8 2.6 1.9 0 .8-.6 1.4-1.4 1.4H11" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
      break;
    case "twitch":
      art = (
        <>
          <rect x="2" y="2" width="20" height="20" rx="5" fill="#9146ff" />
          <path d="M7 6h10v7l-3 3h-3l-2 2v-2H7z" fill="#fff" />
          <path d="M11 9v3M14 9v3" stroke="#9146ff" strokeWidth="1.6" />
        </>
      );
      break;
    case "reddit":
      art = (
        <>
          <circle cx="12" cy="12" r="10" fill="#ff4500" />
          <ellipse cx="12" cy="13.5" rx="5.5" ry="3.7" fill="#fff" />
          <circle cx="10" cy="13" r="1" fill="#ff4500" />
          <circle cx="14" cy="13" r="1" fill="#ff4500" />
          <circle cx="16.5" cy="7.5" r="1.3" fill="#fff" />
          <path d="M12 9.8l.8-3.2 3.4.9" fill="none" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" />
        </>
      );
      break;
    case "g1":
      art = <image href="/platforms/g1.png" x="1" y="1" width="22" height="22" />;
      break;
    default:
      art = (
        <>
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </>
      );
  }
  return (
    <svg {...common}>
      <title>{PLATFORM_LABEL[platform]}</title>
      {art}
    </svg>
  );
}

// Logo do Abe: a pupila do olho aberto é um elemento separado que segue o mouse.
const ABE_W = 394;
const ABE_H = 553;
const PUPIL = { x: 269, y: 218, r: 5.2, reach: 22 };

function AbeLogo() {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const pupilRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const box = boxRef.current;
      const pupil = pupilRef.current;
      if (!box || !pupil) return;
      const rect = box.getBoundingClientRect();
      const scale = rect.width / ABE_W;
      const dx = e.clientX - (rect.left + PUPIL.x * scale);
      const dy = e.clientY - (rect.top + PUPIL.y * scale);
      const dist = Math.hypot(dx, dy) || 1;
      const move = Math.tanh(dist / 160) * PUPIL.reach * scale;
      pupil.style.transform = `translate(-50%, -50%) translate(${(dx / dist) * move}px, ${(dy / dist) * move}px)`;
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  return (
    <div
      ref={boxRef}
      className="abe-logo relative h-28 shrink-0"
      style={{ aspectRatio: `${ABE_W} / ${ABE_H}` }}
    >
      <img src="/abe-base.png" alt="" className="h-full w-full" draggable={false} />
      <span
        ref={pupilRef}
        className="absolute rounded-full bg-black"
        style={{
          left: `${(PUPIL.x / ABE_W) * 100}%`,
          top: `${(PUPIL.y / ABE_H) * 100}%`,
          width: `${((PUPIL.r * 2) / ABE_W) * 100}%`,
          height: `${((PUPIL.r * 2) / ABE_H) * 100}%`,
          transform: "translate(-50%, -50%)",
        }}
      />
    </div>
  );
}

function ThemeMenu({
  theme,
  onChange,
  onPreview,
  onOpenChange,
}: {
  theme: Theme;
  onChange: (t: Theme) => void;
  onPreview: (t: Theme | null) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      onPreview(null);
    };
  }, [open, onPreview]);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  // Posição fixa na tela, medida depois que a coluna termina de deslizar.
  // Assim a lista não acompanha mudanças de layout da prévia (nada treme).
  useEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const wide = window.matchMedia("(min-width: 1200px) and (min-aspect-ratio: 16/10)").matches;
    let done = false;
    const measure = () => {
      if (done) return;
      done = true;
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = 224;
      // Sempre à esquerda do botão, alinhado ao topo dele (nunca abaixo).
      const left = Math.max(8, r.left - width - 8);
      setMenuPos({ top: r.top, left });
    };
    if (!wide) {
      measure();
      return;
    }
    // Mede quando a coluna termina de deslizar (ou, no pior caso, após 900 ms).
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName === "padding-left") measure();
    };
    document.addEventListener("transitionend", onEnd, true);
    const t = window.setTimeout(measure, 900);
    return () => {
      done = true;
      document.removeEventListener("transitionend", onEnd, true);
      window.clearTimeout(t);
    };
  }, [open]);

  const current = THEMES.find((t) => t.value === theme);

  return (
    <div ref={rootRef} className="relative shrink-0 self-start">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Tema: ${current?.label ?? ""}`}
        onClick={() => setOpen((o) => !o)}
        className="flex flex-col items-start gap-1 border-0 bg-transparent p-0"
      >
        <span className="flex h-11 w-[74px] items-center justify-center overflow-hidden rounded-sm border-2 border-accent">
          <img
            src={`/themes/${theme}.png`}
            alt={`Tema: ${current?.label ?? ""}`}
            className="h-full w-full object-fill"
            draggable={false}
          />
        </span>
        <span className="flex items-center gap-1 text-xs text-dim">
          Temas
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Temas"
          onMouseLeave={() => onPreview(null)}
          className="theme-menu fixed z-40 flex w-56 flex-col gap-0.5 p-1.5"
          style={
            {
              top: menuPos?.top ?? 0,
              left: menuPos?.left ?? 0,
              visibility: menuPos ? "visible" : "hidden",
              "--menu-top": `${menuPos?.top ?? 0}px`,
              "--n": THEMES.length,
            } as React.CSSProperties
          }
        >
          {THEMES.map((t) => {
            const active = theme === t.value;
            return (
              <button
                key={t.value}
                role="menuitemradio"
                data-theme-item={t.value}
                aria-checked={active}
                aria-label={t.label}
                title={t.label}
                onMouseEnter={() => onPreview(t.value)}
                onFocus={() => onPreview(t.value)}
                onClick={() => {
                  onChange(t.value);
                  onPreview(null);
                  setOpen(false);
                }}
                className={`flex h-7 w-full shrink-0 items-center gap-2 overflow-hidden rounded-sm border-2 p-0 pr-2 text-left text-xs transition ${
                  active ? "border-accent" : "border-line hover:border-dim"
                }`}
              >
                <img
                  src={`/themes/${t.value}.png`}
                  alt=""
                  className="h-full w-[46px] shrink-0 object-fill"
                  draggable={false}
                />
                <span className="truncate text-bone">{t.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Botão "i": abre uma explicação curta (renderizada em portal para não ser cortada pelo tema).
function InfoButton({
  title,
  wide,
  children,
}: {
  title: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const open = pinned || hover;
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number; maxH: number }>({
    left: 0,
    width: 320,
    maxH: 400,
  });
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setPinned(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPinned(false);
        setHover(false);
      }
    };
    const close = () => {
      setPinned(false);
      setHover(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const width = Math.min(wide ? 400 : 330, window.innerWidth - 16);
      const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
      const spaceBelow = window.innerHeight - r.bottom - 16;
      const spaceAbove = r.top - 16;
      // Abre para cima quando abaixo não cabe um balão de tamanho razoável.
      if (spaceBelow < 260 && spaceAbove > spaceBelow) {
        setPos({ bottom: window.innerHeight - r.top + 8, left, width, maxH: spaceAbove });
      } else {
        setPos({ top: r.bottom + 8, left, width, maxH: spaceBelow });
      }
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="info-btn"
        aria-label={`Ajuda: ${title}`}
        aria-expanded={open}
        onMouseEnter={() => {
          place();
          setHover(true);
        }}
        onMouseLeave={() => setHover(false)}
        onFocus={() => {
          place();
          setHover(true);
        }}
        onBlur={() => setHover(false)}
        onClick={(e) => {
          // Clique fixa o balão aberto (útil em tela de toque); novo clique solta.
          e.preventDefault();
          e.stopPropagation();
          place();
          setPinned((p) => !p);
        }}
      >
        i
      </button>
      {open &&
        createPortal(
          <section
            ref={popRef}
            aria-label={title}
            className={`info-pop rounded-sm border border-line bg-panel p-3 shadow-lg ${pinned ? "pinned" : ""}`}
            style={{
              top: pos.top,
              bottom: pos.bottom,
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxH,
            }}
          >
            <h3>{title}</h3>
            {children}
          </section>,
          document.body
        )}
    </>
  );
}

// Modal de análise: a animação muda conforme o tema ativo.
type AnimKind =
  | "donut" | "warp" | "vinyl" | "pow" | "blocks" | "hex" | "notes" | "sun" | "buttons" | "bars"
  | "bubbles" | "rain" | "symbols" | "ball" | "qblock" | "fight" | "flame" | "confetti" | "heart"
  | "xp" | "snake" | "glitch" | "pixels" | "blink" | "tracking" | "triforce";

const THEME_ANIM: Record<Theme, { kind: AnimKind; text: string }> = {
  simpsons: { kind: "donut", text: "Procurando os vídeos… D’oh!" },
  starwars: { kind: "warp", text: "Entrando no hiperespaço…" },
  jukebox: { kind: "vinyl", text: "Escolhendo o disco…" },
  hq: { kind: "pow", text: "Analisando os links!" },
  win98: { kind: "blocks", text: "Aguarde, analisando…" },
  winning11: { kind: "hex", text: "Escalando o time…" },
  guitarhero: { kind: "notes", text: "Afinando a guitarra…" },
  synthwave: { kind: "sun", text: "Sintonizando o sinal…" },
  snes: { kind: "buttons", text: "Carregando o cartucho…" },
  winamp: { kind: "bars", text: "Lendo a lista de faixas…" },
  msn: { kind: "bubbles", text: "Conectando…" },
  matrix: { kind: "rain", text: "Rastreando a matriz…" },
  ps1: { kind: "symbols", text: "Lendo o disco…" },
  pokemon: { kind: "ball", text: "Procurando selvagens…" },
  mario: { kind: "qblock", text: "Coletando moedas…" },
  sf: { kind: "fight", text: "Round 1… analisando!" },
  mk: { kind: "flame", text: "Finish him… analisando" },
  mtv: { kind: "confetti", text: "No ar em instantes…" },
  orkut: { kind: "heart", text: "Buscando seus scraps…" },
  winxp: { kind: "xp", text: "Iniciando o Windows…" },
  a51: { kind: "snake", text: "Procurando sinal…" },
  cyberpunk: { kind: "glitch", text: "Invadindo a rede…" },
  gameboy: { kind: "pixels", text: "Carregando…" },
  arcade: { kind: "blink", text: "Insira a moeda… analisando" },
  vhs: { kind: "tracking", text: "Ajustando o tracking…" },
  nokia: { kind: "snake", text: "Conectando…" },
  zelda: { kind: "triforce", text: "Reunindo a Triforce…" },
};

function AnimArt({ kind }: { kind: AnimKind }) {
  const dots = (n: number, f: (i: number) => React.CSSProperties) =>
    Array.from({ length: n }, (_, i) => <i key={i} style={f(i)} />);
  switch (kind) {
    case "donut":
      return (
        <div className="an an-donut">
          <svg viewBox="0 0 100 100" width="96" height="96">
            <circle cx="50" cy="50" r="40" fill="#d9964f" />
            <path fillRule="evenodd" fill="#ff7fb0" d="M50 14a36 36 0 1 1 0 72 36 36 0 0 1 0-72zm0 22a14 14 0 1 0 0 28 14 14 0 0 0 0-28z" />
            <g strokeWidth="4" strokeLinecap="round">
              <path d="M26 30l5 3" stroke="#fff" />
              <path d="M70 22l-2 6" stroke="#fed90f" />
              <path d="M80 54l-6-2" stroke="#4aa3ff" />
              <path d="M58 82l1-6" stroke="#fff" />
              <path d="M28 66l6-3" stroke="#fed90f" />
              <path d="M42 18l2 6" stroke="#4aa3ff" />
            </g>
          </svg>
        </div>
      );
    case "warp":
      return (
        <div className="an an-warp">
          {dots(18, (i) => ({ ["--a" as string]: `${i * 20}deg`, animationDelay: `${(i % 6) * 0.12}s` }))}
        </div>
      );
    case "vinyl":
      return (
        <div className="an an-vinyl">
          <svg viewBox="0 0 100 100" width="96" height="96">
            <circle cx="50" cy="50" r="46" fill="#111" />
            <circle cx="50" cy="50" r="36" fill="none" stroke="#333" strokeWidth="1.5" />
            <circle cx="50" cy="50" r="28" fill="none" stroke="#333" strokeWidth="1.5" />
            <circle cx="50" cy="50" r="16" fill="#e0261b" />
            <circle cx="50" cy="50" r="3" fill="#f7ecd0" />
          </svg>
        </div>
      );
    case "pow":
      return (
        <div className="an an-pow">
          <svg viewBox="0 0 100 100" width="104" height="104">
            <path d="M50 4l9 20 21-9-6 22 22 4-18 14 16 16-22 1 3 22-19-12-19 12 3-22-22-1 16-16-18-14 22-4-6-22 21 9z" fill="#ffd600" stroke="#111" strokeWidth="3" strokeLinejoin="round" />
            <text x="50" y="58" textAnchor="middle" fontSize="22" fontWeight="900" fill="#e3262b" stroke="#111" strokeWidth="1">POW!</text>
          </svg>
        </div>
      );
    case "blocks":
      return <div className="an an-blocks">{dots(10, (i) => ({ animationDelay: `${i * 0.1}s` }))}</div>;
    case "hex":
      return (
        <div className="an an-hex">
          <svg viewBox="0 0 100 100" width="96" height="96">
            <polygon points="50,6 88,28 88,72 50,94 12,72 12,28" fill="none" stroke="#ff8a1a" strokeWidth="6" />
            <polygon points="50,26 70,38 70,62 50,74 30,62 30,38" fill="#3a5560" />
          </svg>
        </div>
      );
    case "notes":
      return (
        <div className="an an-notes">
          {dots(5, (i) => ({
            left: `${10 + i * 18}%`,
            background: ["#3ddc4a", "#ff3b3b", "#ffd200", "#3c78ff", "#ff7a00"][i],
            animationDelay: `${i * 0.18}s`,
          }))}
        </div>
      );
    case "sun":
      return (
        <div className="an an-sun">
          <i />
          <b />
        </div>
      );
    case "buttons":
      return (
        <div className="an an-buttons">
          {dots(4, (i) => ({
            background: ["#2e5cd6", "#2e9e44", "#d12a2a", "#f2c500"][i],
            animationDelay: `${i * 0.2}s`,
          }))}
        </div>
      );
    case "bars":
      return <div className="an an-bars">{dots(12, (i) => ({ animationDelay: `${(i * 0.09) % 0.8}s` }))}</div>;
    case "bubbles":
      return (
        <div className="an an-bubbles">
          {dots(6, (i) => ({ left: `${8 + i * 15}%`, animationDelay: `${i * 0.25}s` }))}
        </div>
      );
    case "rain":
      return (
        <div className="an an-rain">
          {dots(12, (i) => ({ left: `${i * 8.5}%`, animationDelay: `${(i * 0.17) % 1.2}s` }))}
        </div>
      );
    case "symbols":
      return (
        <div className="an an-symbols">
          <span style={{ color: "#35c46a", animationDelay: "0s" }}>△</span>
          <span style={{ color: "#e8453c", animationDelay: ".25s" }}>○</span>
          <span style={{ color: "#4a80ff", animationDelay: ".5s" }}>✕</span>
          <span style={{ color: "#e58bd0", animationDelay: ".75s" }}>□</span>
        </div>
      );
    case "ball":
      return (
        <div className="an an-ball">
          <svg viewBox="0 0 100 100" width="88" height="88">
            <circle cx="50" cy="50" r="44" fill="#fff" stroke="#1a1a1a" strokeWidth="5" />
            <path d="M6 50a44 44 0 0 1 88 0z" fill="#d6322f" stroke="#1a1a1a" strokeWidth="5" />
            <rect x="6" y="46" width="88" height="8" fill="#1a1a1a" />
            <circle cx="50" cy="50" r="12" fill="#fff" stroke="#1a1a1a" strokeWidth="5" />
          </svg>
        </div>
      );
    case "qblock":
      return (
        <div className="an an-qblock">
          <svg viewBox="0 0 100 100" width="84" height="84">
            <rect x="8" y="8" width="84" height="84" fill="#fbd000" stroke="#7a3a00" strokeWidth="6" />
            <path d="M34 38a16 16 0 1 1 22 15c-5 2-6 5-6 9" fill="none" stroke="#7a3a00" strokeWidth="9" strokeLinecap="round" />
            <rect x="45" y="70" width="10" height="10" fill="#7a3a00" />
          </svg>
          <b />
        </div>
      );
    case "fight":
      return (
        <div className="an an-fight">
          <div className="hp"><i /></div>
          <div className="hp r"><i /></div>
          <strong>FIGHT!</strong>
        </div>
      );
    case "flame":
      return (
        <div className="an an-flame">
          <svg viewBox="0 0 100 100" width="92" height="92">
            <circle cx="50" cy="50" r="42" fill="#15100f" stroke="#e0b04a" strokeWidth="5" />
            <path d="M28 70c4-26 16-34 36-36-8 8-8 14-2 19-9-3-12 1-14 8 6-2 11 0 14 6-14 3-26 3-34 3z" fill="#b3121b" />
          </svg>
        </div>
      );
    case "confetti":
      return (
        <div className="an an-confetti">
          <strong>M</strong>
          {dots(8, (i) => ({
            background: ["#e6007e", "#00b4ff", "#7a2cff", "#fff200"][i % 4],
            ["--a" as string]: `${i * 45}deg`,
            animationDelay: `${i * 0.1}s`,
          }))}
        </div>
      );
    case "heart":
      return (
        <div className="an an-heart">
          <svg viewBox="0 0 100 100" width="88" height="88">
            <path d="M50 86C14 62 14 24 36 24c8 0 12 5 14 10 2-5 6-10 14-10 22 0 22 38-14 62z" fill="#d81b7a" />
          </svg>
        </div>
      );
    case "xp":
      return (
        <div className="an an-xp">
          <div>
            <i />
            <i />
            <i />
          </div>
        </div>
      );
    case "snake":
      return <div className="an an-snake">{dots(8, (i) => ({ animationDelay: `${i * 0.12}s` }))}</div>;
    case "glitch":
      return (
        <div className="an an-glitch">
          <strong>LOADING</strong>
        </div>
      );
    case "pixels":
      return <div className="an an-pixels">{dots(9, (i) => ({ animationDelay: `${i * 0.1}s` }))}</div>;
    case "blink":
      return (
        <div className="an an-blink">
          <strong>LOADING</strong>
          <span>1UP</span>
        </div>
      );
    case "tracking":
      return (
        <div className="an an-tracking">
          <strong>▶ PLAY</strong>
          <i />
          <i />
          <i />
        </div>
      );
    case "triforce":
      return (
        <div className="an an-triforce">
          <svg viewBox="0 0 100 100" width="92" height="92">
            <polygon points="50,8 74,50 26,50" fill="#f5d76e" />
            <polygon points="26,50 50,92 2,92" fill="#f5d76e" />
            <polygon points="74,50 98,92 50,92" fill="#f5d76e" />
          </svg>
        </div>
      );
  }
}

function AnalyzeModal({ theme, done, total }: { theme: Theme; done: number; total: number }) {
  const cfg = THEME_ANIM[theme];
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="analyze-overlay" role="alertdialog" aria-modal="true" aria-label="Analisando links">
      <section className="analyze-card">
        <AnimArt kind={cfg.kind} />
        <h2 className="mt-3 text-lg font-medium">Analisando links</h2>
        <p className="text-sm text-dim">{cfg.text}</p>
        <div className="analyze-bar" aria-hidden="true">
          <i style={{ width: `${total > 0 ? Math.max(pct, 4) : 12}%` }} />
        </div>
        <p className="mt-1 font-mono text-sm">{total > 0 ? `${done}/${total}` : "iniciando…"}</p>
      </section>
    </div>
  );
}

// Explicações das dicas (título em negrito + descrição), pelo nome do controle.
const TIP_DOCS: Record<string, string> = {
  "tipo": "Escolhe se o arquivo final é só o áudio ou o vídeo completo. Cada item pode ter o seu tipo em Personalizar.",
  "formato": "Formato do arquivo gerado: MP3, M4A, WAV, FLAC ou OPUS no áudio; MP4, MKV ou WEBM no vídeo.",
  "qualidade": "No áudio, a taxa de bits em kbps (maior = melhor som e arquivo maior). No vídeo, a resolução máxima. “Melhor” usa a mais alta disponível.",
  "simultâneos": "Define a quantidade de downloads feitos ao mesmo tempo. Valores altos terminam o lote mais rápido, mas podem causar bloqueios temporários do site.",
  "cookies": "Usa o login do navegador escolhido em sites que exigem conta (Vimeo, Instagram privado). Feche o navegador antes de baixar.",
  "nome do arquivo": "Modelo do nome dos arquivos baixados, combinando título, artista, canal, número da lista, data, ano ou id do vídeo.",
  "velocidade": "Limita a velocidade de cada download para não ocupar toda a sua internet.",
  "subpasta por playlist": "Cria uma pasta com o nome da playlist dentro do destino e coloca nela os itens.",
  "pastas para áudio e vídeo": "Marcado: áudio sempre em /audio e vídeo sempre em /video, dentro da pasta de destino. Desmarcado: tudo na pasta de destino.",
  "legendas": "Baixa legendas .srt em português ou inglês, quando o vídeo tiver.",
  "normalizar volume": "Nivela o volume do áudio para todos os arquivos ficarem no mesmo nível. Só vale quando há conversão de formato.",
  "notificar ao concluir": "Mostra uma notificação do Windows quando o lote termina.",
  "salvar ao concluir": "Grava o arquivo direto no local de destino. Desmarcado, cada item concluído ganha o botão “Baixar arquivo”.",
  "local de destino": "Local onde o app cria a pasta abe_download_manager, com audio e video dentro. Vazio, usa Downloads/abe_download_manager.",
  "links": "Cole um link de vídeo ou playlist por linha. Ctrl+Enter analisa o que está escrito.",
  "colar e analisar": "Lê os links da área de transferência e já inicia a análise.",
  "arquivo .txt": "Carrega vários links de um arquivo .txt, um por linha.",
  "limpar tudo": "Apaga a lista, a seleção e as personalizações para recomeçar. Não apaga arquivos já baixados.",
  "selecionar pasta": "Abre o seletor do Windows para escolher o local de destino.",
  "abrir pasta": "Abre o local de destino no Explorer.",
  "todos": "Seleciona todos os itens da lista.",
  "limpar": "Desmarca todos os itens da lista.",
  "expandir todos": "Abre as ações e opções de todos os itens de uma vez.",
  "recolher todos": "Fecha as ações e opções de todos os itens.",
  "selecionados": "Baixa somente os itens marcados na lista.",
  "tudo": "Baixa todos os itens válidos da lista.",
  "personalizar": "Abre as ações e as opções deste item: tipo, formato, qualidade, título e trecho.",
  "prévia": "Toca 10 segundos do áudio antes de baixar.",
  "baixar": "Baixa somente este item.",
  "baixar de novo": "Baixa este item outra vez, usando as personalizações atuais.",
  "mostrar": "Mostra o arquivo baixado na pasta, no Explorer.",
  "baixar arquivo": "Salva o arquivo no seu computador pelo navegador.",
  "cancelar": "Interrompe o download deste item.",
  "usar padrão": "Desfaz as personalizações deste item e volta às opções de download.",
  "falharam": "Tenta baixar de novo apenas os itens que deram erro.",
  "histórico de downloads": "Lista tudo que já foi baixado, com data e botão para abrir o arquivo.",
  "atualizar motor": "Verifica e instala a versão mais nova do yt-dlp, o componente que conversa com os sites. Reinicie o app depois.",
  "developed by r3vmarcos": "Abre o GitHub do desenvolvedor (github.com/r3vmarcos) no navegador.",
  "diagnóstico": "Gera um arquivo de texto com versões, caminhos e os últimos erros, para descobrir por que um link falhou.",
  "preferências padrão": "Restaura as preferências para o padrão do app: dicas desligadas, salvar ao concluir e pastas para áudio e vídeo ligados; notificação, subpasta por playlist, normalizar volume e legendas desligados.",
  "dicas ao passar o mouse": "Liga ou desliga estas explicações que aparecem ao passar o mouse.",
  "título (nome do arquivo)": "Nome com que o arquivo será salvo. Vem preenchido com o título do vídeo; edite para renomear.",
  "início do trecho": "Arraste para escolher onde o trecho começa.",
  "fim do trecho": "Arraste para escolher onde o trecho termina.",
  "temas": "Troca o visual do aplicativo. Passar o mouse sobre um tema mostra uma prévia.",
  "abe download manager": "Baixe áudio e vídeo de YouTube, Instagram, TikTok, Facebook, G1 e outros sites.",
  "destino": "Onde os arquivos baixados serão salvos.",
  "opções de download": "Configuração aplicada a todos os links, exceto os que você personalizar.",
  "outras opções": "Ajustes extras: nome do arquivo, velocidade, simultâneos e outros.",
};

function tipKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(\s*\d+\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Dicas ao passar o mouse: troca o tooltip nativo (title) por um balão no estilo do tema.
function HoverTips({ enabled }: { enabled: boolean }) {
  const [tip, setTip] = useState<{
    title: string;
    body: string;
    cx: number;
    top: number;
    bottom: number;
  } | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLElement | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    let current: HTMLElement | null = null;
    let openSelect: HTMLElement | null = null;
    const hide = () => {
      current = null;
      setTip(null);
      setPlace(null);
    };
    const show = (el: HTMLElement, title: string, body: string) => {
      const r = el.getBoundingClientRect();
      setPlace(null);
      setTip({ title, body, cx: r.left + r.width / 2, top: r.top, bottom: r.bottom });
    };
    // Texto da dica quando o elemento não tem title: rótulo + valor, aria-label, alt ou o próprio texto.
    const derive = (el: HTMLElement): string | null => {  // devolve o nome do controle (com valor atual quando houver)
      const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
      const aria = clean(el.getAttribute("aria-label"));
      // Rótulo do campo sem o texto do botão "i".
      const labelOf = (field: HTMLElement) => {
        const lab =
          field.closest("label") ??
          (field.id ? document.querySelector(`label[for="${field.id}"]`) : null);
        if (!lab) return "";
        const node = (lab.querySelector("span") ?? lab).cloneNode(true) as HTMLElement;
        node.querySelectorAll(".info-btn").forEach((n) => n.remove());
        return clean(node.textContent);
      };
      if (el instanceof HTMLSelectElement) {
        const label = labelOf(el);
        const val = clean(el.options[el.selectedIndex]?.text);
        return [label, val].filter(Boolean).join(": ") || null;
      }
      if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === "text")) {
        const label = labelOf(el) || aria;
        const ph = clean(el.getAttribute("placeholder"));
        return [label, ph && `ex.: ${ph}`].filter(Boolean).join(" · ") || "Campo de texto";
      }
      if (el instanceof HTMLInputElement && el.type === "checkbox") {
        return labelOf(el) || aria || "Marcar ou desmarcar";
      }
      if (el instanceof HTMLInputElement && el.type === "range") return aria || "Arraste para ajustar";
      if (aria) return aria;
      if (el instanceof HTMLImageElement) return clean(el.alt) || null;
      if (el.tagName === "LABEL" || el.tagName === "H1" || el.tagName === "H2") {
        const n = el.cloneNode(true) as HTMLElement;
        n.querySelectorAll(".info-btn, button").forEach((x) => x.remove());
        return clean(n.textContent) || null;
      }
      if (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement) return clean(el.textContent) || null;
      return clean(el.getAttribute("data-label")) || null;
    };
    const onOver = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!t || !(t instanceof Element)) return;
      // Com o menu suspenso de um campo aberto, nenhuma dica (evita sobrepor as opções).
      if (openSelect) return;
      if (t.closest(".info-pop, .theme-menu, .hover-tip, .info-btn, .analyze-overlay")) {
        if (current) hide();
        return;
      }
      let el = t.closest("[title], [data-tip]") as HTMLElement | null;
      if (!el) {
        el = t.closest(
          'button, a, input, select, textarea, label, [role="img"], [role="progressbar"], img, svg'
        ) as HTMLElement | null;
        // Textos/rótulos não têm dica: só os campos e controles. (Rótulo de checkbox é o próprio controle.)
        if (el && el.tagName === "LABEL" && !el.querySelector('input[type="checkbox"]')) {
          el = null;
        }
      }
      if (!el) {
        if (current) hide();
        return;
      }
      // Tira o title para o navegador não mostrar o tooltip nativo.
      const title = el.getAttribute("title");
      if (title) {
        el.setAttribute("data-tip", title);
        el.removeAttribute("title");
      }
      let text = el.getAttribute("data-tip");
      if (!text) text = derive(el);
      if (!text) {
        if (current) hide();
        return;
      }
      if (!enabledRef.current) {
        if (current) hide();
        return;
      }
      // Nome do controle (sem o valor atual) -> descrição.
      const name = text.split(":")[0];
      const docKey = [tipKey(name), tipKey(text), tipKey(el.getAttribute("aria-label") ?? "")].find(
        (k) => k && TIP_DOCS[k]
      );
      let tipTitle = name;
      let body = docKey ? TIP_DOCS[docKey] : "";
      if (docKey && text.includes(":")) {
        body += ` Atual: ${text.slice(text.indexOf(":") + 1).trim()}.`;
      }
      if (!docKey) {
        // Sem descrição própria: usa o texto do title como corpo.
        tipTitle = text.length > 28 ? text.slice(0, 26).trimEnd() + "…" : text;
        body = text.length > 28 ? text : "";
      }
      current = el;
      show(el, tipTitle, body);
    };
    const onOut = (e: Event) => {
      const rel = (e as MouseEvent).relatedTarget as Node | null;
      if (current && (!rel || !current.contains(rel))) hide();
    };
    const onDown = (e: Event) => {
      hide();
      const t = e.target as HTMLElement | null;
      const sel = t?.closest?.("select") as HTMLElement | null;
      openSelect = sel;
    };
    const onSelectDone = () => {
      openSelect = null;
    };
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("focusin", onOver, true);
    document.addEventListener("mouseout", onOut, true);
    document.addEventListener("focusout", onOut, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("change", onSelectDone, true);
    document.addEventListener("focusout", onSelectDone, true);
    document.addEventListener("keydown", onSelectDone, true);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("focusin", onOver, true);
      document.removeEventListener("mouseout", onOut, true);
      document.removeEventListener("focusout", onOut, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("change", onSelectDone, true);
      document.removeEventListener("focusout", onSelectDone, true);
      document.removeEventListener("keydown", onSelectDone, true);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !tipRef.current) return;
    const w = tipRef.current.offsetWidth;
    const h = tipRef.current.offsetHeight;
    const gap = 8;
    const margin = 8;
    const left = Math.min(Math.max(tip.cx - w / 2, margin), window.innerWidth - w - margin);
    const spaceAbove = tip.top - gap - margin;
    const spaceBelow = window.innerHeight - tip.bottom - gap - margin;
    let top: number;
    if (h <= spaceAbove) top = tip.top - gap - h;
    else if (h <= spaceBelow) top = tip.bottom + gap;
    else top = spaceBelow > spaceAbove ? Math.max(margin, tip.bottom + gap) : margin;
    top = Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - h - margin));
    setPlace({ left, top });
  }, [tip]);

  if (!tip || !enabled) return null;
  return createPortal(
    <section
      ref={tipRef}
      role="tooltip"
      className="hover-tip rounded-sm border border-line bg-panel shadow-lg"
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        visibility: place ? "visible" : "hidden",
        maxWidth: "min(17rem, calc(100vw - 16px))",
      }}
    >
      <strong className="hover-tip-title">{tip.title}</strong>
      {tip.body && <span className="hover-tip-body">{tip.body}</span>}
    </section>,
    document.body
  );
}

function Wave({ seed, progress, status }: { seed: string; progress: number; status: ItemStatus }) {
  const heights = waveHeights(seed);
  const filled = status === "done" ? WAVE_BARS : Math.round((progress / 100) * WAVE_BARS);
  const fillColor =
    status === "done" ? "bg-ok" : status === "error" ? "bg-bad" : "bg-amber";
  return (
    <div
      className="mt-2 flex h-8 items-center gap-px"
      role="progressbar"
      aria-valuenow={Math.round(progress)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {heights.map((v, i) => (
        <span
          key={i}
          className={`flex-1 rounded-[1px] transition-colors ${i < filled ? fillColor : "bg-track"}`}
          style={{ height: `${Math.round(v * 100)}%` }}
        />
      ))}
    </div>
  );
}

interface ItemConfig {
  mode: Mode;
  audioFormat: AudioFormat;
  audioQuality: AudioQuality;
  videoFormat: VideoFormat;
  videoQuality: VideoQuality;
}

const smallSelect =
  "w-full rounded-sm border border-line bg-ink px-2 py-1.5 text-sm text-bone outline-none focus:border-accent disabled:opacity-40";

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? h + ":" : ""}${mm}:${String(r).padStart(2, "0")}`;
}

// Seletor de trecho: duas alças (início e fim) sobre a duração do vídeo.
function TrimSlider({
  duration,
  start,
  end,
  onChange,
}: {
  duration: number;
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
}) {
  const total = Math.max(1, Math.round(duration));
  const s = Math.min(Math.max(0, parseTime(start) ?? 0), total - 1);
  const e = Math.min(Math.max(s + 1, parseTime(end) ?? total), total);
  const emit = (ns: number, ne: number) =>
    onChange(ns <= 0 ? "" : String(ns), ne >= total ? "" : String(ne));
  const pct = (v: number) => `${(v / total) * 100}%`;
  return (
    <div className="trim">
      <div className="trim-head">
        <span>Início {fmtClock(s)}</span>
        <span className="trim-len">trecho {fmtClock(e - s)}</span>
        <span>Fim {fmtClock(e)}</span>
      </div>
      <div className="trim-track">
        <div className="trim-fill" style={{ left: pct(s), width: `${((e - s) / total) * 100}%` }} />
        <input
          type="range"
          min={0}
          max={total}
          step={1}
          value={s}
          aria-label="Início do trecho"
          onChange={(ev) => emit(Math.min(Number(ev.target.value), e - 1), e)}
        />
        <input
          type="range"
          min={0}
          max={total}
          step={1}
          value={e}
          aria-label="Fim do trecho"
          onChange={(ev) => emit(s, Math.max(Number(ev.target.value), s + 1))}
        />
      </div>
      <div className="trim-head trim-ends">
        <span>0:00</span>
        <span>{fmtClock(total)}</span>
      </div>
    </div>
  );
}

function ItemOptions({
  cfg,
  onChange,
  onReset,
  extras,
  onExtras,
  duration,
}: {
  duration?: number | null;
  cfg: ItemConfig;
  onChange: (next: ItemConfig) => void;
  onReset: () => void;
  extras: ItemExtras;
  onExtras: (next: ItemExtras) => void;
}) {
  return (
    <div className="item-opts mt-3 grid w-full gap-3 border-l-2 border-accent pl-3">
      <Field label={<Lbl text="Tipo" tip="Escolha se quer só o áudio ou o vídeo completo. Cada item pode ter o seu próprio tipo em “Personalizar”." />}>
        <IconSelect
          icon="music"
          optionIcon={(v) => (v === "audio" ? "music" : "film")}
          value={cfg.mode}
          onChange={(e) => onChange({ ...cfg, mode: e.target.value as Mode })}
          className={smallSelect}
        >
          <option value="audio">Áudio</option>
          <option value="video">Vídeo</option>
        </IconSelect>
      </Field>
      {cfg.mode === "audio" ? (
        <>
          <Field label={<Lbl text="Formato" tip="Container do arquivo final: MP3, M4A, WAV, FLAC ou OPUS no áudio; MP4, MKV ou WEBM no vídeo. “Original” mantém o áudio sem converter." />}>
            <IconSelect icon="file"
              value={cfg.audioFormat}
              onChange={(e) => onChange({ ...cfg, audioFormat: e.target.value as AudioFormat })}
              className={smallSelect}
            >
              <option value="mp3">MP3</option>
              <option value="m4a">M4A</option>
              <option value="wav">WAV</option>
              <option value="flac">FLAC</option>
              <option value="opus">OPUS</option>
              <option value="original">Original</option>
            </IconSelect>
          </Field>
          <Field label={<Lbl text="Qualidade" tip="No áudio, a taxa de bits (kbps). No vídeo, a resolução máxima. “Melhor” pega a mais alta disponível." />}>
            <select
              value={cfg.audioQuality}
              onChange={(e) => onChange({ ...cfg, audioQuality: e.target.value as AudioQuality })}
              disabled={cfg.audioFormat === "original"}
              className={smallSelect}
            >
              <option value="best">Melhor</option>
              <option value="320">320 kbps</option>
              <option value="256">256 kbps</option>
              <option value="192">192 kbps</option>
              <option value="128">128 kbps</option>
            </select>
          </Field>
        </>
      ) : (
        <>
          <Field label={<Lbl text="Formato" tip="Container do arquivo final: MP3, M4A, WAV, FLAC ou OPUS no áudio; MP4, MKV ou WEBM no vídeo. “Original” mantém o áudio sem converter." />}>
            <IconSelect icon="file"
              value={cfg.videoFormat}
              onChange={(e) => onChange({ ...cfg, videoFormat: e.target.value as VideoFormat })}
              className={smallSelect}
            >
              <option value="mp4">MP4</option>
              <option value="mkv">MKV</option>
              <option value="webm">WEBM</option>
            </IconSelect>
          </Field>
          <Field label={<Lbl text="Qualidade" tip="No áudio, a taxa de bits (kbps). No vídeo, a resolução máxima. “Melhor” pega a mais alta disponível." />}>
            <select
              value={cfg.videoQuality}
              onChange={(e) => onChange({ ...cfg, videoQuality: e.target.value as VideoQuality })}
              className={smallSelect}
            >
              <option value="best">Melhor</option>
              <option value="2160">2160p (4K)</option>
              <option value="1440">1440p</option>
              <option value="1080">1080p</option>
              <option value="720">720p</option>
              <option value="480">480p</option>
              <option value="360">360p</option>
            </select>
          </Field>
        </>
      )}
      <div style={{ gridColumn: "span 2" }}>
        <Field label="Título (nome do arquivo)">
          <input
            type="text"
            value={extras.metaTitle}
            onChange={(e) => onExtras({ ...extras, metaTitle: e.target.value })}
            placeholder="Título do vídeo"
            className={smallSelect}
            title="Edite para escolher o nome com que o arquivo será salvo"
          />
        </Field>
      </div>
      {duration && duration > 1 ? (
        <div style={{ gridColumn: "span 2" }}>
          <TrimSlider
            duration={duration}
            start={extras.start}
            end={extras.end}
            onChange={(st, en) => onExtras({ ...extras, start: st, end: en })}
          />
        </div>
      ) : (
        <>
          <Field label="Início (mm:ss)">
            <input
              type="text"
              value={extras.start}
              onChange={(ev) => onExtras({ ...extras, start: ev.target.value })}
              placeholder="0:00"
              className={smallSelect}
            />
          </Field>
          <Field label="Fim (mm:ss)">
            <input
              type="text"
              value={extras.end}
              onChange={(ev) => onExtras({ ...extras, end: ev.target.value })}
              placeholder="até o fim"
              className={smallSelect}
            />
          </Field>
        </>
      )}
      <div className="flex items-end">
        <button data-tone="2" onClick={onReset} className={btnSmall}>
          <Icon name="undo" />
          Usar padrão
        </button>
      </div>
    </div>
  );
}

function Lbl({ text, tip }: { text: string; tip: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {text}
      <InfoButton title={text}>{tip}</InfoButton>
    </span>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block truncate text-sm text-dim">{label}</span>
      {children}
    </label>
  );
}

type Theme =
  | "simpsons"
  | "starwars"
  | "jukebox"
  | "hq"
  | "win98"
  | "winning11"
  | "guitarhero"
  | "synthwave"
  | "snes"
  | "winamp"
  | "msn"
  | "matrix"
  | "ps1"
  | "pokemon"
  | "mario"
  | "sf"
  | "mk"
  | "mtv"
  | "orkut"
  | "winxp"
  | "a51"
  | "cyberpunk"
  | "gameboy"
  | "arcade"
  | "vhs"
  | "nokia"
  | "zelda";

const THEMES: { value: Theme; label: string }[] = [
  { value: "simpsons", label: "Simpsons" },
  { value: "starwars", label: "Star Wars" },
  { value: "jukebox", label: "Jukebox" },
  { value: "hq", label: "HQ" },
  { value: "win98", label: "Windows 98" },
  { value: "winning11", label: "Winning Eleven 7" },
  { value: "guitarhero", label: "Guitar Hero" },
  { value: "synthwave", label: "Synthwave" },
  { value: "snes", label: "Super Nintendo" },
  { value: "winamp", label: "Winamp" },
  { value: "msn", label: "MSN Messenger" },
  { value: "matrix", label: "Matrix" },
  { value: "ps1", label: "PlayStation 1" },
  { value: "pokemon", label: "Pokémon" },
  { value: "mario", label: "Super Mario" },
  { value: "sf", label: "Street Fighter" },
  { value: "mk", label: "Mortal Kombat" },
  { value: "mtv", label: "MTV anos 90" },
  { value: "orkut", label: "Orkut" },
  { value: "winxp", label: "Windows XP" },
  { value: "a51", label: "Siemens A51" },
  { value: "cyberpunk", label: "Cyberpunk" },
  { value: "gameboy", label: "Game Boy" },
  { value: "arcade", label: "Fliperama" },
  { value: "vhs", label: "VHS" },
  { value: "nokia", label: "Nokia 3310" },
  { value: "zelda", label: "Zelda" },
];

const STORAGE_PREFIX = "ytme_";

function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    // ignore (private mode, storage disabled, etc.)
  }
}

function AudioIcon() {
  return (
    <div className="flex h-9 w-16 shrink-0 items-center justify-center rounded-sm bg-panel text-dim">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M9 18V5l12-2v13" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    </div>
  );
}

export default function App() {
  const [session0] = useState<SessionState | null>(() => loadPref<SessionState | null>("session", null));
  const [urls, setUrls] = useState(() => session0?.urls ?? "");
  const [mode, setMode] = useState<Mode>(() => loadPref("mode", "audio"));
  const [audioFormat, setAudioFormat] = useState<AudioFormat>(() =>
    loadPref("audioFormat", "mp3")
  );
  const [audioQuality, setAudioQuality] = useState<AudioQuality>(() =>
    loadPref("audioQuality", "192")
  );
  const [videoFormat, setVideoFormat] = useState<VideoFormat>(() =>
    loadPref("videoFormat", "mp4")
  );
  const [videoQuality, setVideoQuality] = useState<VideoQuality>(() =>
    loadPref("videoQuality", "best")
  );
  const [outputDir, setOutputDir] = useState(() => loadPref("outputDir", ""));
  const [concurrency, setConcurrency] = useState<number>(() => loadPref("concurrency", 1));
  const [cookiesBrowser, setCookiesBrowser] = useState<CookieBrowser>(() =>
    loadPref("cookiesBrowser", "")
  );

  const [jobs, setJobs] = useState<Job[]>([]);
  const jobsRef = useRef<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<{ done: number; total: number } | null>(
    null
  );
  const [pickingFolder, setPickingFolder] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [preview, setPreview] = useState<ResolvedItem[] | null>(() => session0?.preview ?? null);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(
    () => new Set(session0?.selected ?? [])
  );
  const [error, setError] = useState<string | null>(null);
  const [previewTheme, setPreviewTheme] = useState<Theme | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = loadPref<Theme>("theme", "simpsons");
    return THEMES.some((t) => t.value === saved) ? saved : "simpsons";
  });
  const [overrides, setOverrides] = useState<Record<string, ItemConfig>>(
    () => session0?.overrides ?? {}
  );
  const [extras, setExtras] = useState<Record<string, ItemExtras>>(() => session0?.extras ?? {});
  const [filenameTemplate, setFilenameTemplate] = useState<FilenameTemplate>(() =>
    loadPref("filenameTemplate", "title")
  );
  const [playlistSubfolder, setPlaylistSubfolder] = useState<boolean>(() =>
    loadPref("playlistSubfolder", false)
  );
  const [subtitles, setSubtitles] = useState<boolean>(() => loadPref("subtitles", false));
  const [separateFolders, setSeparateFolders] = useState<boolean>(() =>
    loadPref("separateFolders", true)
  );
  const [normalize, setNormalize] = useState<boolean>(() => loadPref("normalize", false));
  const [rateLimit, setRateLimit] = useState<string>(() => loadPref("rateLimit", ""));
  const [notify, setNotify] = useState<boolean>(() => loadPref("notify", false));
  const [hoverTips, setHoverTips] = useState<boolean>(() => loadPref("hoverTips", false));
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadPref("history", []));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [engine, setEngine] = useState<{
    current: string;
    latest: string | null;
    update_available: boolean;
  } | null>(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recordedRef = useRef<Set<string>>(new Set());
  const wasRunningRef = useRef(false);
  const analyzeRef = useRef<(text: string) => void>(() => {});
  const [customOpen, setCustomOpen] = useState<Set<string>>(new Set());
  const [pendingFile, setPendingFile] = useState<{ name: string; text: string } | null>(null);
  const [saveToFolder, setSaveToFolder] = useState<boolean>(() => loadPref("saveToFolder", true));
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => savePref("mode", mode), [mode]);
  useEffect(() => savePref("audioFormat", audioFormat), [audioFormat]);
  useEffect(() => savePref("audioQuality", audioQuality), [audioQuality]);
  useEffect(() => savePref("videoFormat", videoFormat), [videoFormat]);
  useEffect(() => savePref("videoQuality", videoQuality), [videoQuality]);
  useEffect(() => savePref("outputDir", outputDir), [outputDir]);
  useEffect(() => savePref("concurrency", concurrency), [concurrency]);
  useEffect(() => savePref("cookiesBrowser", cookiesBrowser), [cookiesBrowser]);
  useEffect(() => savePref("saveToFolder", saveToFolder), [saveToFolder]);
  useEffect(() => savePref("filenameTemplate", filenameTemplate), [filenameTemplate]);
  useEffect(() => savePref("playlistSubfolder", playlistSubfolder), [playlistSubfolder]);
  useEffect(() => savePref("subtitles", subtitles), [subtitles]);
  useEffect(() => savePref("separateFolders", separateFolders), [separateFolders]);
  useEffect(() => savePref("normalize", normalize), [normalize]);
  useEffect(() => savePref("rateLimit", rateLimit), [rateLimit]);
  useEffect(() => savePref("notify", notify), [notify]);
  useEffect(() => savePref("hoverTips", hoverTips), [hoverTips]);
  useEffect(() => savePref("history", history.slice(0, 300)), [history]);
  // Fila persistente: lista analisada, seleção e personalizações voltam ao reabrir.
  useEffect(() => {
    savePref("session", {
      urls,
      preview,
      selected: Array.from(selectedUrls),
      overrides,
      extras,
    } satisfies SessionState);
  }, [urls, preview, selectedUrls, overrides, extras]);
  useEffect(() => {
    // Fundo parallax: --scroll alimenta as camadas; alguns temas também "flutuam".
    // px/s na camada mais rápida ≈ valor × 0,6: movimento bem lento.
    const drift: Record<Theme, number> = {
      simpsons: 6,
      starwars: 4,
      jukebox: 5,
      hq: 4,
      win98: 5,
      winning11: 4,
      guitarhero: -14,
      synthwave: 4,
      snes: 5,
      winamp: -6,
      msn: 8,
      matrix: -16,
      ps1: 5,
      pokemon: 6,
      mario: 5,
      sf: 6,
      mk: -8,
      mtv: 8,
      orkut: 6,
      winxp: 4,
      a51: 3,
      cyberpunk: -10,
      gameboy: 4,
      arcade: -8,
      vhs: -6,
      nokia: 3,
      zelda: 5,
    };
    const rate = drift[previewTheme ?? theme];
    const root = document.documentElement;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      root.style.setProperty("--scroll", "0");
      return;
    }
    let raf = 0;
    let scrolled = 0;
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement | Document;
      scrolled = el instanceof HTMLElement ? el.scrollTop : window.scrollY;
    };
    document.addEventListener("scroll", onScroll, true);
    const tick = (t: number) => {
      root.style.setProperty("--scroll", String(scrolled + (t / 1000) * rate));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [theme, previewTheme]);

  useEffect(() => {
    document.documentElement.dataset.theme = previewTheme ?? theme;
  }, [theme, previewTheme]);
  useEffect(() => savePref("theme", theme), [theme]);

  useEffect(() => {
    pollRef.current = setInterval(async () => {
      const incomplete = jobsRef.current.filter((j) => !j.finished);
      if (incomplete.length === 0) return;
      const updates = await Promise.all(
        incomplete.map((j) =>
          fetch(`/api/jobs/${j.id}`)
            .then((r) => (r.ok ? (r.json() as Promise<Job>) : null))
            .catch(() => null)
        )
      );
      setJobs((current) =>
        current.map((j) => updates.find((u) => u && u.id === j.id) ?? j)
      );
    }, 1000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const buildJobConfig = () => ({
    mode,
    audio_format: audioFormat,
    audio_quality: audioQuality,
    video_format: videoFormat,
    video_quality: videoQuality,
    output_dir: outputDir || null,
    save_to_folder: saveToFolder,
    cookies_browser: cookiesBrowser || null,
    concurrency,
    filename_template: filenameTemplate,
    playlist_subfolder: playlistSubfolder,
    separate_folders: separateFolders,
    subtitles,
    normalize,
    rate_limit_kb: rateLimit ? Number(rateLimit) : null,
  });

  const handlePickFolder = async () => {
    setError(null);
    setPickingFolder(true);
    try {
      // No app empacotado (Electron) usa o seletor nativo da janela.
      if (window.abe?.pickFolder) {
        const picked = await window.abe.pickFolder();
        if (picked) setOutputDir(picked);
        return;
      }
      const res = await fetch("/api/pick-folder", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? "Falha ao selecionar a pasta.");
      }
      const data: { path: string } = await res.json();
      setOutputDir(data.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido.");
    } finally {
      setPickingFolder(false);
    }
  };

  const handleOpenFolder = async () => {
    setError(null);
    setOpeningFolder(true);
    try {
      const res = await fetch("/api/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: outputDir || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? "Falha ao abrir a pasta.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido.");
    } finally {
      setOpeningFolder(false);
    }
  };

  const createJob = async (items: Record<string, unknown>[]) => {
    // items may carry per-item overrides (mode, audio_format, ...)
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, ...buildJobConfig() }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail ?? "Falha ao criar o job.");
    }
    const data: Job = await res.json();
    setJobs((current) => [...current, data]);
    return data;
  };

  const handlePasteAndAnalyze = async () => {
    setError(null);
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setError("Não foi possível ler a área de transferência. Cole os links na caixa de texto.");
      return;
    }
    if (!text.trim()) {
      setError("A área de transferência está vazia.");
      return;
    }
    setUrls(text);
    await handleAnalyze(text);
  };

  const handleAnalyze = async (text: string = urls) => {
    setError(null);
    setPreview(null);
    setAnalyzeProgress(null);
    if (!text.trim()) {
      setError("Cole ao menos um link.");
      return;
    }
    setAnalyzing(true);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: text, cookies_browser: cookiesBrowser || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? "Falha ao analisar os links.");
      }
      const { id, total }: { id: string; total: number } = await res.json();
      setAnalyzeProgress({ done: 0, total });

      await new Promise<void>((resolve, reject) => {
        const interval = setInterval(async () => {
          try {
            const r = await fetch(`/api/analyze/${id}`);
            if (!r.ok) {
              clearInterval(interval);
              reject(new Error("Falha ao consultar o progresso da análise."));
              return;
            }
            const data: {
              done: number;
              total: number;
              finished: boolean;
              items: ResolvedItem[];
            } = await r.json();
            setAnalyzeProgress({ done: data.done, total: data.total });
            if (data.finished) {
              clearInterval(interval);
              setPreview(data.items);
              {
                const seen = new Set<string>();
                const doneKeys = new Set(history.map((h) => h.key));
                const chosen: string[] = [];
                for (const it of data.items) {
                  if (it.error) continue;
                  const k = it.key ?? canonicalKey(it.url);
                  if (seen.has(k) || doneKeys.has(k)) continue;
                  seen.add(k);
                  chosen.push(it.url);
                }
                setSelectedUrls(new Set(chosen));
              }
              resolve();
            }
          } catch (err) {
            clearInterval(interval);
            reject(err instanceof Error ? err : new Error("Erro desconhecido."));
          }
        }, 400);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido.");
    } finally {
      setAnalyzing(false);
      setAnalyzeProgress(null);
    }
  };

  const globalItemConfig: ItemConfig = { mode, audioFormat, audioQuality, videoFormat, videoQuality };

  const overridePayload = (url: string) => {
    const o = overrides[url];
    const x = extras[url];
    const base: Record<string, unknown> = {};
    if (o) {
      Object.assign(base, {
        mode: o.mode,
        audio_format: o.audioFormat,
        audio_quality: o.audioQuality,
        video_format: o.videoFormat,
        video_quality: o.videoQuality,
      });
    }
    if (x) {
      const original = (preview?.find((it) => it.url === url)?.title ?? "").trim();
      const edited = x.metaTitle.trim();
      if (edited && edited !== original) base.meta_title = edited;
      const s = parseTime(x.start);
      const e = parseTime(x.end);
      if (s !== undefined) base.start = s;
      if (e !== undefined) base.end = e;
    }
    return base;
  };

  const emptyExtras: ItemExtras = { metaTitle: "", start: "", end: "" };

  const isEdited = (p: ResolvedItem) => {
    const x = extras[p.url];
    if (!x) return false;
    const titleChanged = x.metaTitle.trim() !== "" && x.metaTitle.trim() !== (p.title ?? "").trim();
    return titleChanged || !!x.start || !!x.end;
  };

  const shownTitle = (p: ResolvedItem) => {
    const x = extras[p.url];
    const t = x?.metaTitle.trim();
    return t && t !== (p.title ?? "").trim() ? t : null;
  };

  const setOverride = (url: string, next: ItemConfig) =>
    setOverrides((current) => ({ ...current, [url]: next }));

  const clearOverride = (url: string) => {
    setOverrides((current) => {
      const next = { ...current };
      delete next[url];
      return next;
    });
    setExtras((current) => {
      const next = { ...current };
      delete next[url];
      return next;
    });
    setCustomOpen((current) => {
      const next = new Set(current);
      next.delete(url);
      return next;
    });
  };

  const toggleCustom = (url: string) => {
    const originalTitle = preview?.find((it) => it.url === url)?.title ?? "";
    // Preenche com o título do vídeo quando ainda não há nome (inclui sessões antigas com campo vazio).
    setExtras((cur) => {
      const x = cur[url];
      if (x && x.metaTitle.trim()) return cur;
      return { ...cur, [url]: { ...(x ?? emptyExtras), metaTitle: originalTitle } };
    });
    setCustomOpen((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const handleDownload = async (urlsToDownload: string[]) => {
    setError(null);
    if (urlsToDownload.length === 0) {
      setError("Nenhum item selecionado.");
      return;
    }
    setLoading(true);
    try {
      const items = urlsToDownload.map((url) => {
        const match = preview?.find((p) => p.url === url);
        return {
          url,
          title: match?.title ?? null,
          playlist_title: match?.playlist_title ?? null,
          ...overridePayload(url),
        };
      });
      await createJob(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido.");
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadOne = async (item: ResolvedItem) => {
    setError(null);
    try {
      await createJob([
        {
          url: item.url,
          title: item.title,
          playlist_title: item.playlist_title,
          ...overridePayload(item.url),
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido.");
    }
  };

  const handleCancelAll = async () => {
    setError(null);
    const running = jobsRef.current.filter((j) => !j.finished);
    try {
      const updates = await Promise.all(
        running.map((j) =>
          fetch(`/api/jobs/${j.id}/cancel`, { method: "POST" }).then((r) =>
            r.ok ? (r.json() as Promise<Job>) : null
          )
        )
      );
      setJobs((current) =>
        current.map((j) => updates.find((u) => u && u.id === j.id) ?? j)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido.");
    }
  };

  const handleFile = async (file: File) => {
    const text = await file.text();
    setPendingFile({ name: file.name, text });
  };

  const handleReset = () => {
    setUrls("");
    setPreview(null);
    setSelectedUrls(new Set());
    setOverrides({});
    setCustomOpen(new Set());
    setJobs([]);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const closeFileModal = () => {
    setPendingFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const confirmFileModal = async () => {
    if (!pendingFile) return;
    const { text } = pendingFile;
    closeFileModal();
    setUrls(text);
    setSelectedUrls(new Set());
    await handleAnalyze(text);
  };

  useEffect(() => {
    if (!pendingFile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeFileModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingFile]);

  // Preferências padrão do app.
  const resetPrefs = () => {
    setHoverTips(false);
    setSaveToFolder(true);
    setSeparateFolders(true);
    setNotify(false);
    setPlaylistSubfolder(false);
    setNormalize(false);
    setSubtitles(false);
    setNotice("Preferências restauradas para o padrão.");
    window.setTimeout(() => setNotice(null), 3000);
  };

  const handleCancelItem = async (jobId: string, index: number) => {
    try {
      const r = await fetch(`/api/jobs/${jobId}/cancel/${index}`, { method: "POST" });
      if (r.ok) {
        const updated: Job = await r.json();
        setJobs((current) => current.map((j) => (j.id === updated.id ? updated : j)));
      }
    } catch {
      /* ignora */
    }
  };

  const revealFile = async (path: string) => {
    try {
      const r = await fetch("/api/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(body.detail ?? "Não foi possível mostrar o arquivo.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido.");
    }
  };

  const handlePreviewAudio = async (url: string) => {
    const audio = audioRef.current ?? (audioRef.current = new Audio());
    if (previewing === url) {
      audio.pause();
      setPreviewing(null);
      return;
    }
    audio.pause();
    setPreviewing(url);
    try {
      const qs = new URLSearchParams({ url });
      if (cookiesBrowser) qs.set("cookies_browser", cookiesBrowser);
      const r = await fetch(`/api/preview-url?${qs}`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.detail ?? "Sem prévia para este item.");
      }
      const data: { url: string } = await r.json();
      audio.src = data.url;
      audio.currentTime = 0;
      await audio.play();
      window.setTimeout(() => {
        if (audioRef.current === audio && !audio.paused) {
          audio.pause();
          setPreviewing((p) => (p === url ? null : p));
        }
      }, 10000);
    } catch (err) {
      setPreviewing(null);
      setError(err instanceof Error ? err.message : "Erro ao tocar a prévia.");
    }
  };

  const checkEngine = async () => {
    try {
      const r = await fetch("/api/ytdlp");
      if (r.ok) setEngine(await r.json());
    } catch {
      /* sem conexão */
    }
  };

  const updateEngine = async () => {
    setEngineBusy(true);
    setNotice(null);
    setError(null);
    try {
      const r = await fetch("/api/ytdlp/update", { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.detail ?? "Falha ao atualizar o motor.");
      setNotice(`Motor atualizado para ${body.updated_to}. Reinicie o app para usar a nova versão.`);
      if (window.abe?.restart && window.confirm("Motor atualizado. Reiniciar o app agora?")) {
        await window.abe.restart();
      }
      await checkEngine();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido.");
    } finally {
      setEngineBusy(false);
    }
  };

  const downloadDiagnostics = async () => {
    try {
      const r = await fetch("/api/diagnostics");
      const text = await r.text();
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = "abe-diagnostico.txt";
      a.click();
      URL.revokeObjectURL(href);
    } catch {
      setError("Não foi possível gerar o diagnóstico.");
    }
  };

  const toggleSelected = (url: string) => {
    setSelectedUrls((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const previewValid = preview?.filter((p) => !p.error) ?? [];

  // Duplicados: repetidos na lista ou já baixados antes.
  const dupes: Record<string, "list" | "done"> = {};
  {
    const seen = new Set<string>();
    const doneKeys = new Set(history.map((h) => h.key));
    for (const it of preview ?? []) {
      if (it.error) continue;
      const k = it.key ?? canonicalKey(it.url);
      if (seen.has(k)) dupes[it.url] = "list";
      else if (doneKeys.has(k)) dupes[it.url] = "done";
      seen.add(k);
    }
  }
  const previewErrors = preview?.filter((p) => p.error) ?? [];

  const progressByUrl = new Map<string, { job: Job; item: DownloadItem; idx: number }>();
  jobs.forEach((job) => {
    job.items.forEach((item, idx) => {
      progressByUrl.set(item.url, { job, item, idx });
    });
  });

  const doneCount = jobs.reduce(
    (acc, j) => acc + j.items.filter((i) => i.status === "done").length,
    0
  );
  const totalCount = jobs.reduce((acc, j) => acc + j.items.length, 0);
  const anyRunning = jobs.some((j) => !j.finished);
  const failedUrls = jobs.flatMap((j) =>
    j.items.filter((i) => i.status === "error" && !/cancelad/i.test(i.error ?? "")).map((i) => i.url)
  );
  const runningItems = jobs.flatMap((j) => j.items.filter((i) => i.status === "downloading"));
  const batchEta = runningItems.length
    ? Math.max(...runningItems.map((i) => i.eta ?? 0))
    : null;
  const batchSpeed = runningItems.reduce((acc, i) => acc + (i.speed ?? 0), 0);

  // Mantém referências para handlers globais (colar, soltar, agendar).
  analyzeRef.current = (text: string) => {
    setUrls(text);
    void handleAnalyze(text);
  };

  // Histórico: registra cada item concluído uma única vez.
  useEffect(() => {
    const fresh: HistoryEntry[] = [];
    for (const j of jobs) {
      j.items.forEach((it, idx) => {
        const id = `${j.id}:${idx}`;
        if (it.status === "done" && !recordedRef.current.has(id)) {
          recordedRef.current.add(id);
          fresh.push({
            key: canonicalKey(it.url),
            url: it.url,
            title: it.title,
            filepath: it.filepath ?? null,
            when: Date.now(),
          });
        }
      });
    }
    if (fresh.length) setHistory((h) => [...fresh.reverse(), ...h].slice(0, 300));
  }, [jobs]);

  // Notificação ao concluir o lote.
  useEffect(() => {
    if (wasRunningRef.current && !anyRunning && totalCount > 0 && notify) {
      const failed = failedUrls.length;
      const body = `${doneCount} concluído(s)${failed ? `, ${failed} com erro` : ""}.`;
      try {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("Abe download manager", { body });
        }
      } catch {
        /* notificações indisponíveis */
      }
    }
    wasRunningRef.current = anyRunning;
  }, [anyRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+V na página (fora de campos) e arrastar e soltar.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (/https?:\/\//.test(text)) {
        e.preventDefault();
        analyzeRef.current(text);
      }
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file && /\.txt$/i.test(file.name)) {
        void file.text().then((t) => setPendingFile({ name: file.name, text: t }));
        return;
      }
      const text = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain") || "";
      if (/https?:\/\//.test(text)) analyzeRef.current(text);
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    void checkEngine();
  }, []);

  return (
    <div className={`app-root text-bone ${hoverTips ? "" : "tips-off"}`}>
      <div className="parallax" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div
        className={`app-main relative z-10 mx-auto max-w-4xl px-4 pb-8 pt-4 sm:pb-12 ${preview ? "has-list" : ""} ${menuOpen ? "menu-open" : ""}`}
      >
        <div className="layout">
        <header className="col-header mb-6">
        <div className="relative flex items-center gap-4">
          {/* Largo: fora do conteúdo, à esquerda do Abe. Estreito: inline antes do Abe. */}
          <div className="z-40 max-[1099px]:order-last max-[1099px]:ml-auto min-[1100px]:absolute min-[1100px]:right-full min-[1100px]:top-0 min-[1100px]:mr-2">
            <ThemeMenu
              theme={theme}
              onChange={setTheme}
              onPreview={setPreviewTheme}
              onOpenChange={setMenuOpen}
            />
          </div>
          <AbeLogo />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-4xl font-bold tracking-tight [font-size-adjust:0.5]">Abe download manager</h1>
              <InfoButton title="Como usar o Abe download manager" wide>
                <ol>
                  <li>
                    <b>Links:</b> clique em "Colar e analisar" (ele lê o que você copiou) ou em "Escolher arquivo .txt".
                    Funciona com YouTube, Instagram, TikTok, Facebook, SoundCloud, Pexels e outros sites.
                  </li>
                  <li>
                    <b>Destino:</b> escolha a pasta e marque "Salvar ao concluir" para gravar direto nela.
                  </li>
                  <li>
                    <b>Opções de download:</b> defina tipo (áudio ou vídeo), formato, qualidade e quantos baixar ao mesmo tempo.
                  </li>
                  <li>
                    <b>Lista:</b> marque os itens e use "Baixar selecionados" ou "Baixar tudo". Em cada linha, "Personalizar" muda o formato só daquele item.
                  </li>
                  <li>
                    <b>Acompanhe:</b> a onda de cada item enche conforme baixa. Se "Salvar ao concluir" estiver desmarcado, use "Baixar arquivo".
                  </li>
                  <li>
                    <b>Tema:</b> troque o visual no botão "Temas", à esquerda do Abe. Passar o mouse mostra uma prévia.
                  </li>
                  <li>
                    <b>Atalhos:</b> Ctrl+V em qualquer lugar cola e analisa; Ctrl+Enter na caixa de links analisa; arraste links ou um .txt para a janela; Esc fecha menus e balões.
                  </li>
                  <li>
                    <b>Sessão:</b> a lista analisada, a seleção e as personalizações são lembradas ao reabrir. Itens já baixados aparecem como "Já baixado".
                  </li>
                </ol>
              </InfoButton>
            </div>
            <p className="mt-1 max-w-prose text-dim [font-size-adjust:0.5]">
              Cole links de vídeos ou playlists e baixe áudio ou vídeo.
            </p>
          </div>
        </div>
      </header>
        <div className="col-left">

        <section className={blockCls}>
          <div className="mb-1.5 flex items-center gap-2">
            <label htmlFor="urls" className="block text-base font-medium">
              Links
            </label>
            <InfoButton title="Links">
              <ul>
                <li>Cole um link de vídeo ou playlist por linha. Playlists viram vários itens.</li>
                <li>"Colar e analisar" lê da área de transferência e já inicia a análise.</li>
                <li>"Escolher arquivo .txt" carrega vários links de uma vez (um por linha).</li>
                <li>Digitou ou editou à mão? Pressione Ctrl+Enter na caixa para analisar.</li>
                <li>"Limpar tudo" apaga a lista e recomeça (fica indisponível durante downloads).</li>
              </ul>
            </InfoButton>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                className="tool-btn tool-btn-text"
                onClick={() => setHistoryOpen(true)}
                aria-label="Histórico"
                title={`Histórico de downloads (${history.length})`}
              >
                <Icon name="history" />
                <span className="tool-label">Histórico</span>
              </button>
              <button
                type="button"
                className="tool-btn tool-btn-text"
                onClick={resetPrefs}
                aria-label="Preferências padrão"
                title="Preferências padrão: restaura dicas, salvar ao concluir, pastas, notificação, subpasta, volume e legendas"
              >
                <Icon name="reset" />
                <span className="tool-label">Padrão</span>
              </button>
              <button
                type="button"
                className="tool-btn tool-btn-text"
                data-off={hoverTips ? undefined : "1"}
                onClick={() => setHoverTips((v) => !v)}
                aria-pressed={hoverTips}
                aria-label="Dicas ao passar o mouse"
                title={hoverTips ? "Dicas ao passar o mouse: ligadas (clique para desligar)" : "Dicas ao passar o mouse: desligadas (clique para ligar)"}
              >
                <Icon name="tip" />
                <span className="tool-label">Dicas</span>
              </button>
            </div>
          </div>
          <p className="mb-2 text-sm text-dim">Vídeos ou playlists, um por linha.</p>
          <textarea
            id="urls"
            value={urls}
            onChange={(e) => {
              setUrls(e.target.value);
              setPreview(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !analyzing) {
                e.preventDefault();
                void handleAnalyze();
              }
            }}
            placeholder="https://www.youtube.com/watch?v=...&#10;https://www.youtube.com/playlist?list=..."
            rows={3}
            className="w-full resize-y rounded-sm border border-line bg-panel p-3 font-mono text-sm leading-relaxed text-bone outline-none placeholder:text-dim/60 focus:border-accent"
          />

          <div className="links-actions mt-2 flex flex-nowrap items-center gap-2">
            <button onClick={handlePasteAndAnalyze} disabled={analyzing} className={btnPrimary}>
              <Icon name="paste" />
              {analyzing
                ? analyzeProgress
                  ? `Analisando ${analyzeProgress.done}/${analyzeProgress.total}...`
                  : "Analisando..."
                : "Colar e analisar"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt"
              aria-label="Carregar arquivo .txt com links"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
              className="hidden"
            />
            <button data-tone="1" onClick={() => fileInputRef.current?.click()} className={btn} title="Escolher um arquivo .txt com os links">
              <Icon name="upload" />
              Arquivo .txt
            </button>
            {(urls.trim() || preview || jobs.length > 0) && (
              <button
                onClick={handleReset}
                disabled={analyzing || anyRunning}
                title={anyRunning ? "Cancele os downloads antes de limpar" : undefined}
                data-tone="2" className={`${btn} ml-auto`}
              >
                <Icon name="trash" />
                Limpar tudo
              </button>
            )}
          </div>

          {error && (
            <p role="alert" className="mt-4 text-sm text-bad">
              {error}
            </p>
          )}
        </section>

        <section className={blockCls}>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-base font-medium">Destino</h2>
            <InfoButton title="Destino">
              <ul>
                <li>É o local onde o app cria a pasta abe_download_manager, com as subpastas audio e video. Vazio, usa Downloads/abe_download_manager.</li>
                <li>"Salvar ao concluir" grava o arquivo direto na pasta, sem etapa extra.</li>
                <li>Desmarcado, cada item concluído ganha o botão "Baixar arquivo".</li>
                <li>"Selecionar pasta" abre o seletor do Windows e "Abrir pasta" mostra o destino no Explorer.</li>
              </ul>
            </InfoButton>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-60 flex-1">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label htmlFor="outputDir" className="text-sm text-dim">
                  Local de destino
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-bone">
                  <input
                    type="checkbox"
                    checked={saveToFolder}
                    onChange={(e) => setSaveToFolder(e.target.checked)}
                    className="h-4 w-4 accent-amber"
                  />
                  Salvar ao concluir
                </label>
              </div>
              <input
                id="outputDir"
                type="text"
                value={outputDir}
                onChange={(e) => setOutputDir(e.target.value)}
                disabled={!saveToFolder}
                placeholder="Padrão: Downloads/abe_download_manager"
                className={`${fieldCls} font-mono`}
              />
            </div>
            <button
              type="button"
              onClick={handlePickFolder}
              disabled={pickingFolder || !saveToFolder}
              className="tool-btn tool-btn-lg"
              aria-label="Selecionar pasta"
              title={pickingFolder ? "Abrindo o seletor..." : "Selecionar pasta"}
            >
              <Icon name="folder" />
              <span className="tool-cap">Selecionar</span>
            </button>
            <button
              type="button"
              onClick={handleOpenFolder}
              disabled={openingFolder || !saveToFolder}
              className="tool-btn tool-btn-lg"
              aria-label="Abrir pasta"
              title="Abrir pasta no Explorer"
            >
              <Icon name="folderOpen" />
              <span className="tool-cap">Abrir</span>
            </button>
          </div>
        </section>

        <section className={blockCls}>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-base font-medium">Opções de download</h2>
            <p className="text-sm text-dim">
              Vale para todos os links da lista, exceto os que você personalizar.
            </p>
          </div>
          <div className="std-grid grid grid-cols-2 items-end gap-3 sm:grid-cols-4">
            <Field label={<Lbl text="Tipo" tip="Escolha se quer só o áudio ou o vídeo completo. Cada item pode ter o seu próprio tipo em “Personalizar”." />}>
              <IconSelect
                icon="music"
                optionIcon={(v) => (v === "audio" ? "music" : "film")}
                value={mode}
                onChange={(e) => setMode(e.target.value as Mode)}
                className={fieldCls}
              >
                <option value="audio">Áudio</option>
                <option value="video">Vídeo</option>
              </IconSelect>
            </Field>

            {mode === "audio" ? (
              <>
                <Field label={<Lbl text="Formato" tip="Container do arquivo final: MP3, M4A, WAV, FLAC ou OPUS no áudio; MP4, MKV ou WEBM no vídeo. “Original” mantém o áudio sem converter." />}>
                  <IconSelect icon="file"
                    value={audioFormat}
                    onChange={(e) => setAudioFormat(e.target.value as AudioFormat)}
                    className={fieldCls}
                  >
                    <option value="mp3">MP3</option>
                    <option value="m4a">M4A</option>
                    <option value="wav">WAV</option>
                    <option value="flac">FLAC</option>
                    <option value="opus">OPUS</option>
                    <option value="original">Original</option>
                  </IconSelect>
                </Field>
                <Field label={<Lbl text="Qualidade" tip="No áudio, a taxa de bits (kbps). No vídeo, a resolução máxima. “Melhor” pega a mais alta disponível." />}>
                  <select
                    value={audioQuality}
                    onChange={(e) => setAudioQuality(e.target.value as AudioQuality)}
                    disabled={audioFormat === "original"}
                    className={fieldCls}
                  >
                    <option value="best">Melhor</option>
                    <option value="320">320 kbps</option>
                    <option value="256">256 kbps</option>
                    <option value="192">192 kbps</option>
                    <option value="128">128 kbps</option>
                  </select>
                </Field>
              </>
            ) : (
              <>
                <Field label={<Lbl text="Formato" tip="Container do arquivo final: MP3, M4A, WAV, FLAC ou OPUS no áudio; MP4, MKV ou WEBM no vídeo. “Original” mantém o áudio sem converter." />}>
                  <IconSelect icon="file"
                    value={videoFormat}
                    onChange={(e) => setVideoFormat(e.target.value as VideoFormat)}
                    className={fieldCls}
                  >
                    <option value="mp4">MP4</option>
                    <option value="mkv">MKV</option>
                    <option value="webm">WEBM</option>
                  </IconSelect>
                </Field>
                <Field label={<Lbl text="Qualidade" tip="No áudio, a taxa de bits (kbps). No vídeo, a resolução máxima. “Melhor” pega a mais alta disponível." />}>
                  <select
                    value={videoQuality}
                    onChange={(e) => setVideoQuality(e.target.value as VideoQuality)}
                    className={fieldCls}
                  >
                    <option value="best">Melhor</option>
                    <option value="2160">2160p (4K)</option>
                    <option value="1440">1440p</option>
                    <option value="1080">1080p</option>
                    <option value="720">720p</option>
                    <option value="480">480p</option>
                    <option value="360">360p</option>
                  </select>
                </Field>
              </>
            )}

            <Field
              label={
                <span className="inline-flex items-center gap-1.5">
                  Cookies
                  <InfoButton title="Cookies do navegador">
                    <ul>
                      <li>Usa o login do seu navegador em sites que exigem conta (Vimeo, Instagram privado etc.).</li>
                      <li>Escolha o navegador onde você está logado. "Nenhum" é o normal para a maioria dos links.</li>
                      <li>Feche o navegador antes de baixar: Chrome, Edge e Brave bloqueiam o arquivo de cookies enquanto abertos.</li>
                      <li>Se der erro, tente o Firefox, que costuma funcionar com o navegador aberto.</li>
                    </ul>
                  </InfoButton>
                </span>
              }
            >
              <select
                value={cookiesBrowser}
                onChange={(e) => setCookiesBrowser(e.target.value as CookieBrowser)}
                className={fieldCls}
                title="Usa o login do navegador para sites que exigem conta (Vimeo, Instagram privado...). Feche o navegador antes de baixar."
              >
                <option value="">Nenhum</option>
                <option value="chrome">Chrome</option>
                <option value="edge">Edge</option>
                <option value="firefox">Firefox</option>
                <option value="brave">Brave</option>
                <option value="opera">Opera</option>
                <option value="vivaldi">Vivaldi</option>
              </select>
            </Field>
          </div>
          <div className="opts-oneline mt-2 flex flex-nowrap items-center justify-between gap-x-3 text-sm">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={separateFolders}
              onChange={(e) => setSeparateFolders(e.target.checked)}
              className="h-4 w-4 accent-amber"
            />
            Pastas para áudio e vídeo
            <InfoButton title="Pastas para áudio e vídeo">
              Marcado: o áudio é salvo sempre em /audio e o vídeo sempre em /video, dentro da pasta de destino. Desmarcado: tudo vai direto para a pasta de destino.
            </InfoButton>
          </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={normalize}
                onChange={(e) => setNormalize(e.target.checked)}
                className="h-4 w-4 accent-amber"
              />
              Normalizar volume
              <InfoButton title="Normalizar volume">
                Nivela o volume do áudio para todos os arquivos ficarem no mesmo nível. Só vale quando há conversão de formato.
              </InfoButton>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={subtitles}
                onChange={(e) => setSubtitles(e.target.checked)}
                className="h-4 w-4 accent-amber"
              />
              Legendas
              <InfoButton title="Legendas">
                Baixa legendas .srt em português ou inglês, quando o vídeo tiver.
              </InfoButton>
            </label>
          </div>

        </section>

        <section className={blockCls}>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-base font-medium">Outras opções</h2>
            <InfoButton title="Outras opções" wide>
              <ul>
                <li><b>Nome do arquivo:</b> só o título, “Artista - Título” ou numerado na ordem da lista.</li>
                <li><b>Subpasta por playlist:</b> cria uma pasta com o nome da playlist dentro do destino.</li>
                <li><b>Legendas:</b> baixa .srt em português ou inglês, quando existirem.</li>
                <li><b>Normalizar volume:</b> nivela o volume dos áudios (só quando há conversão).</li>
                <li><b>Limite de velocidade:</b> controla a velocidade de cada download.</li>
                <li><b>Notificar:</b> avisa pelo Windows quando o lote termina.</li>
                <li><b>Motor:</b> atualiza o yt-dlp pelo app quando um site deixa de funcionar.</li>
              </ul>
            </InfoButton>
          </div>
          <div className="opts-grid grid grid-cols-2 items-end gap-3 sm:grid-cols-[2fr_1fr_1fr]">
            <Field label={<Lbl text="Nome do arquivo" tip="Como o arquivo é nomeado: só o título, combinações com artista, canal, número da lista, data, ano ou id do vídeo. Quando o artista não existe, usa o nome do canal." />}>
              <select
                value={filenameTemplate}
                onChange={(e) => setFilenameTemplate(e.target.value as FilenameTemplate)}
                className={fieldCls}
              >
                <option value="title">Título</option>
                <option value="artist_title">Artista - Título</option>
                <option value="title_artist">Título - Artista</option>
                <option value="numbered">01 - Título</option>
                <option value="numbered_artist">01 - Artista - Título</option>
                <option value="channel_title">Canal - Título</option>
                <option value="date_title">Data - Título</option>
                <option value="title_year">Título (ano)</option>
                <option value="title_id">Título [id]</option>
              </select>
            </Field>
            <Field label={<Lbl text="Velocidade" tip="Limita a velocidade de cada download para não ocupar toda a sua internet." />}>
              <select value={rateLimit} onChange={(e) => setRateLimit(e.target.value)} className={fieldCls}>
                <option value="">Sem limite</option>
                <option value="500">500 KB/s</option>
                <option value="1000">1 MB/s</option>
                <option value="2000">2 MB/s</option>
                <option value="5000">5 MB/s</option>
              </select>
            </Field>
            <Field label={<Lbl text="Simultâneos" tip="Quantos itens baixam ao mesmo tempo. Valores altos aceleram, mas podem causar bloqueios temporários do site." />}>
              <select
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                className={fieldCls}
              >
                {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>


          </div>
          <div className="opts-row opts-oneline mt-3 flex flex-nowrap items-center justify-between gap-x-3 text-sm">
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={playlistSubfolder} onChange={(e) => setPlaylistSubfolder(e.target.checked)} className="h-4 w-4 accent-amber" />
              Subpasta por playlist
              <InfoButton title="Subpasta por playlist">Cria uma pasta com o nome da playlist dentro do destino e coloca os itens nela.</InfoButton>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={notify}
                onChange={(e) => {
                  setNotify(e.target.checked);
                  if (e.target.checked && "Notification" in window && Notification.permission === "default") {
                    void Notification.requestPermission();
                  }
                }}
                className="h-4 w-4 accent-amber"
              />
              Notificar ao concluir
              <InfoButton title="Notificar ao concluir">Mostra uma notificação do Windows quando o lote termina.</InfoButton>
            </label>

          </div>
          <div className="engine-row mt-3 flex flex-wrap items-center justify-start gap-2 border-t border-line pt-2">
            <button
              type="button"
              data-tone="3"
              onClick={updateEngine}
              disabled={engineBusy}
              className={`${btnSmall} keep-label`}
              aria-label="Atualizar motor"
              title={
                engineBusy
                  ? "Atualizando o motor..."
                  : engine?.update_available
                    ? `Atualizar motor: ${engine.current} → ${engine.latest}`
                    : `Motor yt-dlp ${engine?.current ?? ""} (clique para verificar/atualizar)`
              }
            >
              <Icon name="refresh" />
              {engineBusy
                ? "Atualizando..."
                : engine?.update_available
                  ? `Atualizar motor (${engine.latest})`
                  : "Atualizar motor"}
            </button>
            <button
              type="button"
              data-tone="4"
              onClick={downloadDiagnostics}
              className={`${btnSmall} keep-label`}
              aria-label="Diagnóstico"
              title="Baixar diagnóstico (versões e últimos erros)"
            >
              <Icon name="bug" />
              Diagnóstico
            </button>
            <a
              href="https://github.com/r3vmarcos"
              target="_blank"
              rel="noopener noreferrer"
              data-tone="5"
              className={`${btnSmall} keep-label ml-auto`}
              aria-label="Developed by r3vmarcos"
              title="Abrir o GitHub do desenvolvedor: github.com/r3vmarcos"
            >
              <img
                src="/platforms/r3vmarcos.png"
                alt=""
                className="dev-avatar"
                width={18}
                height={18}
                draggable={false}
              />
              Developed by r3vmarcos
            </a>
          </div>
          {notice && <p className="mt-2 text-sm text-ok">{notice}</p>}
        </section>
        </div>

        {preview && (
          <div className="col-right">
          <section className={blockCls}>
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-base font-medium">
                {previewValid.length} {previewValid.length === 1 ? "item encontrado" : "itens encontrados"}
                {previewErrors.length > 0 && (
                  <span className="text-bad"> · {previewErrors.length} com erro</span>
                )}
                {totalCount > 0 && (
                  <span className="font-mono text-sm text-dim"> · {doneCount}/{totalCount} baixados</span>
                )}
                {batchEta !== null && batchSpeed > 0 && (
                  <span className="font-mono text-sm text-dim">
                    {" "}
                    · {fmtSpeed(batchSpeed)} · ~{fmtEta(batchEta)}
                  </span>
                )}
              </h2>
              <InfoButton title="Lista de downloads">
                <ul>
                  <li>Cada linha é um item encontrado. A caixa à esquerda marca o que entra em "Baixar selecionados".</li>
                  <li>"Personalizar" abre as ações do item (prévia, baixar, mostrar) e as opções de tipo, formato, título e trecho.</li>
                  <li>Os ícones de setas expandem ou recolhem as opções de todos os itens de uma vez.</li>
                  <li>A onda mostra o progresso: âmbar baixando, verde concluído, vermelho erro.</li>
                  <li>Com erro, use "Baixar de novo". "Cancelar" interrompe os downloads em andamento.</li>
                </ul>
              </InfoButton>
            </div>

            {previewValid.length > 0 && (
              <div className="list-toolbar mb-2">
                <div className="tb-left">
                <button
                  onClick={() => setSelectedUrls(new Set(previewValid.map((p) => p.url)))}
                  data-tone="1"
                  className={btnSmall}
                  title="Selecionar todos os itens"
                >
                  <Icon name="checks" />
                  Todos
                </button>
                <button
                  data-tone="2"
                  onClick={() => setSelectedUrls(new Set())}
                  className={btnSmall}
                  title="Limpar a seleção"
                >
                  <Icon name="square" />
                  Limpar
                </button>
                </div>
                <div className="tb-center">
                <button
                  data-tone="4"
                  aria-label="Expandir todos"
                  onClick={() => {
                    setExtras((cur) => {
                      const next = { ...cur };
                      for (const it of previewValid) {
                        const x = next[it.url];
                        if (!x || !x.metaTitle.trim()) {
                          next[it.url] = { ...(x ?? emptyExtras), metaTitle: it.title ?? "" };
                        }
                      }
                      return next;
                    });
                    setCustomOpen(new Set(previewValid.map((p) => p.url)));
                  }}
                  className={`${btnSmall} tb-icon`}
                  title="Expandir as opções de todos os itens"
                >
                  <Icon name="expandAll" />
                </button>
                <button
                  data-tone="3"
                  aria-label="Recolher todos"
                  onClick={() => setCustomOpen(new Set())}
                  className={`${btnSmall} tb-icon`}
                  title="Recolher as opções de todos os itens"
                >
                  <Icon name="collapseAll" />
                </button>
                </div>
                <div className="tb-right">
                <button
                  onClick={() => handleDownload(Array.from(selectedUrls))}
                  disabled={loading || anyRunning || selectedUrls.size === 0}
                  data-tone="5"
                  className={btnSmall}
                  title={`Baixar os ${selectedUrls.size} itens selecionados`}
                >
                  <Icon name="download" />
                  Selecionados ({selectedUrls.size})
                </button>
                <button
                  onClick={() => handleDownload(previewValid.map((p) => p.url))}
                  disabled={loading || anyRunning}
                  className={`${btnPrimary} tb-primary`}
                  title="Baixar todos os itens válidos"
                >
                  <Icon name="downloadAll" />
                  {loading ? "Iniciando..." : anyRunning ? "Baixando..." : "Tudo"}
                </button>
                {failedUrls.length > 0 && !anyRunning && (
                  <button
                    data-tone="2"
                    onClick={() => handleDownload(failedUrls)}
                    className={btnSmall}
                    title={`Tenta de novo os ${failedUrls.length} itens que deram erro`}
                  >
                    <Icon name="retry" />
                    Falharam ({failedUrls.length})
                  </button>
                )}
                {anyRunning && (
                  <button
                    data-danger="1"
                    onClick={handleCancelAll}
                    className="inline-flex shrink-0 items-center gap-2 rounded-sm border border-bad px-3 py-1.5 text-sm font-medium text-bad transition hover:bg-bad/10"
                  >
                    <Icon name="x" />
                    Cancelar
                  </button>
                )}
                </div>
              </div>
            )}

            <ul className="list-scroll max-h-[36rem] divide-y divide-line overflow-y-auto border-y border-line">
              {preview.map((p, idx) => {
                const progress = progressByUrl.get(p.url);
                const itemCfg = overrides[p.url];
                const effectiveMode = itemCfg?.mode ?? mode;
                const itemActive =
                  !!progress &&
                  (progress.item.status === "downloading" || progress.item.status === "pending");
                const panelOpen = customOpen.has(p.url) && !itemActive;
                return (
                  <li key={idx} className="flex flex-wrap items-start gap-3 py-2 text-sm">
                    {p.error ? (
                      <span className="min-w-0 truncate font-mono text-bad">
                        <PlatformIcon url={p.url} />
                        {p.url} — {p.error}
                      </span>
                    ) : (
                      <>
                        <input
                          type="checkbox"
                          checked={selectedUrls.has(p.url)}
                          onChange={() => toggleSelected(p.url)}
                          disabled={anyRunning}
                          aria-label="Selecionar item"
                          className="mt-2.5 h-4 w-4 shrink-0 accent-amber"
                        />

                        {effectiveMode === "video" && p.thumbnail ? (
                          <img
                            src={p.thumbnail}
                            alt=""
                            className="h-9 w-16 shrink-0 rounded-sm object-cover"
                          />
                        ) : (
                          <AudioIcon />
                        )}

                        <div className="min-w-0 flex-1">
                          <span className="item-title block truncate text-base text-bone">
                            {p.playlist_title && (
                              <span className="mr-2 rounded-sm border border-line px-1.5 py-0.5 text-xs text-dim">
                                {p.playlist_title}
                              </span>
                            )}
                            {dupes[p.url] && (
                              <span
                                className="mr-2 rounded-sm border border-accent px-1.5 py-0.5 text-xs text-accent"
                                title={
                                  dupes[p.url] === "done"
                                    ? "Este item já foi baixado antes"
                                    : "Este link aparece mais de uma vez na lista"
                                }
                              >
                                {dupes[p.url] === "done" ? "Já baixado" : "Duplicado"}
                              </span>
                            )}
                            <PlatformIcon url={p.url} />
                            {shownTitle(p) ?? progress?.item.title ?? p.title ?? p.url}
                          </span>


                          {progress && (
                            <>
                              <Wave
                                seed={p.url}
                                progress={progress.item.progress}
                                status={progress.item.status}
                              />
                              {progress.item.status === "downloading" &&
                                (progress.item.speed || progress.item.eta != null) && (
                                  <p className="mt-1 font-mono text-xs text-dim">
                                    {fmtSpeed(progress.item.speed)}
                                    {progress.item.eta != null && ` · restam ${fmtEta(progress.item.eta)}`}
                                  </p>
                                )}
                              {progress.item.error && (
                                <p className="mt-1 truncate text-xs text-bad">
                                  {progress.item.error}
                                </p>
                              )}
                            </>
                          )}
                        </div>

                        <div className="row-actions flex max-w-[26rem] shrink-0 flex-wrap items-center justify-end gap-2">
                          {progress && (
                            <span
                              className={`w-24 text-right font-mono text-xs ${statusColor[progress.item.status]}`}
                              title={progress.item.status === "error" ? progress.item.error ?? "" : undefined}
                            >
                              {progress.item.status === "downloading"
                                ? `${Math.round(progress.item.progress)}%`
                                : statusLabel[progress.item.status]}
                            </span>
                          )}

                          {itemActive && !progress.job.finished && (
                            <button
                              data-tone="2"
                              onClick={() => handleCancelItem(progress.job.id, progress.idx)}
                              className={btnSmall}
                              title="Cancelar só este item"
                            >
                              <Icon name="x" />
                              Cancelar
                            </button>
                          )}

                          {!itemActive && (
                            <button
                              onClick={() => toggleCustom(p.url)}
                              aria-expanded={panelOpen}
                              title={panelOpen ? "Recolher as opções deste item" : "Personalizar este item (ações, formato, título e trecho)"}
                              data-tone="4"
                              className={`${btnSmall} keep-label ${itemCfg || isEdited(p) ? "border-accent text-accent" : ""}`}
                            >
                              <Icon name={panelOpen ? "chevronUp" : "chevronDown"} />
                              Personalizar
                            </button>
                          )}
                        </div>

                        {panelOpen && (
                          <div className="item-group basis-full">
                            <div className="item-group-actions flex flex-wrap items-center gap-2">
                              <button
                                data-tone="1"
                                onClick={() => handlePreviewAudio(p.url)}
                                className={`${btnSmall} keep-label`}
                                title="Ouvir 10 segundos antes de baixar"
                              >
                                <Icon name={previewing === p.url ? "stop" : "play"} />
                                Prévia
                              </button>
                              <button
                                onClick={() => handleDownloadOne(p)}
                                disabled={anyRunning}
                                data-tone="5"
                                className={`${btnSmall} keep-label`}
                                title={progress ? "Baixar este item de novo (usa as personalizações atuais)" : undefined}
                              >
                                <Icon name={progress ? "retry" : "download"} />
                                {progress ? "Baixar de novo" : "Baixar"}
                              </button>
                              {progress?.item.status === "done" && !progress.job.cfg.save_to_folder && (
                                <a
                                  href={`/api/jobs/${progress.job.id}/download/${progress.idx}`}
                                  data-tone="5"
                                  className={`${btnSmall} keep-label`}
                                >
                                  <Icon name="save" />
                                  Baixar arquivo
                                </a>
                              )}
                              {progress?.item.status === "done" &&
                                progress.job.cfg.save_to_folder &&
                                progress.item.filepath && (
                                  <button
                                    data-tone="1"
                                    onClick={() => revealFile(progress.item.filepath as string)}
                                    className={`${btnSmall} keep-label`}
                                    title="Mostrar o arquivo na pasta"
                                  >
                                    <Icon name="folderOpen" />
                                    Mostrar
                                  </button>
                                )}
                            </div>
                            <ItemOptions
                              cfg={itemCfg ?? globalItemConfig}
                              onChange={(next) => setOverride(p.url, next)}
                              onReset={() => clearOverride(p.url)}
                              duration={p.duration}
                              extras={extras[p.url] ?? emptyExtras}
                              onExtras={(next) =>
                                setExtras((cur) => ({ ...cur, [p.url]: next }))
                              }
                            />
                          </div>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>

          </section>
          </div>
        )}
        </div>
      </div>

      <HoverTips enabled={hoverTips} />

      {analyzing && (
        <AnalyzeModal
          theme={previewTheme ?? theme}
          done={analyzeProgress?.done ?? 0}
          total={analyzeProgress?.total ?? 0}
        />
      )}

      {historyOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4"
          onClick={() => setHistoryOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-title"
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-sm border border-line bg-panel p-5"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 id="history-title" className="text-lg font-medium">
                Histórico de downloads
              </h2>
              <div className="flex gap-2">
                <button
                  data-tone="2"
                  onClick={() => setHistory([])}
                  disabled={history.length === 0}
                  className={btnSmall}
                >
                  <Icon name="trash" />
                  Limpar
                </button>
                <button data-tone="1" onClick={() => setHistoryOpen(false)} className={btnSmall}>
                  <Icon name="x" />
                  Fechar
                </button>
              </div>
            </div>
            {history.length === 0 ? (
              <p className="text-sm text-dim">Nada baixado ainda.</p>
            ) : (
              <ul className="list-scroll divide-y divide-line overflow-y-auto border-y border-line">
                {history.map((h, i) => (
                  <li key={`${h.key}-${i}`} className="flex items-center gap-3 py-2 text-sm">
                    <PlatformIcon url={h.url} />
                    <span className="min-w-0 flex-1 truncate">{h.title ?? h.url}</span>
                    <span className="shrink-0 font-mono text-xs text-dim">
                      {new Date(h.when).toLocaleString([], {
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    {h.filepath && (
                      <button
                        data-tone="1"
                        onClick={() => revealFile(h.filepath as string)}
                        className={btnSmall}
                      >
                        <Icon name="folderOpen" />
                        Mostrar
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {pendingFile && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-ink/80 p-4"
          onClick={closeFileModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-modal-title"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-sm border border-line bg-panel p-6"
          >
            <h2 id="file-modal-title" className="text-lg font-medium">
              Analisar links?
            </h2>
            <p className="mt-2 text-sm text-dim">
              <span className="font-mono text-bone">{pendingFile.name}</span> tem{" "}
              {(pendingFile.text.match(/https?:\/\/\S+/g) ?? []).length} link(s).
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button data-tone="2" onClick={closeFileModal} className={btn}>
                Cancelar
              </button>
              <button autoFocus onClick={confirmFileModal} className={btnPrimary}>
                Analisar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
