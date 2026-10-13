import collections
import glob
import importlib.util
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
# Empacotado (Electron): o app define onde guardar os arquivos, o ffmpeg e o
# frontend compilado por variáveis de ambiente. Em desenvolvimento, nada muda.
DOWNLOADS_DIR = Path(
    os.environ.get("ABE_DOWNLOADS_DIR")
    or Path.home() / "Downloads" / "abe_download_manager"
)
DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)

# Dados do app (yt-dlp atualizado pelo usuário, logs).
DATA_DIR = Path(
    os.environ.get("ABE_DATA_DIR") or Path.home() / ".abe_download_manager"
)
DATA_DIR.mkdir(parents=True, exist_ok=True)
YTDLP_OVERRIDE_DIR = DATA_DIR / "ytdlp"


def _load_ytdlp_override() -> bool:
    """Usa o yt-dlp baixado pelo próprio app (mais novo) no lugar do embutido."""
    pkg = YTDLP_OVERRIDE_DIR / "yt_dlp"
    init = pkg / "__init__.py"
    if not init.exists():
        return False
    spec = importlib.util.spec_from_file_location(
        "yt_dlp", init, submodule_search_locations=[str(pkg)]
    )
    if spec is None or spec.loader is None:
        return False
    module = importlib.util.module_from_spec(spec)
    sys.modules["yt_dlp"] = module
    try:
        spec.loader.exec_module(module)
    except Exception:  # noqa: BLE001
        for name in [n for n in sys.modules if n == "yt_dlp" or n.startswith("yt_dlp.")]:
            sys.modules.pop(name, None)
        return False
    return True


YTDLP_OVERRIDE_ACTIVE = _load_ytdlp_override()

import yt_dlp  # noqa: E402
from yt_dlp.utils import DownloadCancelled, download_range_func, sanitize_filename  # noqa: E402


def find_ffmpeg_location() -> str | None:
    """Locate ffmpeg even if the current process PATH hasn't been refreshed."""
    bundled = os.environ.get("ABE_FFMPEG_DIR")
    if bundled and (Path(bundled) / "ffmpeg.exe").exists():
        return bundled
    if shutil.which("ffmpeg"):
        return None
    pattern = os.path.expandvars(
        r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*-full_build\bin\ffmpeg.exe"
    )
    matches = glob.glob(pattern)
    if matches:
        return str(Path(matches[0]).parent)
    return None


FFMPEG_LOCATION = find_ffmpeg_location()

app = FastAPI(title="Abe download manager")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/files", StaticFiles(directory=DOWNLOADS_DIR), name="files")

ItemStatus = Literal["pending", "downloading", "done", "error"]

AudioFormat = Literal["mp3", "m4a", "wav", "flac", "opus", "original"]
AudioQuality = Literal["best", "320", "256", "192", "128"]
VideoFormat = Literal["mp4", "mkv", "webm"]
VideoQuality = Literal["best", "2160", "1440", "1080", "720", "480", "360"]
Mode = Literal["audio", "video"]
Browser = Literal["chrome", "edge", "firefox", "brave", "opera", "vivaldi"]
FilenameTemplate = Literal[
    "title",
    "artist_title",
    "title_artist",
    "numbered",
    "numbered_artist",
    "channel_title",
    "date_title",
    "title_year",
    "title_id",
]

URL_RE = re.compile(r"(https?://\S+)")

# ---------------------------------------------------------------- erros -----

ANSI_RE = re.compile(r"(?:\x1b)?\[[0-9;]*m")
RECENT_ERRORS: collections.deque = collections.deque(maxlen=200)

ERROR_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"claimed content|copyright|blocked it on|blocked due to", re.I),
     "Bloqueado por direitos autorais."),
    (re.compile(r"private video", re.I), "Vídeo privado."),
    (re.compile(r"confirm your age|age[- ]restrict|inappropriate for some", re.I),
     "Restrito por idade: faça login e use \"Cookies\" do navegador."),
    (re.compile(r"not a bot|sign in to confirm", re.I),
     "O YouTube pediu verificação: tente a opção \"Cookies\" do navegador."),
    (re.compile(r"logged[- ]in|login required|requires? (an )?account|--cookies|use --username", re.I),
     "Este link exige login: escolha o navegador em \"Cookies\"."),
    (re.compile(r"not available in your country|geo.?restrict|blocked in your country", re.I),
     "Indisponível no seu país."),
    (re.compile(r"video unavailable|this video is (not available|unavailable)|has been removed|no longer available", re.I),
     "Vídeo indisponível (removido ou bloqueado pela plataforma)."),
    (re.compile(r"requested format is not available", re.I),
     "Formato indisponível: tente outra qualidade ou atualize o motor."),
    (re.compile(r"unsupported url", re.I), "Link não suportado."),
    (re.compile(r"http error 404|not found", re.I), "Link não encontrado (404)."),
    (re.compile(r"http error 403|forbidden", re.I),
     "Acesso negado pelo site (403). Tente \"Cookies\" ou atualizar o motor."),
    (re.compile(r"http error 429|too many requests", re.I),
     "Muitas requisições: aguarde um pouco e tente de novo."),
    (re.compile(r"getaddrinfo|temporary failure|timed out|connection (reset|refused|aborted)|unable to download (webpage|json)|network is unreachable", re.I),
     "Sem conexão ou site fora do ar."),
    (re.compile(r"ffmpeg|ffprobe|postprocessing|conversion failed", re.I),
     "Falha na conversão (ffmpeg)."),
    (re.compile(r"cancelad", re.I), "Cancelado pelo usuário."),
]


