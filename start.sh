#!/bin/bash
set -e

echo "Starting Python AI Microservice on port 8000..."
cd ai_service
uvicorn main:app --host 127.0.0.1 --port 8000 &
cd ..

echo "Starting Node.js Web Server..."
npm start
