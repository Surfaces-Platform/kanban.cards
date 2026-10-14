#!/bin/bash
set -euo pipefail

kanban_script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
kanban_build_directory="$kanban_script_directory/.build"
kanban_demo_options=(--demo --open-example-cards --reset-demo-window-layout
                     -ApplePersistenceIgnoreState YES)

for kanban_argument in "$@"; do
  case "$kanban_argument" in
    --reset-demo-drafts)
      kanban_demo_options+=("--reset-demo-drafts")
      ;;
    --help|-h)
      printf 'Usage: %s [--reset-demo-drafts]\n' "$0"
      printf 'Build and open a fresh native macOS demo with the board and two Card viewers.\n'
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$kanban_argument" >&2
      exit 64
      ;;
  esac
done

/usr/bin/xcodebuild -project "$kanban_script_directory/KanbanCards.xcodeproj" \
  -scheme KanbanCards -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath "$kanban_build_directory" \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual CODE_SIGNING_ALLOWED=YES \
  CODE_SIGN_ENTITLEMENTS= build

# A fresh synthetic instance leaves any existing account app and session running.
/usr/bin/open -n "$kanban_build_directory/Build/Products/Debug/KanbanCards.app" --args \
  "${kanban_demo_options[@]}"
