UUID    = media-controller@naimur
SRC     = src
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ZIP     = $(UUID).shell-extension.zip

# Virtualenv for the shexli analyzer: outside git, reused since it hits the network.
SHEXLI_VENV = .shexli-venv
SOURCES = $(SRC)/extension.js $(SRC)/prefs.js $(SRC)/mpris.js $(SRC)/mediaCard.js \
          $(SRC)/artCache.js $(SRC)/backdrop.js $(SRC)/playerIcons.js $(SRC)/scrollingLabel.js \
          $(SRC)/transport.js $(SRC)/paths.js $(SRC)/equalizer.js \
          $(SRC)/compat.js $(SRC)/lyrics.js $(SRC)/lyricsPanel.js \
          $(SRC)/cardList.js $(SRC)/playerList.js $(SRC)/outputList.js \
          $(SRC)/soundOutputs.js \
          $(SRC)/updateNotice.js \
          $(SRC)/icons/lyrics-symbolic.svg \
          $(SRC)/metadata.json $(SRC)/stylesheet.css

.PHONY: all schemas install uninstall enable disable pack check shexli clean-shexli logs prefs clean

all: schemas

# Compiles schemas in place so `make check` and `make pack` see gschemas.compiled.
schemas: $(SRC)/schemas/gschemas.compiled

$(SRC)/schemas/gschemas.compiled: $(SRC)/schemas/*.gschema.xml
	glib-compile-schemas --strict $(SRC)/schemas/

install: schemas
	rm -rf $(INSTALL_DIR)
	mkdir -p $(INSTALL_DIR)
	cp -r $(SRC)/. $(INSTALL_DIR)/
	@echo "Installed to $(INSTALL_DIR)"
	@echo "Now log out and back in (Wayland), then: make enable"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf $(INSTALL_DIR)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

# Syntax-checks every module without a running shell.
check:
	@for f in $(SRC)/*.js; do \
		node --input-type=module --check < "$$f" >/dev/null 2>&1 && echo "ok   $$f" || { echo "FAIL $$f"; node --input-type=module --check < "$$f"; exit 1; }; \
	done
	@glib-compile-schemas --strict --dry-run $(SRC)/schemas/ && echo "ok   schemas"
	@python3 -c "import json;json.load(open('$(SRC)/metadata.json'))" && echo "ok   metadata.json"

# EGO review checks, run against a freshly packed zip (the actual upload).
shexli: pack | $(SHEXLI_VENV)/.installed
	@$(SHEXLI_VENV)/bin/shexli "$(CURDIR)/$(ZIP)"

# tree-sitter 0.26 segfaults with shexli's 0.25 JavaScript grammar. The sentinel
# is written only on success, so a failed install is retried.
$(SHEXLI_VENV)/.installed:
	python3 -m venv $(SHEXLI_VENV)
	$(SHEXLI_VENV)/bin/pip install --upgrade pip
	$(SHEXLI_VENV)/bin/pip install --upgrade shexli 'tree-sitter<0.26'
	@touch $@
	@echo "shexli environment ready in $(SHEXLI_VENV)"

clean-shexli:
	rm -rf $(SHEXLI_VENV)

pack: schemas
	rm -f $(ZIP)
	gnome-extensions pack $(SRC) \
		--extra-source=mpris.js \
		--extra-source=mediaCard.js \
		--extra-source=artCache.js \
		--extra-source=backdrop.js \
		--extra-source=playerIcons.js \
		--extra-source=scrollingLabel.js \
		--extra-source=transport.js \
		--extra-source=paths.js \
		--extra-source=equalizer.js \
		--extra-source=compat.js \
		--extra-source=lyrics.js \
		--extra-source=lyricsPanel.js \
		--extra-source=cardList.js \
		--extra-source=playerList.js \
		--extra-source=outputList.js \
		--extra-source=soundOutputs.js \
		--extra-source=updateNotice.js \
		--extra-source=icons \
		"--extra-source=$(CURDIR)/LICENSE" \
		--schema=schemas/org.gnome.shell.extensions.media-controller.gschema.xml \
		--force
	cd $(SRC) && zip -q -u "$(CURDIR)/$(ZIP)" schemas/gschemas.compiled

# Live extension logs. Ctrl-C to stop.
logs:
	journalctl -f -o cat /usr/bin/gnome-shell | grep -i --line-buffered "media-controls\|MediaControls"

clean:
	rm -f $(SRC)/schemas/gschemas.compiled $(ZIP)
