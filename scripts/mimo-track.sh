#!/bin/bash
# MiMo API wrapper — auto-tracks token usage to the dashboard
# Usage: source this file, then use mimo-chat instead of direct API calls
#
# Example:
#   mimo-chat "What is the capital of France?"
#   mimo-chat --model MiMo-7B-RL "Summarize this code"

DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:3000}"
MIMO_PROJECT="${MIMO_PROJECT:-$(pwd)}"

mimo-chat() {
  local prompt="$*"
  local start_time=$(date +%s%3N)
  
  # Call MiMo API (adjust endpoint/key as needed)
  local response=$(curl -s -X POST https://api.mimollm.com/v1/chat/completions \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${MIMO_API_KEY}" \
    -d "{\"model\":\"MiMo-7B-RL\",\"messages\":[{\"role\":\"user\",\"content\":\"$prompt\"}]}")
  
  local end_time=$(date +%s%3N)
  local exec_time=$(( end_time - start_time ))
  
  # Parse token counts from response
  local input_tokens=$(echo "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('usage',{}).get('prompt_tokens',0))" 2>/dev/null || echo 0)
  local output_tokens=$(echo "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('usage',{}).get('completion_tokens',0))" 2>/dev/null || echo 0)
  local saved_tokens=$(echo "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('usage',{}).get('cached_tokens',0))" 2>/dev/null || echo 0)
  
  # Track to dashboard
  if [ "$input_tokens" -gt 0 ] || [ "$output_tokens" -gt 0 ]; then
    curl -s -X POST "$DASHBOARD_URL/api/rtk/ingest" \
      -H "Content-Type: application/json" \
      -d "{
        \"original_cmd\": \"mimo chat completion\",
        \"brand\": \"mimo\",
        \"input_tokens\": $input_tokens,
        \"output_tokens\": $output_tokens,
        \"saved_tokens\": $saved_tokens,
        \"exec_time_ms\": $exec_time,
        \"project_path\": \"$MIMO_PROJECT\"
      }" > /dev/null 2>&1 &
  fi
  
  # Print response (extract content)
  echo "$response" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'choices' in d and d['choices']:
    print(d['choices'][0]['message']['content'])
elif 'error' in d:
    print('Error:', d['error'].get('message','Unknown'))
else:
    print(d)
" 2>/dev/null || echo "$response"
}

export -f mimo-chat
