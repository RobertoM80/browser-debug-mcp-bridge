#!/bin/bash
# Ralph Loop for autonomous development
# Based on: https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum
#
# Usage: ./ralph.sh <iterations>
# Example: ./ralph.sh 10

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <iterations>"
    echo "Example: $0 10  # Run 10 iterations"
    exit 1
fi

echo "Ralph is starting development loop..."
echo "Iterations: $1"
echo ""

# ------------------------------------------------------------------
# CONFIGURATION
# ------------------------------------------------------------------
# Specify the AI model to use (e.g. "gpt-4o", "claude-3-5-sonnet-20240620")
# Leave empty "" to use OpenCode's default.
# If you have "Codex" installed/configured, you can try setting it here. "openai/gpt-5.2-codex"
MODEL_NAME="openai/gpt-5.3-codex"
# ------------------------------------------------------------------

# Function to backup Ralph files
backup_files() {
    mkdir -p .ralph_backup
    cp ralph.sh prd.json progress.md AGENTS.md .ralph_backup/ 2>/dev/null || true
}

# Function to restore Ralph files
restore_files() {
    echo "Restoring Ralph files from backup..."
    cp .ralph_backup/* . 2>/dev/null || true
    rm -rf .ralph_backup
}

for ((i=1; i<=$1; i++)); do
    echo "======================================="
    echo "=== Iteration $i of $1 ==="
    echo "======================================="
    
    # Backup before starting
    backup_files
    
    echo "Running OpenCode (this may take 2-5 minutes)..."
    
    # Windows-friendly prompt handling
    # We construct the prompt as a single line string to avoid shell escaping hell
PROMPT_TEXT="@prd.json @progress.md. 1. Read prd.json to find the next INCOMPLETE task (status passes: false). 2. INSPECT CODEBASE to see if this task is ALREADY implemented. 3. IF ALREADY DONE: Mark it as passes: true in prd.json, append 'Verified [task] was already complete' to progress.md, git commit, and STOP. 4. IF NOT DONE: Implement the task (including UNIT TESTS), RUN 'pnpm test' to verify they pass, update prd.json, and append progress. 5. Git commit. CRITICAL: DO NOT output <promise>COMPLETE</promise> unless EVERY SINGLE TASK in prd.json has passes: true."

    # Use PowerShell to run the command, which handles the Windows binary better than Git Bash
    # We use --prompt flag as discovered in debugging
    WIN_OPENCODE="C:\Users\bronz\.opencode\bin\opencode.exe"
    
    echo "Running OpenCode (via PowerShell)..."
    
    # Create temp file for output
    tmp_out=$(mktemp)
    
    # Run in background with monitoring
    # Use Out-String -Stream to prevent buffering the entire output until the end
    (
        if [ -n "$MODEL_NAME" ]; then
            echo "   (Using model: $MODEL_NAME)"
            powershell.exe -Command "& '$WIN_OPENCODE' --model '$MODEL_NAME' run '$PROMPT_TEXT' | Out-String -Stream" > "$tmp_out" 2>&1
        else
            powershell.exe -Command "& '$WIN_OPENCODE' run '$PROMPT_TEXT' | Out-String -Stream" > "$tmp_out" 2>&1
        fi
    ) &
    pid=$!
    
    # Progress loop with timeout
    count=0
    timeout=900 # 15 minutes
    last_byte_count=0
    
    while kill -0 $pid 2>/dev/null; do
        # Check current byte count of the output file
        # We use 'wc -c' to get the number of bytes. If file is empty, it returns 0.
        if [ -f "$tmp_out" ]; then
            current_byte_count=$(wc -c < "$tmp_out")
        else
            current_byte_count=0
        fi

        # If we have new bytes, print them (handles output without newlines)
        if [ "$current_byte_count" -gt "$last_byte_count" ]; then
            # Print bytes from (last_byte_count + 1) to end
            # tail -c +K outputs from byte K onwards
            tail -c "+$((last_byte_count + 1))" "$tmp_out"

            last_byte_count=$current_byte_count
        else
            # Only print a dot if there is no new output, to show heartbeat
            echo -n "."
        fi
        
        sleep 2
        count=$((count+2))
        if [ $count -ge $timeout ]; then
            kill $pid
            echo ""
            echo "Timeout reached ($timeout seconds). Killing process."
            restore_files
            exit 1
        fi
    done
    
    echo "" # Newline after loop
    
    # Read result
    result=$(cat "$tmp_out")
    rm "$tmp_out"

    echo "--- OpenCode Output ---"
    # Filter out empty lines to keep it clean
    echo "$result" | sed '/^$/d'
    echo "-----------------------"
    
    # Check for meaningful failure (Powershell errors often start with "At line:")
    if [[ "$result" == *"At line:"* ]] || [[ "$result" == *"Error:"* ]]; then
         echo "Possible error detected in output."
    else
         # Success - clean backup
         rm -rf .ralph_backup
    fi

    # Check for completion signal
    if [[ "$result" == *"<promise>COMPLETE</promise>"* ]]; then
        # Double check that we are actually done by reading prd.json
        if grep -q '"passes": false' prd.json; then
             echo "Agent says COMPLETE, but prd.json still has incomplete tasks. continuing loop..."
        else
            echo ""
            echo "======================================="
            echo "PRD complete! All tasks finished."
            echo "======================================="
            rm -rf .ralph_backup
            exit 0
        fi
    fi
    
    echo ""
done

echo "======================================="
echo "Reached iteration limit ($1)."
echo "    Run again to continue: ./ralph.sh $1"
echo "======================================="
