#!/usr/bin/env bash
# Foundry evidence generator for Motion.
#
# Produces a privacy-safe `foundry-evidence.json` describing build, simulator,
# signing, device, and deployment state — WITHOUT any camera frames, motion
# samples, speech samples, screenshots, credentials, or device identifiers.
#
# Motion is intentionally undeployed. This script distinguishes:
#   - source:    typecheck pass
#   - build:     web build pass
#   - simulator: iOS Simulator compile pass (macOS-only, CODE_SIGNING_ALLOWED=NO)
#   - signing:   blocked (no signing team in CI)
#   - device:    blocked (no physical device in CI)
#   - deploy:    intentionally undeployed
#
# Run: ./scripts/foundry-evidence.sh
#
# Exit codes:
#   0 — evidence written (even if some checks failed)
#   1 — evidence could not be written (fatal script error)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/foundry-evidence.json"
GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

PROJECT="motion"
SCHEMA="private-local-toolbox-automation/v1"

# --- Helpers ---------------------------------------------------------------
# run_step <label> <command...> → sets STEP_STATUS to pass|fail
run_step() {
  local label="$1"
  shift
  if "$@" >"/tmp/motion-foundry-$$.log" 2>&1; then
    STEP_STATUS="pass"
    echo "[foundry] $label: pass"
  else
    STEP_STATUS="fail"
    echo "[foundry] $label: fail"
    tail -20 "/tmp/motion-foundry-$$.log" | sed 's/^/  /' >&2
  fi
  rm -f "/tmp/motion-foundry-$$.log"
}

# --- Build steps -----------------------------------------------------------
TYPECHECK="skip"
LINT="skip"
WEB_BUILD="skip"
SIMULATOR="skip"

if command -v npm > /dev/null 2>&1; then
  run_step "typecheck" npm --prefix "$ROOT" run typecheck
  TYPECHECK="$STEP_STATUS"

  run_step "web-build" npm --prefix "$ROOT" run build
  WEB_BUILD="$STEP_STATUS"
fi

# iOS Simulator build — only on macOS with full Xcode + xcodegen.
SIMULATOR="blocked"
SIMULATOR_NOTE="no_xcode_or_xcodegen"
if command -v xcodebuild > /dev/null 2>&1 && command -v xcodegen > /dev/null 2>&1; then
  # Verify xcodebuild is functional (CLT-only installs have the binary but error).
  if xcodebuild -version > /dev/null 2>&1; then
    if [ -d "$ROOT/ios" ]; then
      SIMULATOR_NOTE=""
      SIM_EXIT=0
      (
        cd "$ROOT/ios"
        xcodegen generate > /tmp/motion-sim-$$.log 2>&1 || exit 1
        # Find an available iOS Simulator destination.
        DEST="$(xcodebuild -showdestinations -project Motion.xcodeproj -scheme Motion 2>/dev/null | grep -m1 'platform=iOS Simulator' | sed 's/.*\(platform=iOS Simulator[^{]*\).*/\1/' | tr -d ' ' || true)"
        if [ -z "$DEST" ]; then
          echo "no simulator destination found" >> /tmp/motion-sim-$$.log
          exit 1
        fi
        xcodebuild \
          -project Motion.xcodeproj \
          -scheme Motion \
          -destination "$DEST" \
          -configuration Debug \
          CODE_SIGNING_ALLOWED=NO \
          build >> /tmp/motion-sim-$$.log 2>&1
      ) || SIM_EXIT=$?
      if [ "$SIM_EXIT" -eq 0 ]; then
        SIMULATOR="pass"
        echo "[foundry] simulator: pass"
      else
        SIMULATOR="fail"
        echo "[foundry] simulator: fail"
        tail -20 "/tmp/motion-sim-$$.log" | sed 's/^/  /' >&2
      fi
      rm -f "/tmp/motion-sim-$$.log"
    fi
  else
    SIMULATOR_NOTE="xcodebuild_not_functional_clt_only"
  fi
fi

# --- Signing + device + deploy states (truthful, not failure) -------------
SIGNING_STATE="blocked"
SIGNING_BLOCKER="no signing team in CI; device signing requires human approval"

DEVICE_STATE="blocked"
DEVICE_BLOCKER="no physical device in CI; camera + ReplayKit need a device"

