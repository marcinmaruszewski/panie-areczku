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

ENV_DIR="\$HOME/.panie-areczku"
ENV_FILE="\$ENV_DIR/.env"

mkdir -p "\$ENV_DIR"
if [[ ! -f "\$ENV_FILE" ]]; then
  touch "\$ENV_FILE"
fi

export PANIE_ARECZKU_ENV_PATH="\$ENV_FILE"

load_env_file() {
  if [[ -s "\$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "\$ENV_FILE"
    set +a
  fi
}

prompt_jira_opt_in() {
  printf 'Enable JIRA integration now? [y/N]: '
  local reply
  if IFS= read -r reply; then
    case "\$reply" in
      [Yy]) return 0 ;;
    esac
  fi
  return 1
}

prompt_required() {
  local label="\$1" value
  while :; do
    printf '%s' "\$label"
    if IFS= read -r value && [[ -n "\$value" ]]; then
      printf '%s' "\$value"
      return 0
    fi
    printf 'Value is required.\n'
  done
}

prompt_required_secret() {
  local label="\$1" value
  while :; do
    printf '%s' "\$label"
    if IFS= read -r -s value && [[ -n "\$value" ]]; then
      printf '\n'
      printf '%s' "\$value"
      return 0
    fi
    printf '\nValue is required.\n'
  done
}

write_disable_flag() {
  printf 'JIRA_DISABLED=true\n' >"\$ENV_FILE"
  export JIRA_DISABLED=true
  export PANIE_ARECZKU_ENV_EMPTY=0
  printf 'JIRA integration disabled. Edit %s to re-enable.\n' "\$ENV_FILE"
}

write_jira_env() {
  local email="\$1" base_url="\$2" api_key="\$3"
  {
    printf 'JIRA_EMAIL=%s\n' "\$email"
    printf 'JIRA_API_KEY=%s\n' "\$api_key"
    printf 'JIRA_BASE_URL=%s\n' "\$base_url"
  } >"\$ENV_FILE"
  export JIRA_EMAIL="\$email"
  export JIRA_API_KEY="\$api_key"
  export JIRA_BASE_URL="\$base_url"
  export PANIE_ARECZKU_ENV_EMPTY=0
  printf 'JIRA credentials saved to %s\n' "\$ENV_FILE"
}

validate_jira_credentials() {
  local email="\$1" base_url="\$2" api_key="\$3"
  local normalized_base="\${base_url%/}"
  local endpoint="\${normalized_base}/rest/api/3/myself"
  local auth
  auth=$(printf '%s:%s' "\$email" "\$api_key" | base64)
  local status
  status=$(curl -sS -o /dev/null -w '%{http_code}' \\
    -H "Authorization: Basic \${auth}" \\
    -H 'Accept: application/json' \\
    --max-time 15 \\
    "\$endpoint" || true)
  if [[ "\$status" == "200" ]]; then
    return 0
  fi
  printf 'Validation failed (HTTP %s). Check JIRA email, base URL, or API key.\n' "\$status" >&2
  return 1
}

prompt_retry_or_disable() {
  printf 'Retry JIRA credentials? [Y/d] (d=disable): '
  local reply
  if IFS= read -r reply; then
    case "\$reply" in
      [Dd]|[Nn]) write_disable_flag; return 1 ;;
    esac
  fi
  return 0
}

collect_jira_credentials() {
  while :; do
    local email base_url api_key
    email=$(prompt_required 'JIRA email: ')
    base_url=$(prompt_required 'JIRA base URL (e.g. https://your-domain.atlassian.net): ')
    case "\$base_url" in
      http://*|https://*) ;;
      *) printf 'Base URL must include scheme (e.g. https://your-domain.atlassian.net).\n'; continue ;;
    esac
    api_key=$(prompt_required_secret 'JIRA API key: ')

    printf 'Validating JIRA credentials...\n'
    if validate_jira_credentials "\$email" "\$base_url" "\$api_key"; then
      write_jira_env "\$email" "\$base_url" "\$api_key"
      return 0
    fi

    if ! prompt_retry_or_disable; then
      return 1
    fi
  done
}

maybe_handle_jira_opt_in() {
  if grep -q '^JIRA_DISABLED=true' "\$ENV_FILE"; then
    export JIRA_DISABLED=true
    export PANIE_ARECZKU_ENV_EMPTY=0
    return
  fi

  if [[ "\${PANIE_ARECZKU_ENV_EMPTY:-0}" -eq 0 ]]; then
    return
  fi

  if prompt_jira_opt_in; then
    collect_jira_credentials || true
  else
    write_disable_flag
  fi
}

handle_existing_jira_env() {
  if [[ "\${JIRA_DISABLED:-}" == "true" ]]; then
    export JIRA_DISABLED=true
    export PANIE_ARECZKU_ENV_EMPTY=0
    return
  fi

  if [[ -z "\${JIRA_EMAIL:-}" || -z "\${JIRA_BASE_URL:-}" || -z "\${JIRA_API_KEY:-}" ]]; then
    export PANIE_ARECZKU_ENV_EMPTY=1
    return
  fi

  if validate_jira_credentials "\$JIRA_EMAIL" "\$JIRA_BASE_URL" "\$JIRA_API_KEY"; then
    export JIRA_EMAIL JIRA_BASE_URL JIRA_API_KEY
    export PANIE_ARECZKU_ENV_EMPTY=0
    return
  fi

  printf 'Stored JIRA credentials failed validation.\n'
  while :; do
    printf 'Refresh credentials or disable? [r/d]: '
    local reply
    if IFS= read -r reply; then
      case "\$reply" in
        [Dd])
          write_disable_flag
          return
          ;;
        [Rr]|'')
          if collect_jira_credentials; then
            return
          fi
          if [[ "\${JIRA_DISABLED:-}" == "true" ]]; then
            return
          fi
          printf 'Unable to save credentials. Try again or disable.\n'
          ;;
        *)
          printf 'Enter r to refresh or d to disable.\n'
          ;;
      esac
    fi
  done
}

load_env_file

if [[ ! -s "\$ENV_FILE" ]]; then
  export PANIE_ARECZKU_ENV_EMPTY=1
else
  export PANIE_ARECZKU_ENV_EMPTY=0
fi

if [[ "\${PANIE_ARECZKU_ENV_EMPTY:-0}" -eq 0 ]]; then
  handle_existing_jira_env
fi

maybe_handle_jira_opt_in

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
