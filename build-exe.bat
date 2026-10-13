@echo off
setlocal
set ROOT=%~dp0

echo [1/4] Frontend (vite build)
cd /d "%ROOT%frontend" || exit /b 1
call npm install --no-audit --no-fund || exit /b 1
call npm run build || exit /b 1

echo [2/4] Backend (PyInstaller)
cd /d "%ROOT%backend" || exit /b 1
call .venv\Scripts\activate || exit /b 1
pip install -r requirements.txt pyinstaller || exit /b 1
pyinstaller --noconfirm --clean abe-backend.spec || exit /b 1

echo [3/4] ffmpeg
if not exist "%ROOT%electron\ffmpeg\ffmpeg.exe" (
  echo Copie ffmpeg.exe e ffprobe.exe para electron\ffmpeg\ antes de continuar.
  exit /b 1
)

echo [4/4] Electron (instalador)
cd /d "%ROOT%electron" || exit /b 1
call npm install --no-audit --no-fund || exit /b 1
call npm run dist || exit /b 1

echo.
echo Pronto: electron\dist\Abe download manager Setup 1.0.0.exe
endlocal
