FROM python:3.10-slim

# Install system dependencies (FFmpeg for merging & audio conversion)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY . .

# Set environment
ENV PORT=5000
ENV PYTHONUNBUFFERED=1
ENV RAILWAY_ENVIRONMENT=true

EXPOSE 5000

# Run with Gunicorn WSGI
CMD ["sh", "-c", "gunicorn -w 2 -b 0.0.0.0:${PORT:-5000} --timeout 300 app:app"]