def friendly_error(raw: object, url: str | None = None) -> str:
    """Remove códigos de cor e traduz os erros mais comuns do yt-dlp."""
    text = ANSI_RE.sub("", str(raw)).strip()
    first = text.splitlines()[0] if text else "Erro desconhecido."
    first = re.sub(r"^ERROR:\s*", "", first).strip()
    message = None
    for pattern, translated in ERROR_RULES:
        if pattern.search(text):
            message = translated
            break
    if message is None:
        message = re.sub(r"^\[[^\]]+\]\s*[\w-]+:\s*", "", first)[:220] or "Erro desconhecido."
    RECENT_ERRORS.append(
        {"t": time.strftime("%Y-%m-%d %H:%M:%S"), "url": url, "message": message, "raw": first[:400]}
    )
    return message


# ------------------------------------------------------------ resolução -----


def extract_urls(raw: str) -> list[str]:
    urls: list[str] = []
    for line in raw.splitlines():
        match = URL_RE.search(line)
        if match:
            urls.append(match.group(1).strip())
    return urls


class ResolvedItem(BaseModel):
    url: str
    title: str | None = None
    playlist_title: str | None = None
    thumbnail: str | None = None
    error: str | None = None
    # Chave canônica (id do vídeo ou URL sem parâmetros): detecta duplicados.
    key: str | None = None
    duration: float | None = None  # segundos (usado no seletor de trecho)


VIDEO_ID_RE = re.compile(r"(?:v=|youtu\.be/|shorts/)([A-Za-z0-9_-]{11})")


def canonical_key(url: str) -> str:
    m = VIDEO_ID_RE.search(url)
    if m and re.search(r"(youtube\.com|youtu\.be)", url, re.I):
        return f"yt:{m.group(1)}"
    return re.sub(r"[?#].*$", "", url).rstrip("/").lower()


SOCIAL_PREFIX_RE = re.compile(
    r"^\s*(?:[\d.,]+\s*[KMB]?\s+(?:views?|visualizações|reproduções)"
    r"(?:\s*[·•]\s*[\d.,]+\s*[KMB]?\s+(?:reactions?|reações|likes?|curtidas))?"
    r"|[\d.,]+\s*[KMB]?\s+(?:reactions?|reações))\s*\|\s*",
    re.I,
)


def clean_title(title: str | None) -> str | None:
    """Remove o prefixo "84K views · 250 reactions | " que Facebook/Instagram põem no título."""
    if not title:
        return title
    cleaned = SOCIAL_PREFIX_RE.sub("", title).strip()
    return cleaned or title


GENERIC_TITLE_RE = re.compile(
    r"^\s*(?:video by.*|vídeo de.*|tiktok video.*|reel by.*|post by.*|instagram.*)$", re.I
)


def best_title(info: dict) -> str | None:
    """Título legível: se o site só dá um título genérico, usa a legenda (descrição)."""
    title = clean_title(info.get("title"))
    desc = (info.get("description") or "").strip()
    if desc and (not title or GENERIC_TITLE_RE.match(title)):
        first = next((ln.strip() for ln in desc.splitlines() if ln.strip()), "")
        if first:
            first = re.sub(r"\s+", " ", first)
            return first[:140].rstrip()
    return title


def thumbnail_for_id(video_id: str | None) -> str | None:
    if not video_id:
        return None
    return f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg"


