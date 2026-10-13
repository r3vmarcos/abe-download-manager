@echo off
setlocal

set ROOT=%~dp0

start "Backend - FastAPI" cmd /k "cd /d "%ROOT%backend" && call .venv\Scripts\activate && uvicorn main:app --reload"

start "Frontend - Vite" cmd /k "cd /d "%ROOT%frontend" && npm run dev"

echo.
echo Backend:  http://127.0.0.1:8000
echo Frontend: http://127.0.0.1:5173
echo.
endlocal
