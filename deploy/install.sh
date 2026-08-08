#!/usr/bin/env bash
#
# Installs infinite as a systemd service on a Linux host.
#
# Run as root. The service itself runs as a dedicated unprivileged account,
# because Claude Code refuses to bypass permission prompts when running as root
# and an unattended agent cannot answer them.
#
#   sudo deploy/install.sh
#   sudo deploy/install.sh --dry-run            # print the plan, change nothing
#   sudo deploy/install.sh --project my-project # also scaffold a project
#
set -euo pipefail

PREFIX=/opt/infinite
PROJECTS=/srv/infinite
CONFIG_DIR=/etc/infinite
SERVICE_USER=infinite
SERVICE_GROUP=infinite
UNIT_DIR=/etc/systemd/system
PROJECT=""
DRY_RUN=0
CREATE_USER=1

MIN_NODE_MAJOR=22
MIN_NODE_MINOR=18

SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --prefix <dir>       Where the code is installed        (default: /opt/infinite)
  --projects <dir>     Parent of per-project directories  (default: /srv/infinite)
  --config <dir>       Where env files live               (default: /etc/infinite)
  --user <name>        Service account                    (default: infinite)
  --project <name>     Also scaffold a project of this name
  --no-create-user     Assume the service account already exists
  --dry-run            Print what would happen, change nothing
  -h, --help           This message

After installing:

  1. Authenticate Claude Code as the service user, once:
       sudo -u infinite -H claude auth
     Or put ANTHROPIC_API_KEY in /etc/infinite/default.env instead.
  2. Write the mission:
       sudoedit /srv/infinite/<project>/MISSION.md
  3. Review the config, especially toolPolicy.allowBash:
       sudoedit /srv/infinite/<project>/infinite.config.json
  4. Start it:
       sudo systemctl enable --now infinite@<project>
       journalctl -u infinite@<project> -f
EOF
}

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Every mutating action goes through this so --dry-run is honest rather than
# something that has to be remembered at each call site.
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    # Shell-quoted so the printed plan is something you could paste and run,
    # rather than something that merely looks like the command.
    printf '   would run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# Copies the source tree into the destination, excluding local state. Prefers
# rsync for its --delete, which removes files an older version left behind, but
# rsync is absent on plenty of minimal server images so tar stands in.
copy_tree() {
  local src=$1 dest=$2
  local excludes=(.git node_modules .infinite MISSION.md infinite.config.json)

  if command -v rsync >/dev/null; then
    local args=(-a --delete)
    local e
    for e in "${excludes[@]}"; do args+=(--exclude "$e"); done
    run rsync "${args[@]}" "$src/" "$dest/"
    return
  fi

  local args=(-C "$src")
  local e
  for e in "${excludes[@]}"; do args+=(--exclude "$e"); done
  args+=(-cf - .)

  if [[ $DRY_RUN -eq 1 ]]; then
    printf '   would run: tar %s | tar -C %q -xf -\n' "${args[*]}" "$dest"
    printf '   note: rsync is absent, so files removed in this version are left in place\n'
    return
  fi

  warn "rsync not found; copying with tar. Files dropped since the installed version will remain in $dest."
  tar "${args[@]}" | tar -C "$dest" -xf -
}

write_file() {
  local path=$1 mode=$2 owner=$3
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '   would write: %s (mode %s, owner %s)\n' "$path" "$mode" "$owner"
    cat >/dev/null
    return
  fi
  install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" /dev/stdin "$path"
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --prefix)   PREFIX=$2; shift 2 ;;
    --projects) PROJECTS=$2; shift 2 ;;
    --config)   CONFIG_DIR=$2; shift 2 ;;
    --user)     SERVICE_USER=$2; SERVICE_GROUP=$2; shift 2 ;;
    --project)  PROJECT=$2; shift 2 ;;
    --no-create-user) CREATE_USER=0; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          die "unknown option: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------- preflight

