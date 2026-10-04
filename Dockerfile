FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000 STATIC_DIR=/app/static
WORKDIR /app

# uv for fast installs; no model weights — API only.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY pyproject.toml ./
COPY src/ src/
COPY static/ static/
RUN uv pip install --system --no-cache .

EXPOSE 8000
CMD ["sh", "-c", "uvicorn bossfight.app:app --host 0.0.0.0 --port ${PORT:-8000}"]