def impersonation_opts(url: str) -> dict:
    """TikTok e outros sites recusam clientes sem "cara" de navegador.

    Com curl_cffi instalado, o yt-dlp consegue se passar por um Chrome. O
    YouTube não precisa disso e continua usando o cliente padrão.
    """
    if re.search(r"(youtube\.com|youtu\.be)", url, re.I):
        return {}
    try:
        import curl_cffi  # noqa: F401
        from yt_dlp.networking.impersonate import ImpersonateTarget
    except ImportError:
        return {}
    return {"impersonate": ImpersonateTarget("chrome")}


def cookies_opts(browser: str | None) -> dict:
    """Usa os cookies de um navegador logado (Vimeo, Instagram privado etc.)."""
    return {"cookiesfrombrowser": (browser,)} if browser else {}


def _ffprobe_path() -> str | None:
    if FFMPEG_LOCATION and (Path(FFMPEG_LOCATION) / "ffprobe.exe").exists():
        return str(Path(FFMPEG_LOCATION) / "ffprobe.exe")
    return shutil.which("ffprobe")


def probe_duration(media_url: str | None, headers: dict | None = None) -> float | None:
    """Descobre a duração lendo o cabeçalho da mídia (sites que não informam)."""
    exe = _ffprobe_path()
    if not exe or not media_url:
        return None
    cmd = [exe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1"]
    if headers:
        hdr = "".join(f"{k}: {v}\r\n" for k, v in headers.items() if k.lower() in ("user-agent", "referer", "cookie"))
        if hdr:
            cmd += ["-headers", hdr]
    cmd.append(media_url)
    try:
        out = subprocess.run(
            cmd, capture_output=True, text=True, timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.strip()
        return float(out) if out else None
    except Exception:  # noqa: BLE001
        return None


def og_image(page_url: str) -> str | None:
    """Capa da página (og:image / twitter:image) para sites que não informam miniatura."""
    import html as _html

    try:
        req = urllib.request.Request(
            page_url,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"},
        )
        with urllib.request.urlopen(req, timeout=8) as r:
            head = r.read(300_000).decode("utf-8", "ignore")
    except Exception:  # noqa: BLE001
        return None
    for pattern in (
        r"""<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)""",
        r"""<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']""",
        r"""<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)""",
    ):
        m = re.search(pattern, head, re.I)
        if m:
            return _html.unescape(m.group(1))
    return None


def _is_youtube(url: str) -> bool:
    return bool(re.search(r"(youtube\.com|youtu\.be)", url, re.I))


def resolve_one(url: str, cookies_browser: str | None = None) -> list[ResolvedItem]:
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        **impersonation_opts(url),
        **cookies_opts(cookies_browser),
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001
        return [ResolvedItem(url=url, error=friendly_error(exc, url), key=canonical_key(url))]

    entries = info.get("entries")
    if entries:
        entries = list(entries)
        # Sites que não informam a duração na lista: reextrai por inteiro (só poucos itens).
        if (
            not _is_youtube(url)
            and len(entries) <= 3
            and any(e and not e.get("duration") for e in entries)
        ):
            try:
                full_opts = {k: v for k, v in ydl_opts.items() if k != "extract_flat"}
                with yt_dlp.YoutubeDL(full_opts) as ydl:
                    full = ydl.extract_info(url, download=False)
                full_entries = list(full.get("entries") or [])
                if len(full_entries) == len(entries):
                    entries = full_entries
            except Exception:  # noqa: BLE001
                pass
        items: list[ResolvedItem] = []
        yt_source = _is_youtube(url) or str(info.get("extractor_key", "")).lower().startswith("youtube")
        # "Playlist" de um item só (ex.: G1) não é uma playlist de verdade.
        real_playlist = yt_source or len([x for x in entries if x]) > 1
        for entry in entries:
            if not entry:
                continue
            video_id = entry.get("id")
            if yt_source and video_id:
                video_url = f"https://www.youtube.com/watch?v={video_id}"
            else:
                # Item único: usa a página original (a url interna do extrator, como "globo:ID", não serve para o usuário).
                video_url = url if not real_playlist else (entry.get("webpage_url") or entry.get("url"))
            if not video_url:
                continue
            thumb = (
                thumbnail_for_id(video_id)
                if yt_source
                else entry.get("thumbnail")
                or next((t.get("url") for t in reversed(entry.get("thumbnails") or []) if t.get("url")), None)
                or info.get("thumbnail")
            )
            if not thumb and not yt_source and not real_playlist:
                thumb = og_image(url)
            items.append(
                ResolvedItem(
                    url=video_url,
                    title=clean_title(entry.get("title")),
                    playlist_title=info.get("title") if real_playlist else None,
                    thumbnail=thumb,
                    key=canonical_key(video_url),
                    duration=entry.get("duration"),
                )
            )
        return items

    duration = info.get("duration")
    if not duration and not _is_youtube(url):
        media = info.get("url") or next(
            (f.get("url") for f in reversed(info.get("formats") or []) if f.get("url")), None
        )
        duration = probe_duration(media, info.get("http_headers"))

    webpage_url = info.get("webpage_url", url)
    match = VIDEO_ID_RE.search(webpage_url)
    thumbnail = info.get("thumbnail") or thumbnail_for_id(
        match.group(1) if match else None
    )
    if not info.get("thumbnail") and not _is_youtube(url):
        thumbnail = og_image(url) or thumbnail
    return [
        ResolvedItem(
            url=webpage_url,
            title=best_title(info),
            thumbnail=thumbnail,
            key=canonical_key(webpage_url),
            duration=duration,
        )
    ]


def resolve_urls(
    raw_urls: list[str], cookies_browser: str | None = None
) -> list[ResolvedItem]:
    results: list[ResolvedItem] = []
    with ThreadPoolExecutor(max_workers=6) as executor:
        for batch in executor.map(lambda u: resolve_one(u, cookies_browser), raw_urls):
            results.extend(batch)
    return results


class AnalyzeRequest(BaseModel):
    urls: str
    cookies_browser: Browser | None = None


class AnalyzeJob(BaseModel):
    id: str
    total: int
    done: int = 0
    items: list[ResolvedItem] = []
    finished: bool = False


analyze_jobs: dict[str, AnalyzeJob] = {}
analyze_lock = threading.Lock()


def run_analyze(job_id: str, raw_urls: list[str], cookies_browser: str | None = None):
    def resolve_and_count(url: str) -> list[ResolvedItem]:
        result = resolve_one(url, cookies_browser)
        with analyze_lock:
            analyze_jobs[job_id].done += 1
        return result

    results: list[ResolvedItem] = []
    with ThreadPoolExecutor(max_workers=6) as executor:
        for batch in executor.map(resolve_and_count, raw_urls):
            results.extend(batch)

    with analyze_lock:
        analyze_jobs[job_id].items = results
        analyze_jobs[job_id].finished = True


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest):
    raw = extract_urls(req.urls)
    if not raw:
        raise HTTPException(status_code=400, detail="Nenhuma URL válida encontrada.")

    job_id = str(uuid.uuid4())
    with analyze_lock:
        analyze_jobs[job_id] = AnalyzeJob(id=job_id, total=len(raw))

    thread = threading.Thread(
        target=run_analyze, args=(job_id, raw, req.cookies_browser), daemon=True
    )
    thread.start()

    return {"id": job_id, "total": len(raw)}


@app.get("/api/analyze/{job_id}", response_model=AnalyzeJob)
def get_analyze(job_id: str):
    with analyze_lock:
        job = analyze_jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Análise não encontrada.")
        return job


# ------------------------------------------------------ pastas / arquivos ----


class PickFolderResponse(BaseModel):
    path: str


@app.post("/api/pick-folder", response_model=PickFolderResponse)
def pick_folder():
    script = (
        "import tkinter as tk\n"
        "from tkinter import filedialog\n"
        "root = tk.Tk()\n"
        "root.withdraw()\n"
        "root.attributes('-topmost', True)\n"
        "print(filedialog.askdirectory() or '')\n"
    )
    # Empacotado: sys.executable é o próprio backend, então usa o PowerShell.
    if getattr(sys, "frozen", False):
        cmd = [
            "powershell",
            "-NoProfile",
            "-STA",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
            "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }",
        ]
    else:
        cmd = [sys.executable, "-c", script]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=180,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))

    path = result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ""
    if not path:
        raise HTTPException(status_code=400, detail="Nenhuma pasta selecionada.")
    return PickFolderResponse(path=path)


