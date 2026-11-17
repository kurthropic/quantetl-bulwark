#!/bin/sh
# Puts the `bulwark` command on your PATH by linking it from this folder. Nothing is downloaded.
#   ./scripts/install-bulwark.sh            -> ~/.local/bin/bulwark (or /usr/local/bin if you can write there)
set -eu
cd "$(dirname "$0")/.."
SRC="$(pwd)/bin/bulwark"
chmod +x "$SRC"
if [ -w /usr/local/bin ]; then DEST=/usr/local/bin; else DEST="$HOME/.local/bin"; mkdir -p "$DEST"; fi
ln -sf "$SRC" "$DEST/bulwark"
echo "Installed: $DEST/bulwark -> $SRC"
case ":$PATH:" in *":$DEST:"*) ;; *) echo "Add it to your PATH:  echo 'export PATH=\"$DEST:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;; esac
echo "Try: bulwark help"
