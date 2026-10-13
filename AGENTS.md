# page_yt_extractor

Aplicativo local "Abe download manager" para baixar áudio/vídeo do YouTube (e outras plataformas suportadas) usando `yt-dlp`. Logo em `frontend/public/abe.png`.

## Objetivo
Colar links do YouTube (ou subir um `.txt`) e baixar o áudio (mp3/m4a/wav) de cada um.

## Stack
- Backend: Python + FastAPI + yt-dlp (`backend/`)
- Frontend: React + TypeScript + Vite + Tailwind CSS v4 (`frontend/`)

## Portas locais
- Backend: `http://127.0.0.1:8000`
- Frontend (Vite dev): `http://127.0.0.1:5173` (proxy `/api` e `/files` para o backend)

## Arquitetura
- `backend/main.py`: API FastAPI.
  - `POST /api/jobs` — recebe `{ urls: string, audio_format: "mp3"|"m4a"|"wav" }`, extrai URLs do texto, cria um job em background (thread) que baixa cada item via yt-dlp.
  - `GET /api/jobs/{id}` — status/progresso do job (polling do frontend a cada 1s).
  - `GET /api/jobs/{id}/download/{index}` — baixa o arquivo já processado.
  - Arquivos baixados ficam em `backend/downloads/`.
- `frontend/src/App.tsx`: UI única (textarea de links, upload de `.txt`, seletor de formato, lista de progresso com download individual).

## Dependência externa obrigatória
- `ffmpeg` precisa estar instalado e no PATH (usado pelo yt-dlp para extrair/converter áudio).

## Observações importantes
- `yt-dlp` precisa ser mantido atualizado (`pip install -U yt-dlp` dentro do venv). O YouTube muda o serviço de formatos com frequência e versões antigas passam a falhar com "Requested format is not available".
- Um aviso sobre "no supported JavaScript runtime" pode aparecer nos logs; não impede o funcionamento, mas instalar um runtime como `deno` reduz o risco de formatos ausentes no futuro.

## Como rodar
Backend:
```
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

Frontend:
```
cd frontend
npm install
npm run dev
```

## Empacotamento (exe com Electron)
- `electron/`: shell Electron (`main.js`, `preload.js`). Sobe o backend numa porta livre, espera responder e abre `http://127.0.0.1:<porta>`; ao fechar, encerra o backend e o ffmpeg.
- Backend vira `backend/dist/abe-backend/abe-backend.exe` via PyInstaller (`backend/abe-backend.spec`). Variáveis de ambiente lidas por `main.py`: `ABE_PORT`, `ABE_DOWNLOADS_DIR`, `ABE_STATIC_DIR` (frontend compilado servido em `/`), `ABE_FFMPEG_DIR`.
- `electron/ffmpeg/` guarda `ffmpeg.exe` e `ffprobe.exe` (build "essentials" do gyan.dev; não versionar). Ambos são obrigatórios para conversão e capa.
- Build completo: `build-exe.bat` → `electron/dist/Abe download manager Setup 1.0.0.exe` (instalador NSIS) e `electron/dist/Abe download manager (portatil).exe` (portátil, sem instalar; descompacta em temp a cada abertura, ~15 s). Log do último build em `build.log`.
- Downloads sem pasta escolhida vão para `Downloads/abe_download_manager/{audio,video}` (pasta Downloads do usuário; subpasta por tipo controlada por `separate_folders` (padrão ligado); local escolhido pelo usuário também recebe `abe_download_manager/{audio,video}`; se o local já se chama abe_download_manager não duplica).
- `curl_cffi` é obrigatório no backend: TikTok e outros sites só respondem com impersonação de navegador.
- Rodar o Electron a partir de um processo com `ELECTRON_RUN_AS_NODE=1` (ex.: terminal de algumas ferramentas) faz o exe sair na hora; remova a variável.

## Recursos adicionais (backend/main.py e App.tsx)
- Erros do yt-dlp passam por `friendly_error` (sem códigos ANSI, traduzidos); últimos erros ficam em `/api/diagnostics`.
- Motor atualizável pelo app: `/api/ytdlp` (versão atual/mais nova) e `/api/ytdlp/update` extraem o wheel do PyPI em `ABE_DATA_DIR/ytdlp` (padrão `~/.abe_download_manager`); `main.py` carrega esse pacote no lugar do embutido. Reiniciar o app (Electron `restart`) aplica.
- Opções no job: `filename_template` (title | artist_title | numbered), `playlist_subfolder`, `subtitles`, `normalize` (loudnorm), `rate_limit_kb`. Por item: `meta_title`, `meta_artist`, `start`, `end`, `playlist_title`.
- Cancelar por item: `POST /api/jobs/{id}/cancel/{index}`; mostrar arquivo no Explorer: `POST /api/reveal`; prévia de áudio: `GET /api/preview-url`.
- Frontend: sessão (lista/seleção/personalizações) e histórico em localStorage (`ytme_session`, `ytme_history`); duplicados por chave canônica (`key`); atalhos: Ctrl+V fora de campos, arrastar e soltar, Ctrl+Enter na caixa.
- Layout em 2 colunas só em telas largas (`min-width:1200px` e `min-aspect-ratio:16/10`), tudo em 100dvh; abaixo disso, empilhado.
- Temas: 27, definidos por tokens em `index.css` (`--color-*`, `--color-field`, `--btn-bg`/`--tone-N`, `--info-bg/fg`); botão de cada tema em `frontend/public/themes/<id>.png` (148x88).
- Electron: fechar a janela minimiza para a bandeja; "Sair" no menu da bandeja encerra o app e o backend.
- `backend/smoke_test.py`: teste rápido da API (analisa links de várias plataformas).

## Estado atual
- Fluxo completo implementado: colar/upload de links -> download em background -> progresso por item -> download do arquivo pronto.
- Sem persistência entre reinicializações do backend (jobs ficam em memória).
- Sem autenticação (uso local).
