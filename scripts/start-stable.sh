#!/bin/bash
# Start the STABLE/production environment (ports 3000/3001, .clawui DB)
# Runs from compiled dist/ and .next/ — unaffected by source code changes
#
# To update stable after development:
#   cd backend && npm run build
#   cd frontend && npm run build
#   Then restart this script

cd "$(dirname "$0")/.."

# Kill existing processes on ports 3000/3001
for PORT in 3000 3001; do
  PIDS=$(lsof -ti tcp:$PORT 2>/dev/null)
  if [ -n "$PIDS" ]; then
    echo "🔪 Killing existing process on port $PORT (PID: $PIDS)"
    echo "$PIDS" | xargs kill -9 2>/dev/null
    sleep 0.5
  fi
done

# Check builds exist
if [ ! -d "backend/dist" ]; then
  echo "❌ Backend not built. Run: cd backend && npm run build"
  exit 1
fi
if [ ! -d "frontend/.next" ]; then
  echo "❌ Frontend not built. Run: cd frontend && npm run build"
  exit 1
fi

echo "🟢 Starting STABLE environment (from compiled builds)..."
echo "   Frontend: http://localhost:3000"
echo "   Backend:  http://localhost:3001"
echo "   Database: .clawui/"
echo ""
echo "   ℹ️  Source code changes won't affect this environment."
echo "   ℹ️  Run 'npm run build' + restart to pick up changes."

# Start backend from compiled JS
(cd backend && PORT=3001 CLAWUI_DB_DIR=.clawui CLAWUI_DEV=1 node dist/index.js) &
BACKEND_PID=$!

# Start frontend from production build
(cd frontend && NEXT_PUBLIC_API_PORT=3001 npx next start --port 3000 --hostname 127.0.0.1) &
FRONTEND_PID=$!

echo ""
echo "   Backend PID:  $BACKEND_PID"
echo "   Frontend PID: $FRONTEND_PID"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
