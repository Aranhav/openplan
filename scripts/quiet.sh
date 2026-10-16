#!/usr/bin/env bash
# Runs a command with its full output in .logs/<name>.log and prints one result
# line, the failure lines (on failure only) and the log path. If the log cannot be written, the
# command still runs and a line says where its output went instead. See CLAUDE.md "Context cost".
# Usage: scripts/quiet.sh <name> -- <command> [args...]
set -uo pipefail

usage() {
  echo "usage: scripts/quiet.sh <name> -- <command> [args...]" >&2
  exit 2
}

[ "$#" -ge 3 ] || usage
name=$1
[ "$2" = "--" ] || usage
case $name in
  "" | -* | .* | *[!A-Za-z0-9._-]*)
    echo "quiet.sh: the name uses letters, digits, '.', '_' or '-' and does not start with '-' or '.': $name" >&2
    exit 2 ;;
esac
shift 2

root=$(git rev-parse --show-toplevel 2>/dev/null) || root=$(cd "$(dirname "$0")/.." && pwd)
log="$root/.logs/$name.log"
# A log that cannot be written does not stop the command: its output goes to a scratch file, and
# the problem is reported on its own line at the end.
log_problem=""
if ! { mkdir -p "$root/.logs" && : >"$log"; } 2>/dev/null; then
  if scratch=$(mktemp "${TMPDIR:-/tmp}/quiet.XXXXXX" 2>/dev/null); then
    log_problem="quiet.sh: cannot write $log; the output is in $scratch"
    log=$scratch
  else
    log_problem="quiet.sh: cannot write $log; the output is not kept"
    log=/dev/null
  fi
fi

env NO_COLOR=1 CARGO_TERM_COLOR=never FORCE_COLOR=0 "$@" >"$log" 2>&1
rc=$?

# The log without colour codes or carriage returns; every match below reads this.
esc=$(printf '\033')
cleaned=$(sed -e "s/${esc}\[[0-9;?]*[A-Za-z]//g" "$log" | tr -d '\r')

# The tool the command names; its words win over the output.
detect_command() {
  local tok base prev=""
  for tok in "$@"; do
    base=${tok##*/}
    case $prev:$base in
      cargo:test) echo cargo-test; return 0 ;;
      cargo:build) echo cargo-build; return 0 ;;
      cargo:clippy) echo clippy; return 0 ;;
    esac
    case $base in
      vitest | playwright | tsc | eslint) echo "$base"; return 0 ;;
    esac
    prev=$base
  done
  return 1
}

# The tool the output shows, for commands that name none (a pnpm script, say).
detect_output() {
  if grep -q -E '^test result: ' <<<"$cleaned"; then echo cargo-test
  elif grep -q -E '^[[:space:]]*Tests[[:space:]]' <<<"$cleaned"; then echo vitest
  elif grep -q -E '^Running [0-9]+ tests? using' <<<"$cleaned"; then echo playwright
  elif grep -q -E 'error TS[0-9]+:' <<<"$cleaned"; then echo tsc
  elif grep -q -E '^[[:space:]]+[0-9]+:[0-9]+[[:space:]]+(error|warning)[[:space:]]|^✖ [0-9]+ problems? \(' <<<"$cleaned"; then echo eslint
  else echo other
  fi
}

# One line per error, for the count and the failure lines.
error_lines() {
  case $1 in
    tsc) grep -E 'error TS[0-9]+:' <<<"$cleaned" ;;
    eslint)
      awk '
        /^[^ \t].*\.[cm]?[jt]sx?$/ { file = $0; next }
        /^[ \t]+[0-9]+:[0-9]+[ \t]+(error|warning)[ \t]/ { sub(/^[ \t]+/, ""); print file ":" $0; next }
        /:[0-9]+:[0-9]+: .*\[Error\// { print }
      ' <<<"$cleaned" ;;
    cargo-test | cargo-build | clippy)
      grep -E '^error(\[[A-Za-z0-9]+\])?: ' <<<"$cleaned" | grep -v -E 'could not compile|aborting due to' ;;
  esac
}

failure_lines() {
  case $1 in
    cargo-test | cargo-build | clippy)
      # A panic line also prints the up to 3 lines after it, which hold the assertion text.
      awk '
        /panicked at/ { print; left = 3; next }
        left > 0 { if (NF == 0) left = 0; else { print; left-- }; next }
        /^---- .* stdout ----$|^error(\[|:)/ { print }
      ' <<<"$cleaned" ;;
    vitest) grep -E '(^|[[:space:]])FAIL([[:space:]]|$)|AssertionError|Error:' <<<"$cleaned" ;;
    playwright) grep -E '✘|Error:' <<<"$cleaned" ;;
    tsc | eslint) error_lines "$1" ;;
    *) return 1 ;;
  esac
}

