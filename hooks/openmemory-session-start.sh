#!/bin/bash
# OpenMemory SessionStart hook - queries for relevant context
# Fails silently if OpenMemory/Docker not available

OPENMEMORY_URL="${OPENMEMORY_URL:-http://localhost:8080}"
TIMEOUT_SECS=3

# Quick health check first (fail fast)
if ! curl -s --connect-timeout 1 --max-time 2 "$OPENMEMORY_URL/health" > /dev/null 2>&1; then
  exit 0  # OpenMemory not available, continue without context
fi

# Read hook input from stdin
input=$(cat)
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
project_name=$(basename "$cwd" 2>/dev/null || echo "unknown")

# Query OpenMemory for project-relevant memories
response=$(curl -s --connect-timeout 2 --max-time "$TIMEOUT_SECS" \
  -X POST "$OPENMEMORY_URL/memory/query" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"project $project_name\", \"k\": 5}" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$response" ]; then
  exit 0  # Query failed, continue without context
fi

# Extract memory content
memories=$(echo "$response" | jq -r '.matches[]?.content // empty' 2>/dev/null | head -10)

if [ -n "$memories" ]; then
  # Build JSON output with jq to handle escaping properly
  echo "$memories" | jq -Rs '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: ("## Relevant memories from OpenMemory:\n" + .)
    }
  }'
fi

exit 0