DEPLOY_STATE="intentionally_undeployed"
DEPLOY_NOTE="v1 POC; no production target approved"

# --- No telemetry ----------------------------------------------------------
TELEMETRY="none"
if [ -d "$ROOT/server" ]; then
  TELEMETRY="partykit_relay_only_v2_parked"
fi

# --- Write evidence --------------------------------------------------------
# Use node if available for pretty JSON; otherwise heredoc.
if command -v node > /dev/null 2>&1; then
  PROJECT="$PROJECT" \
  GENERATED_AT="$GENERATED_AT" \
  SCHEMA="$SCHEMA" \
  TYPECHECK="$TYPECHECK" \
  WEB_BUILD="$WEB_BUILD" \
  SIMULATOR="$SIMULATOR" \
  SIMULATOR_NOTE="$SIMULATOR_NOTE" \
  SIGNING_STATE="$SIGNING_STATE" \
  SIGNING_BLOCKER="$SIGNING_BLOCKER" \
  DEVICE_STATE="$DEVICE_STATE" \
  DEVICE_BLOCKER="$DEVICE_BLOCKER" \
  DEPLOY_STATE="$DEPLOY_STATE" \
  DEPLOY_NOTE="$DEPLOY_NOTE" \
  TELEMETRY="$TELEMETRY" \
  OUT="$OUT" \
  node -e '
    const fs = require("fs");
    const evidence = {
      project: process.env.PROJECT,
      generatedAt: process.env.GENERATED_AT,
      schema: process.env.SCHEMA,
      privacy: {
        contentExcluded: true,
        excludedFields: [
          "camera frames",
          "motion samples",
          "speech samples",
          "screenshots",
          "credentials",
          "device identifiers",
        ],
      },
      build: {
        typecheck: process.env.TYPECHECK,
        web: process.env.WEB_BUILD,
      },
      simulator: {
        state: process.env.SIMULATOR,
        note: process.env.SIMULATOR_NOTE || null,
        codeSigning: "not_required",
      },
      signing: {
        state: process.env.SIGNING_STATE,
        blocker: process.env.SIGNING_BLOCKER,
      },
      device: {
        state: process.env.DEVICE_STATE,
        blocker: process.env.DEVICE_BLOCKER,
      },
      deploy: {
        state: process.env.DEPLOY_STATE,
        note: process.env.DEPLOY_NOTE,
      },
      telemetry: process.env.TELEMETRY,
      blockers: [
        ...(process.env.SIGNING_STATE === "blocked" ? ["signing_team"] : []),
        ...(process.env.DEVICE_STATE === "blocked" ? ["physical_device"] : []),
      ],
      pendingApproval: [
        "device signing profile",
        "physical device verification",
        "production deployment",
        "backend creation (v2 relay)",
      ],
    };
    fs.writeFileSync(process.env.OUT, JSON.stringify(evidence, null, 2) + "\n");
  '
else
  cat > "$OUT" <<EOF
{
  "project": "$PROJECT",
  "generatedAt": "$GENERATED_AT",
  "schema": "$SCHEMA",
  "privacy": {
    "contentExcluded": true,
    "excludedFields": [
      "camera frames",
      "motion samples",
      "speech samples",
      "screenshots",
      "credentials",
      "device identifiers"
    ]
  },
  "build": { "typecheck": "$TYPECHECK", "web": "$WEB_BUILD" },
  "simulator": { "state": "$SIMULATOR", "note": "$SIMULATOR_NOTE", "codeSigning": "not_required" },
  "signing": { "state": "$SIGNING_STATE", "blocker": "$SIGNING_BLOCKER" },
  "device": { "state": "$DEVICE_STATE", "blocker": "$DEVICE_BLOCKER" },
  "deploy": { "state": "$DEPLOY_STATE", "note": "$DEPLOY_NOTE" },
  "telemetry": "$TELEMETRY",
  "blockers": ["signing_team", "physical_device"],
  "pendingApproval": [
    "device signing profile",
    "physical device verification",
    "production deployment",
    "backend creation (v2 relay)"
  ]
}
EOF
fi

echo "[foundry] evidence written → $(basename "$OUT")"
echo "[foundry] deploy: $DEPLOY_STATE; signing: $SIGNING_STATE; device: $DEVICE_STATE"
