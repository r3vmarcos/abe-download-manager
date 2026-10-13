# PyInstaller: gera backend/dist/abe-backend/abe-backend.exe (modo onedir).
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas, binaries, hiddenimports = [], [], []
for pkg in ("yt_dlp", "curl_cffi", "mutagen", "certifi", "Cryptodome"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h
hiddenimports += collect_submodules("uvicorn") + collect_submodules("websockets")
hiddenimports += ["multipart", "python_multipart"]

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "numpy", "PIL"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="abe-backend",
    console=True,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="abe-backend", upx=False)
