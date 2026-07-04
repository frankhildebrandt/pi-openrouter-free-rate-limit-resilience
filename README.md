# pi-openrouter-free-rate-limit-resilience

Pi-Extension für stille, resiliente Retries bei OpenRouter-`*:free` Modellen.

## Installation

```bash
pi install https://github.com/frankhildebrandt/pi-openrouter-free-rate-limit-resilience
```

Oder lokal im Projekt:

```bash
pi install ./
```

## Was es macht

- erkennt OpenRouter-Free-Rate-Limits
- retryt bei Bedarf deutlich länger / unbegrenzt
- blendet die Retry-Noise aus
- zeigt nur einen kleinen Wartestatus an

## Hinweis

Die Extension greift intern tief in die Session-Verarbeitung ein. Nur verwenden, wenn du der Quelle vertraust.
