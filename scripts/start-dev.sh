#!/bin/bash
# Start the DEV environment (ports 3100/3101, .clawui-dev DB)
# Use this for Claude Code development — separate DB, won't affect stable

cd "$(dirname "$0")/.."

echo "🔧 Starting DEV environment..."
echo "   Frontend: http://localhost:3100"
echo "   Backend:  http://localhost:3101"
echo "   Database: .clawui-dev/"

# Start backend (with watch mode for hot reload)
(cd backend && PORT=3101 CLAWUI_DB_DIR=.clawui-dev npx tsx watch src/index.ts) &
BACKEND_PID=$!

# Start frontend (dev mode with hot reload)
(cd frontend && NEXT_PUBLIC_API_PORT=3101 next dev --port 3100 --hostname 0.0.0.0) &
FRONTEND_PID=$!

echo "   Backend PID:  $BACKEND_PID"
echo "   Frontend PID: $FRONTEND_PID"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
