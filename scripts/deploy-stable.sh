#!/bin/bash
# Build and prepare stable environment
# Run this after development to update the stable builds

cd "$(dirname "$0")/.."

echo "🔨 Building backend..."
(cd backend && npm run build) || { echo "❌ Backend build failed"; exit 1; }

echo "🔨 Building frontend..."
(cd frontend && npm run build) || { echo "❌ Frontend build failed"; exit 1; }

echo ""
echo "✅ Builds ready. Restart stable to pick up changes:"
echo "   ./scripts/start-stable.sh"
