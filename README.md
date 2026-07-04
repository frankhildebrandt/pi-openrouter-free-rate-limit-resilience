# pi-openrouter-free-rate-limit-resilience

![pi extension](https://img.shields.io/badge/pi-extension-blue)
![pi package](https://img.shields.io/badge/pi-package-blueviolet)

A pi.dev / pi coding agent extension for quiet, resilient retries with OpenRouter `*:free` models.

This repository is an installable pi package. Its `package.json` declares the extension under the `pi.extensions` manifest key.

## Installation

```bash
pi install https://github.com/frankhildebrandt/pi-openrouter-free-rate-limit-resilience
```

Or install it from a local checkout:

```bash
pi install ./
```

## What it does

- detects OpenRouter free-model rate limits
- retries much longer / indefinitely when needed
- hides retry noise from the transcript and UI
- shows only a small waiting status

## Warning

This extension patches pi's internal session handling. Only install it from sources you trust.
