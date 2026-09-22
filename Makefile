# Сборка:
#   kinopub.zip                    — сам плагин (plugin.json и main.js в корне архива, как требует Movian)
#   movian-kinopub-<версия>.zip    — архив для распространения: kinopub.zip + инструкция по установке
VERSION := $(shell sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' plugin.json)
DIST := movian-kinopub-$(VERSION).zip

all: $(DIST)

kinopub.zip: plugin.json main.js
	rm -f $@
	zip -q $@ plugin.json main.js

$(DIST): kinopub.zip INSTALL.txt
	rm -f movian-kinopub-*.zip
	zip -q $@ kinopub.zip INSTALL.txt
	@echo "-> $@"

tlscheck.zip: tools/tlscheck/plugin.json tools/tlscheck/main.js
	cd tools/tlscheck && zip -q ../../$@ plugin.json main.js

check:
	node -e "new Function(require('fs').readFileSync('main.js','utf8'))" && echo "main.js: syntax ok"
	node -e "new Function(require('fs').readFileSync('tools/tlscheck/main.js','utf8'))" && echo "tlscheck: syntax ok"

clean:
	rm -f kinopub.zip movian-kinopub-*.zip tlscheck.zip

.PHONY: all check clean