class OpenFolderRequest(BaseModel):
    path: str | None = None


@app.post("/api/open-folder")
def open_folder(req: OpenFolderRequest):
    target = Path(req.path) if req.path else DOWNLOADS_DIR
    target.mkdir(parents=True, exist_ok=True)
    try:
        os.startfile(str(target))  # noqa: S606 (Windows-only helper)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
    return {"ok": True}


class RevealRequest(BaseModel):
    path: str


@app.post("/api/reveal")
def reveal(req: RevealRequest):
    """Mostra o arquivo no Explorer (seleciona o arquivo); se sumiu, abre a pasta."""
    target = Path(os.path.normpath(req.path))
    folder = target.parent
    if not target.exists() and not folder.exists():
        raise HTTPException(status_code=404, detail="Arquivo e pasta não encontrados.")
    try:
        if target.exists():
            # O Explorer exige /select,"caminho" como UMA string; em lista o
            # Python coloca aspas no argumento todo e ele abre Documentos.
            subprocess.Popen(f'explorer /select,"{target}"')
        else:
            os.startfile(str(folder))  # noqa: S606
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
    return {"ok": True, "selected": target.exists()}


# ---------------------------------------------------------------- jobs ------


class DownloadItem(BaseModel):
    url: str
    title: str | None = None
    status: ItemStatus = "pending"
    progress: float = 0.0
    error: str | None = None
    filename: str | None = None
    filepath: str | None = None
    speed: float | None = None  # bytes/s
    eta: int | None = None  # segundos
    cancel_requested: bool = False
    playlist_title: str | None = None
    # Sobrescrevem a configuração global do job apenas para este item.
    mode: Mode | None = None
    audio_format: AudioFormat | None = None
    audio_quality: AudioQuality | None = None
    video_format: VideoFormat | None = None
    video_quality: VideoQuality | None = None
    meta_title: str | None = None
    meta_artist: str | None = None
    start: float | None = None
    end: float | None = None


