# The Liquid Glass rollout of a phone update. Sourced, never run alone, by
# release-ota.sh (`pnpm release:ota`) and release-ota-test.sh.
#
# EXPO_PUBLIC_LIQUID_GLASS is inlined into the bundle, so every update decides
# the look of every phone it reaches. It comes ONLY from the command that runs
# the script, and must be named every time:
#   off      classic for everyone (every stored choice kept);
#   opt-in   classic unless the person chose Liquid Glass;
#   default  Liquid Glass unless the person chose Classic.
# Anything else, unset and empty included, is refused: the app would read it
# as off, and an update that forgets the flag would turn every phone back to
# classic.
#
# The order a script follows:
#   lg_rollout_take <command>         first, before the env file is loaded;
#   lg_rollout_refuse_env_file <cmd>  before `source .env.local`;
#   lg_rollout_export                 after it, before eas-cli.
# The value is kept read-only, as LG_ROLLOUT_FROM_COMMAND, and these functions
# are read-only too: a line in .env.local that assigns or unsets that name
# stops the script (set -e), and one that redefines a function leaves it as it
# is. The value is checked again before it is exported and printed, so nothing
# in .env.local can change what reaches `eas update` or what is printed.
# (EAS server-side variables of the production environment would still win
# over the shell: none may set it; docs/runbooks/mobile-ota.md.)

# Takes the rollout from the caller, or stops. $1 is how the caller runs the
# script, for the message.
lg_rollout_take() {
  local command="$1"
  local given="${EXPO_PUBLIC_LIQUID_GLASS+given}"
  local value="${EXPO_PUBLIC_LIQUID_GLASS-}"
  local why
  case "$value" in
    off | opt-in | default) ;;
    *)
      if [[ -z "$given" ]]; then
        why="it is not set"
      elif [[ -z "$value" ]]; then
        why="it is empty"
      else
        why="'$value' is not one of them"
      fi
      echo "FATAL: name the Liquid Glass rollout this update ships with: EXPO_PUBLIC_LIQUID_GLASS=off, opt-in or default before $command ($why). Without it the update would turn every phone it reaches to classic." >&2
      exit 1
      ;;
  esac
  readonly LG_ROLLOUT_FROM_COMMAND="$value"
}

# Stops when .env.local names EXPO_PUBLIC_LIQUID_GLASS on a line outside a
# comment (it would override the command). Only whether it does is checked;
# nothing from the file is printed.
lg_rollout_refuse_env_file() {
  local command="$1"
  # 0: named; 1: not named; anything else: the file could not be read.
  local named=0
  grep -Eq '^[^#]*(^|[^A-Za-z0-9_])EXPO_PUBLIC_LIQUID_GLASS([^A-Za-z0-9_]|$)' .env.local || named=$?
  if [[ "$named" == "0" ]]; then
    echo "FATAL: apps/mobile/.env.local sets EXPO_PUBLIC_LIQUID_GLASS. Remove that line: the rollout comes only from the command (EXPO_PUBLIC_LIQUID_GLASS=off, opt-in or default $command)." >&2
    exit 1
  elif [[ "$named" != "1" ]]; then
    echo "FATAL: apps/mobile/.env.local could not be read to check it does not set EXPO_PUBLIC_LIQUID_GLASS." >&2
    exit 1
  fi
}

# Exports the caller's value again, whatever .env.local did, and prints it.
lg_rollout_export() {
  case "${LG_ROLLOUT_FROM_COMMAND-}" in
    off | opt-in | default) ;;
    *)
      echo "FATAL: the Liquid Glass rollout from the command was lost after apps/mobile/.env.local was loaded. Nothing was published." >&2
      exit 1
      ;;
  esac
  export EXPO_PUBLIC_LIQUID_GLASS="$LG_ROLLOUT_FROM_COMMAND"
  echo "Liquid Glass rollout in this update: EXPO_PUBLIC_LIQUID_GLASS=$LG_ROLLOUT_FROM_COMMAND"
}

readonly -f lg_rollout_take lg_rollout_refuse_env_file lg_rollout_export
