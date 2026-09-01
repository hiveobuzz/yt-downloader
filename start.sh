#!/bin/sh
cd backend && gunicorn -w 2 -b 0.0.0.0:${PORT:-5000} --timeout 300 app:app