class PreResolvedItem(BaseModel):
    url: str
    title: str | None = None
    playlist_title: str | None = None
    mode: Mode | None = None
    audio_format: AudioFormat | None = None
    audio_quality: AudioQuality | None = None
    video_format: VideoFormat | None = None
    video_quality: VideoQuality | None = None
    meta_title: str | None = None
    meta_artist: str | None = None
    start: float | None = None
    end: float | None = None


class CreateJobRequest(BaseModel):
    urls: str = ""
    items: list[PreResolvedItem] | None = None
    mode: Mode = "audio"
    audio_format: AudioFormat = "mp3"
    audio_quality: AudioQuality = "192"
    video_format: VideoFormat = "mp4"
    video_quality: VideoQuality = "best"
    output_dir: str | None = None
    # True: salva direto em output_dir. False: guarda em DOWNLOADS_DIR e o
    # usuário baixa o arquivo pelo navegador.
    save_to_folder: bool = True
    cookies_browser: Browser | None = None
    concurrency: int = 1
    filename_template: FilenameTemplate = "title"
    playlist_subfolder: bool = False
    separate_folders: bool = True  # áudio em /audio e vídeo em /video dentro do destino
    subtitles: bool = False
    normalize: bool = False
    rate_limit_kb: int | None = None


APP_FOLDER = "abe_download_manager"


def resolve_output_dir(cfg: CreateJobRequest) -> Path:
    """<local>/abe_download_manager/{audio|video}. Sem local: Downloads/abe_download_manager."""
    if cfg.save_to_folder and cfg.output_dir:
        base = Path(cfg.output_dir)
        # Sempre cria a pasta do app dentro do local escolhido (sem duplicar se já for ela).
        if base.name.lower() != APP_FOLDER:
            base = base / APP_FOLDER
    else:
        base = DOWNLOADS_DIR
    target = base / ("video" if cfg.mode == "video" else "audio") if cfg.separate_folders else base
    target.mkdir(parents=True, exist_ok=True)
    return target


class Job(BaseModel):
    id: str
    cfg: CreateJobRequest
    items: list[DownloadItem]
    finished: bool = False
    cancelled: bool = False


jobs: dict[str, Job] = {}
jobs_lock = threading.Lock()


