#!/usr/bin/env bash
set -euo pipefail

# panie-areczku installer (master branch)

REPO_OWNER="isobar-playground"
REPO_NAME="panie-areczku"
REPO_BRANCH="${REPO_BRANCH:-master}"
TARBALL_URL="${TARBALL_URL:-https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/${REPO_BRANCH}}"

INSTALL_DIR="${INSTALL_DIR:-$HOME/.panie-areczku}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
SHIM_PATH="$BIN_DIR/panie-areczku"

log()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

need_downloader() {
  if have curl || have wget; then
    return 0
  fi
  die "Need either curl or wget to download the package"
}

download() {
  local url="$1"
  local dest="$2"

  if have curl; then
    curl -fsSL "$url" -o "$dest"
    return
  fi

  if have wget; then
    wget -qO "$dest" "$url"
    return
  fi

  die "No downloader available"
}

backup_existing_install() {
  if [[ -d "$INSTALL_DIR" ]]; then
    local ts backup
    ts="$(date +%Y%m%d%H%M%S)"
    backup="${INSTALL_DIR}.bak-${ts}"
    log "Existing install found. Backing up to: $backup"
    mv "$INSTALL_DIR" "$backup"
  fi
}

install_package() {
  need_downloader
  have tar || die "Missing required command: tar"
  have mktemp || die "Missing required command: mktemp"

  local tmp
  tmp="$(mktemp -d)"

  log "Downloading master package from: $TARBALL_URL"
  download "$TARBALL_URL" "$tmp/src.tgz"

  tar -xzf "$tmp/src.tgz" -C "$tmp"

  local src_dir
  src_dir="$tmp/${REPO_NAME}-${REPO_BRANCH}"

  [[ -d "$src_dir" ]] || die "Unexpected archive layout. Missing: $src_dir"

  backup_existing_install
  rm -rf "$INSTALL_DIR"
  mv "$src_dir" "$INSTALL_DIR"

  rm -rf "$tmp"

  log "Installed package to: $INSTALL_DIR"
}

install_shim() {
  mkdir -p "$BIN_DIR"

  cat >"$SHIM_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="$INSTALL_DIR"
export OPENCODE_CONFIG_DIR="\$INSTALL_DIR"
export OPENCODE_CONFIG="\$INSTALL_DIR/config.json"

if command -v opencode >/dev/null 2>&1; then
  exec opencode "\$@"
fi

if [[ -x "\$INSTALL_DIR/opencode" ]]; then
  exec "\$INSTALL_DIR/opencode" "\$@"
fi

echo "ERROR: 'opencode' command not found. Install it from https://opencode.ai/install" >&2
exit 127
EOF

  chmod +x "$SHIM_PATH"
  log "Installed shim to: $SHIM_PATH"

  if ! command -v panie-areczku >/dev/null 2>&1; then
    warn "'panie-areczku' is not on PATH. Add $BIN_DIR to your PATH."
  fi
}

verify_install() {
  local januszek_path="$INSTALL_DIR/agents/januszek.md"

  if [[ -f "$januszek_path" ]]; then
    log "Verified Januszek agent file at: $januszek_path"
  else
    die "Januszek agent file missing at: $januszek_path"
  fi

  if have opencode; then
    if "$SHIM_PATH" --help >/dev/null 2>&1; then
      log "Shim check succeeded (panie-areczku --help)."
    else
      die "Shim invocation failed. Ensure OpenCode is installed and accessible."
    fi
  else
    warn "OpenCode CLI not found; skipped 'panie-areczku --help' check. Install from https://opencode.ai/install to use the shim."
  fi
}

main() {
  install_package
  install_shim
  verify_install

  log "Installation complete."
}

main "$@"
