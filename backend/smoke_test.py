"""Teste de fumaça da API (sem interface).

Uso (com o backend rodando em ABE_PORT, padrão 8000):
    python smoke_test.py [porta]

Analisa e baixa um trecho de cada plataforma, para ver rapidamente se algo quebrou
depois de atualizar o yt-dlp ou o app.
"""
import json
import sys
import time
import urllib.request

PORT = sys.argv[1] if len(sys.argv) > 1 else "8000"
BASE = f"http://127.0.0.1:{PORT}"

LINKS = {
    "YouTube": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "SoundCloud": "https://soundcloud.com/forss/flickermood",
    "Streamable": "https://streamable.com/moo",
    "Internet Archive": "https://archive.org/details/Popeye_forPresident",
    "Vídeo bloqueado (esperado: erro)": "https://www.youtube.com/watch?v=_fbkHtBH0xY",
}


def call(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, headers={"Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    analysis = call("/api/analyze", {"urls": "\n".join(LINKS.values())})
    while True:
        state = call(f"/api/analyze/{analysis['id']}")
        if state["finished"]:
            break
        time.sleep(0.5)
    for item in state["items"]:
        status = f"ERRO: {item['error']}" if item["error"] else "ok"
        print(f"- {item['url']}\n    {status}")


if __name__ == "__main__":
    main()
