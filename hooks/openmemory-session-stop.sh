#!/bin/bash
# OpenMemory Stop hook - stores session summary
# Fails silently if OpenMemory/Docker not available

OPENMEMORY_URL="${OPENMEMORY_URL:-http://localhost:8080}"
TIMEOUT_SECS=3

# Quick health check first (fail fast)
if ! curl -s --connect-timeout 1 --max-time 2 "$OPENMEMORY_URL/health" > /dev/null 2>&1; then
  exit 0  # OpenMemory not available, skip saving
fi

# Read hook input from stdin
input=$(cat)
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
transcript_path=$(echo "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
stop_hook_active=$(echo "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)

# Don't run if already triggered by stop hook (prevent loops)
if [ "$stop_hook_active" = "true" ]; then
  exit 0
fi

project_name=$(basename "$cwd" 2>/dev/null || echo "unknown")

# Extract recent assistant messages from transcript for summary
if [ -f "$transcript_path" ]; then
  # Get last few assistant messages to summarise session
  recent_content=$(tail -50 "$transcript_path" 2>/dev/null | \
    jq -r 'select(.type == "assistant") | .message.content // empty' 2>/dev/null | \
    grep -v '^\[' | head -c 500)

  if [ -n "$recent_content" ] && [ ${#recent_content} -gt 100 ]; then
    # Store session summary to OpenMemory
    summary="Session in $project_name: $recent_content"
    # Escape for JSON
    escaped_summary=$(echo "$summary" | head -c 1000 | jq -Rs '.')

    curl -s --connect-timeout 2 --max-time "$TIMEOUT_SECS" \
      -X POST "$OPENMEMORY_URL/memory/add" \
      -H "Content-Type: application/json" \
      -d "{
        \"content\": $escaped_summary,
        \"user_id\": \"claude-session\",
        \"tags\": [\"session\", \"project:$project_name\"]
      }" > /dev/null 2>&1 || true  # Ignore errors
  fi
fi

exit 0