errors_text() {
  if [ "$1" -eq 1 ]; then echo "1 error"; else echo "$1 errors"; fi
}

# "label: ok" or "label: N errors"; fails when there are no errors and the command failed.
count_result() {
  if [ "$2" -gt 0 ]; then echo "$1: $(errors_text "$2")"
  elif [ "$3" -eq 0 ]; then echo "$1: ok"
  else return 1
  fi
}

# eslint's own tally, such as "0 errors, 1 warning", from its "✖ N problems (...)" line.
eslint_tally() {
  local tally
  tally=$(sed -n -E 's/^✖ [0-9]+ problems? \((.*)\)$/\1/p' <<<"$cleaned" | tail -n 1)
  [ -n "$tally" ] && echo "$tally"
}

# "passed failed ignored" summed over every test binary; fails when cargo printed none.
cargo_test_totals() {
  awk '
    /^test result: / {
      runs++
      for (i = 1; i < NF; i++) {
        if ($(i + 1) == "passed;") passed += $i
        else if ($(i + 1) == "failed;") failed += $i
        else if ($(i + 1) == "ignored;") ignored += $i
      }
    }
    END { if (runs) print passed + 0, failed + 0, ignored + 0; else exit 1 }
  ' <<<"$cleaned"
}

# The result line of a recognised tool; fails when the tool's summary is missing.
result_line() {
  local tool=$1 rc=$2 totals out count p f k tally
  case $tool in
    cargo-test)
      if totals=$(cargo_test_totals); then
        read -r p f k <<<"$totals"
        out="cargo test: $p passed, $f failed, $k ignored"
        if [ "$f" -eq 0 ] && [ "$rc" -ne 0 ]; then out="$out (exit $rc)"; fi
        echo "$out"
        return 0
      fi
      count=$(error_lines cargo-test | wc -l)
      if [ "$count" -gt 0 ]; then echo "cargo test: did not run, $(errors_text "$count")"; return 0; fi
      count_result "cargo test" 0 "$rc" ;;
    vitest)
      out=$(grep -E '^[[:space:]]*Tests[[:space:]]' <<<"$cleaned" | tail -n 1 | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]][[:space:]]*/ /g')
      [ -n "$out" ] || return 1
      if [ "$rc" -ne 0 ] && ! grep -q -E '[0-9]+ failed' <<<"$out"; then out="$out (exit $rc)"; fi
      echo "vitest: $out" ;;
    playwright)
      out=$(grep -E '^[[:space:]]*[0-9]+ (passed|failed|flaky|skipped|did not run|interrupted)' <<<"$cleaned" | sed -e 's/^[[:space:]]*//' | paste -sd, - | sed -e 's/,/, /g')
      [ -n "$out" ] || return 1
      if [ "$rc" -ne 0 ] && ! grep -q -E '[0-9]+ (failed|flaky|did not run|interrupted)' <<<"$out"; then out="$out (exit $rc)"; fi
      echo "playwright: $out" ;;
    eslint)
      if tally=$(eslint_tally); then
        if [ "$rc" -ne 0 ] && ! grep -q -E '[1-9][0-9]* error' <<<"$tally"; then tally="$tally (exit $rc)"; fi
        echo "eslint: $tally"
        return 0
      fi
      count=$(error_lines eslint | wc -l)
      count_result eslint "$count" "$rc" ;;
    tsc | cargo-build | clippy)
      count=$(error_lines "$tool" | wc -l)
      count_result "${tool//-/ }" "$count" "$rc" ;;
    *) return 1 ;;
  esac
}

tool=$(detect_command "$@") || tool=$(detect_output)

line=$(result_line "$tool" "$rc") || line="exit $rc"
echo "$line"

if [ "$rc" -ne 0 ]; then
  failures=$(failure_lines "$tool" | head -n 40)
  [ -n "$failures" ] || failures=$(grep -i -E 'fail|error|panic' <<<"$cleaned" | head -n 40)
  [ -n "$failures" ] || failures=$(tail -n 10 <<<"$cleaned")
  [ -n "$failures" ] && echo "$failures"
fi

if [ -n "$log_problem" ]; then
  echo "$log_problem"
else
  echo "log: ${log#"$PWD"/}"
fi
exit "$rc"
