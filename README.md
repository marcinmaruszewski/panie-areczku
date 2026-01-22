# Panie Areczku!

## Quick install
- *nix (curl): `curl -fsSL https://raw.githubusercontent.com/marcinmaruszewski/panie-areczku/master/install.sh | bash`

## What the installer does
- Downloads the latest master package to `~/.panie-areczku`.
- If the directory already exists, moves it to a timestamped backup like `~/.panie-areczku.bak-YYYYMMDDHHMMSS` before reinstalling.
- Creates/refreshes a `panie-areczku` shim in `~/.local/bin`, exporting `OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG` to the install path.

## PATH guidance
- The shim directory is created automatically, but you may need to add it to `PATH` if `panie-areczku` is not recognized.
- *nix: add `~/.local/bin` to `PATH` (for example: `export PATH="$HOME/.local/bin:$PATH"`).

## Post-install verification
- The installer validates the Januszek agent file at `~/.panie-areczku/agents/januszek.md` and reports the result.
- If `opencode` is available, the shim is exercised with `panie-areczku --help`; run this manually after installing OpenCode to confirm the shim works.
- Rerunning the installer should show the backup path it created and leave a fresh install plus the shim in place.
