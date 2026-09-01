FROM python:3.10-slim

# Install FFmpeg and curl
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install python dependencies
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY . .

ENV PORT=5000
ENV PYTHONUNBUFFERED=1
ENV RAILWAY_ENVIRONMENT=true

EXPOSE 5000

# Start server using Gunicorn
CMD ["sh", "-c", "cd backend && gunicorn -w 2 -b 0.0.0.0:${PORT:-5000} --timeout 300 app:app"]
