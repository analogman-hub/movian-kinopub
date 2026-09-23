# Сборка:
#   dist/kinopub.zip               — сам плагин (plugin.json, main.js, icon.png в корне архива). Лежит в git:
#                                    на него ссылается plugins-v1.json, workflow обновляет его при релизе.
#   movian-kinopub-<версия>.zip    — архив для людей: kinopub.zip + инструкция. Публикуется в релизе.
#   plugins-v1.json                — описание для репозитория плагинов Movian (make repo REPO=owner/name)
VERSION := $(shell sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' plugin.json)
DIST := movian-kinopub-$(VERSION).zip
GUIDE := Инструкция по установке.txt
REPO ?= mranalogman/movian-kinopub

all: $(DIST)

dist/kinopub.zip: plugin.json main.js icon.png
	mkdir -p dist
	rm -f $@
	zip -q $@ plugin.json main.js icon.png

$(DIST): dist/kinopub.zip
	rm -f movian-kinopub-*.zip
	zip -q -j $@ dist/kinopub.zip "$(GUIDE)"
	@echo "-> $@"

repo: plugins-v1.json

plugins-v1.json: plugin.json tools/make-repo.py README.md
	python3 tools/make-repo.py $(REPO) > $@
	@echo "-> $@"

tlscheck.zip: tools/tlscheck/plugin.json tools/tlscheck/main.js
	cd tools/tlscheck && zip -q ../../$@ plugin.json main.js

check:
	node -e "new Function(require('fs').readFileSync('main.js','utf8'))" && echo "main.js: syntax ok"
	node -e "new Function(require('fs').readFileSync('tools/tlscheck/main.js','utf8'))" && echo "tlscheck: syntax ok"
	python3 -c "import json;json.load(open('plugin.json'))" && echo "plugin.json: ok"

clean:
	rm -f movian-kinopub-*.zip tlscheck.zip

.PHONY: all repo check clean
