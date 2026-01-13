# Claude Code Hooks for OpenMemory

These hooks integrate OpenMemory with Claude Code for automatic memory capture.

## Installation

Copy to your Claude hooks directory:

```bash
mkdir -p ~/.claude/hooks
cp hooks/openmemory-session-*.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/openmemory-session-*.sh
```

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/openmemory-session-start.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/openmemory-session-stop.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

## Hooks

### openmemory-session-start.sh

Runs at session start. Queries OpenMemory for project-relevant context and injects it into the conversation.

### openmemory-session-stop.sh

Runs at session end. Stores a summary of the session to OpenMemory.

## Configuration

Set `OPENMEMORY_URL` environment variable to override the default (`http://localhost:8080`).

## Error Handling

Both hooks fail silently with 3-second timeouts if OpenMemory/Docker is unavailable.