[[ $DRY_RUN -eq 1 || $EUID -eq 0 ]] || die "must run as root (or pass --dry-run)"

command -v systemctl >/dev/null || die "systemctl not found; this installer targets systemd hosts"

NODE_BIN=$(command -v node || true)
[[ -n $NODE_BIN ]] || die "node not found on PATH. Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer is required."
NODE_BIN=$(readlink -f "$NODE_BIN")

NODE_VERSION=$("$NODE_BIN" --version)   # e.g. v22.22.2
NODE_MAJOR=${NODE_VERSION#v}; NODE_MAJOR=${NODE_MAJOR%%.*}
NODE_REST=${NODE_VERSION#v*.}; NODE_MINOR=${NODE_REST%%.*}

# Type stripping runs .ts directly, so there is no build step — but it only
# exists from 22.18 on. An older Node fails at the first import, confusingly.
if (( NODE_MAJOR < MIN_NODE_MAJOR )) ||
   { (( NODE_MAJOR == MIN_NODE_MAJOR )) && (( NODE_MINOR < MIN_NODE_MINOR )); }; then
  die "node ${NODE_VERSION} is too old; ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer is required (TypeScript runs unbuilt)"
fi

command -v npm >/dev/null || die "npm not found on PATH"

[[ -f "$SOURCE_DIR/package.json" && -d "$SOURCE_DIR/src" ]] ||
  die "cannot find the source tree; expected package.json and src/ in $SOURCE_DIR"

[[ -f "$SOURCE_DIR/deploy/infinite@.service" ]] ||
  die "missing deploy/infinite@.service in $SOURCE_DIR"

if [[ -n $PROJECT && ! $PROJECT =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  die "project name must be alphanumeric with . _ - (got: $PROJECT)"
fi

log "node          $NODE_VERSION ($NODE_BIN)"
log "source        $SOURCE_DIR"
log "prefix        $PREFIX"
log "projects      $PROJECTS"
log "config        $CONFIG_DIR"
log "service user  $SERVICE_USER"
[[ $DRY_RUN -eq 1 ]] && warn "dry run — nothing will be changed"

# ------------------------------------------------------------ service account

if [[ $CREATE_USER -eq 1 ]] && ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "creating service account $SERVICE_USER"
  # A real home is required: Claude Code stores credentials and transcripts
  # under it, and npm caches there.
  run useradd --system --create-home --home-dir "/var/lib/$SERVICE_USER" \
      --shell /usr/sbin/nologin --comment "infinite agent" "$SERVICE_USER"
else
  log "service account $SERVICE_USER already exists"
fi

if [[ $DRY_RUN -eq 1 ]] && ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  SERVICE_HOME="/var/lib/$SERVICE_USER"
else
  SERVICE_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
  [[ -n $SERVICE_HOME ]] || die "could not determine the home directory of $SERVICE_USER"
fi
log "service home  $SERVICE_HOME"

# ------------------------------------------------------------------- the code

log "installing code to $PREFIX"
run mkdir -p "$PREFIX"
# node_modules is never copied: a clean tree plus `npm ci` is reproducible,
# copying an existing install is not.
copy_tree "$SOURCE_DIR" "$PREFIX"
run chown -R "$SERVICE_USER:$SERVICE_GROUP" "$PREFIX"

log "installing production dependencies"
if [[ $DRY_RUN -eq 1 ]]; then
  printf '   would run: (as %s) npm ci --omit=dev in %s\n' "$SERVICE_USER" "$PREFIX"
else
  # As the service user so the npm cache and any lifecycle scripts land in its
  # home rather than root's.
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" \
    npm --prefix "$PREFIX" ci --omit=dev
fi

# ------------------------------------------------------------------- env files

log "preparing $CONFIG_DIR"
run mkdir -p "$CONFIG_DIR"
run chmod 0750 "$CONFIG_DIR"
run chown "root:$SERVICE_GROUP" "$CONFIG_DIR"

if [[ -e "$CONFIG_DIR/default.env" ]]; then
  log "keeping existing $CONFIG_DIR/default.env"
else
  log "writing $CONFIG_DIR/default.env"
  write_file "$CONFIG_DIR/default.env" 0640 "root:$SERVICE_GROUP" <<'EOF'
# Shared by every infinite instance. Readable by the service group only.
#
# Authentication — either run `claude auth` as the service user once, or set:
# ANTHROPIC_API_KEY=

# Dashboard bearer token. Without it the API is open to anything that can reach
# the bound address.
INFINITE_TOKEN=change-me

# Messenger credentials referenced as ${VAR} from infinite.config.json.
# KNOX_TOKEN=
# KNOX_ROOM_ID=
EOF
fi

# -------------------------------------------------------------------- the unit

log "rendering $UNIT_DIR/infinite@.service"
sed -e "s|@NODE@|$NODE_BIN|g" \
    -e "s|@PREFIX@|$PREFIX|g" \
    -e "s|@PROJECTS@|$PROJECTS|g" \
    -e "s|@USER@|$SERVICE_USER|g" \
    -e "s|@GROUP@|$SERVICE_GROUP|g" \
    -e "s|@HOME@|$SERVICE_HOME|g" \
    "$SOURCE_DIR/deploy/infinite@.service" |
  write_file "$UNIT_DIR/infinite@.service" 0644 "root:root"

run systemctl daemon-reload

# ------------------------------------------------------------------- a project

log "preparing $PROJECTS"
run mkdir -p "$PROJECTS"
run chown "$SERVICE_USER:$SERVICE_GROUP" "$PROJECTS"

if [[ -n $PROJECT ]]; then
  PROJECT_DIR="$PROJECTS/$PROJECT"
  log "scaffolding project $PROJECT in $PROJECT_DIR"
  run mkdir -p "$PROJECT_DIR"
  run chown "$SERVICE_USER:$SERVICE_GROUP" "$PROJECT_DIR"

  if [[ -e "$PROJECT_DIR/MISSION.md" ]]; then
    log "keeping existing $PROJECT_DIR/MISSION.md"
  elif [[ $DRY_RUN -eq 1 ]]; then
    printf '   would run: (as %s) infinite init --cwd %s\n' "$SERVICE_USER" "$PROJECT_DIR"
  else
    runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" \
      "$NODE_BIN" "$PREFIX/src/cli.ts" init --cwd "$PROJECT_DIR"
  fi

  if [[ ! -e "$CONFIG_DIR/$PROJECT.env" ]]; then
    log "writing $CONFIG_DIR/$PROJECT.env"
    write_file "$CONFIG_DIR/$PROJECT.env" 0640 "root:$SERVICE_GROUP" <<EOF
# Overrides for the "$PROJECT" instance. Values here beat default.env.
# INFINITE_MODEL=
# INFINITE_THRESHOLD=0.8
# INFINITE_PORT=4319
EOF
  fi
fi

# ---------------------------------------------------------------- next steps

cat <<EOF

$(log "installed")

Next steps:

  1. Authenticate Claude Code as the service user, once:
       sudo -u $SERVICE_USER -H $(command -v claude 2>/dev/null || echo claude) auth
     Or set ANTHROPIC_API_KEY in $CONFIG_DIR/default.env instead.

  2. Set a dashboard token in $CONFIG_DIR/default.env (it currently reads change-me).

  3. Write the mission and review the config — in particular widen
     toolPolicy.allowBash to the build and test commands this project needs:
       $PROJECTS/<project>/MISSION.md
       $PROJECTS/<project>/infinite.config.json

  4. Start one instance per project:
       systemctl enable --now infinite@<project>
       journalctl -u infinite@<project> -f

  For a first run, cap it: maxLegs 3 and maxCostUsdTotal 5 in the project config,
  then read $PROJECTS/<project>/.infinite/handoffs/ to judge handoff quality
  before letting it run unbounded.
EOF
