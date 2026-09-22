# Сборка архивов плагинов для Movian: plugin.json должен лежать в корне zip.
VERSION := $(shell sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' plugin.json)

all: kinopub-$(VERSION).zip

kinopub-$(VERSION).zip: plugin.json main.js
	rm -f kinopub-*.zip
	zip -q $@ plugin.json main.js
	@echo "-> $@"

tlscheck.zip: tools/tlscheck/plugin.json tools/tlscheck/main.js
	cd tools/tlscheck && zip -q ../../$@ plugin.json main.js

check:
	node -e "new Function(require('fs').readFileSync('main.js','utf8'))" && echo "main.js: syntax ok"
	node -e "new Function(require('fs').readFileSync('tools/tlscheck/main.js','utf8'))" && echo "tlscheck: syntax ok"

clean:
	rm -f kinopub-*.zip tlscheck.zip

.PHONY: all check clean