def embed_thumbnail(opts: dict) -> None:
    # Converte a miniatura (geralmente webp) para jpg antes de embutir.
    opts["writethumbnail"] = True
    opts["postprocessors"].append(
        {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"}
    )
    opts["postprocessors"].append({"key": "EmbedThumbnail"})


def output_template(
    cfg: CreateJobRequest, position: int, playlist_title: str | None, plain: bool = False
) -> str:
    base = resolve_output_dir(cfg)
    if cfg.playlist_subfolder and playlist_title:
        base = base / sanitize_filename(playlist_title, restricted=False)
        base.mkdir(parents=True, exist_ok=True)
    templates = {
        "title": "%(title)s.%(ext)s",
        "artist_title": "%(artist,uploader)s - %(title)s.%(ext)s",
        "title_artist": "%(title)s - %(artist,uploader)s.%(ext)s",
        "numbered": f"{position:02d} - %(title)s.%(ext)s",
        "numbered_artist": f"{position:02d} - %(artist,uploader)s - %(title)s.%(ext)s",
        "channel_title": "%(channel,uploader)s - %(title)s.%(ext)s",
        "date_title": "%(upload_date>%Y-%m-%d)s - %(title)s.%(ext)s",
        "title_year": "%(title)s (%(upload_date>%Y)s).%(ext)s",
        "title_id": "%(title)s [%(id)s].%(ext)s",
    }
    # Título editado pelo usuário: o arquivo usa exatamente esse nome.
    name = templates["title"] if plain else templates.get(cfg.filename_template, templates["title"])
    return str(base / name)


def build_ydl_opts(
    cfg: CreateJobRequest,
    hook,
    with_thumbnail: bool = True,
    position: int = 1,
    playlist_title: str | None = None,
    plain_title: bool = False,
) -> tuple[dict, str | None]:
    opts: dict = {
        "outtmpl": output_template(cfg, position, playlist_title, plain_title),
        "noplaylist": True,
        "progress_hooks": [hook],
        "quiet": True,
        "no_warnings": True,
    }
    if FFMPEG_LOCATION:
        opts["ffmpeg_location"] = FFMPEG_LOCATION
    if cfg.rate_limit_kb:
        opts["ratelimit"] = cfg.rate_limit_kb * 1024
    if cfg.subtitles:
        opts.update(
            writesubtitles=True,
            writeautomaticsub=True,
            subtitleslangs=["pt", "pt-BR", "en"],
            subtitlesformat="srt/best",
        )

    if cfg.mode == "audio":
        opts["format"] = "bestaudio/best"
        if cfg.audio_format == "original":
            return opts, None
        quality = "0" if cfg.audio_quality == "best" else cfg.audio_quality
        opts["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": cfg.audio_format,
                "preferredquality": quality,
            },
            {"key": "FFmpegMetadata", "add_metadata": True},
        ]
        if cfg.normalize:
            opts["postprocessor_args"] = {
                "ffmpegextractaudio": ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"]
            }
        if cfg.audio_format in ("mp3", "m4a", "flac", "opus"):
            if with_thumbnail:
                embed_thumbnail(opts)
        return opts, cfg.audio_format

    height = None if cfg.video_quality == "best" else cfg.video_quality
    if height:
        opts["format"] = (
            f"bestvideo[height<={height}]+bestaudio/best[height<={height}]"
            f"/best[height<={height}]"
        )
    else:
        opts["format"] = "bestvideo+bestaudio/best"
    opts["merge_output_format"] = cfg.video_format
    opts["postprocessors"] = [{"key": "FFmpegMetadata", "add_metadata": True}]
    # webm não suporta capa embutida.
    if with_thumbnail and cfg.video_format in ("mp4", "mkv"):
        embed_thumbnail(opts)
    return opts, cfg.video_format


