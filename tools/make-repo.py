#!/usr/bin/env python3
"""Генерирует plugins-v1.json для репозитория плагинов Movian.

Использование: tools/make-repo.py owner/repo > plugins-v1.json
Адреса: архив плагина — из GitHub Release с тегом v<версия>, иконка — с GitHub Pages репозитория.
"""
import json, re, sys

repo = sys.argv[1] if len(sys.argv) > 1 else "analogman-hub/movian-kinopub"
p = json.load(open("plugin.json", encoding="utf-8"))
readme = open("README.md", encoding="utf-8").read()

# Описание: первый абзац README без ссылок в markdown
intro = readme.split("\n\n")[1]
intro = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", intro).replace("\n", " ").strip()

entry = {
    "id": p["id"],
    "version": p["version"],
    "type": p["type"],
    "author": "Konstantin (analogman-hub)",
    "showtimeVersion": "5.0.0",
    "title": p.get("title", "Kinopub"),
    "synopsis": p.get("synopsis", ""),
    "description": intro,
    "homepage": f"https://github.com/{repo}",
    "category": "video",
    "downloadURL": f"https://github.com/{repo}/releases/download/v{p['version']}/kinopub.zip",
    "icon": f"https://{repo.split('/')[0]}.github.io/{repo.split('/')[1]}/icon.png",
    "control": {"uriprefixes": ["kinopub:"]},
}
print(json.dumps({"version": 1, "plugins": [entry]}, ensure_ascii=False, indent=2))
