#!/bin/sh
# The runner of this bundle. Its programs are those of a Nix store, which is in the bundle:
# they run in a namespace of this user's own, where bwrap mounts that store at /nix/store
# and the machine's other directories are what they are outside.
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)

# Asked to stop, the runner stops its session first, which takes a moment: what is between
# it and whoever asks waits for it, and does not end first.
trap '' INT TERM

given=$#
for entry in /*; do
  case $entry in
    /nix | /proc | /dev) continue ;;
  esac
  if [ -L "$entry" ]; then
    set -- "$@" --symlink "$(readlink "$entry")" "$entry"
  else
    set -- "$@" --bind "$entry" "$entry"
  fi
done
set -- "$@" --dev-bind /dev /dev --proc /proc --ro-bind "$here/nix/store" /nix/store -- @runner@
# What this was given goes after all of that.
while [ "$given" -gt 0 ]; do
  set -- "$@" "$1"
  shift
  given=$((given - 1))
done
# bwrap is the store's as well, and is run by the store's loader, with its libraries.
exec "$here@loader@" --library-path "@libraryPath@" "$here@bwrap@" "$@"