def download_one_item(job_id: str, index: int, cfg: CreateJobRequest):
    with jobs_lock:
        current_job = jobs[job_id]
        item = current_job.items[index]
        if current_job.cancelled or item.cancel_requested:
            if item.status == "pending":
                item.status = "error"
                item.error = "Cancelado pelo usuário."
            return
        item.status = "downloading"
        url = item.url
        playlist_title = item.playlist_title
        meta_title, meta_artist = item.meta_title, item.meta_artist
        start, end = item.start, item.end
        overrides = item.model_dump(
            include={"mode", "audio_format", "audio_quality", "video_format", "video_quality"},
            exclude_none=True,
        )
        if overrides:
            cfg = cfg.model_copy(update=overrides)

    def hook(d):
        with jobs_lock:
            job = jobs[job_id]
            current = job.items[index]
            if job.cancelled or current.cancel_requested:
                raise DownloadCancelled("Cancelado pelo usuário.")
            if d["status"] == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                downloaded = d.get("downloaded_bytes", 0)
                if total:
                    current.progress = round(downloaded / total * 100, 1)
                current.speed = d.get("speed")
                eta = d.get("eta")
                current.eta = int(eta) if eta is not None else None
            elif d["status"] == "finished":
                current.progress = 100.0
                current.speed = None
                current.eta = None

    def run(with_thumbnail: bool):
        ydl_opts, expected_ext = build_ydl_opts(
            cfg,
            hook,
            with_thumbnail,
            position=index + 1,
            playlist_title=playlist_title,
            plain_title=bool(meta_title),
        )
        ydl_opts.update(impersonation_opts(url))
        ydl_opts.update(cookies_opts(cfg.cookies_browser))
        if start is not None or end is not None:
            ydl_opts["download_ranges"] = download_range_func(
                [], [(start or 0, end if end is not None else float("inf"))]
            )
            ydl_opts["force_keyframes_at_cuts"] = True
        out_dir = Path(ydl_opts["outtmpl"]).parent
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            social = re.search(r"(facebook\.com|fb\.watch|instagram\.com)", url, re.I)
            if meta_title or meta_artist or social:
                # Edita título/artista antes do download para valer no nome e nas tags.
                info = ydl.extract_info(url, download=False)
                info["title"] = best_title(info)
                if meta_title:
                    info["title"] = meta_title
                if meta_artist:
                    info["artist"] = meta_artist
                info = ydl.process_ie_result(info, download=True)
            else:
                info = ydl.extract_info(url, download=True)
        title = info.get("title", url)
        ext = expected_ext or info.get("ext", "m4a")
        filepath = None
        downloads = info.get("requested_downloads") or []
        if not downloads:
            # Sites que devolvem uma "playlist" de 1 item (ex.: G1): o arquivo está na entrada.
            for entry in info.get("entries") or []:
                if entry and entry.get("requested_downloads"):
                    downloads = entry["requested_downloads"]
                    title = entry.get("title") or title
                    break
        if downloads:
            filepath = downloads[0].get("filepath")
        if not filepath:
            filepath = str(out_dir / f"{sanitize_filename(title, restricted=False)}.{ext}")
        # O pós-processamento pode trocar a extensão (ex.: .webm -> .mp3).
        if expected_ext and not filepath.lower().endswith("." + expected_ext):
            candidate = Path(filepath).with_suffix("." + expected_ext)
            if candidate.exists():
                filepath = str(candidate)
        return title, filepath

    try:
        try:
            title, filepath = run(with_thumbnail=True)
        except DownloadCancelled:
            raise
        except Exception as exc:  # noqa: BLE001
            # Algumas miniaturas não podem ser embutidas (ex.: Pexels). Nesse
            # caso baixa de novo sem a capa em vez de falhar o item inteiro.
            msg = str(exc).lower()
            if "embed" not in msg and "postprocessing" not in msg:
                raise
            title, filepath = run(with_thumbnail=False)
        with jobs_lock:
            current = jobs[job_id].items[index]
            current.title = title
            current.status = "done"
            current.progress = 100.0
            current.filepath = filepath
            current.filename = Path(filepath).name
            current.speed = None
            current.eta = None
    except Exception as exc:  # noqa: BLE001
        with jobs_lock:
            current = jobs[job_id].items[index]
            current.status = "error"
            current.speed = None
            current.eta = None
        current.error = friendly_error(exc, url)


def run_job(job_id: str):
    with jobs_lock:
        job = jobs[job_id]
        cfg = job.cfg
        total_items = len(job.items)

    max_workers = max(1, min(cfg.concurrency, 10))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [
            executor.submit(download_one_item, job_id, index, cfg)
            for index in range(total_items)
        ]
        for future in futures:
            future.result()

    with jobs_lock:
        jobs[job_id].finished = True


@app.post("/api/jobs")
def create_job(req: CreateJobRequest):
    if req.items:
        # Already resolved by /api/analyze (or a single known item) — avoid
        # re-running yt_dlp extraction, which can trip YouTube rate limits.
        job_items = [DownloadItem(**i.model_dump()) for i in req.items]
    else:
        raw = extract_urls(req.urls)
        if not raw:
            raise HTTPException(status_code=400, detail="Nenhuma URL válida encontrada.")

        resolved = resolve_urls(raw, req.cookies_browser)
        valid = [r for r in resolved if not r.error]
        if not valid:
            raise HTTPException(
                status_code=400,
                detail="Nenhum vídeo válido encontrado nos links informados.",
            )
        job_items = [
            DownloadItem(url=r.url, title=r.title, playlist_title=r.playlist_title)
            for r in valid
        ]

    job_id = str(uuid.uuid4())
    job = Job(
        id=job_id,
        cfg=req,
        items=job_items,
    )
    with jobs_lock:
        jobs[job_id] = job

    thread = threading.Thread(target=run_job, args=(job_id,), daemon=True)
    thread.start()

    return job


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job não encontrado.")
        job.cancelled = True
        return job


@app.post("/api/jobs/{job_id}/cancel/{index}")
def cancel_item(job_id: str, index: int):
    """Cancela só um item (em andamento ou ainda na fila)."""
    with jobs_lock:
        job = jobs.get(job_id)
        if not job or index < 0 or index >= len(job.items):
            raise HTTPException(status_code=404, detail="Item não encontrado.")
        item = job.items[index]
        item.cancel_requested = True
        if item.status == "pending":
            item.status = "error"
            item.error = "Cancelado pelo usuário."
        return job


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job não encontrado.")
        return job


@app.get("/api/jobs/{job_id}/download/{index}")
def download_item(job_id: str, index: int):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job não encontrado.")
        if index < 0 or index >= len(job.items):
            raise HTTPException(status_code=404, detail="Item não encontrado.")
        item = job.items[index]
        if item.status != "done" or not item.filename:
            raise HTTPException(status_code=400, detail="Arquivo ainda não está pronto.")
        filename = item.filename
        filepath = item.filepath

    file_path = Path(filepath) if filepath else resolve_output_dir(job.cfg) / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Arquivo não encontrado no disco.")
    return FileResponse(file_path, filename=filename, media_type="application/octet-stream")


# ------------------------------------------------- pré-visualização --------


@app.get("/api/preview-url")
def preview_url(url: str, cookies_browser: Browser | None = None):
    """Devolve o endereço direto do áudio, para ouvir um trecho antes de baixar."""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "format": "bestaudio/best",
        "noplaylist": True,
        **impersonation_opts(url),
        **cookies_opts(cookies_browser),
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=friendly_error(exc, url))
    direct = info.get("url")
    if not direct:
        raise HTTPException(status_code=400, detail="Sem prévia disponível para este item.")
    return {"url": direct, "title": info.get("title"), "duration": info.get("duration")}


# ------------------------------------------------- motor (yt-dlp) ----------


def _current_ytdlp_version() -> str:
    try:
        from yt_dlp.version import __version__

        return __version__
    except Exception:  # noqa: BLE001
        return "desconhecida"


def _latest_ytdlp() -> dict | None:
    try:
        with urllib.request.urlopen("https://pypi.org/pypi/yt-dlp/json", timeout=10) as r:
            data = json.load(r)
    except Exception:  # noqa: BLE001
        return None
    wheel = next(
        (u for u in data.get("urls", []) if u.get("packagetype") == "bdist_wheel"), None
    )
    return {"version": data["info"]["version"], "wheel_url": wheel["url"] if wheel else None}


@app.get("/api/ytdlp")
def ytdlp_info():
    latest = _latest_ytdlp()
    current = _current_ytdlp_version()

    def parse(v: str) -> tuple:
        return tuple(int(x) for x in re.findall(r"\d+", v))

    newer = bool(latest and parse(latest["version"]) > parse(current))
    return {
        "current": current,
        "latest": latest["version"] if latest else None,
        "update_available": newer,
        "override_active": YTDLP_OVERRIDE_ACTIVE,
    }


@app.post("/api/ytdlp/update")
def ytdlp_update():
    latest = _latest_ytdlp()
    if not latest or not latest.get("wheel_url"):
        raise HTTPException(status_code=502, detail="Não foi possível consultar a versão mais nova.")
    tmp = DATA_DIR / "yt_dlp_update.whl"
    try:
        urllib.request.urlretrieve(latest["wheel_url"], tmp)
        target = YTDLP_OVERRIDE_DIR
        staging = DATA_DIR / "ytdlp_staging"
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True)
        with zipfile.ZipFile(tmp) as zf:
            members = [m for m in zf.namelist() if m.startswith("yt_dlp/")]
            if not members:
                raise RuntimeError("Pacote inválido.")
            zf.extractall(staging, members)
        if target.exists():
            shutil.rmtree(target)
        shutil.move(str(staging), str(target))
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Falha ao atualizar: {exc}")
    finally:
        tmp.unlink(missing_ok=True)
    return {"updated_to": latest["version"], "restart_required": True}


@app.get("/api/diagnostics", response_class=PlainTextResponse)
def diagnostics():
    lines = [
        "Abe download manager - diagnóstico",
        f"Gerado em: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"Sistema: {platform.platform()}",
        f"Python: {sys.version.split()[0]}",
        f"yt-dlp: {_current_ytdlp_version()} (atualizado pelo app: {YTDLP_OVERRIDE_ACTIVE})",
        f"ffmpeg: {FFMPEG_LOCATION or shutil.which('ffmpeg') or 'não encontrado'}",
        f"Pasta de downloads: {DOWNLOADS_DIR}",
        f"Dados do app: {DATA_DIR}",
        "",
        "Erros recentes:",
    ]
    if not RECENT_ERRORS:
        lines.append("  (nenhum)")
    for e in list(RECENT_ERRORS)[-50:]:
        lines.append(f"  [{e['t']}] {e['message']}")
        if e.get("url"):
            lines.append(f"      url: {e['url']}")
        lines.append(f"      original: {e['raw']}")
    return "\n".join(lines)


# Frontend compilado (modo empacotado). Montado por último para não encobrir
# as rotas /api e /files.
STATIC_DIR = os.environ.get("ABE_STATIC_DIR")
if STATIC_DIR and Path(STATIC_DIR).is_dir():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.environ.get("ABE_PORT", "8000")),
        log_level="warning",
    )
